require('dotenv').config();
console.log("=== NUVY MASTER ENGINE V1.0 (PRODUCTION) - 2026 ===");

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { PKPass } = require('passkit-generator');
const apn = require('apn');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');
const http = require('http');
const sharp = require('sharp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

const STEREOTYPES = {
    default:     { bg: "#FAF8F5", text: "#2A8C9C", label: "#AFE3E0" },
    boulangerie: { bg: "#FAF0E6", text: "#8B4513", label: "#CD853F" },
    pizza:       { bg: "#FFFAFA", text: "#CD5C5C", label: "#FFA07A" },
    onglerie:    { bg: "#FFF0F5", text: "#C71585", label: "#FFB6C1" },
    coiffeur:    { bg: "#F8F8F8", text: "#191970", label: "#B0C4DE" },
    cafe:        { bg: "#F5F5DC", text: "#4B3621", label: "#A0522D" }
};
const SYMBOLS = {
    pizza:       { full: "🍕", empty: "◽" },
    onglerie:    { full: "💅", empty: "⚪" },
    cafe:        { full: "☕", empty: "▫️" },
    boulangerie: { full: "🥐", empty: "◽" },
    coiffeur:    { full: "✂️", empty: "▫️" },
    default:     { full: "●",  empty: "○" }
};
const getCert = (envVar, fileName) => {
    if (process.env[envVar]) return Buffer.from(process.env[envVar], 'base64');
    const p = path.resolve(__dirname, fileName);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
const WWDR = getCert('WWDR_CERT', 'WWDR-pem.pem');
const signerCert = getCert('SIGNER_CERT', 'signer-clean.pem');
const signerKey = getCert('SIGNER_KEY', 'nuvy-pass.key');

async function generatePassBuffer(client, boutique, clientRank, hostUrl) {
    const modelPath = path.resolve(__dirname, 'pass-model.pass');
    const tmpDir = path.join('/tmp', 'gen-' + crypto.randomBytes(4).toString('hex') + '.pass');
    
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)));
    
    if (boutique.logo_url && boutique.logo_url.trim() !== "") {
        try {
            const response = await fetch(boutique.logo_url);
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                
                // 🛡️ TRAITEMENT 100% EN MÉMOIRE (Évite les fichiers corrompus ou carrés blancs)
                // On a retiré "trim()" qui détruisait les JPG. On redimensionne direct.
                const logo3x = await sharp(buffer).resize(480, 150, { fit: 'inside' }).png().toBuffer();
                const logo2x = await sharp(buffer).resize(320, 100, { fit: 'inside' }).png().toBuffer();
                const logo1x = await sharp(buffer).resize(160, 50,  { fit: 'inside' }).png().toBuffer();
                
                const icon3x = await sharp(buffer).resize(87, 87, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                const icon2x = await sharp(buffer).resize(58, 58, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                const icon1x = await sharp(buffer).resize(29, 29, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                
                // 💾 Écriture sécurisée une fois que tout est généré
                fs.writeFileSync(path.join(tmpDir, 'logo@3x.png'), logo3x);
                fs.writeFileSync(path.join(tmpDir, 'logo@2x.png'), logo2x);
                fs.writeFileSync(path.join(tmpDir, 'logo.png'), logo1x);
                fs.writeFileSync(path.join(tmpDir, 'icon@3x.png'), icon3x);
                fs.writeFileSync(path.join(tmpDir, 'icon@2x.png'), icon2x);
                fs.writeFileSync(path.join(tmpDir, 'icon.png'), icon1x);
                
                console.log(`✅ Images Wallet générées avec succès pour : ${boutique.nom}`);
            } else {
                console.error(`❌ ERREUR LIEN IMAGE : Le serveur (Supabase/Facebook) a refusé l'accès (Code ${response.status}).`);
                console.error(`👉 Lien bloqué : ${boutique.logo_url}`);
            }
        } catch (e) {
            console.error("❌ CRASH TRAITEMENT IMAGE (Un carré blanc par défaut sera affiché) :", e.message);
        }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    delete passJson.barcode;
    delete passJson.barcodes;
    
    passJson.backgroundColor = boutique.color_bg || "#FAF8F5";
    passJson.foregroundColor = boutique.color_text || "#2A8C9C";
    passJson.labelColor = (STEREOTYPES[boutique.categorie] || STEREOTYPES.default).label;

    // 🚨 CORRECTIONS CRITIQUES APPLE WALLET (Empêche l'erreur Safari) 🚨
    passJson.serialNumber = client.serial_number;
    passJson.authenticationToken = client.token;
    if (hostUrl) { passJson.webServiceURL = `https://${hostUrl}`; }
    
    passJson.organizationName = boutique.nom || "Fidélité";
    passJson.description = `Carte de fidélité ${boutique.nom || ""}`;
    passJson.logoText = (boutique.nom && boutique.nom.trim() !== "") ? boutique.nom : "Fidélité";

    // 📍 GÉOLOCALISATION
    if (boutique.latitude && boutique.longitude) {
        passJson.locations = [
            {
                latitude: parseFloat(boutique.latitude),
                longitude: parseFloat(boutique.longitude),
                relevantText: `Votre carte ${boutique.nom || "de fidélité"} est prête à être scannée !`
            }
        ];
        // 🎯 On demande 500 mètres (Apple appliquera 500m, ou son propre maximum s'il est inférieur)
        passJson.maxDistance = 500; 
    }

    const maxT = boutique.max_tampons || 10;
    const { data: allClients } = await supabase.from('clients').select('id, total_historique').eq('boutique_id', boutique.id);
    let vraiRang = 1;
    if (allClients) {
        const monScore = client.total_historique || 0;
        allClients.forEach(c => { if ((c.total_historique || 0) > monScore) vraiRang++; });
    }
    
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
    const suffixe = (vraiRang === 1) ? "er" : "ème";
    const symbolePlein = SYMBOLS[boutique.categorie] ? SYMBOLS[boutique.categorie].full : "⭐";
    const symboleVide = SYMBOLS[boutique.categorie] ? SYMBOLS[boutique.categorie].empty : "⚪";
    let fideliteTexte = "";
    for(let i = 0; i < maxT; i++) { fideliteTexte += (i < (client.tampons || 0)) ? symbolePlein : symboleVide; }

    const layout = {
        "headerFields": [{
            "key": "score_header",
            "label": "TAMPONS",
            "value": `${client.tampons || 0} / ${maxT}`,
            "textAlignment": "PKTextAlignmentRight",
            "changeMessage": "Nouveau solde : %@ 🎁"
        }],
        "primaryFields": [{
            "key": "bienvenue",
            "label": `Vous êtes le ${vraiRang}${suffixe} meilleur client`,
            "value": `Bonjour, ${prenom} ! 👋`
        }],
        "secondaryFields": [{
            "key": "fidelite",
            "label": "VOTRE FIDÉLITÉ",
            "value": fideliteTexte,
            "textAlignment": "PKTextAlignmentCenter"
        }],
        "auxiliaryFields": [], 
        "backFields": [
            {
                "key": "adresse",
                "label": "ADRESSE DE LA BOUTIQUE",
                "value": boutique.adresse || "Adresse non renseignée"
            },
            {
                "key": "telephone",
                "label": "CONTACT",
                "value": boutique.telephone || "Non renseigné",
                "dataDetectorTypes": ["PKDataDetectorTypePhoneNumber"]
            }
        ]
    };

    // 🚨 CORRECTION : Affiche toujours les cadeaux et déclenche la notification !
    layout.auxiliaryFields.push({
        "key": "cadeaux",
        "label": "CADEAUX DISPONIBLES",
        "value": `${client.recompenses || 0} 🎁`,
        "textAlignment": "PKTextAlignmentCenter",
        "changeMessage": "Vos cadeaux : %@ 🎁"
    });
    passJson.storeCard = layout;

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const buf = pass.getAsBuffer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return buf;
}

// ==========================================
// ROUTES : AFFICHAGE DES PAGES HTML
// ==========================================
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')));

// ==========================================
// 🔐 SÉCURITÉ CEO (SOURCE DE VÉRITÉ UNIQUE)
// ==========================================
const MASTER_CEO_KEY = "natrisT05"; 

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

// ==========================================
// API CEO & COMMERÇANT
// ==========================================

// CRÉER UNE BOUTIQUE
app.post('/admin/create-boutique', async (req, res) => {
    try {
        const { nom, username, password, ceoKey, categorie, logo_url, max_tampons } = req.body;
        
        // 🛡️ CORRECTION ICI
        if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ message: "Clé CEO invalide." });
        
        const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        const da = STEREOTYPES[categorie] || STEREOTYPES.default;
        const join_url = `https://${req.get('host')}/join/${slug}`;
        const finalMaxTampons = parseInt(max_tampons) || 10;
        const hashedPassword = await bcrypt.hash(password, 10);

        const { data, error } = await supabase.from('boutiques').insert([{ 
            nom, slug, username, password: hashedPassword, categorie, logo_url, join_url, 
            color_bg: da.bg, color_text: da.text, max_tampons: finalMaxTampons
        }]).select().single();
        
        if (error) throw error;
        res.json({ success: true, boutique: data });
    } catch (e) { res.status(400).json({ message: e.message }); }
});


