const { jwt, googleCredentials, GOOGLE_ISSUER_ID, supabase, SYMBOLS } = require('../config');

function generateGoogleWalletLink(client, boutique) {
    const classId = `${GOOGLE_ISSUER_ID}.${boutique.slug}`;
    const objectId = `${GOOGLE_ISSUER_ID}.${client.id}`;
    const maxT = boutique.max_tampons || 10;
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';

    const GOOGLE_COLORS = {
        default: "#2A8C9C", boulangerie: "#8B4513", pizza: "#CD5C5C",
        onglerie: "#C71585", coiffeur: "#191970", cafe: "#4B3621"
    };
    const bgColor = GOOGLE_COLORS[boutique.categorie] || GOOGLE_COLORS.default;

    const defaultSymbols = SYMBOLS[boutique.categorie] || SYMBOLS.default;
    const symbolePlein = boutique.emoji_full || defaultSymbols.full || "⭐";
    const symboleVide = boutique.emoji_empty || defaultSymbols.empty || "⚪";
    let fideliteTexte = "";
    for (let i = 0; i < maxT; i++) { fideliteTexte += (i < (client.tampons || 0)) ? symbolePlein : symboleVide; }

    const rang = client._rang || 1;
    const suffixe = rang === 1 ? "er" : "ème";

    const textModules = [];
    textModules.push({ header: "Votre fidélité", body: fideliteTexte, id: "fidelite" });
    textModules.push({ header: "Classement", body: `${rang}${suffixe} meilleur client 🏆`, id: "rang" });
    if ((client.recompenses || 0) > 0) {
        textModules.push({ header: "Cadeaux disponibles 🎁", body: `${client.recompenses} cadeau${client.recompenses > 1 ? 'x' : ''} à récupérer !`, id: "cadeaux" });
    }
    if (boutique.adresse) textModules.push({ header: "Adresse", body: boutique.adresse, id: "adresse" });
    if (boutique.telephone) textModules.push({ header: "Contact", body: boutique.telephone, id: "telephone" });

    const payload = {
        iss: googleCredentials.client_email,
        aud: 'google',
        typ: 'savetowallet',
        origins: [],
        payload: {
            loyaltyClasses: [{
                id: classId,
                issuerName: "Nuvy",
                programName: boutique.nom || "Fidélité",
                programLogo: boutique.logo_url ? { sourceUri: { uri: boutique.logo_url } } : undefined,
                reviewStatus: "APPROVED",
                hexBackgroundColor: bgColor,
                localizedIssuerName: { defaultValue: { language: "fr", value: boutique.nom || "Nuvy" } },
                locations: boutique.latitude && boutique.longitude ? [{ latitude: parseFloat(boutique.latitude), longitude: parseFloat(boutique.longitude) }] : [],
                linksModuleData: {
                    uris: [
                        { uri: `https://nuvy.pro/join/${boutique.slug}`, description: "Carte de fidélité", id: "link-fidelite" },
                        ...(boutique.google_review_url ? [{ uri: boutique.google_review_url, description: "⭐ Laisser un avis Google", id: "link-avis" }] : []),
                        { uri: `https://nuvy.pro/mon-compte/${client.token}`, description: "Mon espace Nuvy", id: "link-compte" }
                    ]
                },
                secondaryLoyaltyPoints: {
                    label: "Cadeaux 🎁",
                    balance: { int: client.recompenses || 0 }
                }
            }],
            loyaltyObjects: [{
                id: objectId,
                classId: classId,
                state: "ACTIVE",
                accountId: client.id.toString(),
                accountName: `${client.nom} — ${rang}${suffixe} meilleur client`,
                header: { defaultValue: { language: "fr", value: `Bonjour ${prenom} ! 👋` } },
                loyaltyPoints: { label: "Tampons", balance: { string: fideliteTexte } },
                textModulesData: textModules
            }]
        }
    };

    const token = jwt.sign(payload, googleCredentials.private_key, { algorithm: 'RS256' });
    return `https://pay.google.com/gp/v/save/${token}`;
}

async function getGoogleAccessToken() {
    const authClaim = {
        iss: googleCredentials.client_email,
        scope: "https://www.googleapis.com/auth/wallet_object.issuer",
        aud: "https://oauth2.googleapis.com/token",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000)
    };
    const authToken = jwt.sign(authClaim, googleCredentials.private_key, { algorithm: 'RS256' });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: authToken })
    });
    const { access_token } = await tokenRes.json();
    return access_token;
}

