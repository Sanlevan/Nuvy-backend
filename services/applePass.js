const { PKPass } = require('passkit-generator');
const apn = require('@parse/node-apn');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { supabase, STEREOTYPES, SYMBOLS } = require('../config');

const getCert = (envVar, fileName) => {
    if (process.env[envVar]) return Buffer.from(process.env[envVar], 'base64');
    const p = path.resolve(__dirname, '..', fileName);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
};
const WWDR = getCert('WWDR_CERT', 'WWDR-pem.pem');
const signerCert = getCert('SIGNER_CERT', 'signer-clean.pem');
const signerKey = getCert('SIGNER_KEY', 'nuvy-pass.key');

async function generatePassBuffer(client, boutique, clientRank, hostUrl) {
    const modelPath = path.resolve(__dirname, '..', 'pass-model.pass');
    const tmpDir = path.join('/tmp', 'gen-' + crypto.randomBytes(4).toString('hex') + '.pass');

    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    fs.readdirSync(modelPath).forEach(f => fs.copyFileSync(path.join(modelPath, f), path.join(tmpDir, f)));

    if (boutique.logo_url && boutique.logo_url.trim() !== "") {
        try {
            const response = await fetch(boutique.logo_url);
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                const logo3x = await sharp(buffer).resize(480, 150, { fit: 'inside' }).png().toBuffer();
                const logo2x = await sharp(buffer).resize(320, 100, { fit: 'inside' }).png().toBuffer();
                const logo1x = await sharp(buffer).resize(160, 50, { fit: 'inside' }).png().toBuffer();
                const icon3x = await sharp(buffer).resize(87, 87, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                const icon2x = await sharp(buffer).resize(58, 58, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                const icon1x = await sharp(buffer).resize(29, 29, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
                fs.writeFileSync(path.join(tmpDir, 'logo@3x.png'), logo3x);
                fs.writeFileSync(path.join(tmpDir, 'logo@2x.png'), logo2x);
                fs.writeFileSync(path.join(tmpDir, 'logo.png'), logo1x);
                fs.writeFileSync(path.join(tmpDir, 'icon@3x.png'), icon3x);
                fs.writeFileSync(path.join(tmpDir, 'icon@2x.png'), icon2x);
                fs.writeFileSync(path.join(tmpDir, 'icon.png'), icon1x);
            }
        } catch (e) {
            console.error("❌ CRASH TRAITEMENT IMAGE :", e.message);
        }
    }

    const passJson = JSON.parse(fs.readFileSync(path.join(tmpDir, 'pass.json'), 'utf8'));
    delete passJson.barcode;
    delete passJson.barcodes;

    passJson.backgroundColor = boutique.color_bg || "#FAF8F5";
    passJson.foregroundColor = boutique.color_text || "#2A8C9C";
    passJson.labelColor = boutique.color_label || (STEREOTYPES[boutique.categorie] || STEREOTYPES.default).label;

    if (boutique.strip_enabled && boutique.strip_image_url) {
        try {
            const stripResp = await fetch(boutique.strip_image_url);
            if (stripResp.ok) {
                const stripBuf = Buffer.from(await stripResp.arrayBuffer());
                const strip3x = await sharp(stripBuf).resize(1125, 369, { fit: 'cover', position: 'attention' }).png().toBuffer();
                const strip2x = await sharp(stripBuf).resize(750, 246, { fit: 'cover', position: 'attention' }).png().toBuffer();
                const strip1x = await sharp(stripBuf).resize(375, 123, { fit: 'cover', position: 'attention' }).png().toBuffer();
                fs.writeFileSync(path.join(tmpDir, 'strip@3x.png'), strip3x);
                fs.writeFileSync(path.join(tmpDir, 'strip@2x.png'), strip2x);
                fs.writeFileSync(path.join(tmpDir, 'strip.png'), strip1x);
            }
        } catch (e) {
            console.error("⚠️ Erreur traitement strip:", e.message);
        }
    }

    passJson.serialNumber = client.serial_number;
    passJson.authenticationToken = client.token;
    if (hostUrl) { passJson.webServiceURL = `https://${hostUrl}`; }

    passJson.organizationName = boutique.nom || "Fidélité";
    passJson.description = `Carte de fidélité ${boutique.nom || ""}`;
    passJson.logoText = (boutique.nom && boutique.nom.trim() !== "") ? boutique.nom : "Fidélité";

    if (boutique.latitude && boutique.longitude) {
        passJson.locations = [{
            latitude: parseFloat(boutique.latitude),
            longitude: parseFloat(boutique.longitude),
            relevantText: `Votre carte ${boutique.nom || "de fidélité"} est prête à être scannée !`
        }];
        passJson.maxDistance = 10;
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
    const defaultSymbols = SYMBOLS[boutique.categorie] || SYMBOLS.default;
    const symbolePlein = boutique.emoji_full || defaultSymbols.full || "⭐";
    const symboleVide = boutique.emoji_empty || defaultSymbols.empty || "⚪";
    let fideliteTexte = "";
    for (let i = 0; i < maxT; i++) { fideliteTexte += (i < (client.tampons || 0)) ? symbolePlein : symboleVide; }

    const hasStrip = boutique.strip_enabled && boutique.strip_image_url;

    const backFields = [
        {
            "key": "promo",
            "label": "DERNIÈRE INFO DE LA BOUTIQUE",
            "value": boutique.last_push_message || "Aucune actualité pour le moment.",
            "changeMessage": "%@"
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
        },
        ...(boutique.google_review_url ? [{
            "key": "avis",
            "label": "DONNEZ-NOUS VOTRE AVIS ⭐",
            "value": boutique.google_review_url,
            "dataDetectorTypes": ["PKDataDetectorTypeLink"]
        }] : []),
        {
            "key": "compte",
            "label": "MON ESPACE NUVY",
            "value": `https://nuvy.pro/mon-compte/${client.token}`,
            "dataDetectorTypes": ["PKDataDetectorTypeLink"]
        }
    ];

    let layout;
    if (hasStrip) {
        layout = {
            "headerFields": [{
                "key": "score_header",
                "label": "TAMPONS",
                "value": `${client.tampons || 0} / ${maxT}`,
                "textAlignment": "PKTextAlignmentRight",
                "changeMessage": "Nouveau solde : %@ ✨"
            }],
            "primaryFields": [],
            "secondaryFields": [{
                "key": "fidelite",
                "label": "VOTRE FIDÉLITÉ",
                "value": fideliteTexte,
                "textAlignment": "PKTextAlignmentLeft"
            }],
            "auxiliaryFields": [],
            "backFields": backFields
        };
    } else {
        layout = {
            "headerFields": [{
                "key": "score_header",
                "label": "TAMPONS",
                "value": `${client.tampons || 0} / ${maxT}`,
                "textAlignment": "PKTextAlignmentRight",
                "changeMessage": "Nouveau solde : %@ ✨"
            }],
            "primaryFields": [{
                "key": "bienvenue",
                "label": `${vraiRang}${suffixe} meilleur client 🏆`,
                "value": `${prenom} 👋`
            }],
            "secondaryFields": [{
                "key": "fidelite",
                "label": "VOTRE FIDÉLITÉ",
                "value": fideliteTexte,
                "textAlignment": "PKTextAlignmentLeft"
            }],
            "auxiliaryFields": [],
            "backFields": backFields
        };
    }

    if (client.recompenses && client.recompenses > 0) {
        layout.secondaryFields.push({
            "key": "cadeaux",
            "label": "CADEAUX",
            "value": `${client.recompenses} 🎁`,
            "textAlignment": "PKTextAlignmentRight",
            "changeMessage": "Vos cadeaux : %@ 🎁"
        });
    }

    passJson.storeCard = layout;

    fs.writeFileSync(path.join(tmpDir, 'pass.json'), JSON.stringify(passJson));
    const pass = await PKPass.from({ model: tmpDir, certificates: { wwdr: WWDR, signerCert, signerKey } });
    const buf = pass.getAsBuffer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return buf;
}

async function refreshAllPasses(boutiqueId) {
    try {
        const { data: clients } = await supabase.from('clients').select('serial_number').eq('boutique_id', boutiqueId);
        if (!clients || clients.length === 0) return { sent: 0 };

        const serials = clients.map(c => c.serial_number).filter(Boolean);
        if (serials.length === 0) return { sent: 0 };

        const { data: devices } = await supabase.from('devices').select('push_token').in('serial_number', serials);
        if (!devices || devices.length === 0) return { sent: 0 };

        const p8Key = process.env.APN_KEY
            ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8')
            : fs.readFileSync(path.resolve(__dirname, '..', 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
        const provider = new apn.Provider({
            token: { key: p8Key, keyId: process.env.APPLE_KEY_ID || 'RM6P22PX7A', teamId: process.env.APPLE_TEAM_ID || 'Q762BTBA98' },
            production: true
        });
        const notification = new apn.Notification();
        notification.topic = 'pass.pro.nuvy.loyalty';
        notification.payload = { action: "update_pass" };

        let sent = 0;
        for (const d of devices) {
            try { await provider.send(notification, d.push_token); sent++; } catch (_) {}
        }
        provider.shutdown();
        return { sent };
    } catch (e) {
        console.error("Erreur refresh passes:", e.message);
        return { sent: 0, error: e.message };
    }
}

async function sendPushToDevices(serialNumbers) {
    if (!serialNumbers || serialNumbers.length === 0) return { sent: 0 };
    const { data: devices } = await supabase.from('devices').select('push_token').in('serial_number', serialNumbers);
    if (!devices || devices.length === 0) return { sent: 0 };

    const p8Key = process.env.APN_KEY
        ? Buffer.from(process.env.APN_KEY, 'base64').toString('utf8')
        : fs.readFileSync(path.resolve(__dirname, '..', 'AuthKey_RM6P22PX7A.p8')).toString('utf8');
    const provider = new apn.Provider({
        token: { key: p8Key, keyId: process.env.APPLE_KEY_ID || 'RM6P22PX7A', teamId: process.env.APPLE_TEAM_ID || 'Q762BTBA98' },
        production: true
    });
    const notification = new apn.Notification();
    notification.topic = 'pass.pro.nuvy.loyalty';
    notification.payload = { action: "update_pass" };

    let sent = 0;
    for (const d of devices) {
        try { await provider.send(notification, d.push_token); sent++; } catch (e) { console.error("Push error:", e.message); }
    }
    provider.shutdown();
    return { sent, total: devices.length };
}

module.exports = { generatePassBuffer, refreshAllPasses, sendPushToDevices };