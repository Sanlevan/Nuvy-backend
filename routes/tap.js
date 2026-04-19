const express = require('express');
const crypto = require('crypto');
const { supabase, PLAN_LIMITS } = require('../config');
const { cleanString, isValidPhone } = require('../utils/validation');

const router = express.Router();

// Page "tap" NFC
router.get('/tap/:slug', async (req, res) => {
    const slug = req.params.slug;
    let reviewUrl = '';
    try {
        const { data: boutique } = await supabase.from('boutiques').select('google_review_url').eq('slug', slug).single();
        if (boutique && boutique.google_review_url) reviewUrl = boutique.google_review_url;
    } catch (e) { console.error(e); }

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Nuvy Tap</title>
        <link href="https://fonts.googleapis.com/css2?family=Bagel+Fat+One&family=Manrope:wght@600;800&display=swap" rel="stylesheet">
        <style>
            body { background: #FAF8F5; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Manrope', sans-serif; margin: 0; overflow: hidden; }
            .c { background: white; padding: 40px 30px; border-radius: 35px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.06); border: 1px solid #E0DEDA; max-width: 360px; width: 90%; transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
            .c.success { background: #111111; border-color: #111111; box-shadow: 0 30px 60px rgba(0,0,0,0.2); transform: scale(1.05); }
            .loader { border: 4px solid rgba(42,140,156,0.1); border-left-color: #2A8C9C; border-radius: 50%; width: 48px; height: 48px; animation: spin 1s linear infinite; margin: 0 auto 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .check-box { display: flex; justify-content: center; align-items: center; width: 64px; height: 64px; background: #34C759; border-radius: 50%; margin: 0 auto 20px auto; animation: popIn 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
            @keyframes popIn { 0% { transform: scale(0); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
            .check-icon { color: white; font-size: 32px; font-weight: bold; }
            h2 { font-weight: 800; margin: 0 0 8px 0; font-size: 24px; color: #2A8C9C; transition: color 0.4s; }
            .c.success h2 { color: #FFFFFF; }
            p { color: #888; font-weight: 600; margin: 0; font-size: 15px; line-height: 1.5; transition: color 0.4s; }
            .c.success p { color: #AAAAAA; }
            .btn-group { display: flex; flex-direction: column; gap: 12px; margin-top: 25px; }
            .btn { display: inline-block; background: #2A8C9C; color: white; padding: 14px 28px; border-radius: 20px; text-decoration: none; font-weight: 800; font-size: 15px; transition: transform 0.2s; }
            .c.success .btn { background: #FFFFFF; color: #111111; }
            .btn:active { transform: scale(0.95); }
            .btn-review { display: inline-block; background: #FFFFFF; color: #111111; padding: 14px 28px; border-radius: 20px; text-decoration: none; font-weight: 800; font-size: 15px; border: 2px solid #E0DEDA; transition: transform 0.2s; }
            .c.success .btn-review { background: #222222; color: #FFFFFF; border-color: #333333; }
            .btn-review:active { transform: scale(0.95); }
        </style>
    </head>
    <body>
        <div class="c" id="ui-box">
            <div id="loader-view"><div class="loader"></div><h2>Magic Tap ⚡️</h2><p>Transmission de votre carte...</p></div>
            <div id="success-view" style="display: none;">
                <div class="check-box"><span class="check-icon">✓</span></div>
                <h2>C'est validé ! 🎉</h2>
                <p>Le commerçant a bien reçu votre carte sur sa caisse.</p>
                <div class="btn-group">
                    <a href="#" id="wallet-btn" class="btn">Fermer & Voir ma carte </a>
                    ${reviewUrl ? `<a href="${reviewUrl}" target="_blank" class="btn-review">⭐ Laisser un avis Google</a>` : ''}
                </div>
            </div>
        </div>
        <script>
            const slug = '${slug}';
            const reviewUrl = '${reviewUrl}';
            const token = localStorage.getItem('nuvy_token_' + slug);
            function playDing() {
                try {
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.type = 'sine'; osc.frequency.setValueAtTime(880, audioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
                    osc.start(); gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.3);
                    osc.stop(audioCtx.currentTime + 0.3);
                } catch(e) {}
            }
            if (!token) window.location.href = '/join/' + slug;
            else {
                const isBlocked = localStorage.getItem('nuvy_blocked_' + slug);
                const navEntry = (performance.getEntriesByType('navigation')[0] || {});
                const isNewNavigation = (navEntry.type === 'navigate');
                if (isBlocked && !isNewNavigation) {
                    document.getElementById('ui-box').classList.add('success');
                    document.getElementById('loader-view').style.display = 'none';
                    document.getElementById('success-view').style.display = 'block';
                    const isAndroid = /android/i.test(navigator.userAgent);
                    const btnHref = isAndroid ? '/google-pass/' + token : '/pass/' + token;
                    const btnText = isAndroid ? "Voir sur Google Wallet" : "Voir ma carte";
                    const googleBtnHtml = reviewUrl ? '<a href="' + reviewUrl + '" target="_blank" class="btn-review">⭐ Laisser un avis Google</a>' : '';
                    document.getElementById('success-view').innerHTML = '<div style="font-size:50px;margin-bottom:15px;">✅</div><h2 style="color:#FFFFFF;">Déjà enregistré</h2><p>Présentez le badge en boutique pour un nouveau passage.</p><div class="btn-group"><a href="' + btnHref + '" class="btn">' + btnText + '</a>' + googleBtnHtml + '</div>';
                } else {
                    fetch('/tap/' + slug + '/notify?token=' + token, { method: 'POST' })
                    .then(r => {
                        if (r.status === 404) {
                            localStorage.removeItem('nuvy_token_' + slug);
                            localStorage.removeItem('nuvy_blocked_' + slug);
                            window.location.href = '/join/' + slug;
                            return;
                        }
                        if (!r.ok) throw new Error();
                        return r.json();
                    })
                    .then(data => {
                        if (!data) return;
                        const box = document.getElementById('ui-box');
                        document.getElementById('loader-view').style.display = 'none';
                        document.getElementById('success-view').style.display = 'block';
                        box.classList.add('success');
                        const isAndroid = /android/i.test(navigator.userAgent);
                        const btnText = isAndroid ? "Voir sur Google Wallet" : "Voir ma carte";
                        const btnHref = isAndroid ? '/google-pass/' + token : '/pass/' + token;
                        const googleBtnHtml = reviewUrl ? '<a href="' + reviewUrl + '" target="_blank" class="btn-review">⭐ Laisser un avis Google</a>' : '';
                        localStorage.setItem('nuvy_blocked_' + slug, '1');
                        if (data.already) {
                            document.getElementById('success-view').innerHTML = '<div style="font-size:50px;margin-bottom:15px;">✅</div><h2 style="color:#FFFFFF;">Déjà enregistré</h2><p>Présentez le badge en boutique pour un nouveau passage.</p><div class="btn-group"><a href="' + btnHref + '" class="btn">' + btnText + '</a>' + googleBtnHtml + '</div>';
                        } else {
                            playDing();
                            const btn = document.getElementById('wallet-btn');
                            btn.innerText = btnText;
                            btn.href = btnHref;
                        }
                    })
                    .catch(() => {
                        document.getElementById('ui-box').innerHTML = '<div style="font-size:50px;margin-bottom:15px;">⚠️</div><h2 style="color:#C62828;">Oups...</h2><p>Vérifiez votre connexion internet.</p>';
                    });
                }
            }
        </script>
    </body>
    </html>`;
    res.send(html);
});

// Notifier le serveur du tap NFC
// BESOIN de io depuis l'extérieur → on exporte une factory
function createTapNotifyRoute(io) {
    return async (req, res) => {
        try {
            const { data: clientData, error } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
            if (error || !clientData) return res.status(404).send();

            if (clientData.last_visit) {
                const ecart = Date.now() - new Date(clientData.last_visit).getTime();
                if (ecart < 1 * 60 * 1000) return res.json({ success: true, already: true });
            }

            await supabase.from('clients').update({ last_visit: new Date().toISOString() }).eq('id', clientData.id);

            if (!clientData.user_id) {
                const { data: u } = await supabase.from('users').select('id').eq('telephone', clientData.telephone).maybeSingle();
                if (u) await supabase.from('clients').update({ user_id: u.id }).eq('id', clientData.id);
            }

            io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', clientData);
            res.json({ success: true });
        } catch (e) {
            console.error("❌ Erreur Tap Notify:", e);
            res.status(500).send();
        }
    };
}

module.exports = { router, createTapNotifyRoute };