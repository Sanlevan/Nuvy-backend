require('dotenv').config();
console.log("--- DEMARRAGE NUVY ---");

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
app.use(express.static('public'));

console.log("Connexion Supabase...");
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

// Vérification des certificats
console.log("Chargement certificats Apple...");
const getCert = (envVar, fileName) => {
    if (process.env[envVar]) return Buffer.from(process.env[envVar], 'base64');
    const p = path.resolve(__dirname, fileName);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

const WWDR = getCert('WWDR_CERT', 'WWDR-pem.pem');
const signerCert = getCert('SIGNER_CERT', 'signer-clean.pem');
const signerKey = getCert('SIGNER_KEY', 'nuvy-pass.key');

if (!WWDR || !signerCert || !signerKey) {
    console.log("⚠️ ATTENTION : Certains certificats sont absents !");
} else {
    console.log("✅ Certificats chargés.");
}

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
    
    // DA INTELLIGENTE
    let finalColorBg = "#FAF8F5", finalColorText = "#2A8C9C", finalLabelColor = "#AFE3E0";
    const url = boutique.logo_url || "";
    if (url.includes("3132693.png")) { finalColorBg = "#FFFAFA"; finalColorText = "#CD5C5C"; finalLabelColor = "#FFA07A"; }
    else if (url.includes("992744.png")) { finalColorBg = "#FAF0E6"; finalColorText = "#8B4513"; finalLabelColor = "#CD853F"; }
    else if (url.includes("2821012.png")) { finalColorBg = "#F8F8F8"; finalColorText = "#191970"; finalLabelColor = "#B0C4DE"; }
    else if (url.includes("3567086.png")) { finalColorBg = "#FFF0F5"; finalColorText = "#C71585"; finalLabelColor = "#FFB6C1"; }
    else if (url.includes("2738730.png")) { finalColorBg = "#F5F5DC"; finalColorText = "#4B3621"; finalLabelColor = "#A0522D"; }

    passJson.backgroundColor = finalColorBg;
    passJson.foregroundColor = finalColorText;
    passJson.labelColor = finalLabelColor;
    
    let dots = "";
    for(let i=1; i<=10; i++) { dots += (i <= client.tampons) ? "● " : "○ "; }
    
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
    passJson.logoText = boutique.nom || 'Nuvy';
    passJson.storeCard.primaryFields[0].value = prenom;
    passJson.storeCard.primaryFields[0].label = "VOUS ÊTES LE " + clientRank + (clientRank === 1 ? "ER" : "ÈME") + " MEILLEUR CLIENT";
    passJson.storeCard.secondaryFields[0].value = dots;
    
    if (client.tampons >= 10) {
        passJson.storeCard.auxiliaryFields = [{ key: "status", label: "RÉCOMPENSE", value: "CADEAU DÉBLOQUÉ 🎁" }];
    } else { passJson.storeCard.auxiliaryFields = []; }
    
    passJson.organizationName = boutique.nom || 'Nuvy';
    passJson.serialNumber = client.serial_number;

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const buf = pass.getAsBuffer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return buf;
}

app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')));
app.get('/nuvy-ceo-portal', (req, res) => res.sendFile(path.resolve(__dirname, 'admin.html')));

app.post('/admin/create-boutique', async (req, res) => {
    const { nom, username, password, ceoKey, logo_url } = req.body;
    if (ceoKey !== process.env.CEO_KEY) return res.status(403).json({ message: "Clé CEO invalide" });
    const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
    const { data, error } = await supabase.from('boutiques').insert([{ nom, slug, username, password, logo_url }]).select().single();
    if (error) return res.status(400).json(error);
    res.json({ success: true, boutique: data });
});

app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: b } = await supabase.from('boutiques').select('*').eq('username', user).eq('password', pass).single();
    if (b) res.json({ boutiqueId: b.id, slug: b.slug }); else res.status(401).send();
});

app.get('/pass/:token', async (req, res) => {
    try {
        const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
        const { data: all } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
        const score = (c.recompenses * 10) + c.tampons;
        let rank = 1;
        all.forEach(other => { if(((other.recompenses||0)*10 + (other.tampons||0)) > score) rank++; });
        const buffer = await generatePassBuffer(c, c.boutiques, rank);
        res.set('Content-Type', 'application/vnd.apple.pkpass').send(buffer);
    } catch (e) { res.status(500).send("Pass Error"); }
});

app.post('/join/:slug/create', async (req, res) => {
    const { prenom, nom, telephone } = req.body;
    const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single();
    const token = crypto.randomUUID();
    const { data } = await supabase.from('clients').insert([{ boutique_id: b.id, nom: prenom + " " + nom, telephone, tampons: 0, recompenses: 0, token, serial_number: 'NUVY-' + token.split('-')[0].toUpperCase(), last_visit: new Date().toISOString() }]).select().single();
    res.json({ token: data.token });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log("--- NUVY EST EN LIGNE SUR LE PORT " + PORT + " ---");
});