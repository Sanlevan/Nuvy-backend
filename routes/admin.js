const express = require('express');
const bcrypt = require('bcrypt');
const { supabase, MASTER_CEO_KEY, STEREOTYPES } = require('../config');
const { refreshAllPasses } = require('../services/applePass');
const { generateManuelPdf } = require('../services/manuelPdf');

const router = express.Router();

function requireCeoKey(req, res, next) {
    const key = req.headers['x-ceo-key'] || req.body.ceoKey || req.query.key;
    if (key !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });
    next();
}

router.post('/create-boutique', async (req, res) => {
    try {
        const { nom, username, password, ceoKey, categorie, logo_url, max_tampons, plan, engagement } = req.body;
        if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ message: "Clé CEO invalide." });

        const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        const da = STEREOTYPES[categorie] || STEREOTYPES.default;
        const join_url = `nuvy.pro/tap/${slug}`;
        const finalMaxTampons = parseInt(max_tampons) || 10;
        const hashedPassword = await bcrypt.hash(password, 10);
        const plansValides = ['essentiel', 'pro', 'multi-site'];
        const finalPlan = plansValides.includes(plan) ? plan : 'essentiel';
        const finalEngagement = engagement === 'annuel' ? 'annuel' : 'mensuel';

        // Récupérer le bon Price ID
        const priceMap = {
            'essentiel_mensuel': process.env.STRIPE_PRICE_ESSENTIEL_MENSUEL,
            'essentiel_annuel': process.env.STRIPE_PRICE_ESSENTIEL_ANNUEL,
            'pro_mensuel': process.env.STRIPE_PRICE_PRO_MENSUEL,
            'pro_annuel': process.env.STRIPE_PRICE_PRO_ANNUEL,
            'multi-site_mensuel': process.env.STRIPE_PRICE_MULTISITE_MENSUEL,
            'multi-site_annuel': process.env.STRIPE_PRICE_MULTISITE_ANNUEL
        };
        const priceKey = `${finalPlan}_${finalEngagement}`;
        const priceId = priceMap[priceKey];

        if (!priceId) {
            throw new Error(`Price ID manquant pour ${priceKey}`);
        }

        // Créer le customer Stripe
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const stripeCustomer = await stripe.customers.create({
            email: req.body.email || `${slug}@nuvy.pro`,
            name: nom,
            metadata: { boutique_name: nom, slug: slug }
        });

        // Créer la subscription
        const subscription = await stripe.subscriptions.create({
            customer: stripeCustomer.id,
            items: [{ price: priceId }],
            metadata: { plan: finalPlan, engagement: finalEngagement }
        });

        // Insérer en base
        const { data, error } = await supabase.from('boutiques').insert([{
            nom, slug, username, password: hashedPassword, categorie, logo_url, join_url,
            color_bg: da.bg, color_text: da.text, max_tampons: finalMaxTampons,
            plan: finalPlan,
            stripe_customer_id: stripeCustomer.id,
            stripe_subscription_id: subscription.id,
            plan_status: subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : 'inactive'
        }]).select().single();

        if (error) throw error;

        // Générer le PDF
        let pdfBase64 = null;
        try {
            const pdfBuffer = await generateManuelPdf({
                nom: data.nom,
                username: data.username,
                passwordPlain: password,
                plan: data.plan,
                max_tampons: data.max_tampons,
                slug: data.slug
            });
            pdfBase64 = pdfBuffer.toString('base64');
        } catch (pdfErr) {
            console.error("⚠️ Erreur génération PDF manuel:", pdfErr.message);
        }

        res.json({ success: true, boutique: data, pdfBase64 });
    } catch (e) { 
        res.status(400).json({ message: e.message }); 
    }
});

router.post('/force-reset-password', async (req, res) => {
    const { boutiqueId, newPassword, ceoKey } = req.body;
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ message: "Accès refusé. Clé CEO invalide." });
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const { error } = await supabase.from('boutiques').update({ password: hashedPassword }).eq('id', boutiqueId);
        if (error) throw error;
        res.json({ success: true, message: "Mot de passe réinitialisé avec succès." });
    } catch (e) { res.status(500).json({ message: "Erreur lors de la réinitialisation." }); }
});

router.post('/login-as', async (req, res) => {
    const { jwt, JWT_SECRET } = require('../config');
    const { boutiqueId, ceoKey } = req.body;
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });

    const { data: boutique, error } = await supabase.from('boutiques').select('id, slug, nom, max_tampons').eq('id', boutiqueId).single();
    if (error || !boutique) return res.status(404).json({ error: "Boutique introuvable" });

    const authToken = jwt.sign(
        { boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom },
        JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
        boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom,
        maxTampons: boutique.max_tampons, token: authToken
    });
});

