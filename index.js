const { logger, jwt, MASTER_CEO_KEY, JWT_SECRET, googleCredentials, GOOGLE_ISSUER_ID, supabase, STEREOTYPES, SYMBOLS, PLAN_LIMITS } = require('./config');
const { generatePassBuffer, refreshAllPasses, sendPushToDevices } = require('./services/applePass');
const { generateGoogleWalletLink, updateGoogleWalletPass, pushMessageToAllGoogleCards } = require('./services/googleWallet');
const adminRouter = require('./routes/admin');
const reseauxRouter = require('./routes/reseaux');
const express = require('express');
const { PKPass } = require('passkit-generator');
const apn = require('@parse/node-apn');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');
const http = require('http');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const { uploadStrip } = require('./config');
const boutiquesRouter = require('./routes/boutiques');
const clientsRouter = require('./routes/clients');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ["https://nuvy.pro", "https://nuvy-production.up.railway.app"] } });

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));
app.use('/admin', adminRouter);
app.use('/', reseauxRouter);
app.use('/boutiques', boutiquesRouter);
app.use('/clients', clientsRouter);

const limiterStrict = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: "Trop de requêtes. Réessayez dans quelques minutes." }
});
const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});
const authRouter = require('./routes/auth');
app.use('/auth', limiterLogin, authRouter);


// ==========================================
// 🛡️ UTILITAIRES DE VALIDATION
// ==========================================
const { cleanString, isValidPhone, isValidInteger } = require('./utils/validation');
// ==========================================
// 🛡️ MIDDLEWARE D'AUTHENTIFICATION JWT
// ==========================================
const { verifyAuth, verifyAuthOwner, requireFeature } = require('./middleware/auth');

// ==========================================
// ROUTES : AFFICHAGE DES PAGES HTML
// ==========================================
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
// ==========================================
// ROUTES LÉGALES (RGPD / LCEN)
// ==========================================
app.get('/cgv', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'cgv.html')));
app.get('/cgu', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'cgu.html')));
app.get('/confidentialite', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'confidentialite.html')));
app.get('/mentions-legales', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'mentions-legales.html')));
app.get('/join/:slug', async (req, res) => {
    const { data: boutique } = await supabase.from('boutiques').select('nom, slug, categorie, logo_url, color_bg, color_text').eq('slug', req.params.slug).single();
    if (!boutique) return res.status(404).send('Boutique introuvable');
    
    const html = fs.readFileSync(path.resolve(__dirname, 'join.html'), 'utf8');
    const safeJson = JSON.stringify(boutique).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const injected = html.replace('</head>', `<script>window.__BOUTIQUE__=${safeJson};</script></head>`);
    res.send(injected);
});

// ==========================================
// 🔐 SÉCURITÉ CEO (SOURCE DE VÉRITÉ UNIQUE)
// ==========================================

// 1. Route pour la page de Login
app.get('/admin-login', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'admin-login.html'));
});

// 2. Route pour le Dashboard Web
app.get('/nuvy-ceo-portal', (req, res) => {
    const key = req.query.key;
    if (key !== MASTER_CEO_KEY) {
        return res.redirect('/admin-login?error=1');
    }
    res.sendFile(path.resolve(__dirname, 'admin.html'));
});

// NOTIFICATION PUSH MARKETING (COMMERÇANT)
app.post('/boutiques/:id/push-notification', verifyAuthOwner, async (req, res) => {
    const allowed = await requireFeature(req, res, 'push_notifications');
    if (allowed !== true) return; // La réponse 403 a déjà été envoyée
    
    const { message } = req.body;
    if (!message || message.trim() === '') return res.status(400).json({ error: "Message vide." });
    
    try {
        // 1. Sauvegarder le message sur la boutique AVANT d'envoyer le push
        await supabase.from('boutiques').update({ 
            last_push_message: message, 
            last_push_date: new Date().toISOString() 
        }).eq('id', req.params.id);

        // 2. Récupérer les clients et envoyer le push Apple via le NOUVEAU service
        const { data: clients } = await supabase.from('clients').select('serial_number').eq('boutique_id', req.params.id);
        let sent = 0;
        let total = 0;

        if (clients && clients.length > 0) {
            const serials = clients.map(c => c.serial_number).filter(Boolean);
            // On utilise la fonction sendPushToDevices que tu as importée à l'étape 2
            const pushResult = await sendPushToDevices(serials);
            sent = pushResult.sent || 0;
            total = pushResult.total || 0;
        }
        
        // 3. Sauvegarder la notification en base
        await supabase.from('notifications').insert([{
            boutique_id: req.params.id,
            message: message,
            devices_reached: sent,
            created_at: new Date().toISOString()
        }]);
        
        // 4. Mise à jour des cartes Google Wallet via le NOUVEAU service
        let googleUpdated = 0;
        if (googleCredentials) {
            googleUpdated = await pushMessageToAllGoogleCards(req.params.id, message);
        } // <-- Le bug était ici, il n'y a plus qu'une seule accolade maintenant !

        res.json({ sent, total: total, googleUpdated });
        
    } catch (e) {
        console.error("Erreur push:", e);
        res.status(500).json({ error: "Erreur lors de l'envoi." });
    }
});

