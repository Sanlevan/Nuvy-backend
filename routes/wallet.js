const express = require('express');
const { supabase, googleCredentials } = require('../config');
const { generatePassBuffer } = require('../services/applePass');
const { generateGoogleWalletLink } = require('../services/googleWallet');

const router = express.Router();

// Apple : télécharger une carte (première fois ou sur demande)
router.get('/pass/:token', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        if (!c) return res.status(404).send('Client introuvable');

        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        let rank = 1;
        if (all) all.forEach(o => { if (((o.recompenses || 0) * 10 + (o.tampons || 0)) > score) rank++; });

        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.status(200).send(buf);
    } catch (e) {
        console.error('❌ Erreur génération pass:', e);
        res.status(500).send();
    }
});

// Google Wallet : télécharger une carte
router.get('/google-pass/:token', async (req, res) => {
    try {
        const { data: client } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        if (!client || !client.boutiques) return res.status(404).send("Carte introuvable");
        if (!googleCredentials) return res.status(500).send("Google Wallet non configuré sur ce serveur.");

        const { data: allClients } = await supabase.from('clients').select('id, total_historique').eq('boutique_id', client.boutique_id);
        let vraiRang = 1;
        if (allClients) {
            const monScore = client.total_historique || 0;
            allClients.forEach(c => { if ((c.total_historique || 0) > monScore) vraiRang++; });
        }
        client._rang = vraiRang;

        const googleLink = await generateGoogleWalletLink(client, client.boutiques);
        res.redirect(googleLink);
    } catch (e) {
        console.error("❌ Erreur Google Wallet :", e.message);
        res.status(500).send("Erreur lors de la génération de la carte Android.");
    }
});

// ============================================================
// APPLE WEB SERVICES (enregistrement device, update pass, log)
// ============================================================

router.post('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    console.log(`📲 [APPLE] L'iPhone essaie de s'enregistrer...`);
    try {
        const { data: existing } = await supabase.from('devices')
            .select('id').eq('device_id', req.params.dId).eq('serial_number', req.params.sN).single();
        if (existing) {
            await supabase.from('devices').update({ push_token: req.body.pushToken }).eq('id', existing.id);
        } else {
            const { error } = await supabase.from('devices').insert([{
                device_id: req.params.dId, push_token: req.body.pushToken,
                pass_type_id: req.params.pId, serial_number: req.params.sN
            }]);
            if (error) throw error;
        }
        console.log(`✅ [APPLE] Jeton Push sauvegardé.`);
        res.status(201).send();
    } catch (e) {
        console.error("❌ [APPLE] Erreur de sauvegarde :", e.message);
        res.status(500).send();
    }
});

router.delete('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    await supabase.from('devices').delete().eq('device_id', req.params.dId).eq('serial_number', req.params.sN);
    console.log(`🗑️ [APPLE] iPhone désinscrit.`);
    res.status(200).send();
});

router.get('/v1/devices/:dId/registrations/:pId', async (req, res) => {
    const { data } = await supabase.from('devices').select('serial_number').eq('device_id', req.params.dId);
    if (data && data.length > 0) res.json({ serialNumbers: data.map(d => d.serial_number), lastUpdated: new Date().toISOString() });
    else res.status(204).send();
});

router.get('/v1/passes/:pId/:sN', async (req, res) => {
    try {
        console.log(`🔄 [APPLE] Téléchargement nouvelle carte...`);
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('serial_number', req.params.sN).single();
        if (!c) return res.status(404).send();

        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        let rank = 1;
        all.forEach(o => { if (((o.recompenses || 0) * 10 + (o.tampons || 0)) > score) rank++; });

        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Last-Modified', new Date().toUTCString());
        res.status(200).send(buf);
    } catch (e) { res.status(500).send(); }
});

router.post('/v1/log', (req, res) => {
    console.error("🍎 [APPLE ERREUR IPHONE] :", JSON.stringify(req.body));
    res.status(200).send();
});

module.exports = router;