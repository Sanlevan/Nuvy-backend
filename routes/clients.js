const express = require('express');
const { supabase, SYMBOLS } = require('../config');
const { verifyAuth } = require('../middleware/auth');
const { sendPushToDevices, sendAlertToDevices} = require('../services/applePass');
const { updateGoogleWalletPass, pushMessageToSingleGoogleCard } = require('../services/googleWallet');
const { isValidInteger } = require('../utils/validation');

const router = express.Router();

// ============================================================
// Templates de notification de relance
// ============================================================
const RELANCE_TEMPLATES = [
    {
        id: 'on_vous_attend',
        label: 'On vous attend',
        message: 'Ça fait un moment qu\'on ne vous a pas vu ! Revenez nous rendre visite 😊'
    },
    {
        id: 'recompense',
        label: 'Récompense disponible',
        message: 'Votre carte de fidélité vous attend. Revenez profiter de vos avantages 🎁'
    },
    {
        id: 'offre_speciale',
        label: 'Offre spéciale',
        message: 'Offre spéciale cette semaine ! On vous réserve une belle surprise 🎉'
    }
];

// ============================================================
// GET /clients/notify-templates
// Retourne les templates disponibles (utilisé par le dashboard)
// ============================================================
router.get('/notify-templates', verifyAuth, (req, res) => {
    res.json(RELANCE_TEMPLATES);
});

// ============================================================
// POST /clients/:id/tampon
// ============================================================
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

        await supabase.from('visites').insert([{
            client_id: client.id,
            boutique_id: client.boutique_id,
            points_ajoutes: pointsAjoutes
        }]);

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

router.post('/:id/notify', verifyAuth, async (req, res) => {
    try {
        const { message } = req.body;
        const boutiqueId = req.boutiqueId;

        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: "Le message ne peut pas être vide." });
        }
        if (message.trim().length > 200) {
            return res.status(400).json({ error: "Le message ne peut pas dépasser 200 caractères." });
        }

        // 1. Récupérer le client + vérifier appartenance boutique
        const { data: client, error: clientError } = await supabase
            .from('clients')
            .select('id, nom, serial_number, device_type, boutique_id')
            .eq('id', req.params.id)
            .eq('boutique_id', boutiqueId)
            .maybeSingle();

        if (clientError || !client) {
            return res.status(404).json({ error: "Client introuvable." });
        }

        if (!client.serial_number) {
            return res.status(422).json({
                error: "Ce client n'a pas de carte Wallet enregistrée.",
                notifiable: false
            });
        }

        let devicesReached = 0;
        let channel = null;

        // ============================================================
        // iOS — APNs avec message texte visible
        // ============================================================
        if (client.device_type === 'ios') {
            const { data: devices } = await supabase
                .from('devices')
                .select('push_token')
                .eq('serial_number', client.serial_number);

            const tokensActifs = devices?.filter(d => d.push_token) || [];

            if (tokensActifs.length === 0) {
                return res.status(422).json({
                    error: "Ce client a désactivé les notifications sur son appareil.",
                    notifiable: false
                });
            }

            // sendAlertToDevices = message visible dans le centre de notifications
            await sendAlertToDevices([client.serial_number], message.trim());
            devicesReached = tokensActifs.length;
            channel = 'apple';
        }

        // ============================================================
        // Android — Google Wallet message (bandeau sur la carte)
        // ============================================================
        else if (client.device_type === 'android') {
            const result = await pushMessageToSingleGoogleCard(client.serial_number, message.trim());
            if (!result.success) {
                return res.status(422).json({
                    error: "Impossible d'envoyer le message sur cette carte Google Wallet.",
                    notifiable: false,
                    detail: result.reason
                });
            }
            devicesReached = 1;
            channel = 'google';
        }

        // Autres (device_type = 'other' ou null) → non joignable
        else {
            return res.status(422).json({
                error: "Ce client n'est pas joignable par notification.",
                notifiable: false
            });
        }

        // 5. Logger dans notifications
        await supabase.from('notifications').insert([{
            boutique_id: boutiqueId,
            message: `[Relance ${channel === 'apple' ? 'iOS' : 'Android'} → ${client.nom}] ${message.trim()}`,
            devices_reached: devicesReached,
            created_at: new Date().toISOString()
        }]);

        res.json({
            success: true,
            client_nom: client.nom,
            devices_reached: devicesReached,
            channel
        });

    } catch (e) {
        console.error("Erreur notify client individuel:", e);
        res.status(500).json({ error: "Erreur serveur lors de l'envoi de la notification." });
    }
});

module.exports = router;