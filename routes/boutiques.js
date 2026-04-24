const express = require('express');
const { supabase, PLAN_LIMITS, STEREOTYPES, SYMBOLS, uploadStrip, logger } = require('../config');
const { verifyAuth, verifyAuthOwner, requireFeature } = require('../middleware/auth');
const { refreshAllPasses, sendPushToDevices } = require('../services/applePass');
const { updateGoogleWalletPass, pushMessageToAllGoogleCards } = require('../services/googleWallet');
const { isValidInteger } = require('../utils/validation');
const sharp = require('sharp');

const router = express.Router();

// ============================================================
// PROFIL BOUTIQUE
// ============================================================

router.get('/:id', verifyAuthOwner, async (req, res) => {
    const { data, error } = await supabase.from('boutiques').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Boutique introuvable' });
    res.json(data);
});

router.put('/:id', verifyAuthOwner, async (req, res) => {
    const { id } = req.params;
    const { adresse, telephone, panier_moyen, valeur_tampon, roi_mode, google_review_url } = req.body;

    let latitude = null, longitude = null, geoDebug = "Non tenté";

    try {
        if (adresse && adresse.trim() !== "") {
            try {
                const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(adresse)}`;
                const geoRes = await fetch(url, { headers: { 'User-Agent': 'NuvyApp/1.0 (contact@nuvy.pro)' } });
                if (!geoRes.ok) geoDebug = `API Rejet (Code ${geoRes.status})`;
                else {
                    const geoData = await geoRes.json();
                    if (geoData && geoData.length > 0) {
                        latitude = parseFloat(geoData[0].lat);
                        longitude = parseFloat(geoData[0].lon);
                        geoDebug = "Succès";
                    } else geoDebug = "Adresse introuvable par le GPS";
                }
            } catch (geoErr) { geoDebug = `Erreur réseau: ${geoErr.message}`; }
        }

        const updatePayload = { adresse, telephone };
        if (panier_moyen !== undefined) updatePayload.panier_moyen = parseFloat(panier_moyen) || 0;
        if (valeur_tampon !== undefined) updatePayload.valeur_tampon = parseFloat(valeur_tampon) || 0;
        if (roi_mode) updatePayload.roi_mode = roi_mode;
        if (google_review_url !== undefined) updatePayload.google_review_url = google_review_url;
        if (latitude && longitude) { updatePayload.latitude = latitude; updatePayload.longitude = longitude; }

        const { data, error } = await supabase.from('boutiques').update(updatePayload).eq('id', id).select().single();
        if (error) return res.status(400).json({ error: error.message });
        res.json({ data, geoDebug, latitude, longitude });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/plan', verifyAuthOwner, async (req, res) => {
    const { data } = await supabase.from('boutiques').select('plan').eq('id', req.params.id).single();
    const plan = data?.plan || 'essentiel';
    res.json({ plan, limits: PLAN_LIMITS[plan] || PLAN_LIMITS.essentiel });
});

// ============================================================
// CLIENTS
// ============================================================

router.get('/:id/clients', verifyAuthOwner, async (req, res) => {
    const { data, error } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false });
    if (error) return res.status(500).json({ error: "Erreur lors du chargement des clients." });
    res.json(data || []);
});

router.delete('/:id/clients/:clientId', verifyAuthOwner, async (req, res) => {
    try {
        const { data: client } = await supabase.from('clients').select('serial_number').eq('id', req.params.clientId).eq('boutique_id', req.params.id).single();
        if (!client) return res.status(404).json({ error: "Client introuvable" });

        if (client.serial_number) await supabase.from('devices').delete().eq('serial_number', client.serial_number);
        await supabase.from('visites').delete().eq('client_id', req.params.clientId);
        const { error } = await supabase.from('clients').delete().eq('id', req.params.clientId);
        if (error) throw error;

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});

router.post('/:id/clients-manuels', verifyAuthOwner, async (req, res) => {
    const { nom, telephone } = req.body;
    const boutique_id = req.params.id;
    try {
        const { data: existing } = await supabase.from('clients').select('*').eq('boutique_id', boutique_id).eq('telephone', telephone).maybeSingle();
        if (existing) return res.status(400).json({ error: "Ce numéro est déjà enregistré dans votre boutique." });

        const token = require('crypto').randomUUID();
        const { data, error } = await supabase.from('clients').insert([{
            nom, telephone, boutique_id, tampons: 0, recompenses: 0, total_historique: 0,
            token, serial_number: `NUVY-${token.split('-')[0].toUpperCase()}`,
            device_type: 'other', last_visit: new Date().toISOString()
        }]).select().single();
        if (error) throw error;
        res.json(data);
    } catch (e) { res.status(500).json({ error: "Erreur lors de la création du client." }); }
});

// ============================================================
// STATS & ANALYTICS
// ============================================================

router.get('/:id/passages-du-jour', verifyAuthOwner, async (req, res) => {
    const debut = new Date(); debut.setHours(0, 0, 0, 0);
    const { data, error } = await supabase.from('visites').select('id').eq('boutique_id', req.params.id).gte('created_at', debut.toISOString());
    if (error) return res.status(500).json({ error: "Erreur lors du comptage des passages." });
    res.json({ count: data?.length || 0 });
});

router.get('/:id/activites-du-jour', verifyAuthOwner, async (req, res) => {
    try {
        const debut = new Date(); debut.setHours(0, 0, 0, 0);
        const { data, error } = await supabase.from('visites')
            .select('created_at, points_ajoutes, clients(nom)')
            .eq('boutique_id', req.params.id)
            .gte('created_at', debut.toISOString())
            .order('created_at', { ascending: false }).limit(8);
        if (error) throw error;
        res.json(data || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/segments', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'segments');
    if (allowed !== true) return;
    try {
        const { data: clients } = await supabase.from('clients')
            .select('id, nom, telephone, tampons, recompenses, total_historique, last_visit')
            .eq('boutique_id', req.params.id);
        if (!clients || clients.length === 0) return res.json({ vip: [], reguliers: [], dormants: [] });

        const now = Date.now();
        const jour14 = 14 * 86400000, jour30 = 30 * 86400000;
        const sorted = [...clients].sort((a, b) => (b.total_historique || 0) - (a.total_historique || 0));
        const topCount = Math.max(1, Math.ceil(sorted.length * 0.1));
        const vipIds = new Set(sorted.slice(0, topCount).map(c => c.id));

        const vip = [], reguliers = [], dormants = [];
        clients.forEach(c => {
            const lastVisit = c.last_visit ? now - new Date(c.last_visit).getTime() : Infinity;
            const item = { id: c.id, nom: c.nom, telephone: c.telephone, tampons: c.tampons, recompenses: c.recompenses, total_historique: c.total_historique || 0, derniere_visite: c.last_visit };
            if (vipIds.has(c.id)) vip.push(item);
            if (lastVisit < jour14) reguliers.push(item);
            if (lastVisit > jour30 && lastVisit !== Infinity) dormants.push(item);
        });
        res.json({ vip, reguliers, dormants, total: clients.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/stats', verifyAuthOwner, async (req, res) => {
    try {
        const [{ data: visites }, { data: clients }] = await Promise.all([
            supabase.from('visites').select('created_at').eq('boutique_id', req.params.id),
            supabase.from('clients').select('tampons').eq('boutique_id', req.params.id)
        ]);
        const { data: boutique } = await supabase.from('boutiques').select('max_tampons').eq('id', req.params.id).single();
        const maxT = boutique?.max_tampons || 10;

        const peakHours = Array(24).fill(0);
        if (visites) visites.forEach(v => { peakHours[new Date(v.created_at).getHours()]++; });
        const distribution = Array(maxT + 1).fill(0);
        if (clients) clients.forEach(c => { distribution[Math.min(c.tampons || 0, maxT)]++; });

        let avgFrequency = '--';
        if (visites && visites.length > 1) {
            const sorted = visites.map(v => new Date(v.created_at).getTime()).sort((a, b) => a - b);
            const diffs = [];
            for (let i = 1; i < sorted.length; i++) diffs.push((sorted[i] - sorted[i - 1]) / 86400000);
            avgFrequency = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
        }

        const { data: allClients } = await supabase.from('clients').select('created_at').eq('boutique_id', req.params.id);
        const clientsParJour = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000).toISOString().split('T')[0];
            clientsParJour[d] = 0;
        }
        let cumul = 0;
        const allSorted = (allClients || []).map(c => c.created_at.split('T')[0]).sort();
        const cumulParJour = {};
        allSorted.forEach(d => { cumulParJour[d] = (cumulParJour[d] || 0) + 1; });
        const debutFenetre = Object.keys(clientsParJour)[0];
        allSorted.forEach(d => { if (d < debutFenetre) cumul++; });
        const evolutionLabels = [], evolutionData = [];
        Object.keys(clientsParJour).forEach(d => {
            cumul += (cumulParJour[d] || 0);
            evolutionLabels.push(d.slice(5));
            evolutionData.push(cumul);
        });

        const debutMois = new Date(); debutMois.setDate(1); debutMois.setHours(0, 0, 0, 0);
        const { data: visitesMois } = await supabase.from('visites').select('id').eq('boutique_id', req.params.id).gte('created_at', debutMois.toISOString());
        const visitesCount = visitesMois?.length || 0;
        const { data: visitesMoisDetail } = await supabase.from('visites').select('points_ajoutes').eq('boutique_id', req.params.id).gte('created_at', debutMois.toISOString());
        const tamponsMois = (visitesMoisDetail || []).reduce((acc, v) => acc + Math.max(0, v.points_ajoutes || 0), 0);

        const { data: boutiqueROI } = await supabase.from('boutiques').select('panier_moyen, valeur_tampon, roi_mode').eq('id', req.params.id).single();
        const panierMoyen = boutiqueROI?.panier_moyen || 0;
        const valeurTampon = boutiqueROI?.valeur_tampon || 0;
        const roiMode = boutiqueROI?.roi_mode || 'panier';

        res.json({
            avgFrequency, peakHours, distribution, evolutionLabels, evolutionData,
            totalClients: allClients?.length || 0,
            roi: { visitesCount, tamponsMois, panierMoyen, valeurTampon, roiMode, caParPanier: visitesCount * panierMoyen, caParTampon: tamponsMois * valeurTampon }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

router.post('/:id/push-notification', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'push_notifications');
    if (allowed !== true) return;
    const { message } = req.body;
    if (!message || message.trim() === '') return res.status(400).json({ error: "Message vide." });
    try {
        const { data: clients } = await supabase.from('clients').select('serial_number').eq('boutique_id', req.params.id);
        if (!clients || clients.length === 0) return res.json({ sent: 0 });
        const serials = clients.map(c => c.serial_number).filter(Boolean);

        await supabase.from('boutiques').update({
            last_push_message: message,
            last_push_date: new Date().toISOString()
        }).eq('id', req.params.id);

        const pushResult = await sendPushToDevices(serials);

        await supabase.from('notifications').insert([{
            boutique_id: req.params.id, message: message,
            devices_reached: pushResult.sent, created_at: new Date().toISOString()
        }]);

        const googleUpdated = await pushMessageToAllGoogleCards(req.params.id, message);

        res.json({ sent: pushResult.sent, total: pushResult.total, googleUpdated });
    } catch (e) {
        console.error("Erreur push:", e);
        res.status(500).json({ error: "Erreur lors de l'envoi." });
    }
});

router.get('/:id/push-history', verifyAuthOwner, async (req, res) => {
    const { data, error } = await supabase.from('notifications').select('*').eq('boutique_id', req.params.id).order('created_at', { ascending: false }).limit(6);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// ============================================================
// APPARENCE
// ============================================================

router.get('/:id/appearance', verifyAuthOwner, async (req, res) => {
    try {
        const { data, error } = await supabase.from('boutiques')
            .select('color_bg, color_text, color_label, strip_image_url, strip_enabled, emoji_full, emoji_empty, categorie, plan')
            .eq('id', req.params.id).single();
        if (error) throw error;
        const defaults = STEREOTYPES[data.categorie] || STEREOTYPES.default;
        const defaultSymbols = SYMBOLS[data.categorie] || SYMBOLS.default;
        const plan = data.plan || 'essentiel';
        res.json({
            colors: {
                bg: data.color_bg || defaults.bg,
                text: data.color_text || defaults.text,
                label: data.color_label || defaults.label
            },
            strip: { url: data.strip_image_url, enabled: data.strip_enabled },
            emojis: { full: data.emoji_full || defaultSymbols.full, empty: data.emoji_empty || defaultSymbols.empty },
            categorie: data.categorie, plan,
            canPersonalize: PLAN_LIMITS[plan]?.personnalisation || false
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/colors', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'personnalisation');
    if (allowed !== true) return;
    try {
        const { color_bg, color_text, color_label } = req.body;
        const hexRegex = /^#[0-9A-Fa-f]{6}$/;
        if (color_bg && !hexRegex.test(color_bg)) return res.status(400).json({ error: "Format couleur fond invalide." });
        if (color_text && !hexRegex.test(color_text)) return res.status(400).json({ error: "Format couleur texte invalide." });
        if (color_label && !hexRegex.test(color_label)) return res.status(400).json({ error: "Format couleur libellé invalide." });

        const { error } = await supabase.from('boutiques').update({ color_bg, color_text, color_label }).eq('id', req.params.id);
        if (error) throw error;
        refreshAllPasses(req.params.id);
        res.json({ success: true, message: "Couleurs mises à jour. Vos clients recevront la mise à jour visuelle dans quelques instants." });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/strip', verifyAuthOwner, uploadStrip.single('strip'), async (req, res) => {
    const allowed = await requireFeature(req, res, 'personnalisation');
    if (allowed !== true) return;
    try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });

        const baseImage = sharp(req.file.buffer).resize(1125, 369, { fit: 'cover', position: 'attention' });
        const gradientSvg = Buffer.from(`
            <svg width="1125" height="369" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
                        <stop offset="60%" stop-color="#000000" stop-opacity="0"/>
                        <stop offset="100%" stop-color="#000000" stop-opacity="0.45"/>
                    </linearGradient>
                </defs>
                <rect width="1125" height="369" fill="url(#grad)"/>
            </svg>
        `);
        const finalBuffer = await baseImage.composite([{ input: gradientSvg, blend: 'over' }]).png({ quality: 90 }).toBuffer();

        const fileName = `boutique_${req.params.id}_${Date.now()}.png`;
        const { error: upErr } = await supabase.storage.from('pass-strips').upload(fileName, finalBuffer, { contentType: 'image/png', upsert: true });
        if (upErr) throw upErr;

        const { data: pub } = supabase.storage.from('pass-strips').getPublicUrl(fileName);
        const publicUrl = pub.publicUrl;

        const { error: dbErr } = await supabase.from('boutiques').update({ strip_image_url: publicUrl, strip_enabled: true }).eq('id', req.params.id);
        if (dbErr) throw dbErr;

        refreshAllPasses(req.params.id);
        res.json({ success: true, url: publicUrl, message: "Bandeau ajouté. Mise à jour envoyée à vos clients." });
    } catch (e) {
        console.error("Erreur upload strip:", e);
        res.status(500).json({ error: e.message });
    }
});

router.patch('/:id/strip/toggle', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'personnalisation');
    if (allowed !== true) return;
    try {
        const { enabled } = req.body;
        const { error } = await supabase.from('boutiques').update({ strip_enabled: !!enabled }).eq('id', req.params.id);
        if (error) throw error;
        refreshAllPasses(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/emojis', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'personnalisation');
    if (allowed !== true) return;
    try {
        const { emoji_full, emoji_empty } = req.body;
        if (emoji_full && emoji_full.length > 8) return res.status(400).json({ error: "Emoji plein invalide." });
        if (emoji_empty && emoji_empty.length > 8) return res.status(400).json({ error: "Emoji vide invalide." });

        const { error } = await supabase.from('boutiques').update({ emoji_full, emoji_empty }).eq('id', req.params.id);
        if (error) throw error;

        refreshAllPasses(req.params.id);
        res.json({ success: true, message: "Emojis mis à jour. Vos clients recevront la mise à jour dans quelques instants." });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;