router.delete('/boutique/:id', requireCeoKey, async (req, res) => {
    try {
        const boutiqueId = req.params.id;
        const { data: clients } = await supabase.from('clients').select('serial_number').eq('boutique_id', boutiqueId);
        if (clients && clients.length > 0) {
            const serials = clients.map(c => c.serial_number).filter(Boolean);
            if (serials.length > 0) await supabase.from('devices').delete().in('serial_number', serials);
        }
        await supabase.from('visites').delete().eq('boutique_id', boutiqueId);
        await supabase.from('clients').delete().eq('boutique_id', boutiqueId);
        const { error } = await supabase.from('boutiques').delete().eq('id', boutiqueId);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur lors de la suppression : " + e.message }); }
});

router.get('/export-csv', async (req, res) => {
    if (req.query.key !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");
    try {
        const { data: boutiques } = await supabase.from('boutiques').select('id, nom, slug, categorie, created_at');
        const { data: clients } = await supabase.from('clients').select('id, nom, telephone, tampons, recompenses, total_historique, boutique_id, device_type, created_at');

        const boutiqueMap = {};
        boutiques?.forEach(b => { boutiqueMap[b.id] = b.nom; });

        let csv = 'Boutique,Nom Client,Téléphone,Tampons,Récompenses,Points Totaux,Appareil,Inscrit le\n';
        clients?.forEach(c => {
            const boutNom = (boutiqueMap[c.boutique_id] || 'Inconnue').replace(/,/g, ' ');
            const nom = (c.nom || '').replace(/,/g, ' ');
            const tel = (c.telephone || '').replace(/,/g, ' ');
            const date = new Date(c.created_at).toLocaleDateString('fr-FR');
            csv += `${boutNom},${nom},${tel},${c.tampons || 0},${c.recompenses || 0},${c.total_historique || 0},${c.device_type || 'inconnu'},${date}\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=nuvy-export-' + new Date().toISOString().split('T')[0] + '.csv');
        res.send('\uFEFF' + csv);
    } catch (e) { res.status(500).send("Erreur export : " + e.message); }
});

router.get('/boutiques', requireCeoKey, async (req, res) => {
    try {
        const { data: boutiques, error } = await supabase.from('boutiques').select('id, nom, username, slug, plan, created_at, reseau_id');
        if (error) throw error;

        const septJours = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const trenteJours = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const [visites7j, visites30j] = await Promise.all([
            supabase.from('visites').select('boutique_id').gte('created_at', septJours),
            supabase.from('visites').select('boutique_id').gte('created_at', trenteJours)
        ]);

        const actives7jIds = new Set(visites7j.data?.map(v => v.boutique_id) || []);
        const actives30jIds = new Set(visites30j.data?.map(v => v.boutique_id) || []);

        const boutiquesAnalysees = boutiques.map(b => {
            let statut = 'inactif';
            if (actives7jIds.has(b.id)) statut = 'actif';
            else if (actives30jIds.has(b.id)) statut = 'attention';
            else if (new Date(b.created_at) > new Date(septJours)) statut = 'attention';
            return { ...b, statut };
        });

        res.json(boutiquesAnalysees);
    } catch (error) {
        console.error("Erreur API Boutiques:", error);
        res.status(500).json({ error: "Erreur lors de l'analyse de la flotte" });
    }
});

router.put('/boutique/:id/plan', requireCeoKey, async (req, res) => {
    const { plan } = req.body;
    const plansValides = ['essentiel', 'pro', 'multi-site'];
    if (!plansValides.includes(plan)) return res.status(400).json({ error: "Plan invalide." });
    const { data, error } = await supabase.from('boutiques').update({ plan }).eq('id', req.params.id).select('id, nom, plan').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.get('/boutique/:id/appearance-current', requireCeoKey, async (req, res) => {
    try {
        const { data, error } = await supabase.from('boutiques').select('color_bg, color_text, color_label, categorie').eq('id', req.params.id).single();
        if (error) throw error;
        const defaults = STEREOTYPES[data.categorie] || STEREOTYPES.default;
        res.json({
            color_bg: data.color_bg || defaults.bg,
            color_text: data.color_text || defaults.text,
            color_label: data.color_label || defaults.label
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/boutique/:id/appearance', async (req, res) => {
    if (req.body.ceoKey !== MASTER_CEO_KEY && req.headers['x-ceo-key'] !== MASTER_CEO_KEY) {
        return res.status(403).json({ error: "Clé CEO invalide." });
    }
    try {
        const { color_bg, color_text, color_label, strip_enabled } = req.body;
        const update = {};
        if (color_bg !== undefined) update.color_bg = color_bg;
        if (color_text !== undefined) update.color_text = color_text;
        if (color_label !== undefined) update.color_label = color_label;
        if (strip_enabled !== undefined) update.strip_enabled = !!strip_enabled;

        const { error } = await supabase.from('boutiques').update(update).eq('id', req.params.id);
        if (error) throw error;
        refreshAllPasses(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/global-stats', requireCeoKey, async (req, res) => {
    try {
        const trenteJours = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const septJours = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const today = new Date(); today.setHours(0, 0, 0, 0);

        const [
            { data: visites30j }, { count: totalClients }, { data: visitesAujourd },
            { data: boutiques }, { data: devices },
        ] = await Promise.all([
            supabase.from('visites').select('created_at, client_id, boutique_id').gte('created_at', trenteJours),
            supabase.from('clients').select('*', { count: 'exact', head: true }),
            supabase.from('visites').select('id').gte('created_at', today.toISOString()),
            supabase.from('boutiques').select('id, categorie, adresse'),
            supabase.from('devices').select('serial_number'),
        ]);

        const scansParJour = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            scansParJour[d.toISOString().split('T')[0]] = 0;
        }
        visites30j?.forEach(v => { const j = v.created_at.split('T')[0]; if (scansParJour[j] !== undefined) scansParJour[j]++; });

        const joursLabels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        const scansParSemaine = Array(7).fill(0);
        visites30j?.forEach(v => { scansParSemaine[new Date(v.created_at).getDay()]++; });
        const weeklyData = joursLabels.map((day, i) => ({ day, scans: scansParSemaine[i] }));
        const weeklyOrdered = [...weeklyData.slice(1), weeklyData[0]];

        const uniqueUsers30j = new Set(visites30j?.map(v => v.client_id)).size;
        const cartesWallet = new Set(devices?.map(d => d.serial_number)).size;

        const comptageParClient = {};
        visites30j?.forEach(v => { comptageParClient[v.client_id] = (comptageParClient[v.client_id] || 0) + 1; });
        const clientsFideles = Object.values(comptageParClient).filter(n => n > 1).length;
        const totalVisiteurs = Object.keys(comptageParClient).length;
        const tauxRetention = totalVisiteurs > 0 ? Math.round((clientsFideles / totalVisiteurs) * 100) : 0;

        const totalBoutiques = boutiques?.length || 0;
        const { data: actives7j } = await supabase.from('visites').select('boutique_id').gte('created_at', septJours);
        const activesIds = new Set(actives7j?.map(v => v.boutique_id) || []);
        const healthScore = totalBoutiques > 0 ? Math.round((activesIds.size / totalBoutiques) * 100) : 0;

        const secteurs = {};
        boutiques?.forEach(b => { const c = b.categorie || 'default'; secteurs[c] = (secteurs[c] || 0) + 1; });

        const { data: deviceTypes } = await supabase.from('clients').select('device_type');
        const totalD = deviceTypes?.length || 1;
        const iosCount = deviceTypes?.filter(c => c.device_type === 'ios').length || 0;
        const androidCount = deviceTypes?.filter(c => c.device_type === 'android').length || 0;
        const otherCount = deviceTypes?.filter(c => !c.device_type || c.device_type === 'other').length || 0;
        const deviceData = {
            iphone: Math.round((iosCount / totalD) * 100),
            android: Math.round((androidCount / totalD) * 100),
            autre: Math.round((otherCount / totalD) * 100),
        };

        const villeScans = {};
        const boutiqueVille = {};
        boutiques?.forEach(b => {
            if (b.adresse) {
                const parts = b.adresse.split(',');
                let cityRaw = parts[parts.length - 1].trim();
                if (cityRaw.toLowerCase().includes('france') && parts.length > 1) cityRaw = parts[parts.length - 2].trim();
                cityRaw = cityRaw.replace(/^\d{5}\s*/, '').trim();
                if (cityRaw) boutiqueVille[b.id] = cityRaw;
            }
        });
        visites30j?.forEach(v => {
            const ville = boutiqueVille[v.boutique_id];
            if (ville) villeScans[ville] = (villeScans[ville] || 0) + 1;
        });
        const totalScansVilles = Object.values(villeScans).reduce((a, b) => a + b, 0) || 1;
        const topVilles = Object.entries(villeScans).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([city, scans]) => ({ city, scans, percentage: Math.round((scans / totalScansVilles) * 100) }));

        res.json({
            scansAujourdhui: visitesAujourd?.length || 0,
            scans30j: visites30j?.length || 0,
            totalClients: totalClients || 0,
            uniqueUsers30j, cartesWallet, tauxRetention, healthScore,
            secteurs, deviceData, weeklyData: weeklyOrdered, topVilles,
            chartLabels: Object.keys(scansParJour).map(d => d.slice(5)),
            chartData: Object.values(scansParJour),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/radar', requireCeoKey, async (req, res) => {
    try {
        const sept = new Date(Date.now() - 7 * 86400000).toISOString();
        const trente = new Date(Date.now() - 30 * 86400000).toISOString();

        const [{ data: boutiques }, { data: v7j }, { data: v30j }] = await Promise.all([
            supabase.from('boutiques').select('id, nom'),
            supabase.from('visites').select('boutique_id').gte('created_at', sept),
            supabase.from('visites').select('boutique_id').gte('created_at', trente)
        ]);

        const ids7j = new Set(v7j?.map(v => v.boutique_id));
        const compte7j = {};
        v7j?.forEach(v => { compte7j[v.boutique_id] = (compte7j[v.boutique_id] || 0) + 1; });

        const churn = boutiques?.filter(b => !ids7j.has(b.id) && v30j?.some(v => v.boutique_id === b.id)) || [];
        const top = boutiques?.filter(b => ids7j.has(b.id))
            .map(b => ({ ...b, scans: compte7j[b.id] || 0 }))
            .sort((a, b) => b.scans - a.scans).slice(0, 5) || [];

        res.json({ churn, top });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;