// RÉINITIALISER UN MOT DE PASSE
app.post('/admin/reset-password', async (req, res) => {
    const { boutiqueId, newPassword, ceoKey } = req.body;
    
    // 🛡️ CORRECTION ICI
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const { error } = await supabase.from('boutiques').update({ password: hashedPassword }).eq('id', boutiqueId);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erreur de mise à jour" });
    }
});
app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body;
    
    // 1. On cherche la boutique UNIQUEMENT avec le nom d'utilisateur (on récupère le hash)
    const { data: boutique } = await supabase.from('boutiques')
        .select('id, slug, nom, max_tampons, password')
        .eq('username', user)
        .maybeSingle();

    if (!boutique) {
        return res.status(401).json({ error: "Identifiant incorrect." });
    }

    // 2. On compare le mot de passe tapé (pass) avec l'empreinte cryptée (boutique.password)
    const match = await bcrypt.compare(pass, boutique.password);

    if (match) {
        res.json({ 
            boutiqueId: boutique.id, 
            slug: boutique.slug, 
            nom: boutique.nom, 
            maxTampons: boutique.max_tampons 
        });
    } else {
        res.status(401).json({ error: "Mot de passe incorrect." });
    }
});
app.post('/auth/change-password', async (req, res) => {
    const { boutiqueId, oldPassword, newPassword } = req.body;

    try {
        // 1. On récupère le mot de passe actuel (haché) en base
        const { data: boutique } = await supabase
            .from('boutiques')
            .select('password')
            .eq('id', boutiqueId)
            .single();

        // 2. On vérifie que l'ancien mot de passe est correct
        const match = await bcrypt.compare(oldPassword, boutique.password);
        if (!match) return res.status(401).json({ error: "L'ancien mot de passe est incorrect." });

        // 3. On hache le nouveau et on met à jour
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await supabase.from('boutiques').update({ password: hashedPassword }).eq('id', boutiqueId);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: "Erreur lors du changement de mot de passe." });
    }
});
// 🛡️ ROUTE DE SECOURS CEO : RÉINITIALISATION FORCEE
app.post('/admin/force-reset-password', async (req, res) => {
    const { boutiqueId, newPassword, ceoKey } = req.body;

    // 1. Vérification de ta clé secrète
    if (ceoKey !== MASTER_CEO_KEY) {
        return res.status(403).json({ message: "Accès refusé. Clé CEO invalide." });
    }

    try {
        // 2. On hache le nouveau mot de passe
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // 3. On écrase l'ancien en base
        const { error } = await supabase
            .from('boutiques')
            .update({ password: hashedPassword })
            .eq('id', boutiqueId);

        if (error) throw error;
        res.json({ success: true, message: "Mot de passe réinitialisé avec succès." });
    } catch (e) {
        res.status(500).json({ message: "Erreur lors de la réinitialisation." });
    }
});
// VOIR TOUTES LES BOUTIQUES (AVEC INTELLIGENCE DES STATUTS)
app.get('/admin/boutiques', async (req, res) => {
    const ceoKey = req.headers['x-ceo-key'];
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");

    try {
        // 1. Récupérer toutes les boutiques
        const { data: boutiques, error } = await supabase.from('boutiques').select('id, nom, username, slug, created_at');
        if (error) throw error;

        // 2. Analyse temporelle : Qui a scanné récemment ?
        const septJours = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const trenteJours = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // On interroge la table des visites en parallèle pour aller très vite
        const [visites7j, visites30j] = await Promise.all([
            supabase.from('visites').select('boutique_id').gte('created_at', septJours),
            supabase.from('visites').select('boutique_id').gte('created_at', trenteJours)
        ]);

        // On crée des "Sets" (listes uniques) pour trier ultra-rapidement
        const actives7jIds = new Set(visites7j.data?.map(v => v.boutique_id) || []);
        const actives30jIds = new Set(visites30j.data?.map(v => v.boutique_id) || []);

        // 3. Jugement de chaque boutique
        const boutiquesAnalysees = boutiques.map(b => {
            let statut = 'inactif'; // Pire scénario par défaut
            
            if (actives7jIds.has(b.id)) {
                statut = 'actif'; // Scan récent = tout va bien
            } else if (actives30jIds.has(b.id)) {
                statut = 'attention'; // Actif ce mois-ci, mais rien cette semaine = Churn Risk
            } else {
                // Tolérance "Cold Start" : Créée il y a moins de 7 jours = Attention, pas Inactif
                if (new Date(b.created_at) > new Date(septJours)) {
                    statut = 'attention';
                }
            }
            return { ...b, statut }; // On fusionne les données de la boutique avec son nouveau statut
        });

        res.json(boutiquesAnalysees);
    } catch (error) {
        console.error("Erreur API Boutiques:", error);
        res.status(500).json({ error: "Erreur lors de l'analyse de la flotte" });
    }
});

