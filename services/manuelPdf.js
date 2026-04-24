// services/manuelPdf.js
// Génère le manuel d'onboarding PDF personnalisé pour chaque boutique
const PDFDocument = require('pdfkit');

// ---------- Palette Nuvy ----------
const COLORS = {
    nuvy: '#2A8C9C',
    nuvyDark: '#1F6B78',
    nuvyLight: '#EFF9FB',
    sidebar: '#111111',
    gray900: '#111111',
    gray700: '#374151',
    gray500: '#6B7280',
    gray300: '#D1D5DB',
    gray100: '#F3F4F6',
    gray50: '#FAFAFA',
    amberBg: '#FFFBEB',
    amberText: '#92400E',
    amberBorder: '#F59E0B',
    greenBg: '#ECFDF5',
    greenText: '#047857',
    greenBorder: '#10B981'
};

// Libellé humain du plan
function planLabel(plan) {
    const labels = {
        'essentiel': 'Essentiel — 29€/mois',
        'pro': 'Pro — 59€/mois',
        'multi-site': 'Multi-site — 79€/mois + 29€/boutique additionnelle'
    };
    return labels[plan] || 'Essentiel — 29€/mois';
}

function canPersonalize(plan) {
    return plan === 'pro' || plan === 'multi-site';
}

function hasPush(plan) {
    return plan === 'pro' || plan === 'multi-site';
}

