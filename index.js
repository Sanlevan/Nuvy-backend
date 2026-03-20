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
app.use(express.static('public')) // Pour tes fichiers CSS/JS si besoin

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// --- CONFIGURATION SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => {
        socket.join(slug);
        console.log(`Boutique connectée au flux live : ${slug}`);
    });
});

// --- CHARGEMENT DES CERTIFICATS APPLE ---
const WWDR = process.env.WWDR_CERT ? Buffer.from(process.env.WWDR_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'WWDR-pem.pem'))
const signerCert = process.env.SIGNER_CERT ? Buffer.from(process.env.SIGNER_CERT, 'base64') : fs.readFileSync(path.resolve(__dirname, 'signer-clean.pem'))
const signerKey = process.env.SIGNER_KEY ? Buffer.from(process.env.SIGNER_KEY, 'base64') : fs.readFileSync(path.resolve(__dirname, 'nuvy-pass.key'))

// --- GÉNÉRATEUR DE PASS WALLET ---
async function generatePassBuffer(tampons, clientNom, serialNumber, boutiqueNom) {
    const modelPath = path.resolve(__dirname, 'pass-model.pass')
    const tmpDir = path.join('/tmp', `gen-${crypto.randomBytes(4).toString('hex')}.pass`)
    
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)))
    
    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'))
    passJson.storeCard.secondaryFields[0].value = tampons >= 10 ? "CADEAU PRÊT ! 🎁" : `${tampons} / 10`
    passJson.storeCard.primaryFields[0].value = clientNom || 'Client'
    passJson.organizationName = boutiqueNom || 'Nuvy'
    passJson.serialNumber = serialNumber
    
    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson))
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } })
    const buffer = pass.getAsBuffer()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return buffer
}

// --- NOTIFICATIONS PUSH APNs ---
async function sendPassUpdate(pushToken) {
    try {
        const p8Key = process.env.APN_KEY ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8') : fs.readFileSync(path.resolve(__dirname, 'AuthKey_RM6P22PX7A.p8')).toString('utf8')
        const provider = new apn.Provider({ token: { key: p8Key, keyId: 'RM6P22PX7A', teamId: 'Q762BTBA98' }, production: true })
        const notification = new apn.Notification()
        notification.topic = 'pass.pro.nuvy.loyalty'
        await provider.send(notification, pushToken)
        provider.shutdown()
    } catch (err) { console.error('Erreur Push:', err); }
}

// --- ROUTES PAGES ---
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')))
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')))

// --- AUTHENTICATION ---
app.post('/auth/login', async (req, res) => {
    const { user, pass } = req.body
    const { data: b } = await supabase.from('boutiques').select('*').eq('username', user).eq('password', pass).single()
    if (b) res.json({ boutiqueId: b.id, slug: b.slug })
    else res.status(401).send('Identifiants incorrects')
})

// --- GESTION DES CLIENTS & TAMPONS ---
app.get('/boutiques/:id/clients', async (req, res) => {
    const { data } = await supabase.from('clients').select('*').eq('boutique_id', req.params.id).order('last_visit', { ascending: false })
    res.json(data)
})

app.post('/clients/:id/tampon', async (req, res) => {
    const { nb } = req.body
    const { data: client } = await supabase.from('clients').select('tampons, serial_number').eq('id', req.params.id).single()
    
    let nouveaux = Math.max(0, Math.min(10, (client.tampons || 0) + (parseInt(nb) || 1)))
    const { data: updated } = await supabase.from('clients').update({ tampons: nouveaux, last_visit: new Date().toISOString() }).eq('id', req.params.id).select().single()

    const { data: devices } = await supabase.from('devices').select('push_token').eq('serial_number', client.serial_number)
    if (devices) { for (const d of devices) { await sendPassUpdate(d.push_token) } }
    res.json(updated)
})

// --- LE "TAP" NFC INTELLIGENT ---
app.get('/tap/:slug', async (req, res) => {
    const { slug } = req.params;
    // Cette page s'affiche une fraction de seconde pour rediriger vers le Wallet ou l'inscription
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Nuvy Tap</title></head>
        <body style="background:#000; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; margin:0;">
            <div style="text-align:center;">
                <p>Connexion à Nuvy...</p>
                <script>
                    const token = localStorage.getItem('nuvy_token');
                    if (!token) {
                        window.location.href = '/join/${slug}';
                    } else {
                        // Notifie le commerçant en arrière-plan
                        fetch('/tap/${slug}/notify?token=' + token, { method: 'POST' });
                        // Ouvre directement le pass Wallet
                        window.location.href = '/pass/' + token;
                    }
                </script>
            </div>
        </body>
        </html>
    `);
});

app.post('/tap/:slug/notify', async (req, res) => {
    const { data: client } = await supabase.from('clients').select('*').eq('token', req.query.token).single()
    if (client) {
        io.to(req.params.slug).emit('client-detected', client)
        res.json({ success: true })
    } else { res.status(404).send() }
})

// --- INSCRIPTION NOUVEAU CLIENT ---
app.get('/join/:slug', (req, res) => res.sendFile(path.resolve(__dirname, 'join.html')))

app.post('/join/:slug/create', async (req, res) => {
    const { data: b } = await supabase.from('boutiques').select('id').eq('slug', req.params.slug).single()
    const token = crypto.randomUUID()
    const serial = 'NUVY-' + token.split('-')[0].toUpperCase()
    
    const { data, error } = await supabase.from('clients').insert([{ 
        boutique_id: b.id, 
        nom: req.body.nom, 
        telephone: req.body.telephone || null,
        tampons: 0, 
        token, 
        serial_number: serial,
        last_visit: new Date().toISOString()
    }]).select().single()

    if (error) return res.status(500).json(error)
    res.json({ token, serialNumber: data.serial_number })
})

// --- ROUTES APPLE WALLET (WWS) ---
app.get('/pass/:token', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*, boutiques(nom)').eq('token', req.params.token).single()
    if (!c) return res.status(404).send('Pass introuvable')
    const buffer = await generatePassBuffer(c.tampons, c.nom, c.serial_number, c.boutiques.nom)
    res.set('Content-Type', 'application/vnd.apple.pkpass').send(buffer)
})

app.post('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    await supabase.from('devices').upsert([{ device_id: req.params.deviceId, push_token: req.body.pushToken, pass_type_id: req.params.passTypeId, serial_number: req.params.serialNumber }])
    res.status(201).send()
})

app.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
    const { data } = await supabase.from('devices').select('serial_number').eq('device_id', req.params.deviceId)
    res.json({ lastUpdated: new Date().toISOString(), serialNumbers: data ? data.map(d => d.serial_number) : [] })
})

app.get('/v1/passes/:passTypeId/:serialNumber', async (req, res) => {
    const { data: c } = await supabase.from('clients').select('*, boutiques(nom)').eq('serial_number', req.params.serialNumber).single()
    const buffer = await generatePassBuffer(c ? c.tampons : 0, c ? c.nom : 'Client', req.params.serialNumber, c?.boutiques?.nom)
    res.set('Content-Type', 'application/vnd.apple.pkpass').set('Last-Modified', new Date().toUTCString()).send(buffer)
})

app.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serialNumber', async (req, res) => {
    await supabase.from('devices').delete().eq('device_id', req.params.deviceId).eq('serial_number', req.params.serialNumber)
    res.status(200).send()
})

const PORT = process.env.PORT || 8080
server.listen(PORT, () => console.log(`Nuvy Engine démarré sur le port ${PORT}`))