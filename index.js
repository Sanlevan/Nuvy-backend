require('dotenv').config();
console.log("--- ⚡ NUVY MASTER ENGINE V2026 : FULL LOAD ---");

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { PKPass } = require('passkit-generator');
const apn = require('apn');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public')); // Pour ton favicon.png

// 1. CONNEXION SUPABASE
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

// 2. MATRICE DES STÉRÉOTYPES (DA INTELLIGENTE)
const STEREOTYPES = {
    default:     { bg: "#FAF8F5", text: "#2A8C9C", label: "#AFE3E0" },
    boulangerie: { bg: "#FAF0E6", text: "#8B4513", label: "#CD853F" },
    pizza:       { bg: "#FFFAFA", text: "#CD5C5C", label: "#FFA07A" },
    onglerie:    { bg: "#FFF0F5", text: "#C71585", label: "#FFB6C1" },
    coiffeur:    { bg: "#F8F8F8", text: "#191970", label: "#B0C4DE" },
    cafe:        { bg: "#F5F5DC", text: "#4B3621", label: "#A0522D" }
};

// 3. GESTION DES CERTIFICATS APPLE
const getCert = (envVar, fileName) => {
    if (process.env[envVar]) return Buffer.from(process.env[envVar], 'base64');
    const p = path.resolve(__dirname, fileName);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

const WWDR = getCert('WWDR_CERT', 'WWDR-pem.pem');
const signerCert = getCert('SIGNER_CERT', 'signer-clean.pem');
const signerKey = getCert('SIGNER_KEY', 'nuvy-pass.key');

// 4. GÉNÉRATEUR DE PASS (AVEC RANG ET DA)
async function generatePassBuffer(client, boutique, clientRank) {
    const modelPath = path.resolve(__dirname, 'pass-model.pass');
    const tmpDir = path.join('/tmp', 'gen-' + crypto.randomBytes(4).toString('hex') + '.pass');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)));
    
    if (boutique.logo_url) {
        try {
            const response = await fetch(boutique.logo_url);
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                fs.writeFileSync(path.join(tmpDir, 'logo.png'), Buffer.from(buffer));
                fs.writeFileSync(path.join(tmpDir, 'logo@2x.png'), Buffer.from(buffer));
            }
        } catch (e) { console.log("Logo skip"); }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    passJson.backgroundColor = boutique.color_bg || "#FAF8F5";
    passJson.foregroundColor = boutique.color_text || "#2A8C9C";
    passJson.labelColor = (STEREOTYPES[boutique.categorie] || STEREOTYPES.default).label;
    
    let dots = "";
    for(let i=1; i<=10; i++) { dots += (i <= client.tampons) ? "● " : "○ "; }
    
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
    passJson.logoText = boutique.nom;
    passJson.storeCard.primaryFields[0].value = prenom;
    passJson.storeCard.primaryFields[0].label = "VOUS ÊTES LE " + clientRank + (clientRank === 1 ? "ER" : "ÈME") + " MEILLEUR CLIENT";
    passJson.storeCard.secondaryFields[0].value = dots;
    
    if (client.recompenses > 0) {
        passJson.storeCard.auxiliaryFields = [{ key: "gifts", label: "RÉCOMPENSES", value: client.recompenses + " 🎁 DISPO" }];
    } else { passJson.storeCard.auxiliaryFields = []; }
    
    passJson.organizationName = boutique.nom;
    passJson.serialNumber = client.serial_number;
    passJson.barcodes = [{ message: client.serial_number, format: "PKBarcodeFormatQR", messageEncoding: "iso-8859-1" }];

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const buf = pass.getAsBuffer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return buf;
}

// 5. ROUTES API
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')));
app.get('/nuvy-ceo-portal', (req, res) => res.sendFile(path.resolve(__dirname, 'admin.html')));

// --- PORTAIL CEO (AVEC GÉNÉRATION LIEN JOIN) ---
app.post('/admin/create-boutique', async (req, res) => {
    try {
        const { nom, username, password, ceoKey, categorie, logo_url } = req.body;
        if (ceoKey !== process.env.CEO_KEY) return res.status(403).json({ message: "CEO Key Error" });
        const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        const da = STEREOTYPES[categorie] || STEREOTYPES.default;
        const join_url = "https://" + req.get('host') + "/join/" + slug;

        const { data, error } = await supabase.from('boutiques').insert([{ 
            nom, slug, username, password, categorie, logo_url, join_url, color_bg: da.bg, color_text: da.text 
        }]).select().single();
        if (error) throw error;
        res.json({ success: true, boutique: data });
    } catch (e) { res.status(400).json({ message: e.message }); }
});

