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

io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => {
        socket.join(slug);
        console.log("Boutique en ligne : " + slug);
    });
});

const WWDR = process.env.WWDR_CERT ? Buffer.from(process.env.WWDR_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'WWDR-pem.pem'))
const signerCert = process.env.SIGNER_CERT ? Buffer.from(process.env.SIGNER_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'signer-clean.pem'))
const signerKey = process.env.SIGNER_KEY ? Buffer.from(process.env.SIGNER_KEY, 'base64') : fs.readFileSync(path.resolve(__dirname, 'nuvy-pass.key'))

// --- GENERATION DU PASS PREMIUM ---
async function generatePassBuffer(client, boutique, clientRank) {
    const modelPath = path.resolve(__dirname, 'pass-model.pass');
    const tmpDir = path.join('/tmp', 'gen-' + crypto.randomBytes(4).toString('hex') + '.pass');
    
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)));
    
    if (boutique.logo_url) {
        try {
            const response = await fetch(boutique.logo_url);
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(path.join(tmpDir, 'logo.png'), Buffer.from(buffer));
            fs.writeFileSync(path.join(tmpDir, 'logo@2x.png'), Buffer.from(buffer));
        } catch (error) {
            console.log("Erreur logo");
        }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    
    passJson.backgroundColor = boutique.color_bg || "#FAF8F5";
    passJson.labelColor = boutique.color_text || "#AFE3E0";
    passJson.foregroundColor = boutique.color_text || "#2A8C9C";
    
    let dots = "";
    for(let i=1; i<=10; i++) { dots += (i <= client.tampons) ? "● " : "○ "; }
    
    passJson.logoText = boutique.nom || 'Nuvy';
    
    const suffixe = (clientRank === 1) ? "ER" : "ÈME";
    const labelClassement = "VOUS ÊTES LE " + clientRank + suffixe + " MEILLEUR CLIENT CHEZ " + boutique.nom.toUpperCase();
    const prenomClient = client.nom ? client.nom.split(' ')[0] : 'Client';
    
    passJson.storeCard.primaryFields[0].value = prenomClient;
    passJson.storeCard.primaryFields[0].label = labelClassement;

    passJson.storeCard.secondaryFields[0].label = "FIDÉLITÉ";
    passJson.storeCard.secondaryFields[0].value = dots;
    
    // NOUVEAUTÉ : AFFICHAGE DU NOMBRE DE CADEAUX
    const nbRecompenses = client.recompenses || 0;
    if (nbRecompenses > 0) {
        passJson.storeCard.auxiliaryFields = [{
            key: "recompenses",
            label: "CADEAUX DISPONIBLES",
            value: nbRecompenses + " 🎁",
            textAlignment: "PKTextAlignmentCenter",
            changeMessage: "Félicitations, vous avez débloqué un nouveau cadeau : %@"
        }];
    } else {
        passJson.storeCard.auxiliaryFields = [];
    }
    
    passJson.organizationName = boutique.nom || 'Nuvy';
    passJson.serialNumber = client.serial_number;

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const passBuffer = pass.getAsBuffer();
    
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    
    return passBuffer;
}

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')));
app.get('/nuvy-ceo-portal', (req, res) => res.sendFile(path.resolve(__dirname, 'admin.html')));

app.post('/admin/create-boutique', async (req, res) => {
    const { nom, username, password, ceoKey, color_bg, color_text } = req.body;
    if (ceoKey !== process.env.CEO_KEY) return res.status(403).json({ message: "Accès refusé" });
    
    const slug = nom.toLowerCase().trim().replace(/ /g, '-').replace(/[^\w-]+/g, '');
    const { data, error } = await supabase.from('boutiques').insert([{ nom: nom, slug: slug, username: username, password: password, color_bg: color_bg, color_text: color_text }]).select().single();
    if (error) return res.status(400).json(error);
    res.json({ success: true, boutique: data });
});

app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body;
    const { data: b } = await supabase.from('boutiques').select('*').eq('username', user).eq('password', pass).single();
    if (b) res.json({ boutiqueId: b.id, slug: b.slug });
    else res.status(401).send();
});

app.get('/boutiques/:id/clients', async (req, res) => {
    const { data } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false });
    res.json(data || []);
});

app.get('/boutiques/:id/visites', async (req, res) => {
    const { data } = await supabase.from('visites').select('*').eq('boutique_id', req.params.id);
    res.json(data || []);
});