async function updateGoogleWalletPass(client) {
    if (!googleCredentials) return;
    try {
        const objectId = `${GOOGLE_ISSUER_ID}.${client.id}`;
        const { data: boutique } = await supabase.from('boutiques').select('max_tampons, categorie, emoji_full, emoji_empty').eq('id', client.boutique_id).single();
        const maxT = boutique?.max_tampons || 10;
        const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';

        const defaultSymbols = SYMBOLS[boutique?.categorie] || SYMBOLS.default;
        const symbolePlein = boutique?.emoji_full || defaultSymbols.full || "⭐";
        const symboleVide = boutique?.emoji_empty || defaultSymbols.empty || "⚪";
        let fideliteTexte = "";
        for (let i = 0; i < maxT; i++) { fideliteTexte += (i < (client.tampons || 0)) ? symbolePlein : symboleVide; }

        const messages = [{ header: `Bonjour ${prenom} ! 👋`, body: fideliteTexte, id: "fidelite" }];
        if ((client.recompenses || 0) > 0) {
            messages.push({ header: "Cadeaux disponibles 🎁", body: `${client.recompenses} cadeau${client.recompenses > 1 ? 'x' : ''} à récupérer !`, id: "cadeaux" });
        }

        const access_token = await getGoogleAccessToken();
        await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                loyaltyPoints: { label: "Tampons", balance: { string: `${client.tampons || 0} / ${maxT}` } },
                textModulesData: messages
            })
        });
        console.log(`✅ [GOOGLE WALLET] Carte mise à jour pour ${client.nom}`);
    } catch (e) {
        console.error("⚠️ [GOOGLE WALLET] Erreur:", e.message);
    }
}

async function pushMessageToAllGoogleCards(boutiqueId, message) {
    if (!googleCredentials) return 0;
    try {
        const { data: allClients } = await supabase.from('clients').select('id, nom, tampons, recompenses').eq('boutique_id', boutiqueId);
        if (!allClients || allClients.length === 0) return 0;

        const { data: bout } = await supabase.from('boutiques').select('max_tampons, categorie, emoji_full, emoji_empty').eq('id', boutiqueId).single();
        const maxT = bout?.max_tampons || 10;
        const access_token = await getGoogleAccessToken();

        let updated = 0;
        for (const c of allClients) {
            try {
                const objectId = `${GOOGLE_ISSUER_ID}.${c.id}`;
                const prenom = c.nom ? c.nom.split(' ')[0] : 'Client';
                const defaultSymbols = SYMBOLS[bout?.categorie] || SYMBOLS.default;
                const symbolePlein = bout?.emoji_full || defaultSymbols.full || "⭐";
                const symboleVide = bout?.emoji_empty || defaultSymbols.empty || "⚪";
                let fideliteTexte = "";
                for (let i = 0; i < maxT; i++) { fideliteTexte += (i < (c.tampons || 0)) ? symbolePlein : symboleVide; }

                const msgs = [
                    { header: `Bonjour ${prenom} ! 👋`, body: fideliteTexte, id: "fidelite" },
                    { header: "📢 Message de la boutique", body: message, id: "promo" }
                ];
                if ((c.recompenses || 0) > 0) {
                    msgs.push({ header: "Cadeaux disponibles 🎁", body: `${c.recompenses} cadeau${c.recompenses > 1 ? 'x' : ''} à récupérer !`, id: "cadeaux" });
                }

                await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${objectId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ textModulesData: msgs })
                });
                updated++;
            } catch (_) {}
        }
        return updated;
    } catch (e) {
        console.error("⚠️ [GOOGLE PUSH] Erreur:", e.message);
        return 0;
    }
}

// ============================================================
// pushMessageToSingleGoogleCard
// Envoie un message de relance à une carte Google Wallet individuelle
// Le message apparaît dans le bandeau de la carte lors de la prochaine ouverture
// ============================================================
async function pushMessageToSingleGoogleCard(serialNumber, message) {
    try {
        // Récupérer le client via son serial_number
        const { supabase } = require('../config');
        const { data: client } = await supabase
            .from('clients')
            .select('id, token, boutique_id')
            .eq('serial_number', serialNumber)
            .maybeSingle();

        if (!client) return { success: false, reason: 'Client introuvable' };

        // Récupérer la boutique pour le Google Issuer ID
        const { data: boutique } = await supabase
            .from('boutiques')
            .select('slug')
            .eq('id', client.boutique_id)
            .single();

        if (!boutique) return { success: false, reason: 'Boutique introuvable' };

        // Construire l'Object ID Google Wallet
        // Format : {issuerId}.{slug}-{token}
        const GOOGLE_ISSUER_ID = process.env.GOOGLE_ISSUER_ID;
        const objectId = `${GOOGLE_ISSUER_ID}.${boutique.slug}-${client.token}`;

        // Authentification Google
        const { GoogleAuth } = require('google-auth-library');
        const credentials = JSON.parse(
            process.env.GOOGLE_CREDENTIALS ||
            require('fs').readFileSync(require('path').resolve(__dirname, '..', 'google-credentials.json'), 'utf8')
        );
        const auth = new GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/wallet_object.issuer']
        });
        const authClient = await auth.getClient();
        const accessToken = (await authClient.getAccessToken()).token;

        // Appel API Google Wallet — PATCH pour mettre à jour le message
        const url = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                textModulesData: [{
                    header: 'Message de votre boutique',
                    body: message,
                    id: 'relance_message'
                }]
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`Google Wallet patch error pour ${objectId}:`, err);
            return { success: false, reason: err };
        }

        return { success: true };
    } catch (e) {
        console.error('pushMessageToSingleGoogleCard error:', e.message);
        return { success: false, reason: e.message };
    }
}

module.exports = { generateGoogleWalletLink, updateGoogleWalletPass, pushMessageToAllGoogleCards, pushMessageToSingleGoogleCard };