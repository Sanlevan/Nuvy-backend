require('dotenv').config()
const express = require('express')
const { createClient } = require('@supabase/supabase-js')
const { PKPass } = require('passkit-generator')
const apn = require('apn')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { Server } = require('socket.io')
const http = require('http')

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })

app.use(express.json())
app.use(express.static('public'))

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// --- LIVE CONNECT ---
io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => {
        socket.join(slug);
        console.log("Boutique en ligne : " + slug);
    });
});

// --- APPLE WALLET CONFIG ---
const WWDR = process.env.WWDR_CERT ? Buffer.from(process.env.WWDR_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'WWDR-pem.pem'))
const signerCert = process.env.SIGNER_CERT ? Buffer.from(process.env.SIGNER_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'signer-clean.pem'))
const signerKey = process.env.SIGNER_KEY ? Buffer.from(process.env.SIGNER_KEY, 'base64') : fs.readFileSync(path.resolve(__dirname, 'nuvy-pass.key'))

// --- GENERATION DU PASS (CO-BRANDING INCLUS) ---
async function generatePassBuffer(tampons, clientNom, serialNumber, boutiqueNom, boutiqueLogoUrl) {
    const modelPath = path.resolve(__dirname, 'pass-model.pass');
    const tmpDir = path.join('/tmp', 'gen-' + crypto.randomBytes(4).toString('hex') + '.pass');
    
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)));
    
    // Gestion du logo personnalisé (téléchargement si URL fournie)
    if (boutiqueLogoUrl) {
        try {
            const response = await fetch(boutiqueLogoUrl);
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(path.join(tmpDir, 'logo.png'), Buffer.from(buffer));
            fs.writeFileSync(path.join(tmpDir, 'logo@2x.png'), Buffer.from(buffer));
        } catch (error) {
            console.log("Impossible de charger le logo de la boutique, on garde Nuvy par défaut.");
        }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    
    // DA PREMIUM NUVY
    passJson.backgroundColor = "rgb(250, 248, 245)";
    passJson.labelColor = "rgb(175, 227, 224)";
    passJson.foregroundColor = "rgb(42, 140, 156)";
    
    let dots = "";
    for(let i=1; i<=10; i++) { dots += (i <= tampons) ? "● " : "○ "; }
    
    // CO-BRANDING : Nom de la boutique en haut
    passJson.logoText = boutiqueNom || 'Nuvy';
    
    passJson.storeCard.secondaryFields[0].label = "FIDÉLITÉ";
    passJson.storeCard.secondaryFields[0].value = dots;
    passJson.storeCard.auxiliaryFields[0].label = "PROGRESSION";
    passJson.storeCard.auxiliaryFields[0].value = tampons >= 10 ? "CADEAU PRÊT ! 🎁" : tampons + " / 10 TAMPONS";
    passJson.storeCard.primaryFields[0].value = clientNom || 'Client';
    passJson.organizationName = boutiqueNom || 'Nuvy';
    passJson.serialNumber = serialNumber;

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const passBuffer = pass.getAsBuffer();
    
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    
    return passBuffer;
}

// --- ROUTES PAGES ---
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')));
app.get('/nuvy-ceo-portal', (req, res) => res.sendFile(path.resolve(__dirname, 'admin.html')));

// --- API CEO : CRÉATION DE BOUTIQUE ---
app.post('/admin/create-boutique', async (req, res) => {
    const { nom, username, password, ceoKey } = req.body;
    
    // Vérification de sécurité CEO
    if (ceoKey !== process.env.CEO_KEY) {
        return res.status(403).json({ message: "Accès refusé : Code CEO invalide" });
    }
    
    const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
    const { data, error } = await supabase.from('boutiques').insert([{ nom: nom, slug: slug, username: username, password: password }]).select().single();
    
    if (error) return res.status(400).json(error);
    res.json({ success: true, boutique: data });
});

// --- API AUTH COMMERÇANT ---
app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: b } = await supabase.from('boutiques').select('*').eq('username', user).eq('password', pass).single();
    if (b) res.json({ boutiqueId: b.id, slug: b.slug });
    else res.status(401).send();
});

// --- API DATA ---
app.get('/boutiques/:id/clients', async (req, res) => {
    const { data } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false });
    res.json(data || []);
});