function formatDateFr(date) {
    const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const d = new Date(date);
    return `${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
}

// ============================================================
// Helpers de rendu
// ============================================================

function addHeader(doc) {
    doc.fontSize(9).fillColor(COLORS.gray500).font('Helvetica')
       .text('Nuvy  ·  Manuel d\'onboarding commerçant', 50, 30, { align: 'right', width: doc.page.width - 100 });
    doc.moveTo(50, 48).lineTo(doc.page.width - 50, 48)
       .strokeColor(COLORS.nuvy).lineWidth(1).stroke();
}

function addFooter(doc, pageNum) {
    const y = doc.page.height - 40;
    doc.fontSize(9).fillColor(COLORS.gray500).font('Helvetica')
       .text(`Page ${pageNum}  ·  nuvy.pro  ·  contact@nuvy.pro`,
             50, y, { align: 'center', width: doc.page.width - 100 });
}

function h1(doc, text) {
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.moveDown(0.8);
    doc.fontSize(22).fillColor(COLORS.sidebar).font('Helvetica-Bold').text(text, { align: 'left' });
    doc.moveDown(0.5);
}

function h2(doc, text) {
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc.moveDown(0.6);
    doc.fontSize(15).fillColor(COLORS.nuvyDark).font('Helvetica-Bold').text(text);
    doc.moveDown(0.3);
}

function h3(doc, text) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.moveDown(0.4);
    doc.fontSize(12).fillColor(COLORS.sidebar).font('Helvetica-Bold').text(text);
    doc.moveDown(0.2);
}

function para(doc, text, opts = {}) {
    const { italic = false, bold = false, color = COLORS.gray700, size = 10.5 } = opts;
    const font = bold ? 'Helvetica-Bold' : (italic ? 'Helvetica-Oblique' : 'Helvetica');
    doc.fontSize(size).fillColor(color).font(font)
       .text(text, { align: 'justify', lineGap: 2 });
    doc.moveDown(0.5);
}

function bullet(doc, text, boldPrefix = null) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    const x = doc.x;
    const startY = doc.y;
    doc.fontSize(10.5).fillColor(COLORS.nuvy).font('Helvetica-Bold').text('•', x, startY, { continued: false });
    doc.fillColor(COLORS.gray700).font('Helvetica');
    if (boldPrefix) {
        doc.font('Helvetica-Bold').text(boldPrefix, x + 15, startY, { continued: true, lineGap: 2 });
        doc.font('Helvetica').text(' ' + text, { lineGap: 2 });
    } else {
        doc.text(text, x + 15, startY, { lineGap: 2 });
    }
    doc.moveDown(0.3);
}

function numbered(doc, num, text) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    const x = doc.x;
    const startY = doc.y;
    doc.fontSize(10.5).fillColor(COLORS.nuvyDark).font('Helvetica-Bold').text(`${num}.`, x, startY);
    doc.fillColor(COLORS.gray700).font('Helvetica').text(text, x + 22, startY, { lineGap: 2 });
    doc.moveDown(0.3);
}

function callout(doc, title, lines, variant = 'info') {
    const palettes = {
        info:    { bg: COLORS.nuvyLight, titleColor: COLORS.nuvyDark, border: COLORS.nuvy },
        warn:    { bg: COLORS.amberBg, titleColor: COLORS.amberText, border: COLORS.amberBorder },
        success: { bg: COLORS.greenBg, titleColor: COLORS.greenText, border: COLORS.greenBorder }
    };
    const pal = palettes[variant];
    const x = doc.x;
    const width = doc.page.width - 100;
    const padding = 12;

    // Mesure approximative de la hauteur nécessaire
    const linesArr = Array.isArray(lines) ? lines : [lines];
    doc.fontSize(10.5).font('Helvetica-Bold');
    const titleH = doc.heightOfString(title, { width: width - padding * 2 });
    doc.font('Helvetica');
    let bodyH = 0;
    linesArr.forEach(l => { bodyH += doc.heightOfString(l, { width: width - padding * 2, lineGap: 2 }) + 4; });
    const totalH = titleH + bodyH + padding * 2 + 6;

    if (doc.y + totalH > doc.page.height - 60) doc.addPage();

    const topY = doc.y;
    doc.rect(x, topY, width, totalH).fillAndStroke(pal.bg, pal.border);
    doc.fillColor(pal.titleColor).font('Helvetica-Bold').fontSize(10.5)
       .text(title, x + padding, topY + padding, { width: width - padding * 2 });
    let cursorY = topY + padding + titleH + 4;
    doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10);
    linesArr.forEach(l => {
        doc.text(l, x + padding, cursorY, { width: width - padding * 2, lineGap: 2 });
        cursorY += doc.heightOfString(l, { width: width - padding * 2, lineGap: 2 }) + 4;
    });
    doc.y = topY + totalH + 8;
    doc.x = x;
}

// Ligne d'info clé / valeur avec soulignement
function credentialRow(doc, label, value) {
    const x = doc.x;
    const y = doc.y;
    const labelW = 180;
    const valueW = doc.page.width - 100 - labelW;
    doc.fontSize(10.5).fillColor(COLORS.gray700).font('Helvetica-Bold').text(label, x, y, { width: labelW });
    doc.fontSize(11).fillColor(COLORS.nuvyDark).font('Courier-Bold')
       .text(value, x + labelW, y, { width: valueW });
    const afterY = Math.max(doc.y, y + 16);
    doc.moveTo(x + labelW, afterY + 2).lineTo(x + labelW + valueW, afterY + 2)
       .strokeColor(COLORS.gray300).lineWidth(0.5).stroke();
    doc.y = afterY + 10;
    doc.x = x;
}

// Table clé/description
function twoColTable(doc, rows) {
    const x = doc.x;
    const width = doc.page.width - 100;
    const leftW = 150;
    const rightW = width - leftW;
    const padding = 8;

    rows.forEach(([label, desc]) => {
        doc.fontSize(10).font('Helvetica-Bold');
        const labelH = doc.heightOfString(label, { width: leftW - padding * 2 });
        doc.font('Helvetica');
        const descLines = Array.isArray(desc) ? desc : [desc];
        let descH = 0;
        descLines.forEach(l => { descH += doc.heightOfString(l, { width: rightW - padding * 2, lineGap: 2 }) + 3; });
        const rowH = Math.max(labelH, descH) + padding * 2;

        if (doc.y + rowH > doc.page.height - 60) doc.addPage();

        const topY = doc.y;
        doc.rect(x, topY, leftW, rowH).fillAndStroke(COLORS.gray50, COLORS.gray300);
        doc.rect(x + leftW, topY, rightW, rowH).fillAndStroke('#FFFFFF', COLORS.gray300);

        doc.fillColor(COLORS.sidebar).font('Helvetica-Bold').fontSize(10)
           .text(label, x + padding, topY + padding, { width: leftW - padding * 2 });

        let cursorY = topY + padding;
        doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10);
        descLines.forEach(l => {
            doc.text(l, x + leftW + padding, cursorY, { width: rightW - padding * 2, lineGap: 2 });
            cursorY += doc.heightOfString(l, { width: rightW - padding * 2, lineGap: 2 }) + 3;
        });

        doc.y = topY + rowH;
        doc.x = x;
    });
    doc.moveDown(0.5);
}

function checklistItem(doc, text) {
    if (doc.y > doc.page.height - 80) doc.addPage();
    const x = doc.x;
    const y = doc.y;
    doc.rect(x, y + 2, 10, 10).strokeColor(COLORS.nuvy).lineWidth(1).stroke();
    doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10.5)
       .text(text, x + 18, y, { lineGap: 2 });
    doc.moveDown(0.3);
    doc.x = x;
}

// ============================================================
// GÉNÉRATION DU PDF
// ============================================================
function generateManuelPdf(boutique) {
    const {
        nom = 'Votre boutique',
        username = '—',
        passwordPlain = '—',
        plan = 'essentiel',
        max_tampons = 10,
        slug = ''
    } = boutique;

    const dateMiseService = formatDateFr(new Date());

    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 60, left: 50, right: 50 },
        bufferPages: true,
        info: {
            Title: `Manuel d'onboarding — ${nom}`,
            Author: 'Nuvy',
            Subject: 'Guide de démarrage commerçant',
            Creator: 'Nuvy'
        }
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const donePromise = new Promise(resolve => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    // ========= PAGE DE GARDE =========
    doc.y = 180;
    doc.fontSize(64).fillColor(COLORS.nuvy).font('Helvetica-Bold')
       .text('Nuvy', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).fillColor(COLORS.gray500).font('Helvetica-Oblique')
       .text('La fidélité dans le Wallet.', { align: 'center' });
    doc.moveDown(3);
    doc.fontSize(28).fillColor(COLORS.sidebar).font('Helvetica-Bold')
       .text('MANUEL D\'ONBOARDING', { align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(COLORS.gray500).font('Helvetica')
       .text('Guide de démarrage commerçant', { align: 'center' });

    // Encart infos boutique
    doc.moveDown(4);
    const boxY = doc.y;
    const boxW = 380;
    const boxX = (doc.page.width - boxW) / 2;
    doc.rect(boxX, boxY, boxW, 110).fillAndStroke(COLORS.nuvyLight, COLORS.nuvy);
    doc.fillColor(COLORS.nuvyDark).font('Helvetica-Bold').fontSize(11)
       .text('Document personnel remis à la signature', boxX, boxY + 12, { width: boxW, align: 'center' });
    doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(11);
    doc.text(`Boutique : ${nom}`, boxX + 20, boxY + 38, { width: boxW - 40 });
    doc.text(`Plan souscrit : ${planLabel(plan)}`, boxX + 20, boxY + 58, { width: boxW - 40 });
    doc.text(`Date de mise en service : ${dateMiseService}`, boxX + 20, boxY + 78, { width: boxW - 40 });

    // Footer cover
    doc.fillColor(COLORS.gray500).font('Helvetica').fontSize(10)
       .text('nuvy.pro  ·  contact@nuvy.pro', 50, doc.page.height - 70,
             { align: 'center', width: doc.page.width - 100 });

    // ========= INTRODUCTION =========
    doc.addPage();
    h1(doc, `Bienvenue chez Nuvy, ${nom}`);
    para(doc, "Ce manuel vous accompagne pas à pas dans la prise en main de votre nouvelle solution de fidélité. Il est pensé pour être lu une fois, de bout en bout, au moment de la mise en service, puis gardé à portée de main les premières semaines.");
    para(doc, "Le parti pris de Nuvy est simple : tout ce qui est complexe a été traité pour vous. Il ne vous reste qu'à paramétrer trois choses — votre identité boutique, votre programme de fidélité, et (si votre plan le permet) l'apparence de votre carte. Comptez 20 minutes pour être pleinement opérationnel.");
    para(doc, "Un principe directeur : ne pas reporter ce paramétrage. Chaque champ vide côté dashboard est une information manquante côté client. Les commerçants qui convertissent le mieux sont ceux qui configurent tout dès le premier jour.");
    callout(doc, 'Le chemin critique à retenir', [
        '1. Vous recevez vos identifiants (page suivante).',
        '2. Vous vous connectez et changez votre mot de passe.',
        '3. Vous complétez votre profil boutique (adresse, téléphone, avis Google).',
        canPersonalize(plan) ? '4. Vous personnalisez votre carte (couleurs, bandeau, emojis).' : '4. Votre carte utilise le thème par défaut de votre catégorie.',
        '5. Vous installez votre tag NFC et vous faites un test réel.'
    ], 'info');

    // ========= 1. VOS ACCÈS (PRÉ-REMPLI) =========
    doc.addPage();
    h1(doc, '1. Vos accès');
    para(doc, "Les identifiants ci-dessous sont personnels. Le mot de passe est provisoire et doit être changé lors de votre première connexion.");

    h2(doc, 'Votre espace de connexion');
    para(doc, "L'accès au dashboard se fait depuis un navigateur web, sur mobile ou ordinateur. Aucune application à installer.");
    doc.moveDown(0.3);
    credentialRow(doc, 'URL de connexion', 'https://nuvy.pro/login');
    credentialRow(doc, 'Identifiant', username);
    credentialRow(doc, 'Mot de passe provisoire', passwordPlain);
    credentialRow(doc, 'Plan souscrit', planLabel(plan));
    credentialRow(doc, 'Nombre de tampons', `${max_tampons} tampons par carte`);
    if (slug) credentialRow(doc, 'Votre lien tap (NFC)', `nuvy.pro/tap/${slug}`);

    doc.moveDown(0.5);
    callout(doc, 'Sécurité', [
        'Ne partagez jamais vos identifiants par email, SMS ou messagerie instantanée.',
        'Changez votre mot de passe dès la première connexion (procédure en section 2).',
        'Si vous suspectez une compromission, contactez immédiatement contact@nuvy.pro.'
    ], 'warn');

    h2(doc, 'Ce à quoi vous avez accès');
    para(doc, "Selon votre plan, les fonctionnalités disponibles diffèrent. Voici ce que vous pouvez faire :");

    const features = [
        ['Dashboard temps réel', 'Voir chaque passage client en direct, consulter le classement de vos meilleurs clients, gérer votre base manuellement.'],
        ['Profil boutique', 'Renseigner adresse, téléphone, lien d\'avis Google, valeur moyenne d\'un panier ou d\'un tampon.'],
        ['Fidélité (tap NFC)', 'Vos clients ajoutent leur carte Wallet en un tap. Le tampon est comptabilisé automatiquement.'],
        ['Notifications push', hasPush(plan) ? 'INCLUS dans votre plan. Envoyer un message à l\'ensemble de vos clients sur leur carte Wallet.' : 'NON INCLUS — réservé aux plans Pro et Multi-site.'],
        ['Personnalisation carte', canPersonalize(plan) ? 'INCLUS dans votre plan. Couleurs, bandeau image, emojis de tampons.' : 'NON INCLUS — réservé aux plans Pro et Multi-site.'],
        ['Dashboard réseau', plan === 'multi-site' ? 'INCLUS. Vue consolidée toutes boutiques, clients dédupliqués, top clients du réseau.' : 'NON INCLUS — réservé au plan Multi-site.']
    ];
    twoColTable(doc, features);

    // ========= 2. PREMIÈRE CONNEXION =========
    doc.addPage();
    h1(doc, '2. Première connexion et sécurité');
    para(doc, "La première connexion poursuit deux objectifs : vérifier que vos accès fonctionnent, et sécuriser votre compte avec un mot de passe personnel.");

    h2(doc, 'Étape 1 — Se connecter');
    numbered(doc, 1, "Ouvrez votre navigateur (Safari, Chrome ou Firefox) et rendez-vous sur nuvy.pro/login.");
    numbered(doc, 2, `Saisissez l'identifiant « ${username} » et le mot de passe provisoire qui vous ont été communiqués.`);
    numbered(doc, 3, "Cliquez sur « Se connecter ». Vous êtes redirigé directement sur votre tableau de bord.");

    h2(doc, 'Étape 2 — Changer votre mot de passe');
    para(doc, "Cette étape est à faire immédiatement, avant tout autre paramétrage.");
    numbered(doc, 1, "Dans la barre latérale, cliquez sur « Mon compte ».");
    numbered(doc, 2, "Sélectionnez « Changer mon mot de passe ».");
    numbered(doc, 3, "Renseignez votre mot de passe provisoire, puis le nouveau mot de passe.");
    numbered(doc, 4, "Validez.");

    callout(doc, 'Bonnes pratiques de mot de passe', [
        'Au minimum 10 caractères, avec majuscules, minuscules, chiffres et un caractère spécial.',
        'Ne le réutilisez pas d\'un autre service (réseaux sociaux, banque, messagerie).',
        'Notez-le dans un gestionnaire de mots de passe (1Password, Bitwarden, trousseau Apple), jamais sur un post-it près de la caisse.'
    ], 'info');

    h2(doc, 'En cas de mot de passe oublié');
    para(doc, "Contactez contact@nuvy.pro avec le nom de votre boutique. Un nouveau mot de passe provisoire vous sera transmis sous 24 heures ouvrées.");

    // ========= 3. PROFIL BOUTIQUE =========
    doc.addPage();
    h1(doc, '3. Paramétrage du profil boutique');
    para(doc, "Chaque information renseignée ici apparaît au dos de la carte Wallet de vos clients. C'est votre identité commerciale embarquée dans leur téléphone — traitez ce paramétrage avec la même rigueur que la devanture de votre boutique.");
    para(doc, "Accès : barre latérale → « Mon compte » → section « Profil boutique ».", { italic: true });

    h2(doc, '3.1 Adresse de la boutique');
    para(doc, "L'adresse sert à deux choses : elle s'affiche au dos de la carte Wallet du client, et elle alimente la géolocalisation d'Apple Wallet — c'est elle qui déclenche l'apparition automatique de la carte sur l'écran verrouillé quand le client passe devant votre boutique.");
    para(doc, "Quatre champs à remplir :");
    bullet(doc, "Rue et numéro (ex : 12 rue de la Paix)");
    bullet(doc, "Code postal (ex : 75002)");
    bullet(doc, "Ville (ex : Paris)");
    bullet(doc, "Pays (ex : France)");

    callout(doc, 'Ce qui se passe en coulisses', [
        "À l'enregistrement, Nuvy interroge l'API cartographique pour convertir votre adresse en coordonnées GPS précises.",
        "Si l'adresse est valide : message « Coordonnées GPS trouvées et sauvegardées ».",
        "Si l'adresse est introuvable, vérifiez l'orthographe (évitez « bd » ou « av. »). Le profil est sauvegardé, mais la géolocalisation Wallet ne fonctionnera pas."
    ], 'info');

    h2(doc, '3.2 Numéro de téléphone');
    para(doc, "Saisissez le numéro sur lequel vos clients peuvent vous joindre (boutique ou portable professionnel). Apple Wallet le rend cliquable : un tap depuis la carte lance directement l'appel.");
    para(doc, "Format recommandé : 01 23 45 67 89 ou +33 1 23 45 67 89.", { italic: true });

    h2(doc, '3.3 Lien d\'avis Google');
    para(doc, "Ce champ est l'un des leviers de ROI les plus sous-exploités. Il affiche au dos de la carte Wallet un bouton « Donnez-nous votre avis », qui renvoie directement sur votre fiche Google Business.");

    h3(doc, 'Comment récupérer votre lien');
    numbered(doc, 1, "Rendez-vous sur google.com et cherchez le nom de votre boutique.");
    numbered(doc, 2, "Sur votre fiche Google Business, cliquez sur « Rédiger un avis ».");
    numbered(doc, 3, "Copiez l'URL de la page qui s'ouvre — c'est ce lien-là qu'il faut coller dans Nuvy.");

    para(doc, "Format typique : https://g.page/r/VOTRE-CODE-UNIQUE/review", { italic: true });
    para(doc, "Un client qui a pris 30 minutes pour cumuler 10 tampons chez vous est, statistiquement, celui qui laissera l'avis 5 étoiles. Cette mécanique rend le geste évident au moment où il ouvre sa carte pour vérifier son solde.");

    doc.addPage();
    h2(doc, '3.4 Paramètres ROI (panier moyen et valeur de tampon)');
    para(doc, "Ces deux champs n'apparaissent pas côté client. Ils servent à calculer le chiffre d'affaires généré par le programme de fidélité, visible dans votre section « Statistiques ».");
    para(doc, "Vous choisissez un mode de calcul parmi les deux :");
    twoColTable(doc, [
        ['Mode Panier moyen', ['Recommandé pour restaurants, cafés, boulangeries, coiffeurs.', 'Renseignez le ticket moyen d\'un client (ex : 12 €).', 'CA fidélité estimé : nombre de visites × panier moyen.']],
        ['Mode Valeur tampon', ['Recommandé pour activités où un passage = un produit à prix fixe.', 'Renseignez la valeur du produit donné à chaque tampon (ex : 3 € pour un café).', 'CA fidélité estimé : nombre de tampons × valeur tampon.']]
    ]);
    para(doc, "Il vaut mieux renseigner une estimation raisonnable qu'un chiffre vide. Vous pourrez affiner à tout moment — seules les statistiques futures seront recalculées.", { italic: true });

    // ========= 4. PROGRAMME FIDÉLITÉ =========
    doc.addPage();
    h1(doc, '4. Votre programme de fidélité');
    para(doc, `Votre programme est configuré avec ${max_tampons} tampons par carte. Avant de le mettre en circulation, assurez-vous qu'il est cohérent sur trois dimensions : le palier de tampons, la récompense, et la communication en boutique.`);

    h2(doc, '4.1 Nombre de tampons');
    para(doc, `Vous êtes configuré sur ${max_tampons} tampons. Pour référence :`);
    twoColTable(doc, [
        ['5 tampons', 'Activités haute fréquence ou ticket élevé : restaurant, coiffeur, onglerie.'],
        ['8 tampons', 'Équilibre polyvalent. Valeur par défaut recommandée.'],
        ['10 tampons', 'Activités très haute fréquence et ticket bas : café, boulangerie.']
    ]);
    para(doc, "Si vous souhaitez modifier ce nombre, contactez contact@nuvy.pro. Attention : changer le palier en cours de route remet à zéro la perception de vos clients. À faire avec parcimonie.", { italic: true });

    h2(doc, '4.2 La récompense');
    para(doc, "Nuvy ne définit pas votre récompense — c'est vous qui fixez les règles. Trois principes pour une récompense qui convertit :");
    bullet(doc, "« La 10ème boisson offerte » bat « 20 % de réduction sur votre prochaine commande de plus de 15 € hors boissons chaudes ».", "Simplicité :");
    bullet(doc, "la récompense doit représenter au moins 80 à 100 % de la valeur d'un passage standard.", "Générosité perçue :");
    bullet(doc, "ce que vous offrez doit ramener le client à l'intérieur, idéalement à un moment calme où il consommera autre chose.", "Convertibilité :");

    callout(doc, 'Conseil d\'usage', [
        "La récompense n'est pas un coût — c'est un investissement marketing à ROI mesurable.",
        "Si vous offrez une boisson à 3 € pour 9 passages à 5 € en moyenne, vous investissez 6 % du CA du client fidélisé.",
        "À comparer au coût d'acquisition d'un nouveau client (flyer, Google Ads, Meta Ads : rarement inférieur à 15 €)."
    ], 'success');

    h2(doc, '4.3 Communication en boutique');
    para(doc, "Le tag NFC, seul, ne suffit pas. Un client ne tap pas un objet qu'il n'identifie pas. Trois supports à mettre en place dès J+0 :");
    bullet(doc, "à la caisse avec un message simple : « Approchez votre téléphone pour votre carte de fidélité ».", "Un chevalet");
    bullet(doc, "sur le tag NFC avec le logo du tap et une flèche directionnelle.", "Un autocollant");
    bullet(doc, "en caisse pour votre équipe : « Vous avez votre carte de fidélité ? Elle est dans votre téléphone maintenant, il suffit d'un tap ici. »", "Un script");
    para(doc, "Les premières semaines, formez vos équipes à proposer systématiquement la carte à chaque encaissement. C'est la friction humaine, pas la friction technique, qui fait décroître le taux d'adoption.", { italic: true });

    // ========= 5. PERSONNALISATION (CONDITIONNEL) =========
    doc.addPage();
    h1(doc, '5. Personnalisation de la carte');

    if (!canPersonalize(plan)) {
        callout(doc, 'Non inclus dans votre plan Essentiel', [
            "La personnalisation visuelle (couleurs, bandeau image, emojis) est réservée aux plans Pro et Multi-site.",
            "Votre carte utilise automatiquement le thème par défaut de votre catégorie, optimisé pour votre secteur.",
            "Pour débloquer la personnalisation, contactez contact@nuvy.pro — le passage au plan supérieur prend moins d'une minute et n'interrompt pas votre service."
        ], 'warn');
        para(doc, "Vous pouvez sauter cette section et passer directement à la section 6 (Installation du tag NFC).", { italic: true });
    } else {
        para(doc, "La personnalisation est ce qui transforme une carte Wallet générique en un prolongement visuel de votre marque. Trois leviers sont à votre disposition : les couleurs, le bandeau image, et les emojis de tampons.");
        para(doc, "Accès : barre latérale → « Apparence ».", { italic: true });

        h2(doc, '5.1 Les couleurs');
        para(doc, "Trois couleurs sont paramétrables :");
        twoColTable(doc, [
            ['Fond de la carte', 'La couleur dominante. Privilégiez la couleur principale de votre identité (logo, devanture, site).'],
            ['Texte principal', 'Nom, prénom, score de tampons. Doit contraster fortement avec le fond pour rester lisible.'],
            ['Libellés', 'Les petits textes en majuscules. Un ton plus clair que le texte principal donne du raffinement.']
        ]);
        h3(doc, 'Comment procéder');
        numbered(doc, 1, "Dans la section « Couleurs », cliquez sur chaque carré de couleur pour ouvrir le sélecteur.");
        numbered(doc, 2, "L'aperçu à droite se met à jour en temps réel — ajustez jusqu'à satisfaction.");
        numbered(doc, 3, "Cliquez sur « Enregistrer ».");
        numbered(doc, 4, "Vos clients existants reçoivent la mise à jour visuelle automatiquement dans les minutes qui suivent.");
        callout(doc, 'Conseil design', [
            "Règle de contraste : si vous avez un doute sur la lisibilité, vos clients l'auront aussi.",
            "Évitez les dégradés forts (non supportés par Apple Wallet) et les couleurs fluo.",
            "Pour revenir à la palette par défaut de votre catégorie, utilisez « Réinitialiser »."
        ], 'info');

        h2(doc, '5.2 Le bandeau image');
        para(doc, "Le bandeau est une photo horizontale qui remplace la zone « Bonjour X » sur le recto de la carte. C'est le levier le plus impactant visuellement.");
        h3(doc, 'Choix de l\'image');
        bullet(doc, "Photo de votre devanture en lumière naturelle, prise de face.");
        bullet(doc, "Photo d'un produit signature (pizza emblématique, pâtisserie, mise en beauté).");
        bullet(doc, "Photo d'ambiance de la boutique.");
        h3(doc, 'Spécifications techniques');
        twoColTable(doc, [
            ['Format', 'JPG, PNG ou WebP.'],
            ['Ratio', 'Paysage. Idéalement 3:1 ou 4:1.'],
            ['Résolution', 'Au moins 1125 × 432 px pour un rendu Retina.'],
            ['Poids', 'Moins de 2 Mo recommandé.']
        ]);
        h3(doc, 'Comment procéder');
        numbered(doc, 1, "Cliquez sur « Choisir un fichier » et sélectionnez votre image.");
        numbered(doc, 2, "L'aperçu se met à jour — vérifiez le cadrage.");
        numbered(doc, 3, "Cliquez sur « Uploader le bandeau ».");
        numbered(doc, 4, "Activez le toggle « Afficher le bandeau ».");

        h2(doc, '5.3 Les emojis de tampons');
        para(doc, "La barre de fidélité affiche deux symboles : un pour les tampons obtenus, un pour les tampons restants. Nuvy propose une palette adaptée à votre catégorie.");
        numbered(doc, 1, "Dans « Emojis de la carte », deux grilles apparaissent : « Tampon rempli » et « Tampon vide ».");
        numbered(doc, 2, "Cliquez sur l'emoji souhaité dans chaque grille.");
        numbered(doc, 3, "L'aperçu se met à jour en temps réel.");
        numbered(doc, 4, "Cliquez sur « Enregistrer ».");
        para(doc, "Règle d'or : un emoji plein qui évoque la récompense (cœur, étoile, produit signature), et un emoji vide neutre (rond ou carré) qui n'entre pas en compétition visuelle.", { italic: true });
    }

    // ========= 6. INSTALLATION NFC =========
    doc.addPage();
    h1(doc, '6. Installation du tag NFC');
    para(doc, "Le tag NFC est le point d'entrée physique de votre programme. Son placement conditionne directement le taux d'adoption.");

    h2(doc, '6.1 Placement optimal');
    para(doc, "Trois critères à respecter :");
    bullet(doc, "Un client qui ne voit pas le tag ne demande pas à l'utiliser.", "Visible depuis la file d'attente.");
    bullet(doc, "Le client a souvent son portefeuille ou ses achats dans l'autre main — le tag doit être à hauteur de comptoir.", "Accessible d'une seule main.");
    bullet(doc, "Le métal perturbe la lecture NFC. Collez le tag sur du bois, plastique ou verre.", "À l'écart des surfaces métalliques.");

    callout(doc, 'Les trois placements qui fonctionnent', [
        'Sur le chevalet à côté du terminal de paiement (placement n° 1 en taux d\'adoption).',
        'À droite de la caisse, au bord du comptoir, avec un pictogramme « Fidélité — Approchez votre téléphone ».',
        'Sur la vitre côté client, face à la file d\'attente (idéal pour cafés et boulangeries à fort débit).'
    ], 'success');

    h2(doc, '6.2 Test de mise en service');
    para(doc, "Ne comptez pas sur le premier vrai client pour découvrir qu'un paramètre est mal configuré. Faites un test complet avant la mise en service.");
    numbered(doc, 1, "Prenez votre propre téléphone (iPhone ou Android).");
    numbered(doc, 2, "Approchez-le du tag NFC — à 1 ou 2 cm, pas besoin de coller.");
    numbered(doc, 3, "Une notification propose d'ouvrir une page web. Tapez dessus.");
    numbered(doc, 4, "Un formulaire demande prénom, nom et téléphone. Remplissez-le.");
    numbered(doc, 5, "Acceptez les conditions d'utilisation et validez.");
    numbered(doc, 6, "Cliquez sur « Ouvrir ma carte » — la carte s'ajoute à votre Wallet.");
    numbered(doc, 7, "Retapez le tag : la carte se met à jour, un tampon est ajouté.");
    numbered(doc, 8, "Ouvrez votre dashboard : vous devez voir le passage en temps réel.");

    callout(doc, 'Si quelque chose ne fonctionne pas', [
        'Téléphone ne détecte pas le tag : vérifiez que le NFC est activé (automatique sur iPhone, Paramètres → NFC sur Android).',
        'Formulaire OK mais carte ne s\'ajoute pas à Wallet : testez avec Safari (iOS) ou Chrome (Android).',
        'Dashboard ne reflète pas le passage : rafraîchissez la page. Si le problème persiste, contact@nuvy.pro.'
    ], 'warn');

    // ========= 7. ANIMATION =========
    doc.addPage();
    h1(doc, '7. Animer votre base de clients');
    para(doc, "Acquérir des cartes ne suffit pas. Ce qui fait la différence sur la durée, c'est la capacité à faire revenir vos clients fidèles et à réveiller les dormants.");

    h2(doc, '7.1 Notifications push');
    if (!hasPush(plan)) {
        callout(doc, 'Non inclus dans votre plan Essentiel', [
            "Les notifications push sont réservées aux plans Pro et Multi-site.",
            "Pour débloquer cette fonctionnalité, contactez contact@nuvy.pro."
        ], 'warn');
    } else {
        para(doc, "Vous envoyez un message qui apparaît directement sur l'écran verrouillé de vos clients, via leur carte Wallet. Aucune application à installer, aucune opt-in complexe — la simple possession de la carte suffit.");
        h3(doc, 'Comment envoyer');
        numbered(doc, 1, "Barre latérale → « Notifications Push ».");
        numbered(doc, 2, "Rédigez un message court (maximum 200 caractères, 80 idéalement).");
        numbered(doc, 3, "Cliquez sur « Envoyer la notification ».");
        numbered(doc, 4, "Le système confirme le nombre d'appareils atteints.");
        h3(doc, 'Fréquence recommandée');
        bullet(doc, "Pas plus de 2 envois par mois. Au-delà, vos clients suppriment la carte.");
        bullet(doc, "Évitez dimanche matin, nuit, jours fériés.");
        bullet(doc, "Fenêtres idéales : mardi-vendredi, 10h-11h ou 17h-18h.");
        h3(doc, 'Messages qui fonctionnent');
        twoColTable(doc, [
            ['Promotion', '« -20 % sur tout le menu vendredi soir, rien que pour nos fidèles. »'],
            ['Nouveauté produit', '« La pizza truffe est enfin de retour ! Réservez votre table. »'],
            ['Fermeture', '« On ferme samedi pour inventaire — reprise dimanche dès 8h. »'],
            ['Anniversaire', '« 3 ans de Nuvy ! Un croissant offert jeudi à tous nos fidèles. »']
        ]);
        callout(doc, 'Ce qu\'il ne faut pas faire', [
            "Pas de ventes à rabais à répétition : vous habituez vos clients à ne plus venir au prix plein.",
            "Pas de messages génériques (« Passez nous voir ! ») : aucun trafic généré.",
            "Pas de clickbait : vous cassez la confiance et le client supprime la carte."
        ], 'warn');
    }

    h2(doc, '7.2 Segmentation clients');
    para(doc, "Le dashboard distingue automatiquement trois segments :");
    twoColTable(doc, [
        ['Clients VIP', 'Vos meilleurs clients. Au moins 10 passages cumulés et visite récente. À soigner.'],
        ['Clients Réguliers', 'Visites fréquentes mais pas encore VIP. À faire monter en gamme.'],
        ['Clients Dormants', 'Inactifs depuis plus de 60 jours. À réactiver en priorité.']
    ]);

    // ========= 8. STATISTIQUES =========
    doc.addPage();
    h1(doc, '8. Lire vos statistiques');
    para(doc, "L'onglet « Statistiques » consolide la performance de votre programme. Voici comment interpréter chaque indicateur.");

    h2(doc, '8.1 Les trois KPI principaux');
    twoColTable(doc, [
        ['Clients inscrits', 'Total des cartes Wallet générées. Surveillez la tendance — une courbe plate signale un problème d\'acquisition.'],
        ['Fréquence moyenne', 'Jours entre deux visites. Objectifs : < 14j pour un café, < 30j pour un restaurant, < 45j pour un coiffeur.'],
        ['Récompenses prêtes', 'Cadeaux disponibles non réclamés. Chaque récompense en attente est un client qui reviendra.']
    ]);

    h2(doc, '8.2 Courbe d\'évolution');
    para(doc, "La courbe sur 30 jours montre l'accumulation de passages. Deux choses à regarder :");
    bullet(doc, "La pente : plus elle est raide, plus le programme accélère.");
    bullet(doc, "Les discontinuités : chute un lundi = jour de fermeture mal communiqué ; pic un week-end = effet d'une notification push.");

    h2(doc, '8.3 ROI estimé');
    para(doc, "Le CA généré par le programme est calculé à partir des paramètres renseignés en section 3.4. C'est une estimation — elle n'inclut ni les clients sans carte, ni le bouche-à-oreille.");
    para(doc, "Règle de lecture : si le ROI mensuel estimé est au moins 5 fois supérieur au prix de votre abonnement, le programme est largement rentable.", { italic: true });

    // ========= 9. CHECKLIST =========
    doc.addPage();
    h1(doc, '9. Checklist de lancement');
    para(doc, "Imprimez cette page et cochez au fur et à mesure. Les commerçants qui suivent cette checklist convertissent en moyenne 40 % plus de clients fidélisés dans les trois premiers mois.");

    h2(doc, 'Jour 0 — Mise en service');
    checklistItem(doc, 'Connexion au dashboard réussie');
    checklistItem(doc, 'Mot de passe provisoire changé');
    checklistItem(doc, 'Adresse complète renseignée (GPS validé)');
    checklistItem(doc, 'Numéro de téléphone renseigné');
    checklistItem(doc, 'Lien d\'avis Google renseigné');
    checklistItem(doc, 'Panier moyen ou valeur tampon renseigné');
    if (canPersonalize(plan)) checklistItem(doc, 'Couleurs, bandeau et emojis configurés');
    checklistItem(doc, 'Tag NFC placé à l\'emplacement optimal');
    checklistItem(doc, 'Test complet réalisé (tap + formulaire + Wallet + dashboard)');
    checklistItem(doc, 'Chevalet ou affichette de communication en place');
    checklistItem(doc, 'Équipe briefée sur le script d\'encaissement');

    h2(doc, 'Semaine 1 — Vérifications');
    checklistItem(doc, 'Au moins 10 premières cartes générées');
    checklistItem(doc, 'Un passage client réel observé sur le dashboard');
    checklistItem(doc, 'Aucune anomalie signalée par l\'équipe');
    checklistItem(doc, 'Communication sur les réseaux sociaux (photo du tag)');

    h2(doc, 'Mois 1 — Optimisations');
    checklistItem(doc, 'Analyse des statistiques : fréquence, clients inscrits, ROI');
    if (hasPush(plan)) checklistItem(doc, 'Premier envoi de notification push');
    checklistItem(doc, 'Identification des clients VIP — un mot personnalisé ne coûte rien');
    checklistItem(doc, 'Révision éventuelle de la récompense si adoption faible');
    checklistItem(doc, 'Demande d\'avis Google sollicité auprès des meilleurs clients');

    // ========= 10. SUPPORT =========
    doc.addPage();
    h1(doc, '10. Support et contact');
    para(doc, "Nuvy est une équipe française, joignable en français. Le support est inclus dans tous les plans.");

    h2(doc, 'Comment nous joindre');
    twoColTable(doc, [
        ['Email', 'contact@nuvy.pro — réponse sous 24 heures ouvrées.'],
        ['Site web', 'nuvy.pro'],
        ['Changement de plan', 'À tout moment, sans engagement, par email.']
    ]);

    h2(doc, 'En cas d\'incident');
    para(doc, "Si votre tag NFC ne répond plus, si un client signale un bug, ou si vous constatez une anomalie :");
    numbered(doc, 1, "Vérifiez d'abord votre connexion internet.");
    numbered(doc, 2, "Déconnectez-vous et reconnectez-vous.");
    numbered(doc, 3, "Si le problème persiste : contact@nuvy.pro avec navigateur utilisé, heure du problème, capture d'écran.");

    callout(doc, 'Un dernier mot', [
        "Nuvy n'est pas un produit figé — il évolue chaque mois avec les retours des commerçants comme vous.",
        "Si une fonctionnalité vous manque, si une interaction vous semble mal pensée, dites-le-nous.",
        "Bon lancement, et bienvenue dans le réseau."
    ], 'success');

    // ========= HEADERS/FOOTERS SUR TOUTES LES PAGES SAUF LA COVER =========
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        if (i === 0) continue; // skip cover page
        addHeader(doc);
        addFooter(doc, i + 1);
    }

    doc.end();
    return donePromise;
}

module.exports = { generateManuelPdf };