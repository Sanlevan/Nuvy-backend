const express = require('express');
const bcrypt = require('bcrypt');
const { jwt, JWT_SECRET, supabase, MASTER_CEO_KEY } = require('../config');

const router = express.Router();

function verifyAuthReseau(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: "Non authentifié." });
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type !== 'reseau') return res.status(403).json({ error: "Accès refusé." });
        req.auth = decoded;
        next();
    } catch (e) { return res.status(401).json({ error: "Session expirée." }); }
}

router.post('/admin/create-reseau', async (req, res) => {
    const { nom, username, password, ceoKey } = req.body;
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });
    if (!nom || !username || !password) return res.status(400).json({ error: "Champs manquants." });
    try {
        const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        const hashedPassword = await bcrypt.hash(password, 10);
        const { data, error } = await supabase.from('reseaux')
            .insert([{ nom, slug, username, password: hashedPassword }])
            .select().single();
        if (error) throw error;
        res.json({ success: true, reseau: data });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/admin/reseaux', async (req, res) => {
    if (req.headers['x-ceo-key'] !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });
    const { data, error } = await supabase.from('reseaux').select('id, nom, slug, username, created_at');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.put('/admin/boutique/:id/reseau', async (req, res) => {
    if (req.headers['x-ceo-key'] !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });
    const { reseau_id } = req.body;
    const { data, error } = await supabase.from('boutiques')
        .update({ reseau_id: reseau_id || null })
        .eq('id', req.params.id)
        .select('id, nom, reseau_id').single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

router.post('/auth/login-reseau', async (req, res) => {
    const { user, pass } = req.body;
    const { data: reseau } = await supabase.from('reseaux')
        .select('id, slug, nom, password').eq('username', user).maybeSingle();
    if (!reseau) return res.status(401).json({ error: "Identifiant incorrect." });
    const match = await bcrypt.compare(pass, reseau.password);
    if (!match) return res.status(401).json({ error: "Mot de passe incorrect." });
    const token = jwt.sign(
        { reseauId: reseau.id, slug: reseau.slug, nom: reseau.nom, type: 'reseau' },
        JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ reseauId: reseau.id, slug: reseau.slug, nom: reseau.nom, token });
});