app.get('/boutiques/:id/visites', async (req, res) => {
    const { data } = await supabase.from('visites').select('*').eq('boutique_id', req.params.id);
    res.json(data || []);
});

app.post('/clients/:id/tampon', async (req, res) => {
    const { nb } = req.body;
    const { data: client } = await supabase.from('clients').select('id, boutique_id, tampons, serial_number').eq('id', req.params.id).single();
    if (!client) return res.status(404).send('Client introuvable');

    let nouveaux = Math.max(0, Math.min(10, (client.tampons || 0) + parseInt(nb)));
    const { data: updated } = await supabase.from('clients').update({ tampons: nouveaux, last_visit: new Date().toISOString() }).eq('id', req.params.id).select().single();
    await supabase.from('visites').insert([{ client_id: client.id, boutique_id: client.boutique_id, points_ajoutes: parseInt(nb) }]);
    
    // Notifications Push Apple WWS
    const { data: devices } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number);
    if (devices && devices.length > 0) {
        const p8 = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : fs.readFileSync(path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
        const provider = new apn.Provider({ token: { key: p8, keyId: 'RM6P22PX7A', teamId: 'Q762BTBA98' }, production: true });
        const notification = new apn.Notification({ topic: 'pass.pro.nuvy.loyalty' });
        for (const d of devices) { await provider.send(notification, d.push_token); }
        provider.shutdown();
    }
    
    res.json(updated);
});

// --- FLUX NFC ---
app.get('/tap/:slug', async (req, res) => {
    const slug = req.params.slug;
    res.send("<html><body style='background:#FAF8F5;'><script>const t = localStorage.getItem('nuvy_token'); if(!t) { window.location.href='/join/" + slug + "'; } else { fetch('/tap/" + slug + "/notify?token='+t, {method:'POST'}); window.location.href='/pass/'+t; }</script></body></html>");
});

app.post('/tap/:slug/notify', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*').eq('token', req.query.token).single();
    if (c) { io.to(req.params.slug).emit('client-detected', c); res.json({success:true}); }
    else res.status(404).send();
});

app.post('/join/:slug/create', async (req, res) => {
    const { prenom, nom, telephone } = req.body;
    const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();
    const token = crypto.randomUUID();
    const serial = 'NUVY-' + token.split('-')[0].toUpperCase();
    const full = prenom + " " + nom;
    const { data } = await supabase.from('clients').insert([{ boutique_id: b.id, nom: full, telephone: telephone, tampons: 0, token: token, serial_number: serial, last_visit: new Date().toISOString() }]).select().single();
    res.json({ token: token, serialNumber: data.serial_number });
});

// --- ROUTES APPLE WALLET (CO-BRANDING) ---
app.get('/pass/:token', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*, boutiques(nom, logo_url)').eq('token', req.params.token).single();
    const buffer = await generatePassBuffer(c.tampons, c.nom, c.serial_number, c.boutiques.nom, c.boutiques.logo_url);
    res.set('Content-Type', 'application/vnd.apple.pkpass').send(buffer);
});

app.post('/v1/devices/:dId/registrations/:pId/:sN', async (req,res) => {
    await supabase.from('devices').upsert([{ device_id: req.params.dId, push_token: req.body.pushToken, pass_type_id: req.params.pId, serial_number: req.params.sN }]);
    res.status(201).send();
});

app.get('/v1/devices/:dId/registrations/:pId', async (req,res) => {
    const {data} = await supabase.from('devices').select('serial_number').eq('device_id', req.params.dId);
    res.json({ lastUpdated: new Date().toISOString(), serialNumbers: data ? data.map(d=>d.serial_number) : [] });
});

app.get('/v1/passes/:pId/:sN', async (req,res) => {
    const {data:c} = await supabase.from('clients').select('*, boutiques(nom, logo_url)').eq('serial_number', req.params.sN).single();
    const buffer = await generatePassBuffer(c?c.tampons:0, c?c.nom:'Client', req.params.sN, c?.boutiques?.nom, c?.boutiques?.logo_url);
    res.set('Content-Type', 'application/vnd.apple.pkpass').set('Last-Modified', new Date().toUTCString()).send(buffer);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Nuvy Master Online sur " + PORT));