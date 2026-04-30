const { jwt, googleCredentials, GOOGLE_ISSUER_ID, supabase, SYMBOLS, STEREOTYPES } = require('../config');

// ============================================================
// Helpers
// ============================================================

// Format unifié de l'objectId Google Wallet
// Doit être identique dans generateGoogleWalletLink, updateGoogleWalletPass
// et pushMessageToSingleGoogleCard
function buildObjectId(clientId) {
    return `${GOOGLE_ISSUER_ID}.${clientId}`;
}

function buildClassId(boutiqueSlug) {
    return `${GOOGLE_ISSUER_ID}.${boutiqueSlug}`;
}

// Couleur de fond : respecte la perso Pro du commerçant,
// sinon fallback sur la couleur par catégorie, sinon Nuvy default
function resolveBackgroundColor(boutique) {
    if (boutique.color_bg) return boutique.color_bg;
    const defaults = STEREOTYPES[boutique.categorie] || STEREOTYPES.default;
    return defaults.bg || '#2A8C9C';
}

// Construit la barre de fidélité en texte (emojis)
function buildFideliteTexte(boutique, tampons) {
    const maxT = boutique.max_tampons || 10;
    const defaultSymbols = SYMBOLS[boutique.categorie] || SYMBOLS.default;
    const symbolePlein = boutique.emoji_full || defaultSymbols.full || '⭐';
    const symboleVide = boutique.emoji_empty || defaultSymbols.empty || '⚪';
    let texte = '';
    for (let i = 0; i < maxT; i++) {
        texte += (i < (tampons || 0)) ? symbolePlein : symboleVide;
    }
    return texte;
}

// Construit le rang affiché
function buildRangLabel(rang) {
    const suffixe = rang === 1 ? 'er' : 'ème';
    return `${rang}${suffixe} meilleur client 🏆`;
}

// Construit les textModulesData complets, alignés sur les backFields Apple
function buildTextModules(client, boutique, rang) {
    const fideliteTexte = buildFideliteTexte(boutique, client.tampons);
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
    const modules = [];

    // 1. Barre de fidélité (équivalent secondary field Apple)
    modules.push({
        header: 'Votre fidélité',
        body: fideliteTexte,
        id: 'fidelite'
    });

    // 2. Classement
    modules.push({
        header: 'Classement',
        body: buildRangLabel(rang || client._rang || 1),
        id: 'rang'
    });

    // 3. Cadeaux disponibles (si applicable)
    if ((client.recompenses || 0) > 0) {
        modules.push({
            header: 'Cadeaux disponibles',
            body: `${client.recompenses} cadeau${client.recompenses > 1 ? 'x' : ''} à récupérer ! 🎁`,
            id: 'cadeaux'
        });
    }

    // 4. Dernier message push du commerçant (équivalent backFields.promo Apple)
    if (boutique.last_push_message) {
        modules.push({
            header: 'Dernière info de la boutique',
            body: boutique.last_push_message,
            id: 'promo'
        });
    }

    // 5. Adresse (équivalent backFields.adresse Apple)
    if (boutique.adresse) {
        modules.push({
            header: 'Adresse',
            body: boutique.adresse,
            id: 'adresse'
        });
    }

    // 6. Téléphone (équivalent backFields.telephone Apple)
    if (boutique.telephone) {
        modules.push({
            header: 'Contact',
            body: boutique.telephone,
            id: 'telephone'
        });
    }

    return modules;
}

// Construit les uris (liens) affichés sur la carte
function buildLinksModule(client, boutique) {
    const uris = [
        {
            uri: `https://nuvy.pro/mon-compte/${client.token}`,
            description: 'Mon espace Nuvy',
            id: 'link-compte'
        }
    ];
    if (boutique.google_review_url) {
        uris.push({
            uri: boutique.google_review_url,
            description: 'Laisser un avis Google',
            id: 'link-avis'
        });
    }
    return { uris };
}

// ============================================================
// getGoogleAccessToken
// OAuth2 via JWT service account (RS256)
// ============================================================
async function getGoogleAccessToken() {
    if (!googleCredentials) throw new Error('Google credentials manquantes');
    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: googleCredentials.client_email,
        scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    };
    const token = jwt.sign(claim, googleCredentials.private_key, { algorithm: 'RS256' });
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: token
        })
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(`OAuth2 Google échoué : ${JSON.stringify(data)}`);
    return data.access_token;
}

