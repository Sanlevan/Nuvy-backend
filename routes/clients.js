const express = require('express');
const { supabase, SYMBOLS } = require('../config');
const { verifyAuth } = require('../middleware/auth');
const { sendPushToDevices } = require('../services/applePass');
const { updateGoogleWalletPass } = require('../services/googleWallet');
const { isValidInteger } = require('../utils/validation');

const router = express.Router();

router.post('/:id/tampon', verifyAuth, async (req, res) => {
    try {
        if (!isValidInteger(req.body.nb)) return res.status(400).json({ error: "Nombre de points invalide." });
        const pointsAjoutes = parseInt(req.body.nb);

        const { data: client } = await supabase.from('clients')
            .select('*, boutiques(max_tampons)')
            .eq('id', req.params.id).single();

        const maxT = client.boutiques.max_tampons || 10;

        let finalTampons = client.tampons || 0;
        let finalRecompenses = client.recompenses || 0;
        let totalHistorique = client.total_historique || 0;

        if (pointsAjoutes < 0) {
            let cadeauxARetirer = (pointsAjoutes <= -10) ? Math.abs(pointsAjoutes) / 10 : Math.abs(pointsAjoutes);
            finalRecompenses = Math.max(0, finalRecompenses - cadeauxARetirer);
        } else {
            let totalStamps = finalTampons + pointsAjoutes;
            finalTampons = totalStamps % maxT;
            finalRecompenses += Math.floor(totalStamps / maxT);
            totalHistorique += pointsAjoutes;
        }

        const { data: updatedClient } = await supabase.from('clients').update({
            tampons: finalTampons, recompenses: finalRecompenses,
            total_historique: totalHistorique, last_visit: new Date().toISOString()
        }).eq('id', req.params.id).select().single();

        await supabase.from('visites').insert([{ client_id: client.id, boutique_id: client.boutique_id, points_ajoutes: pointsAjoutes }]);

        updateGoogleWalletPass(updatedClient);

        if (client.serial_number) {
            await sendPushToDevices([client.serial_number]);
        }

        res.json(updatedClient);
    } catch (e) {
        console.error("Erreur tampon:", e);
        res.status(500).send();
    }
});

module.exports = router;