// ==========================================
// LE TAP NFC (EXPÉRIENCE PREMIUM)
// ==========================================
app.get('/tap/:slug', async (req, res) => {
    const slug = req.params.slug;
    
    // 🌟 NOUVEAU : On récupère le lien d'avis Google de la boutique
    let reviewUrl = '';
    try {
        const { data: boutique } = await supabase.from('boutiques').select('google_review_url').eq('slug', slug).single();
        if (boutique && boutique.google_review_url) {
            reviewUrl = boutique.google_review_url;
        }
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
            
            /* 🌟 NOUVEAU STYLE : Bouton Google */
            .btn-review { display: inline-block; background: #FFFFFF; color: #111111; padding: 14px 28px; border-radius: 20px; text-decoration: none; font-weight: 800; font-size: 15px; border: 2px solid #E0DEDA; transition: transform 0.2s; }
            .c.success .btn-review { background: #222222; color: #FFFFFF; border-color: #333333; }
            .btn-review:active { transform: scale(0.95); }
        </style>
    </head>
    <body>
        <div class="c" id="ui-box">
            <div id="loader-view">
                <div class="loader"></div>
                <h2>Magic Tap ⚡️</h2>
                <p>Transmission de votre carte...</p>
            </div>
            <div id="success-view" style="display: none;">
                <div class="check-box"><span class="check-icon">✓</span></div>
                <h2>C'est validé ! 🎉</h2>
                <p>Le commerçant a bien reçu votre carte sur sa caisse.</p>
                <div class="btn-group">
                    <a href="#" id="wallet-btn" class="btn">Fermer & Voir ma carte </a>
                    ${reviewUrl ? `<a href="${reviewUrl}" target="_blank" class="btn-review">⭐ Laisser un avis Google</a>` : ''}
                </div>
            </div>
        </div>
        
        <script>
            const slug = '${slug}';
            const reviewUrl = '${reviewUrl}'; // Injecté depuis NodeJS
            const token = localStorage.getItem('nuvy_token_' + slug);
            
            function playDing() {
                try {
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.type = 'sine'; 
                    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
                    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
                    osc.start(); 
                    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.3);
                    osc.stop(audioCtx.currentTime + 0.3);
                } catch(e) {}
            }

            if (!token) {
                window.location.href = '/join/' + slug;
            } else {
                const isBlocked = localStorage.getItem('nuvy_blocked_' + slug);
                const navEntry = (performance.getEntriesByType('navigation')[0] || {});
                const isNewNavigation = (navEntry.type === 'navigate');

                if (isBlocked && !isNewNavigation) {
                    // REFRESH ou RETOUR ONGLET → page morte
                    document.getElementById('ui-box').classList.add('success');
                    document.getElementById('loader-view').style.display = 'none';
                    document.getElementById('success-view').style.display = 'block';
                    const isAndroid = /android/i.test(navigator.userAgent);
                    const btnHref = isAndroid ? '/google-pass/' + token : '/pass/' + token;
                    const btnText = isAndroid ? "Voir sur Google Wallet" : "Voir ma carte";
                    const googleBtnHtml = reviewUrl ? '<a href="' + reviewUrl + '" target="_blank" class="btn-review">⭐ Laisser un avis Google</a>' : '';
                    document.getElementById('success-view').innerHTML = '<div style="font-size:50px;margin-bottom:15px;">✅</div><h2 style="color:#FFFFFF;">Déjà enregistré</h2><p>Présentez le badge en boutique pour un nouveau passage.</p><div class="btn-group"><a href="' + btnHref + '" class="btn">' + btnText + '</a>' + googleBtnHtml + '</div>';
                } else {
                    // NOUVEAU TAP NFC (navigate) ou premier passage → on demande au serveur
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

                        // On verrouille dans tous les cas
                        localStorage.setItem('nuvy_blocked_' + slug, '1');

                        if (data.already) {
                            document.getElementById('success-view').innerHTML = '<div style="font-size:50px;margin-bottom:15px;">✅</div><h2 style="color:#FFFFFF;">Déjà enregistré</h2><p>Présentez le badge en boutique pour un nouveau passage.</p><div class="btn-group"><a href="' + btnHref + '" class="btn">' + btnText + '</a>' + googleBtnHtml + '</div>';
                        } else {
                            playDing();
                            const btn = document.getElementById('wallet-btn');
                            if (isAndroid) {
                                btn.innerText = "Voir sur Google Wallet";
                                btn.href = '/google-pass/' + token;
                            } else {
                                btn.innerText = "Voir ma carte";
                                btn.href = '/pass/' + token;
                            }
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

app.post('/tap/:slug/notify', limiterStrict, async (req, res) => {
    try {
        const { data: clientData, error } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
        
        if (error || !clientData) { 
            return res.status(404).send();
        }
        if (clientData) {
            // ⏱️ COOLDOWN SERVEUR : bloquer si dernier passage < 3 minutes
            if (clientData.last_visit) {
                const ecart = Date.now() - new Date(clientData.last_visit).getTime();
                if (ecart < 1 * 60 * 1000) {
                    return res.json({ success: true, already: true });
                }
            }

            // 🌟 1. On met à jour l'heure de visite pour remonter le client dans la liste du Dashboard !
            await supabase.from('clients').update({ last_visit: new Date().toISOString() }).eq('id', clientData.id);

            // Rattacher au user si pas encore fait
            if (!clientData.user_id) {
                const { data: u } = await supabase.from('users').select('id').eq('telephone', clientData.telephone).maybeSingle();
                if (u) await supabase.from('clients').update({ user_id: u.id }).eq('id', clientData.id);
            }
            
            // 🌟 2. On fait "popper" la carte sur le Dashboard Commerçant !
            io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', clientData); // Flag pour débloquer le prochain tap côté client
            res.json({ success: true }); 
        } else {
            res.status(404).send();
        }
    } catch (e) {
        console.error("❌ Erreur Tap Notify:", e);
        res.status(500).send();
    }
});

// ==========================================
// DISTRIBUTION WALLET & INSCRIPTION
// ==========================================
app.get('/pass/:token', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        if (!c) return res.status(404).send('Client introuvable');
        
        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        let rank = 1;
        if (all) all.forEach(o => { if (((o.recompenses||0)*10 + (o.tampons||0)) > score) rank++; });
        
        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        
        // 🛡️ CORRECTIONS SAFARI (Pas de téléchargement forcé)
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

// PAGE "MON COMPTE" NUVY (IDENTITÉ UNIVERSELLE)
app.get('/mon-compte/:token', async (req, res) => {
    try {
        // On retrouve le client via son token
        const { data: client } = await supabase.from('clients').select('user_id, nom, telephone').eq('token', req.params.token).single();
        if (!client || !client.user_id) return res.status(404).send('Compte introuvable');

        // On récupère TOUTES les cartes de fidélité de ce user
        const { data: cartes } = await supabase.from('clients')
            .select('id, nom, tampons, recompenses, total_historique, last_visit, token, boutiques(nom, slug, categorie, max_tampons, logo_url, color_bg, color_text)')
            .eq('user_id', client.user_id)
            .order('last_visit', { ascending: false });

        const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
        const totalBoutiques = cartes?.length || 0;
        const totalPoints = cartes?.reduce((acc, c) => acc + (c.total_historique || 0), 0) || 0;
        const totalCadeaux = cartes?.reduce((acc, c) => acc + (c.recompenses || 0), 0) || 0;

        const cartesHtml = (cartes || []).map(c => {
            const b = c.boutiques;
            const maxT = b?.max_tampons || 10;
            const pct = Math.min(100, Math.round(((c.tampons || 0) / maxT) * 100));
            const lastVisit = c.last_visit ? new Date(c.last_visit).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) : 'Jamais';
            const isAndroid = ''; // Sera détecté côté client
            return `
                <div class="carte" style="border-left: 4px solid ${b?.color_text || '#2A8C9C'}">
                    <div class="carte-header">
                        ${b?.logo_url ? '<img src="' + b.logo_url + '" class="carte-logo">' : ''}
                        <div>
                            <div class="carte-nom">${b?.nom || 'Boutique'}</div>
                            <div class="carte-cat">${b?.categorie || ''}</div>
                        </div>
                    </div>
                    <div class="carte-progress">
                        <div class="carte-bar" style="width:${pct}%; background:${b?.color_text || '#2A8C9C'}"></div>
                    </div>
                    <div class="carte-stats">
                        <span>${c.tampons || 0} / ${maxT} tampons</span>
                        <span>${c.recompenses || 0} 🎁</span>
                    </div>
                    <div class="carte-footer">
                        <span class="carte-visit">Dernière visite : ${lastVisit}</span>
                        <span class="carte-total">${c.total_historique || 0} pts totaux</span>
                    </div>
                </div>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mon Compte Nuvy</title>
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
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="brand" style="font-family: 'Bagel Fat One', cursive;">Nuvy</div>
            <div class="greeting">Bonjour ${prenom} 👋</div>
            <div class="subtitle">Votre espace fidélité</div>
        </div>
        <div class="kpis">
            <div class="kpi">
                <div class="kpi-val">${totalBoutiques}</div>
                <div class="kpi-label">Boutiques</div>
            </div>
            <div class="kpi">
                <div class="kpi-val">${totalPoints}</div>
                <div class="kpi-label">Points totaux</div>
            </div>
            <div class="kpi">
                <div class="kpi-val">${totalCadeaux}</div>
                <div class="kpi-label">Cadeaux 🎁</div>
            </div>
        </div>
        <div class="section-title">Mes cartes de fidélité</div>
        ${cartesHtml || '<div class="empty">Aucune carte de fidélité pour le moment.</div>'}
        <div class="footer">Propulsé par <a href="https://nuvy.pro">Nuvy</a></div>
    </div>
</body>
</html>`;
        res.send(html);
    } catch (e) {
        console.error("Erreur mon-compte:", e);
        res.status(500).send('Erreur serveur');
    }
});

// TRACKING : Compteur de visiteurs page join
app.post('/join/:slug/visit', limiterStrict, async (req, res) => {
    try {
        const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();
        if (!b) return res.status(404).send();
        await supabase.from('page_visits').insert([{ boutique_id: b.id, page: 'join' }]);
        res.json({ ok: true });
    } catch (e) { res.status(500).send(); }
});

app.post('/join/:slug/create', limiterStrict, async (req, res) => {
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
        
        // Guard : limite de clients par plan
        const plan = b?.plan || 'essentiel';
        const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.essentiel;
        if (limits.max_clients !== Infinity) {
            const { count } = await supabase.from('clients').select('id', { count: 'exact', head: true }).eq('boutique_id', b.id);
            if (count >= limits.max_clients) {
                return res.status(403).json({ error: `Cette boutique a atteint sa limite de ${limits.max_clients} clients. Le commerçant doit passer au plan supérieur.` });
            }
        }

        // 1. LE DÉTECTEUR : Est-ce que ce numéro existe déjà dans CETTE pizzeria ?
        const { data: existingClient } = await supabase
            .from('clients')
            .select('*')
            .eq('telephone', telephone)
            .eq('boutique_id', b.id)
            .maybeSingle(); 

        if (existingClient) {
            // SCÉNARIO A : LA CLIENTE REVIENT !
            // 🌟 MAGIE : On met à jour sa visite et on fait sonner le dashboard !
            await supabase.from('clients').update({ last_visit: new Date().toISOString() }).eq('id', existingClient.id);
            io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', existingClient);
            return res.json({ token: existingClient.token });
        }

        // Rattachement au compte Nuvy universel
        let userId = null;
        const { data: existingUser } = await supabase.from('users').select('id').eq('telephone', telephone).maybeSingle();
        if (existingUser) {
            userId = existingUser.id;
        } else {
            const { data: newUser } = await supabase.from('users').insert([{
                telephone,
                prenom,
                nom
            }]).select().single();
            if (newUser) userId = newUser.id;
        }

        // SCÉNARIO B : NOUVEAU CLIENT
        const token = crypto.randomUUID();
        const ua = req.headers['user-agent'] || '';
        const device_type = /iphone|ipad|ipod/i.test(ua) ? 'ios' : /android/i.test(ua) ? 'android' : 'other';
        
        const { data } = await supabase.from('clients').insert([{
            boutique_id: b.id,
            nom: `${prenom} ${nom}`,
            telephone,
            tampons: 0,
            recompenses: 0,
            token,
            serial_number: `NUVY-${token.split('-')[0].toUpperCase()}`,
            user_id: userId,
            last_visit: new Date().toISOString(),
            device_type,
            consent_given_at: consentGivenAt,
            consent_version: consentVersion,
        }]).select().single();
        
        // 🌟 MAGIE : Le nouveau client fait sonner le dashboard immédiatement !
        io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', data);
        res.json({ token: data.token });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTE : GÉNÉRER LA CARTE GOOGLE WALLET ---
app.get('/google-pass/:token', async (req, res) => {
    try {
        // 1. On cherche le client par son token UUID (comme pour Apple)
        const { data: client } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        
        if (!client || !client.boutiques) return res.status(404).send("Carte introuvable");

        // 2. On vérifie que les credentials Google sont disponibles
        if (!googleCredentials) {
            return res.status(500).send("Google Wallet non configuré sur ce serveur.");
        }

        // 3. Calcul du rang
        const { data: allClients } = await supabase.from('clients').select('id, total_historique').eq('boutique_id', client.boutique_id);
        let vraiRang = 1;
        if (allClients) {
            const monScore = client.total_historique || 0;
            allClients.forEach(c => { if ((c.total_historique || 0) > monScore) vraiRang++; });
        }
        client._rang = vraiRang;

        // 4. On génère le lien magique
        const googleLink = generateGoogleWalletLink(client, client.boutiques);

        // 4. On redirige le client vers l'application Google Wallet !
        res.redirect(googleLink);
        
    } catch (e) {
        console.error("❌ Erreur Google Wallet :", e.message);
        res.status(500).send("Erreur lors de la génération de la carte Android.");
    }
});

// ==========================================
// WEB SERVICES APPLE (ÉCOUTE ET MISES À JOUR)
// ==========================================
app.post('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    console.log(`📲 [APPLE] L'iPhone essaie de s'enregistrer...`);
    try {
        // Méthode 100% sûre : On cherche d'abord, puis on met à jour ou on insère
        const { data: existing } = await supabase.from('devices')
            .select('id').eq('device_id', req.params.dId).eq('serial_number', req.params.sN).single();

        if (existing) {
            await supabase.from('devices').update({ push_token: req.body.pushToken }).eq('id', existing.id);
        } else {
            const { error } = await supabase.from('devices').insert([{ 
                device_id: req.params.dId, 
                push_token: req.body.pushToken, 
                pass_type_id: req.params.pId, 
                serial_number: req.params.sN 
            }]);
            if (error) throw error;
        }
        console.log(`✅ [APPLE] Jeton Push sauvegardé avec succès dans Supabase !`);
        res.status(201).send();
    } catch (e) {
        console.error("❌ [APPLE] Erreur fatale de sauvegarde :", e.message);
        res.status(500).send();
    }
});

app.delete('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    await supabase.from('devices').delete().eq('device_id', req.params.dId).eq('serial_number', req.params.sN);
    console.log(`🗑️ [APPLE] iPhone désinscrit.`);
    res.status(200).send();
});

app.get('/v1/devices/:dId/registrations/:pId', async (req, res) => {
    const { data } = await supabase.from('devices').select('serial_number').eq('device_id', req.params.dId);
    if (data && data.length > 0) res.json({ serialNumbers: data.map(d => d.serial_number), lastUpdated: new Date().toISOString() });
    else res.status(204).send();
});

app.get('/v1/passes/:pId/:sN', async (req, res) => {
    try {
        console.log(`🔄 [APPLE] L'iPhone télécharge la nouvelle carte...`);
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('serial_number', req.params.sN).single();
        if(!c) return res.status(404).send();
        
        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        let rank = 1; all.forEach(o => { if(((o.recompenses||0)*10 + (o.tampons||0)) > score) rank++; });
        
        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Last-Modified', new Date().toUTCString()); 
        res.status(200).send(buf);
    } catch (e) { res.status(500).send(); }
});

app.post('/v1/log', (req, res) => {
    console.error("🍎 [APPLE ERREUR IPHONE] :", JSON.stringify(req.body));
    res.status(200).send();
});

// ==========================================
// SOCKET.IO (TEMPS RÉEL DASHBOARD)
// ==========================================
io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => { socket.join(slug.toLowerCase().trim()); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`=== MOTEUR NUVY PRÊT SUR LE PORT ${PORT} ===`));
