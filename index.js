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

                // ✂️ TRIM : Enlève le vide transparent autour de l'image pour aligner parfaitement à gauche
                await sharp(buffer).trim().resize(480, 150, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'logo@3x.png'));
                await sharp(buffer).trim().resize(320, 100, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'logo@2x.png'));
                await sharp(buffer).trim().resize(160, 50, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'logo.png'));

                await sharp(buffer).trim().resize(174, 174, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'icon@3x.png')); 
                await sharp(buffer).trim().resize(116, 116, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'icon@2x.png'));
                await sharp(buffer).trim().resize(58, 58, { fit: 'inside' }).png().toFile(path.join(tmpDir, 'icon.png'));
            }
        } catch (e) {
            console.error("❌ Erreur image :", e);
        }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    delete passJson.barcode;
    delete passJson.barcodes;
    
    passJson.backgroundColor = boutique.color_bg || "#FAF8F5";
    passJson.foregroundColor = boutique.color_text || "#2A8C9C";
    passJson.labelColor = (STEREOTYPES[boutique.categorie] || STEREOTYPES.default).label;
    
    // 🔔 NOUVEAU : Nom de la boutique sur la notification Push au lieu de "Nuvy"
    passJson.organizationName = boutique.nom || "Fidélité";
    passJson.description = `Carte de fidélité ${boutique.nom || ""}`;
    passJson.logoText = boutique.nom || "Fidélité";

    // 🛡️ OBLIGATOIRE POUR LES MISES A JOUR APPLE WALLET
    passJson.serialNumber = client.serial_number;
    passJson.authenticationToken = client.token;
    if (hostUrl) { passJson.webServiceURL = `https://${hostUrl}`; }

    // CALCUL DU RANG
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

    passJson.storeCard = {
        // 🎯 NOUVEAU : Score en haut à droite (Face au logo)
        "headerFields": [{
            "key": "score_header",
            "label": "TAMPONS",
            "value": `${client.tampons || 0} / ${maxT}`,
            "textAlignment": "PKTextAlignmentRight"
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
        "backFields": [
            {
                "key": "carte_en_cours",
                "label": "CARTE EN COURS",
                "value": `${client.tampons || 0} / ${maxT}`,
                "changeMessage": "Nouveau solde : %@ 🎁"
            },
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

// VOIR TOUTES LES BOUTIQUES
app.get('/admin/boutiques', async (req, res) => {
    const ceoKey = req.headers['x-ceo-key'];
    
    // 🛡️ CORRECTION ICI
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");

    const { data, error } = await supabase.from('boutiques').select('id, nom, username, slug, created_at');
    if (error) return res.status(500).json(error);
    res.json(data);
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
// ==========================================
// DATA CENTER CEO : STATISTIQUES GLOBALES (DYNAMIQUE)
// ==========================================
app.get('/admin/stats-globales', async (req, res) => {
    const ceoKey = req.headers['x-ceo-key'];
    if (ceoKey !== MASTER_CEO_KEY) return res.status(403).json({ error: "Accès refusé" });

    try {
        // 1. Définition de la période (Par défaut : 30 derniers jours)
        let dateFin = req.query.fin ? new Date(req.query.fin) : new Date();
        dateFin.setHours(23, 59, 59, 999);
        
        let dateDebut = req.query.debut ? new Date(req.query.debut) : new Date(dateFin.getTime() - (29 * 24 * 60 * 60 * 1000));
        dateDebut.setHours(0, 0, 0, 0);

        const diffJours = Math.round((dateFin - dateDebut) / (1000 * 60 * 60 * 24)) + 1;

        // 2. Récupération globale
        const [clientsRes, visitesRes, boutiquesRes, devicesRes] = await Promise.all([
            supabase.from('clients').select('id, tampons, recompenses, boutique_id, created_at'),
            supabase.from('visites').select('id, created_at, boutique_id, client_id'),
            supabase.from('boutiques').select('id, adresse, nom'),
            supabase.from('devices').select('id')
        ]);

        const clients = clientsRes.data || [];
        const visites = visitesRes.data || [];
        const boutiques = boutiquesRes.data || [];
        const devices = devicesRes.data || [];

        // 3. Filtrage temporel sur les visites
        const visitesPeriode = visites.filter(v => {
            const d = new Date(v.created_at);
            return d >= dateDebut && d <= dateFin;
        });

        // 4. Calculs KPIs
        const scansPeriode = visitesPeriode.length;
        const totalClients = clients.length; // Total global du réseau
        // --- NOUVEAU CALCUL DE RÉTENTION (Basé sur les vrais passages en caisse) ---
        const comptageVisites = {};
        visites.forEach(v => {
            if (v.client_id) {
                comptageVisites[v.client_id] = (comptageVisites[v.client_id] || 0) + 1;
            }
        });
        
        // On ne garde que les clients qui ont été scannés au moins 2 fois (2 vraies visites)
        const clientsFideles = Object.values(comptageVisites).filter(nbVisites => nbVisites > 1).length;
        const tauxRetention = totalClients > 0 ? Math.round((clientsFideles / totalClients) * 100) : 0;
        const cartesAppleWallet = devices.length;

        // 5. Graphique principal dynamique (Affluence)
        // On limite à 30 points affichés pour que la courbe reste belle même si tu sélectionnes 1 an
        const nbPoints = Math.min(diffJours, 30); 
        const step = diffJours / nbPoints;
        const dynamicData = new Array(nbPoints).fill(0);
        const dynamicLabels = new Array(nbPoints).fill('');

        for (let i = 0; i < nbPoints; i++) {
            const d = new Date(dateFin.getTime() - ((nbPoints - 1 - i) * step * 24 * 60 * 60 * 1000));
            dynamicLabels[i] = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            
            const scansJour = visitesPeriode.filter(v => {
                const dateVisite = new Date(v.created_at);
                return dateVisite.getDate() === d.getDate() && dateVisite.getMonth() === d.getMonth() && dateVisite.getFullYear() === d.getFullYear();
            }).length;
            dynamicData[i] = scansJour;
        }

        // Graphique Hebdo (7 derniers jours de la période sélectionnée)
        const weeklyData = [0, 0, 0, 0, 0, 0, 0];
        const joursSemaine = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        const labelsHebdo = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(dateFin.getTime() - (i * 24 * 60 * 60 * 1000));
            labelsHebdo.push(joursSemaine[d.getDay()]);
            const scansJour = visitesPeriode.filter(v => {
                const dateVisite = new Date(v.created_at);
                return dateVisite.getDate() === d.getDate() && dateVisite.getMonth() === d.getMonth() && dateVisite.getFullYear() === d.getFullYear();
            }).length;
            weeklyData[6 - i] = scansJour;
        }

        const statsAppareils = { iphone: cartesAppleWallet > 0 ? 100 : 0, android: 0, autre: 0 };

        // 6. Top Villes (sur la période sélectionnée)
        const villesCount = {};
        boutiques.forEach(b => {
            const adresseParts = b.adresse ? b.adresse.split(',') : [];
            let ville = adresseParts.length > 0 ? adresseParts[adresseParts.length - 1].trim().replace(/[0-9]/g, '').trim() : "Inconnue";
            if (!ville || ville === "") ville = "Non renseignée";

            const visitesBoutique = visitesPeriode.filter(v => v.boutique_id === b.id).length;
            if (!villesCount[ville]) villesCount[ville] = 0;
            villesCount[ville] += visitesBoutique;
        });

        const topVilles = Object.entries(villesCount)
            .map(([nom, scans]) => ({ nom, scans, pourcentage: visitesPeriode.length > 0 ? Math.round((scans / visitesPeriode.length) * 100) : 0 }))
            .sort((a, b) => b.scans - a.scans)
            .slice(0, 5);

        res.json({
            kpis: { scansPeriode, totalClients, cartesAppleWallet, tauxRetention: `${tauxRetention}%` },
            graphiques: { hebdo: { labels: labelsHebdo, data: weeklyData }, mensuel: { labels: dynamicLabels, data: dynamicData }, appareils: statsAppareils },
            topVilles
        });

    } catch (err) {
        console.error("Erreur Stats:", err);
        res.status(500).json({ error: "Erreur serveur" });
    }
});
// FORCER LA CONNEXION À UNE BOUTIQUE (GOD MODE CEO)
app.get('/admin/force-login', async (req, res) => {
    const { username, key } = req.query;
    
    // On vérifie que c'est bien toi (le CEO) qui demande ça
    if (key !== MASTER_CEO_KEY) return res.status(403).send("Accès refusé");

    try {
        // On va chercher la boutique cible dans Supabase
        const { data: boutique, error } = await supabase.from('boutiques').select('*').eq('username', username).single();
        if (error || !boutique) return res.status(404).send("Boutique introuvable");

        // On génère le badge d'accès (token) pour cette boutique précise
        const token = jwt.sign({ id: boutique.id, username: boutique.username }, JWT_SECRET, { expiresIn: '24h' });
        
        // On écrase l'ancien cookie du navigateur par le nouveau
        res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
        
        // On t'envoie directement sur le dashboard !
        res.redirect('/dashboard');
    } catch (err) {
        console.error("Erreur Force Login:", err);
        res.status(500).send("Erreur serveur");
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

// ==========================================
// MOTEUR FIDÉLITÉ : TAMPONS & PUSH APNS
// ==========================================
app.post('/clients/:id/tampon', async (req, res) => {
    try {
        const pointsAjoutes = parseInt(req.body.nb);
        
        // On récupère le client
        const { data: client } = await supabase.from('clients').select('*, boutiques(max_tampons)').eq('id', req.params.id).single();
        const maxT = client.boutiques.max_tampons || 10;

        let finalTampons = client.tampons || 0;
        let finalRecompenses = client.recompenses || 0;
        let totalHistorique = client.total_historique || 0;

        if (pointsAjoutes === -10) {
            finalRecompenses = Math.max(0, finalRecompenses - 1);
        } else {
            let totalStamps = finalTampons + pointsAjoutes;
            finalTampons = totalStamps % maxT;
            finalRecompenses += Math.floor(totalStamps / maxT);
            totalHistorique += pointsAjoutes;
        }

        const { data: updatedClient } = await supabase.from('clients').update({
            tampons: finalTampons,
            recompenses: finalRecompenses,
            total_historique: totalHistorique,
            last_visit: new Date().toISOString()
        }).eq('id', req.params.id).select().single();
        
        if (pointsAjoutes > 0) {
            await supabase.from('visites').insert([{ client_id: client.id, boutique_id: client.boutique_id, points_ajoutes: pointsAjoutes }]);
        }

        // 🚀 MOTEUR DE NOTIFICATION PUSH APPLE WALLET
        const { data: devices } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number);
        
        if (devices && devices.length > 0) {
            console.log(`📡 Préparation du Push pour ${devices.length} appareil(s)`);
            
            const p8Path = path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8');
            const p8Key = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : (fs.existsSync(p8Path) ? fs.readFileSync(p8Path).toString('utf8') : null);
            
            if (!p8Key) {
                console.error("❌ ERREUR: Fichier .p8 introuvable pour les notifications.");
            } else {
                const provider = new apn.Provider({ 
                    token: { key: p8Key, keyId: process.env.APPLE_KEY_ID || 'RM6P22PX7A', teamId: process.env.APPLE_TEAM_ID || 'Q762BTBA98' }, 
                    production: true 
                });
                
                const notification = new apn.Notification();
                notification.topic = 'pass.pro.nuvy.loyalty';
                
                const pushTokens = devices.map(d => d.push_token);
                const result = await provider.send(notification, pushTokens);
                
                console.log("✅ Résultat APNs :", JSON.stringify(result));
                provider.shutdown();
            }
        }
        res.json(updatedClient);
    } catch (e) { 
        console.error("❌ Erreur ajout tampon :", e);
        res.status(500).send(); 
    }
});

// ==========================================
// LE TAP NFC (Check-in ultra rapide)
// ==========================================
app.get('/tap/:slug', (req, res) => {
    const slug = req.params.slug;
    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Nuvy Tap</title>
        <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;800&display=swap" rel="stylesheet">
        <style>
            body { background: #FAF8F5; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Manrope', sans-serif; margin: 0; overflow: hidden; }
            .c { background: white; padding: 40px 30px; border-radius: 35px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.04); border: 1px solid #E0DEDA; max-width: 340px; width: 90%; }
            .loader { border: 4px solid rgba(42,140,156,0.1); border-left-color: #2A8C9C; border-radius: 50%; width: 48px; height: 48px; animation: spin 1s linear infinite; margin: 0 auto 20px auto; }
            
            /* L'animation de validation type Apple Pay */
            .success-circle { width: 80px; height: 80px; background: #E8F5E9; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px auto; transform: scale(0); animation: popIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }
            .success-circle svg { width: 40px; height: 40px; color: #2E7D32; }
            
            h2 { margin: 0 0 10px 0; font-weight: 800; font-size: 24px; color: #111; }
            p { color: #888; font-weight: 600; margin: 0; font-size: 15px; }
            .btn { display: block; background: #111; color: white; padding: 18px 24px; border-radius: 20px; text-decoration: none; font-weight: 800; font-size: 16px; margin-top: 30px; transition: transform 0.2s; }
            .btn:active { transform: scale(0.96); }
            
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            @keyframes popIn { 100% { transform: scale(1); } }
        </style>
    </head>
    <body>
        <div class="c" id="ui-box">
            <div class="loader"></div>
            <h2 style="color:#2A8C9C;">Transmission...</h2>
            <p>Ne bougez pas votre téléphone</p>
        </div>
        <script>
            // 1. On cherche la mémoire du client
            const token = localStorage.getItem('nuvy_token');
            
            // 2. Si Inconnu -> Redirection immédiate vers l'inscription
            if (!token) {
                window.location.replace('/join/${slug}');
            } else {
                // 3. Si Connu -> On "bip" la caisse du commerçant
                fetch('/tap/${slug}/notify?token=' + token, { method: 'POST' })
                .then(r => {
                    if(r.ok) {
                        // --- EFFET MAGIQUE : Vibration Haptique Apple ---
                        if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
                        
                        // --- INTERFACE : Apparition du checkmark ---
                        document.getElementById('ui-box').innerHTML = \`
                            <div class="success-circle">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            </div>
                            <h2>Connecté !</h2>
                            <p>Le commerçant ajoute vos points.</p>
                            <a href="/pass/\${token}" class="btn">Voir ma carte </a>
                        \`;
                    } else if (r.status === 404) {
                        // Le client a vidé son cache ou changé de téléphone
                        localStorage.removeItem('nuvy_token');
                        window.location.replace('/join/${slug}');
                    } else {
                        throw new Error();
                    }
                })
                .catch(() => {
                    if (navigator.vibrate) navigator.vibrate(200); // Grosse vibration d'erreur
                    document.getElementById('ui-box').innerHTML = '<h2 style="color:#C62828;">Erreur réseau</h2><p>Vérifiez votre connexion 4G/5G.</p>';
                });
            }
        </script>
    </body>
    </html>`;
    res.send(html);
});

app.post('/tap/:slug/notify', async (req, res) => {
    const { data: clientData } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
    if (clientData) { io.to(req.params.slug.toLowerCase().trim()).emit('client-detected', clientData); res.json({ success: true }); } 
    else res.status(404).send();
});

// ==========================================
// DISTRIBUTION WALLET & INSCRIPTION
// ==========================================
app.get('/pass/:token', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        if (!c) return res.status(404).send("Client introuvable");

        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const maxT = c.boutiques.max_tampons || 10;
        const score = (c.recompenses * maxT) + c.tampons;
        
        let rank = 1; 
        if (all) all.forEach(o => { if(((o.recompenses||0)*maxT + (o.tampons||0)) > score) rank++; });
        
        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));

        // --- 🛡️ PROTECTION SAFARI (CORRECTION 1) ---
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Content-Disposition', `attachment; filename="nuvy-${c.boutiques.slug}.pkpass"`);
        res.setHeader('Content-Length', buf.length); 
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        return res.status(200).send(buf);
    } catch (e) { 
        console.error("Erreur téléchargement pass:", e);
        res.status(500).send("Erreur interne"); 
    }
});

app.post('/join/:slug/create', async (req, res) => {
    try {
        // ⚠️ CORRECTION : on récupère juste 'nom' depuis le front-end
        const { nom, telephone } = req.body;
        const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();

        const { data: existingClient } = await supabase
            .from('clients')
            .select('*')
            .eq('telephone', telephone)
            .eq('boutique_id', b.id)
            .maybeSingle(); 

        if (existingClient) {
            return res.json({ token: existingClient.token });
        }

        const token = crypto.randomUUID();
        const { data } = await supabase.from('clients').insert([{ 
            boutique_id: b.id, 
            nom: nom, // ⚠️ CORRECTION : Le nom est propre, sans "undefined"
            telephone, 
            tampons: 0, 
            recompenses: 0, 
            token, 
            serial_number: `NUVY-${token.split('-')[0].toUpperCase()}`, 
            last_visit: new Date().toISOString() 
        }]).select().single();
        
        res.json({ token: data.token });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// WEB SERVICES APPLE (OBLIGATOIRES POUR LA MISE A JOUR)
// ==========================================
app.post('/v1/devices/:dId/registrations/:pId/:sN', async (req, res) => {
    await supabase.from('devices').upsert([{ device_id: req.params.dId, push_token: req.body.pushToken, pass_type_id: req.params.pId, serial_number: req.params.sN }]);
    res.status(201).send();
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
        
        const buf = await generatePassBuffer(c, c.boutiques, rank, req.get('host'));
        res.set('Content-Type', 'application/vnd.apple.pkpass').send(buf);
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