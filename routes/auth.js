const express = require('express');
const bcrypt = require('bcrypt');
const { jwt, JWT_SECRET, supabase } = require('../config');
const { verifyAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: boutique } = await supabase.from('boutiques')
        .select('id, slug, nom, max_tampons, password, plan')
        .eq('username', user).maybeSingle();
    if (!boutique) return res.status(401).json({ error: "Identifiant incorrect." });

    const match = await bcrypt.compare(pass, boutique.password);
    if (match) {
        const authToken = jwt.sign(
            { boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom },
            JWT_SECRET, { expiresIn: '7d' }
        );
        res.json({
            boutiqueId: boutique.id, slug: boutique.slug, nom: boutique.nom,
            maxTampons: boutique.max_tampons, plan: boutique.plan || 'essentiel', token: authToken
        });
    } else { res.status(401).json({ error: "Mot de passe incorrect." }); }
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