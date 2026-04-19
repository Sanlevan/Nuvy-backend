const express = require('express');
const { supabase } = require('../config');

const router = express.Router();

router.get('/:token', async (req, res) => {
    try {
        const { data: client } = await supabase.from('clients').select('user_id, nom, telephone').eq('token', req.params.token).single();
        if (!client || !client.user_id) return res.status(404).send('Compte introuvable');

        const { data: cartes } = await supabase.from('clients')
            .select('id, nom, tampons, recompenses, total_historique, last_visit, token, boutiques(nom, slug, categorie, max_tampons, logo_url, color_bg, color_text)')
            .eq('user_id', client.user_id).order('last_visit', { ascending: false });

        const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
        const totalBoutiques = cartes?.length || 0;
        const totalPoints = cartes?.reduce((acc, c) => acc + (c.total_historique || 0), 0) || 0;
        const totalCadeaux = cartes?.reduce((acc, c) => acc + (c.recompenses || 0), 0) || 0;

        const cartesHtml = (cartes || []).map(c => {
            const b = c.boutiques;
            const maxT = b?.max_tampons || 10;
            const pct = Math.min(100, Math.round(((c.tampons || 0) / maxT) * 100));
            const lastVisit = c.last_visit ? new Date(c.last_visit).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : 'Jamais';
            return `
                <div class="carte" style="border-left: 4px solid ${b?.color_text || '#2A8C9C'}">
                    <div class="carte-header">
                        ${b?.logo_url ? '<img src="' + b.logo_url + '" class="carte-logo">' : ''}
                        <div>
                            <div class="carte-nom">${b?.nom || 'Boutique'}</div>
                            <div class="carte-cat">${b?.categorie || ''}</div>
                        </div>
                    </div>
                    <div class="carte-progress"><div class="carte-bar" style="width:${pct}%; background:${b?.color_text || '#2A8C9C'}"></div></div>
                    <div class="carte-stats"><span>${c.tampons || 0} / ${maxT} tampons</span><span>${c.recompenses || 0} 🎁</span></div>
                    <div class="carte-footer"><span class="carte-visit">Dernière visite : ${lastVisit}</span><span class="carte-total">${c.total_historique || 0} pts totaux</span></div>
                </div>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Mon Compte Nuvy</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&family=Manrope:wght@400;600;800&display=swap" rel="stylesheet">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Manrope', sans-serif; background: #FAF8F5; min-height: 100vh; padding: 20px; }
    .container { max-width: 480px; margin: 0 auto; }
    .header { text-align: center; padding: 30px 0 20px; }
    .brand { font-size: 28px; font-weight: 800; color: #2A8C9C; }
    .greeting { font-size: 22px; font-weight: 800; color: #333; margin-top: 8px; }
    .subtitle { font-size: 14px; color: #888; margin-top: 4px; }
    .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 20px 0; }
    .kpi { background: white; border: 1px solid #E0DEDA; border-radius: 16px; padding: 16px; text-align: center; }
    .kpi-val { font-size: 24px; font-weight: 800; color: #333; }
    .kpi-label { font-size: 11px; color: #888; font-weight: 600; margin-top: 4px; text-transform: uppercase; }
    .section-title { font-size: 16px; font-weight: 800; color: #333; margin: 24px 0 12px; }
    .carte { background: white; border: 1px solid #E0DEDA; border-radius: 20px; padding: 20px; margin-bottom: 12px; }
    .carte-header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .carte-logo { width: 40px; height: 40px; border-radius: 10px; object-fit: cover; }
    .carte-nom { font-size: 16px; font-weight: 800; color: #333; }
    .carte-cat { font-size: 12px; color: #888; text-transform: capitalize; }
    .carte-progress { height: 8px; background: #F0EFED; border-radius: 100px; overflow: hidden; margin-bottom: 10px; }
    .carte-bar { height: 100%; border-radius: 100px; transition: width 0.5s; }
    .carte-stats { display: flex; justify-content: space-between; font-size: 14px; font-weight: 700; color: #555; }
    .carte-footer { display: flex; justify-content: space-between; margin-top: 10px; }
    .carte-visit { font-size: 11px; color: #AAA; font-weight: 600; }
    .carte-total { font-size: 11px; color: #2A8C9C; font-weight: 700; }
    .empty { text-align: center; padding: 40px 20px; color: #AAA; font-size: 14px; }
    .footer { text-align: center; padding: 30px 0; font-size: 12px; color: #CCC; }
    .footer a { color: #2A8C9C; text-decoration: none; font-weight: 700; }
</style></head><body>
<div class="container">
    <div class="header">
        <div class="brand" style="font-family: 'Bagel Fat One', cursive;">Nuvy</div>
        <div class="greeting">Bonjour ${prenom} 👋</div>
        <div class="subtitle">Votre espace fidélité</div>
    </div>
    <div class="kpis">
        <div class="kpi"><div class="kpi-val">${totalBoutiques}</div><div class="kpi-label">Boutiques</div></div>
        <div class="kpi"><div class="kpi-val">${totalPoints}</div><div class="kpi-label">Points totaux</div></div>
        <div class="kpi"><div class="kpi-val">${totalCadeaux}</div><div class="kpi-label">Cadeaux 🎁</div></div>
    </div>
    <div class="section-title">Mes cartes de fidélité</div>
    ${cartesHtml || '<div class="empty">Aucune carte de fidélité pour le moment.</div>'}
    <div class="footer">Propulsé par <a href="https://nuvy.pro">Nuvy</a></div>
</div></body></html>`;
        res.send(html);
    } catch (e) {
        console.error("Erreur mon-compte:", e);
        res.status(500).send('Erreur serveur');
    }
});

module.exports = router;