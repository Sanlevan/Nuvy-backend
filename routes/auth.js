const express = require('express');
const bcrypt = require('bcrypt');
const { jwt, JWT_SECRET, supabase, logger } = require('../config');
const { verifyAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// Statuts qui autorisent la connexion au dashboard
// ============================================================
// active        → abonnement payé, en cours
// trialing      → période d'essai 14j active (CB enregistrée)
// past_due      → dernier prélèvement échoué, on laisse passer (souci CB temporaire)
// payment_warning → idem, échec ponctuel
// ------------------------------------------------------------
// Statuts qui REFUSENT la connexion (avec message dédié)
// ------------------------------------------------------------
// pending_payment → boutique créée mais le commerçant n'a jamais payé
// suspended       → 3 échecs consécutifs de paiement, suspendu
// canceled        → abonnement annulé volontairement
// inactive        → état terminal
// ============================================================
const STATUTS_AUTORISES = ['active', 'trialing', 'past_due', 'payment_warning'];

const MESSAGES_BLOCAGE = {
    pending_payment: "Votre boutique n'est pas encore activée. Merci de finaliser votre paiement via le lien Stripe que nous vous avons envoyé.",
    suspended: "Votre boutique est suspendue suite à plusieurs échecs de paiement. Contactez-nous à contact@nuvy.pro pour la réactiver.",
    canceled: "Votre abonnement a été annulé. Pour reprendre l'utilisation de Nuvy, contactez-nous à contact@nuvy.pro.",
    inactive: "Votre boutique est inactive. Contactez-nous à contact@nuvy.pro pour la réactiver."
};

router.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: boutique } = await supabase.from('boutiques')
        .select('id, slug, nom, max_tampons, password, plan, plan_status')
        .eq('username', user).maybeSingle();
    if (!boutique) return res.status(401).json({ error: "Identifiant incorrect." });

    const match = await bcrypt.compare(pass, boutique.password);
    if (!match) return res.status(401).json({ error: "Mot de passe incorrect." });

    // ============================================================
    // Vérification du statut d'abonnement Stripe
    // ============================================================
    const status = boutique.plan_status || 'pending_payment';
    if (!STATUTS_AUTORISES.includes(status)) {
        const message = MESSAGES_BLOCAGE[status] || "Votre boutique n'est pas accessible actuellement. Contactez contact@nuvy.pro.";
        if (logger) logger.warn(`Connexion refusée pour ${user} : statut ${status}`);
        return res.status(403).json({
            error: message,
            plan_status: status,
            blocked: true
        });
    }

    // Connexion autorisée
    const authToken = jwt.sign(
        { boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom },
        JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
        boutiqueId: boutique.id,
        slug: boutique.slug,
        nom: boutique.nom,
        maxTampons: boutique.max_tampons,
        plan: boutique.plan || 'essentiel',
        plan_status: status,
        token: authToken
    });
});

router.post('/change-password', verifyAuth, async (req, res) => {
    const { boutiqueId, oldPassword, newPassword } = req.body;
    try {
        const { data: boutique } = await supabase.from('boutiques').select('password').eq('id', boutiqueId).single();
        const match = await bcrypt.compare(oldPassword, boutique.password);
        if (!match) return res.status(401).json({ error: "L'ancien mot de passe est incorrect." });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await supabase.from('boutiques').update({ password: hashedPassword }).eq('id', boutiqueId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Erreur lors du changement de mot de passe." }); }
});

module.exports = router;