// ============================================================
// ensureClassExists
// Crée la classe Google Wallet si elle n'existe pas,
// ou la met à jour si elle est en DRAFT.
// Appelé avant chaque génération de lien Wallet.
// ============================================================
async function ensureClassExists(boutique, access_token) {
    const classId = buildClassId(boutique.slug);
    const bgColor = resolveBackgroundColor(boutique);

    const classBody = {
        id: classId,
        issuerName: 'Nuvy',
        programName: boutique.nom || 'Fidélité',
        reviewStatus: 'APPROVED',
        hexBackgroundColor: bgColor,
        programLogo: boutique.logo_url
            ? { sourceUri: { uri: boutique.logo_url } }
            : undefined,
        localizedIssuerName: {
            defaultValue: { language: 'fr', value: boutique.nom || 'Nuvy' }
        },
        locations: (boutique.latitude && boutique.longitude)
            ? [{ latitude: parseFloat(boutique.latitude), longitude: parseFloat(boutique.longitude) }]
            : [],
        linksModuleData: {
            uris: [
                {
                    uri: `https://nuvy.pro/join/${boutique.slug}`,
                    description: 'Programme de fidélité',
                    id: 'link-fidelite'
                },
                ...(boutique.google_review_url ? [{
                    uri: boutique.google_review_url,
                    description: 'Laisser un avis Google',
                    id: 'link-avis'
                }] : [])
            ]
        }
    };

    const url = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${encodeURIComponent(classId)}`;

    // 1. On essaie de récupérer la classe
    const getRes = await fetch(url, {
        headers: { 'Authorization': `Bearer ${access_token}` }
    });

    if (getRes.status === 404) {
        // La classe n'existe pas → on la crée
        await fetch('https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(classBody)
        });
    } else if (getRes.ok) {
        const existing = await getRes.json();
        // La classe existe mais est en DRAFT → on la passe en APPROVED
        if (existing.reviewStatus === 'DRAFT') {
            await fetch(url, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ reviewStatus: 'APPROVED', hexBackgroundColor: bgColor })
            });
        }
        // Si elle est déjà APPROVED, on ne touche à rien
    }
}

// ============================================================
// generateGoogleWalletLink
// Génère le lien "Save to Google Wallet" (JWT signé)
// Appelé dans routes/wallet.js GET /google-pass/:token
// ============================================================
async function generateGoogleWalletLink(client, boutique) {
    if (!googleCredentials) return null;

    try {
        // Garantit que la classe existe et est APPROVED avant de générer le lien
        const access_token = await getGoogleAccessToken();
        await ensureClassExists(boutique, access_token);
    } catch (e) {
        // On continue même si ça échoue — le lien fonctionnera quand même
        console.error('ensureClassExists error:', e.message);
    }

    const classId = buildClassId(boutique.slug);
    const objectId = buildObjectId(client.id);
    const rang = client._rang || 1;
    const prenom = client.nom ? client.nom.split(' ')[0] : 'Client';
    const bgColor = resolveBackgroundColor(boutique);
    const textModules = buildTextModules(client, boutique, rang);
    const linksModule = buildLinksModule(client, boutique);

    const payload = {
        iss: googleCredentials.client_email,
        aud: 'google',
        typ: 'savetowallet',
        origins: [],
        payload: {
            loyaltyClasses: [{
                id: classId,
                issuerName: 'Nuvy',
                programName: boutique.nom || 'Fidélité',
                programLogo: boutique.logo_url
                    ? { sourceUri: { uri: boutique.logo_url } }
                    : undefined,
                reviewStatus: 'APPROVED',
                hexBackgroundColor: bgColor,
                localizedIssuerName: {
                    defaultValue: { language: 'fr', value: boutique.nom || 'Nuvy' }
                },
                // GPS : localisation de la boutique (équivalent passJson.locations Apple)
                locations: (boutique.latitude && boutique.longitude)
                    ? [{ latitude: parseFloat(boutique.latitude), longitude: parseFloat(boutique.longitude) }]
                    : [],
                linksModuleData: linksModule
            }],
            loyaltyObjects: [{
                id: objectId,
                classId,
                state: 'ACTIVE',
                accountId: client.id.toString(),
                accountName: `${client.nom || 'Client'} — ${buildRangLabel(rang)}`,
                header: { defaultValue: { language: 'fr', value: `Bonjour ${prenom} !` } },
                loyaltyPoints: {
                    label: 'Tampons',
                    balance: { string: buildFideliteTexte(boutique, client.tampons) }
                },
                secondaryLoyaltyPoints: {
                    label: 'Cadeaux',
                    balance: { int: client.recompenses || 0 }
                },
                textModulesData: textModules
            }]
        }
    };

    const token = jwt.sign(payload, googleCredentials.private_key, { algorithm: 'RS256' });
    return `https://pay.google.com/gp/v/save/${token}`;
}

