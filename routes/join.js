const express = require('express');
const crypto = require('crypto');
const { supabase, PLAN_LIMITS } = require('../config');
const { cleanString, isValidPhone } = require('../utils/validation');

const router = express.Router();

function createJoinRoutes(io) {
    const path = require('path');
    const fs = require('fs');

    router.get('/:slug', async (req, res) => {
        const { data: boutique } = await supabase.from('boutiques').select('nom, slug, categorie, logo_url, color_bg, color_text').eq('slug', req.params.slug).single();
        if (!boutique) return res.status(404).send('Boutique introuvable');
        const html = fs.readFileSync(path.resolve(__dirname, '..', 'join.html'), 'utf8');
        const safeJson = JSON.stringify(boutique).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
        const injected = html.replace('</head>', `<script>window.__BOUTIQUE__=${safeJson};</script></head>`);
        res.send(injected);
    });

    router.post('/:slug/visit', async (req, res) => {
        try {
            const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();
            if (!b) return res.status(404).send();
            await supabase.from('page_visits').insert([{ boutique_id: b.id, page: 'join' }]);
            res.json({ ok: true });
        } catch (e) { res.status(500).send(); }
    });

    router.post('/:slug/create', async (req, res) => {
        try {
            const prenom = cleanString(req.body.prenom, 50);
            const nom = cleanString(req.body.nom, 50);
            const telephone = cleanString(req.body.telephone, 20);
            const consentVersion = cleanString(req.body.consent_version, 20);
            const consentGivenAt = req.body.consent_given_at;

            if (!prenom || !nom || !telephone) return res.status(400).json({ error: "Tous les champs sont obligatoires." });
            if (!isValidPhone(telephone)) return res.status(400).json({ error: "Numéro de téléphone invalide." });
            if (!consentVersion || !consentGivenAt) return res.status(400).json({ error: "Consentement RGPD requis." });

            const { data: b } = await supabase.from('boutiques').select('id, plan').eq('slug', req.params.slug).single();
            const plan = b?.plan || 'essentiel';
            const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.essentiel;
            if (limits.max_clients !== Infinity) {
                const { count } = await supabase.from('clients').select('id', { count: 'exact', head: true }).eq('boutique_id', b.id);
                if (count >= limits.max_clients) return res.status(403).json({ error: `Cette boutique a atteint sa limite de ${limits.max_clients} clients.` });
            }

            const { data: existingClient } = await supabase.from('clients')
                .select('*').eq('telephone', telephone).eq('boutique_id', b.id).maybeSingle();

            if (existingClient) {
                await supabase.from('clients').update({ last_visit: new Date().toISOString() }).eq('id', existingClient.id);
                io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', existingClient);
                return res.json({ token: existingClient.token });
            }

            let userId = null;
            const { data: existingUser } = await supabase.from('users').select('id').eq('telephone', telephone).maybeSingle();
            if (existingUser) userId = existingUser.id;
            else {
                const { data: newUser } = await supabase.from('users').insert([{ telephone, prenom, nom }]).select().single();
                if (newUser) userId = newUser.id;
            }

            const token = crypto.randomUUID();
            const ua = req.headers['user-agent'] || '';
            const device_type = /iphone|ipad|ipod/i.test(ua) ? 'ios' : /android/i.test(ua) ? 'android' : 'other';

            const { data } = await supabase.from('clients').insert([{
                boutique_id: b.id, nom: `${prenom} ${nom}`, telephone,
                tampons: 0, recompenses: 0, token,
                serial_number: `NUVY-${token.split('-')[0].toUpperCase()}`,
                user_id: userId, last_visit: new Date().toISOString(),
                device_type, consent_given_at: consentGivenAt, consent_version: consentVersion,
            }]).select().single();

            io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', data);
            res.json({ token: data.token });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    return router;
}

module.exports = createJoinRoutes;