router.get('/reseau/:id/boutiques', verifyAuthReseau, async (req, res) => {
    if (String(req.auth.reseauId) !== String(req.params.id)) return res.status(403).json({ error: "Accès interdit." });
    const { data, error } = await supabase.from('boutiques')
        .select('id, nom, slug, categorie, plan, created_at, adresse, color_text')
        .eq('reseau_id', req.params.id).order('nom');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

router.get('/reseau/:id/stats', verifyAuthReseau, async (req, res) => {
    if (String(req.auth.reseauId) !== String(req.params.id)) return res.status(403).json({ error: "Accès interdit." });
    try {
        const { data: boutiques } = await supabase.from('boutiques').select('id, nom').eq('reseau_id', req.params.id);
        if (!boutiques || boutiques.length === 0) {
            return res.json({ totalClients: 0, totalScans30j: 0, boutiquesActives: 0, totalBoutiques: 0, scansParBoutique: [], topClients: [], chartLabels: [], chartData: [] });
        }
        const boutiqueIds = boutiques.map(b => b.id);
        const trenteJours = new Date(Date.now() - 30 * 86400000).toISOString();
        const septJours = new Date(Date.now() - 7 * 86400000).toISOString();

        const [
            { count: totalClients }, { data: visites30j },
            { data: visites7j }, { data: topClientsRaw }
        ] = await Promise.all([
            supabase.from('clients').select('id', { count: 'exact', head: true }).in('boutique_id', boutiqueIds),
            supabase.from('visites').select('boutique_id, created_at').in('boutique_id', boutiqueIds).gte('created_at', trenteJours),
            supabase.from('visites').select('boutique_id').in('boutique_id', boutiqueIds).gte('created_at', septJours),
            supabase.from('clients').select('nom, telephone, total_historique, boutique_id').in('boutique_id', boutiqueIds).order('total_historique', { ascending: false }).limit(50)
        ]);

        const activesIds = new Set(visites7j?.map(v => v.boutique_id) || []);
        const boutiquesActives = activesIds.size;

        const scanCount = {};
        visites30j?.forEach(v => { scanCount[v.boutique_id] = (scanCount[v.boutique_id] || 0) + 1; });
        const scansParBoutique = boutiques.map(b => ({ nom: b.nom, id: b.id, scans: scanCount[b.id] || 0 })).sort((a, b) => b.scans - a.scans);

        const clientsParTel = {};
        topClientsRaw?.forEach(c => {
            const tel = c.telephone;
            if (!clientsParTel[tel]) clientsParTel[tel] = { nom: c.nom, telephone: tel, total: 0, boutiques: 0 };
            clientsParTel[tel].total += (c.total_historique || 0);
            clientsParTel[tel].boutiques += 1;
        });
        const topClients = Object.values(clientsParTel).sort((a, b) => b.total - a.total).slice(0, 5);

        const scansParJour = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
            scansParJour[d] = 0;
        }
        visites30j?.forEach(v => { const j = v.created_at.split('T')[0]; if (scansParJour[j] !== undefined) scansParJour[j]++; });

        res.json({
            totalClients: totalClients || 0,
            totalScans30j: visites30j?.length || 0,
            boutiquesActives, totalBoutiques: boutiques.length,
            scansParBoutique, topClients,
            chartLabels: Object.keys(scansParJour).map(d => d.slice(5)),
            chartData: Object.values(scansParJour)
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reseau/:id/clients', verifyAuthReseau, async (req, res) => {
    if (String(req.auth.reseauId) !== String(req.params.id)) return res.status(403).json({ error: "Accès interdit." });
    try {
        const { data: boutiques } = await supabase.from('boutiques').select('id, nom').eq('reseau_id', req.params.id);
        if (!boutiques || boutiques.length === 0) return res.json([]);

        const boutiqueIds = boutiques.map(b => b.id);
        const boutiqueMap = Object.fromEntries(boutiques.map(b => [b.id, b.nom]));

        const { data: clients } = await supabase.from('clients')
            .select('nom, telephone, tampons, recompenses, total_historique, last_visit, boutique_id')
            .in('boutique_id', boutiqueIds).order('total_historique', { ascending: false });

        const clientsReseau = {};
        clients?.forEach(c => {
            const tel = c.telephone;
            if (!clientsReseau[tel]) clientsReseau[tel] = { nom: c.nom, telephone: tel, total_reseau: 0, boutiques_visitees: [], derniere_visite: null };
            clientsReseau[tel].total_reseau += (c.total_historique || 0);
            clientsReseau[tel].boutiques_visitees.push(boutiqueMap[c.boutique_id]);
            if (!clientsReseau[tel].derniere_visite || c.last_visit > clientsReseau[tel].derniere_visite) {
                clientsReseau[tel].derniere_visite = c.last_visit;
            }
        });

        res.json(Object.values(clientsReseau).sort((a, b) => b.total_reseau - a.total_reseau));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reseau/login-as-boutique', verifyAuthReseau, async (req, res) => {
    const { boutiqueId, reseauId } = req.body;
    if (String(req.auth.reseauId) !== String(reseauId)) return res.status(403).json({ error: "Accès interdit." });
    const { data: boutique } = await supabase.from('boutiques')
        .select('id, slug, nom, max_tampons, plan')
        .eq('id', boutiqueId).eq('reseau_id', reseauId).single();
    if (!boutique) return res.status(404).json({ error: "Boutique introuvable dans ce réseau." });
    const token = jwt.sign(
        { boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom },
        JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
        boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom,
        maxTampons: boutique.max_tampons, plan: boutique.plan || 'essentiel', token
    });
});

module.exports = router;