// ============================================================
// updateGoogleWalletPass
// Met à jour la carte Google Wallet d'un client après un tampon
// Appelé dans routes/clients.js POST /:id/tampon
// ============================================================
async function updateGoogleWalletPass(client) {
    if (!googleCredentials) return;
    try {
        const objectId = buildObjectId(client.id);

        // Récupérer la boutique complète pour avoir toutes les infos
        const { data: boutique } = await supabase
            .from('boutiques')
            .select('max_tampons, categorie, emoji_full, emoji_empty, last_push_message, adresse, telephone, color_bg, nom')
            .eq('id', client.boutique_id)
            .single();

        if (!boutique) return;

        const rang = 1; // On ne recalcule pas le rang à chaque tampon (coûteux), affiché à la génération
        const textModules = buildTextModules(client, boutique, rang);
        const fideliteTexte = buildFideliteTexte(boutique, client.tampons);

        const access_token = await getGoogleAccessToken();

        await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                loyaltyPoints: {
                    label: 'Tampons',
                    balance: { string: fideliteTexte }
                },
                secondaryLoyaltyPoints: {
                    label: 'Cadeaux',
                    balance: { int: client.recompenses || 0 }
                },
                textModulesData: textModules
            })
        });
    } catch (e) {
        console.error('updateGoogleWalletPass error:', e.message);
    }
}

// ============================================================
// pushMessageToAllGoogleCards
// Envoie un message push à toutes les cartes Google d'une boutique
// Appelé dans routes/boutiques.js POST /:id/push-notification
// ============================================================
async function pushMessageToAllGoogleCards(boutiqueId, message) {
    if (!googleCredentials) return 0;
    try {
        const { data: clients } = await supabase
            .from('clients')
            .select('id, nom, tampons, recompenses, boutique_id')
            .eq('boutique_id', boutiqueId)
            .eq('device_type', 'android');

        if (!clients || clients.length === 0) return 0;

        // Récupérer la boutique une seule fois
        const { data: boutique } = await supabase
            .from('boutiques')
            .select('max_tampons, categorie, emoji_full, emoji_empty, adresse, telephone, color_bg, nom, last_push_message')
            .eq('id', boutiqueId)
            .single();

        if (!boutique) return 0;

        const access_token = await getGoogleAccessToken();
        let updated = 0;

        for (const c of clients) {
            try {
                const objectId = buildObjectId(c.id);
                const textModules = buildTextModules(
                    { ...c, token: null },
                    { ...boutique, last_push_message: message },
                    1
                );

                await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${access_token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ textModulesData: textModules })
                });
                updated++;
            } catch (_) {}
        }
        return updated;
    } catch (e) {
        console.error('pushMessageToAllGoogleCards error:', e.message);
        return 0;
    }
}

// ============================================================
// pushMessageToSingleGoogleCard
// Envoie un message de relance individuelle à une carte Google
// Appelé dans routes/clients.js POST /:id/notify
// ============================================================
async function pushMessageToSingleGoogleCard(serialNumber, message) {
    if (!googleCredentials) return { success: false, reason: 'Google credentials manquantes' };
    try {
        const { data: client } = await supabase
            .from('clients')
            .select('id, nom, tampons, recompenses, boutique_id, token')
            .eq('serial_number', serialNumber)
            .maybeSingle();

        if (!client) return { success: false, reason: 'Client introuvable' };

        const { data: boutique } = await supabase
            .from('boutiques')
            .select('max_tampons, categorie, emoji_full, emoji_empty, adresse, telephone, color_bg, nom')
            .eq('id', client.boutique_id)
            .single();

        if (!boutique) return { success: false, reason: 'Boutique introuvable' };

        const objectId = buildObjectId(client.id);
        const access_token = await getGoogleAccessToken();

        // Pour une relance individuelle, le message remplace last_push_message
        const textModules = buildTextModules(
            client,
            { ...boutique, last_push_message: message },
            1
        );

        const res = await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ textModulesData: textModules })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error(`Google PATCH error ${objectId}:`, err);
            return { success: false, reason: err };
        }

        return { success: true };
    } catch (e) {
        console.error('pushMessageToSingleGoogleCard error:', e.message);
        return { success: false, reason: e.message };
    }
}

module.exports = {
    generateGoogleWalletLink,
    updateGoogleWalletPass,
    pushMessageToAllGoogleCards,
    pushMessageToSingleGoogleCard
};