app.get('/boutiques/:id/clients', async (req, res) => {
    const { data } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false });
    res.json(data || []);
});
// --- CRÉATION MANUELLE D'UN CLIENT ---
app.post('/boutiques/:id/clients-manuels', async (req, res) => {
    const { nom, telephone } = req.body;
    const boutique_id = req.params.id;

    try {
        // 1. On vérifie si ce numéro existe déjà dans CETTE boutique
        const { data: existing } = await supabase
            .from('clients')
            .select('*')
            .eq('boutique_id', boutique_id)
            .eq('telephone', telephone)
            .maybeSingle(); // Utilise maybeSingle pour éviter une erreur si rien n'est trouvé

        if (existing) {
            return res.status(400).json({ error: "Ce numéro est déjà enregistré dans votre boutique." });
        }

        // 2. On insère le nouveau client
        const { data, error } = await supabase
            .from('clients')
            .insert([{ 
                nom, 
                telephone, 
                boutique_id, 
                tampons: 0,
                last_visit: new Date().toISOString() 
            }])
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: "Erreur lors de la création du client." }); 
    }
});
// --- NOUVEAU : MISE À JOUR DU PROFIL BOUTIQUE ---
app.put('/boutiques/:id', async (req, res) => {
    const { id } = req.params;
    const { adresse, telephone } = req.body;

    try {
        const { data, error } = await supabase
            .from('boutiques')
            .update({ adresse, telephone })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (e) {
        console.error("Erreur Profil:", e);
        res.status(500).json({ error: "Erreur lors de la mise à jour du profil" });
    }
});

app.get('/boutiques/:id', async (req, res) => {
    const { data, error } = await supabase.from('boutiques').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Boutique introuvable' });
    res.json(data);
});

app.get('/boutiques/:id/passages-du-jour', async (req, res) => {
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const { data } = await supabase.from('visites').select('id').eq('boutique_id', req.params.id).gte('created_at', debut.toISOString());
    res.json({ count: data?.length || 0 });
});

app.get('/boutiques/:id/stats', async (req, res) => {
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
            for (let i = 1; i < sorted.length; i++) diffs.push((sorted[i] - sorted[i-1]) / 86400000);
            avgFrequency = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
        }

        res.json({ avgFrequency, peakHours, distribution });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/global-stats', async (req, res) => {
    if (req.headers['x-ceo-key'] !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");
    try {
        const trenteJours = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const septJours  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString();
        const today = new Date(); today.setHours(0, 0, 0, 0);

        const [
            { data: visites30j },
            { count: totalClients },
            { data: visitesAujourd },
            { data: boutiques },
            { data: devices },
        ] = await Promise.all([
            supabase.from('visites').select('created_at, client_id, boutique_id').gte('created_at', trenteJours),
            supabase.from('clients').select('*', { count: 'exact', head: true }),
            supabase.from('visites').select('id').gte('created_at', today.toISOString()),
            supabase.from('boutiques').select('id, categorie, adresse'),
            supabase.from('devices').select('serial_number'),
        ]);

        // --- Scans par jour (30j pour le graphique principal) ---
        const scansParJour = {};
        for (let i = 29; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000);
            scansParJour[d.toISOString().split('T')[0]] = 0;
        }
        visites30j?.forEach(v => { const j = v.created_at.split('T')[0]; if (scansParJour[j] !== undefined) scansParJour[j]++; });

        // --- Scans par jour de semaine (Lun–Dim) ---
        const joursLabels = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        const scansParSemaine = Array(7).fill(0);
        visites30j?.forEach(v => { scansParSemaine[new Date(v.created_at).getDay()]++; });
        const weeklyData = joursLabels.map((day, i) => ({ day, scans: scansParSemaine[i] }));
        // Réordonner Lun → Dim
        const weeklyOrdered = [...weeklyData.slice(1), weeklyData[0]];

        // --- Utilisateurs uniques 30j ---
        const uniqueUsers30j = new Set(visites30j?.map(v => v.client_id)).size;

        // --- Cartes Apple Wallet ---
        const cartesWallet = new Set(devices?.map(d => d.serial_number)).size;

        // --- Taux de rétention (clients venus 2+ fois sur 30j) ---
        const comptageParClient = {};
        visites30j?.forEach(v => { comptageParClient[v.client_id] = (comptageParClient[v.client_id] || 0) + 1; });
        const clientsFideles = Object.values(comptageParClient).filter(n => n > 1).length;
        const totalVisiteurs = Object.keys(comptageParClient).length;
        const tauxRetention = totalVisiteurs > 0 ? Math.round((clientsFideles / totalVisiteurs) * 100) : 0;

        // --- Health Score & KPIs flotte ---
        const totalBoutiques = boutiques?.length || 0;
        const { data: actives7j } = await supabase.from('visites').select('boutique_id').gte('created_at', septJours);
        const activesIds = new Set(actives7j?.map(v => v.boutique_id) || []);
        const healthScore = totalBoutiques > 0 ? Math.round((activesIds.size / totalBoutiques) * 100) : 0;

        // --- Secteurs ---
        const secteurs = {};
        boutiques?.forEach(b => { const c = b.categorie || 'default'; secteurs[c] = (secteurs[c] || 0) + 1; });

        // --- Répartition appareils (depuis device_type enregistré à l'inscription) ---
        const { data: deviceTypes } = await supabase.from('clients').select('device_type');
        const totalD = deviceTypes?.length || 1;
        const iosCount     = deviceTypes?.filter(c => c.device_type === 'ios').length     || 0;
        const androidCount = deviceTypes?.filter(c => c.device_type === 'android').length || 0;
        const otherCount   = deviceTypes?.filter(c => !c.device_type || c.device_type === 'other').length || 0;
        const deviceData = {
            iphone:  Math.round((iosCount     / totalD) * 100),
            android: Math.round((androidCount / totalD) * 100),
            autre:   Math.round((otherCount   / totalD) * 100),
        };

        // --- Top 5 Villes (depuis adresse des boutiques) ---
        const villeScans = {};
        const boutiqueVille = {};
        boutiques?.forEach(b => {
            if (b.adresse) {
                const parts = b.adresse.split(',');
                const cityRaw = parts[parts.length - 1].trim().replace(/^\d{5}\s*/, '').trim();
                if (cityRaw) boutiqueVille[b.id] = cityRaw;
            }
        });
        visites30j?.forEach(v => {
            const ville = boutiqueVille[v.boutique_id];
            if (ville) villeScans[ville] = (villeScans[ville] || 0) + 1;
        });
        const totalScansVilles = Object.values(villeScans).reduce((a, b) => a + b, 0) || 1;
        const topVilles = Object.entries(villeScans)
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([city, scans]) => ({ city, scans, percentage: Math.round((scans / totalScansVilles) * 100) }));

        res.json({
            scansAujourdhui: visitesAujourd?.length || 0,
            scans30j: visites30j?.length || 0,
            totalClients: totalClients || 0,
            uniqueUsers30j,
            cartesWallet,
            tauxRetention,
            healthScore,
            secteurs,
            deviceData,
            weeklyData: weeklyOrdered,
            topVilles,
            chartLabels: Object.keys(scansParJour).map(d => d.slice(5)),
            chartData: Object.values(scansParJour),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/radar', async (req, res) => {
    if (req.headers['x-ceo-key'] !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");
    try {
        const sept = new Date(Date.now() - 7 * 86400000).toISOString();
        const trente = new Date(Date.now() - 30 * 86400000).toISOString();

        const [{ data: boutiques }, { data: v7j }, { data: v30j }] = await Promise.all([
            supabase.from('boutiques').select('id, nom'),
            supabase.from('visites').select('boutique_id').gte('created_at', sept),
            supabase.from('visites').select('boutique_id').gte('created_at', trente)
        ]);

        const ids7j = new Set(v7j?.map(v => v.boutique_id));
        const compte7j = {};
        v7j?.forEach(v => { compte7j[v.boutique_id] = (compte7j[v.boutique_id] || 0) + 1; });

        const churn = boutiques?.filter(b => !ids7j.has(b.id) && v30j?.some(v => v.boutique_id === b.id)) || [];
        const top = boutiques
            ?.filter(b => ids7j.has(b.id))
            .map(b => ({ ...b, scans: compte7j[b.id] || 0 }))
            .sort((a, b) => b.scans - a.scans)
            .slice(0, 5) || [];

        res.json({ churn, top });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// MOTEUR FIDÉLITÉ : TAMPONS & PUSH APNS
// ==========================================
app.post('/clients/:id/tampon', async (req, res) => {
    try {
        const pointsAjoutes = parseInt(req.body.nb);
        
        // On récupère le client ET les infos de sa boutique associée
        const { data: client } = await supabase
            .from('clients')
            .select('*, boutiques(max_tampons)')
            .eq('id', req.params.id)
            .single();
        
        // On récupère la limite de la boutique (ou 10 par défaut si non défini)
        const maxT = client.boutiques.max_tampons || 10;

        let finalTampons = client.tampons || 0;
    let finalRecompenses = client.recompenses || 0;
    let totalHistorique = client.total_historique || 0; // 👈 1. On charge la mémoire du client

    if (pointsAjoutes < 0) {
            // 🎁 GESTION DE MULTIPLES CADEAUX
            // Si le dashboard envoie -1, on retire 1 cadeau. Si -2, on retire 2, etc.
            let cadeauxARetirer = (pointsAjoutes <= -10) ? Math.abs(pointsAjoutes) / 10 : Math.abs(pointsAjoutes);
            finalRecompenses = Math.max(0, finalRecompenses - cadeauxARetirer);
        } else {
            // Ajout classique de tampons
            let totalStamps = finalTampons + pointsAjoutes;
            finalTampons = totalStamps % maxT;
            finalRecompenses += Math.floor(totalStamps / maxT);
            totalHistorique += pointsAjoutes; 
        }

    const { data: updatedClient } = await supabase.from('clients').update({
        tampons: finalTampons,
        recompenses: finalRecompenses,
        total_historique: totalHistorique, // 👈 3. On sauvegarde la mémoire en base
        last_visit: new Date().toISOString()
    }).eq('id', req.params.id).select().single();
        
        if (pointsAjoutes > 0) await supabase.from('visites').insert([{ client_id: client.id, boutique_id: client.boutique_id, points_ajoutes: pointsAjoutes }]);

        const { data: devices } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number);
        if (devices && devices.length > 0) {
            const p8Key = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : fs.readFileSync(path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
            const teamId = process.env.APPLE_TEAM_ID || 'Q762BTBA98'; 
            const keyId = process.env.APPLE_KEY_ID || 'RM6P22PX7A';
            
            const provider = new apn.Provider({ token: { key: p8Key, keyId: keyId, teamId: teamId }, production: true });
            
            // Le payload Wallet DOIT être vide pour fonctionner
            const notification = new apn.Notification();
            notification.topic = 'pass.pro.nuvy.loyalty';
            
            for (const d of devices) { await provider.send(notification, d.push_token); }
            provider.shutdown();
        }
        res.json(updatedClient);
    } catch (e) { res.status(500).send(); }
});

// ==========================================
// LE TAP NFC (EXPÉRIENCE PREMIUM)
// ==========================================
app.get('/tap/:slug', (req, res) => {
    const slug = req.params.slug;
    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Nuvy Tap</title>
        <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;800&display=swap" rel="stylesheet">
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
            
            .btn { display: inline-block; background: #2A8C9C; color: white; padding: 14px 28px; border-radius: 20px; text-decoration: none; font-weight: 800; font-size: 15px; margin-top: 25px; transition: transform 0.2s; }
            .c.success .btn { background: #FFFFFF; color: #111111; }
            .btn:active { transform: scale(0.95); }
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
                <a href="#" id="wallet-btn" class="btn">Fermer & Voir ma carte </a>
            </div>
        </div>
        
        <script>
            const token = localStorage.getItem('nuvy_token');
            const slug = '${slug}';
            
            // Le petit "Ding" de succès !
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
                fetch('/tap/' + slug + '/notify?token=' + token, { method: 'POST' })
                .then(r => {
                    if(r.ok) {
                        playDing();
                        // Animation vers le succès
                        const box = document.getElementById('ui-box');
                        document.getElementById('loader-view').style.display = 'none';
                        document.getElementById('success-view').style.display = 'block';
                        box.classList.add('success');
                        document.getElementById('wallet-btn').href = '/pass/' + token;
                    } else if (r.status === 404) {
                        localStorage.removeItem('nuvy_token');
                        window.location.href = '/join/' + slug;
                    } else {
                        throw new Error();
                    }
                })
                .catch(() => {
                    document.getElementById('ui-box').innerHTML = '<div style="font-size: 50px; margin-bottom:15px;">⚠️</div><h2 style="color:#C62828;">Oups...</h2><p>Vérifiez votre connexion internet.</p>';
                });
            }
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.post('/tap/:slug/notify', async (req, res) => {
    try {
        const { data: clientData } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
        
        if (clientData) { 
            // 🌟 1. On met à jour l'heure de visite pour remonter le client dans la liste du Dashboard !
            await supabase.from('clients').update({ last_visit: new Date().toISOString() }).eq('id', clientData.id);
            
            // 🌟 2. On fait "popper" la carte sur le Dashboard Commerçant !
            io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', clientData); 
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

app.post('/join/:slug/create', async (req, res) => {
    try {
        const { prenom, nom, telephone } = req.body;
        const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();

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
            last_visit: new Date().toISOString(),
            device_type,
        }]).select().single();
        
        // 🌟 MAGIE : Le nouveau client fait sonner le dashboard immédiatement !
        io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', data);
        res.json({ token: data.token });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// WEB SERVICES APPLE (ÉCOUTE ET MISES À JOUR)
// ==========================================
app.post('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    await supabase.from('devices').upsert([{ device_id: req.params.dId, push_token: req.body.pushToken, pass_type_id: req.params.pId, serial_number: req.params.sN }]);
    res.status(201).send();
});

app.delete('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    await supabase.from('devices').delete().eq('device_id', req.params.dId).eq('serial_number', req.params.sN);
    res.status(200).send();
});

app.get('/v1/devices/:dId/registrations/:pId', async (req, res) => {
    const { data } = await supabase.from('devices').select('serial_number').eq('device_id', req.params.dId);
    if (data && data.length > 0) res.json({ serialNumbers: data.map(d => d.serial_number), lastUpdated: new Date().toISOString() });
    else res.status(204).send();
});

app.get('/v1/passes/:pId/:sN', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('serial_number', req.params.sN).single();
        if(!c) return res.status(404).send();
        
        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        let rank = 1; all.forEach(o => { if(((o.recompenses||0)*10 + (o.tampons||0)) > score) rank++; });
        
        // La bonne fonction avec l'URL pour les mises à jour Apple
        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Last-Modified', new Date().toUTCString()); // Force l'iPhone à se mettre à jour
        res.status(200).send(buf);
    } catch (e) { res.status(500).send(); }
});

app.post('/v1/log', (req, res) => res.status(200).send());

// ==========================================
// SOCKET.IO (TEMPS RÉEL DASHBOARD)
// ==========================================
io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => { socket.join(slug.toLowerCase().trim()); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`=== MOTEUR NUVY PRÊT SUR LE PORT ${PORT} ===`));