// --- AUTH ---
app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: b } = await supabase.from('boutiques').select('*').eq('username', user).eq('password', pass).single();
    if (b) res.json({ boutiqueId: b.id, slug: b.slug, nom: b.nom }); else res.status(401).send();
});

// --- TAMPONS & NOTIFICATIONS PUSH (LOGIQUE COMPLÈTE) ---
app.post('/clients/:id/tampon', async (req, res) => {
    try {
        const pointsAjoutes = parseInt(req.body.nb);
        const { data: client } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
        
        let total = (client.tampons || 0) + pointsAjoutes;
        let tamponsRestants = Math.max(0, total % 10);
        let nouvellesRecompenses = total >= 10 ? Math.floor(total / 10) : (total < 0 ? -1 : 0);
        let pointsManquants = 10 - tamponsRestants;

        const { data: updated } = await supabase.from('clients').update({ 
            tampons: tamponsRestants, 
            recompenses: Math.max(0, (client.recompenses || 0) + nouvellesRecompenses),
            last_visit: new Date().toISOString() 
        }).eq('id', req.params.id).select().single();
        
        // Notification Push Intelligente
        let pushMsg = `Félicitations ! +${pointsAjoutes} tampon(s).`;
        if (nouvellesRecompenses > 0) {
            pushMsg = `🎉 Bravo ! Votre récompense est prête ! Plus que ${pointsManquants} tampons avant la prochaine.`;
        } else if (pointsAjoutes > 0) {
            pushMsg += ` Plus que ${pointsManquants} tampons pour votre cadeau !`;
        } else {
            pushMsg = "Récompense utilisée ! C'est reparti pour un tour 🎁";
        }

        const { data: devs } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number);
        if (devs && devs.length > 0) {
            const p8 = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : fs.readFileSync(path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
            const provider = new apn.Provider({ token: { key: p8, keyId: 'RM6P22PX7A', teamId: 'Q762BTBA98' }, production: true });
            const notif = new apn.Notification({ topic: 'pass.pro.nuvy.loyalty', alert: pushMsg, sound: 'default' });
            for (const d of devs) { await provider.send(notif, d.push_token); }
            provider.shutdown();
        }
        res.json(updated);
    } catch (e) { res.status(500).send(); }
});

// --- GESTION DES PASS & CLASSEMENT ---
app.get('/pass/:token', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const score = (c.recompenses * 10) + c.tampons;
        let rank = 1;
        all.forEach(o => { if(((o.recompenses||0)*10 + (o.tampons||0)) > score) rank++; });
        const buf = await generatePassBuffer(c, c.boutiques, rank);
        res.set('Content-Type', 'application/vnd.apple.pkpass').send(buf);
    } catch (e) { res.status(500).send(); }
});

// --- INSCRIPTION & NFC ---
app.post('/join/:slug/create', async (req, res) => {
    const { prenom, nom, telephone } = req.body;
    const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();
    const token = crypto.randomUUID();
    const { data } = await supabase.from('clients').insert([{ boutique_id: b.id, nom: prenom + " " + nom, telephone, tampons: 0, recompenses: 0, token, serial_number: 'NUVY-' + token.split('-')[0].toUpperCase(), last_visit: new Date().toISOString() }]).select().single();
    res.json({ token: data.token });
});

app.post('/tap/:slug/notify', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
    if (c) { io.to(req.params.slug).emit('client-detected', c); res.json({success:true}); }
    else res.status(404).send();
});

app.get('/boutiques/:id/clients', async (req, res) => {
    const { data } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false });
    res.json(data || []);
});

io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => { socket.join(slug); });
});

// Apple Registration (WWS)
app.post('/v1/devices/:dId/registrations/:pId/:sN', async (req,res) => {
    await supabase.from('devices').upsert([{ device_id: req.params.dId, push_token: req.body.pushToken, pass_type_id: req.params.pId, serial_number: req.params.sN }]);
    res.status(201).send();
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("--- ⚡ NUVY MASTER ENGINE ONLINE ---"));