// --- LOGIQUE DE POINTS ET RÉCOMPENSES ---
app.post('/clients/:id/tampon', async (req, res) => {
    const { nb } = req.body;
    const { data: client } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (!client) return res.status(404).send('Client introuvable');

    let totalTampons = (client.tampons || 0) + parseInt(nb);
    let tampons_restants = totalTampons;
    let recompenses_gagnees = 0;

    // Si on dépasse 10, on calcule les cadeaux gagnés et le reste
    if (totalTampons >= 10) {
        recompenses_gagnees = Math.floor(totalTampons / 10); // Ex: 15/10 -> 1 cadeau
        tampons_restants = totalTampons % 10;                // Ex: 15%10 -> 5 restants
    } else if (totalTampons < 0) {
        tampons_restants = 0;
    }

    let nouveau_total_recompenses = (client.recompenses || 0) + recompenses_gagnees;

    const { data: updated } = await supabase.from('clients').update({ 
        tampons: tampons_restants, 
        recompenses: nouveau_total_recompenses,
        last_visit: new Date().toISOString() 
    }).eq('id', req.params.id).select().single();
    
    await supabase.from('visites').insert([{ client_id: client.id, boutique_id: client.boutique_id, points_ajoutes: parseInt(nb) }]);
    
    // Notifications Push Apple
    const { data: devices } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number);
    if (devices && devices.length > 0) {
        const p8 = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : fs.readFileSync(path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
        const provider = new apn.Provider({ token: { key: p8, keyId: 'RM6P22PX7A', teamId: 'Q762BTBA98' }, production: true });
        
        let notifText = "Vous avez reçu " + nb + " point(s) !";
        if (recompenses_gagnees > 0) notifText = "🎉 Félicitations ! Vous avez débloqué une nouvelle récompense !";
        
        const notification = new apn.Notification({ topic: 'pass.pro.nuvy.loyalty', alert: notifText });
        for (const d of devices) { await provider.send(notification, d.push_token); }
        provider.shutdown();
    }
    res.json(updated);
});

// --- NOUVEAU : DONNER LE CADEAU AU CLIENT (-1 RÉCOMPENSE) ---
app.post('/clients/:id/cadeau', async (req, res) => {
    const { data: client } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (!client || !client.recompenses || client.recompenses <= 0) return res.status(400).send('Aucun cadeau dispo');
    
    const { data: updated } = await supabase.from('clients').update({ recompenses: client.recompenses - 1 }).eq('id', req.params.id).select().single();
    
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
    const { data } = await supabase.from('clients').insert([{ boutique_id: b.id, nom: full, telephone: telephone, tampons: 0, recompenses: 0, token: token, serial_number: serial, last_visit: new Date().toISOString() }]).select().single();
    res.json({ token: token, serialNumber: data.serial_number });
});

app.get('/pass/:token', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*, boutiques(*)').eq('token', req.params.token).single();
    if (!c) return res.status(404).send();
    
    // Calcul classement (on prend en compte les récompenses pour départager)
    const scoreClient = (c.recompenses * 10) + c.tampons;
    const { data: allClients } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
    let rank = 1;
    for(let i=0; i<allClients.length; i++) {
        let scoreOther = ((allClients[i].recompenses || 0) * 10) + (allClients[i].tampons || 0);
        if(scoreOther > scoreClient) rank++;
    }

    const buffer = await generatePassBuffer(c, c.boutiques, rank);
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
    const {data:c} = await supabase.from('clients').select('*, boutiques(*)').eq('serial_number', req.params.sN).single();
    if (!c) return res.status(404).send();
    
    const scoreClient = ((c.recompenses||0) * 10) + c.tampons;
    const { data: allClients } = await supabase.from('clients').select('tampons, recompenses').eq('boutique_id', c.boutique_id);
    let rank = 1;
    for(let i=0; i<allClients.length; i++) {
        let scoreOther = ((allClients[i].recompenses || 0) * 10) + (allClients[i].tampons || 0);
        if(scoreOther > scoreClient) rank++;
    }

    const buffer = await generatePassBuffer(c, c.boutiques, rank);
    res.set('Content-Type', 'application/vnd.apple.pkpass').set('Last-Modified', new Date().toUTCString()).send(buffer);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log("Nuvy Master Online sur " + PORT));