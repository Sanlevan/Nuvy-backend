// services/manuelPdf.js
// Génère le manuel d'onboarding PDF personnalisé pour chaque boutique
const PDFDocument = require('pdfkit');

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

const MARGIN = 50;
const TOP = 60;
const BOTTOM = 60;

function planLabel(plan) {
    const labels = {
        'essentiel': 'Essentiel — 29€/mois',
        'pro': 'Pro — 59€/mois',
        'multi-site': 'Multi-site — 79€/mois + 29€/boutique additionnelle'
    };
    return labels[plan] || 'Essentiel — 29€/mois';
}

function canPersonalize(plan) { return plan === 'pro' || plan === 'multi-site'; }
function hasPush(plan) { return plan === 'pro' || plan === 'multi-site'; }

function formatDateFr(date) {
    const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
                  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const d = new Date(date);
    return `${d.getDate()} ${mois[d.getMonth()]} ${d.getFullYear()}`;
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
        checkoutUrl = null,
        max_tampons = 10,
        slug = ''
    } = boutique;

    const dateMiseService = formatDateFr(new Date());

    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: TOP, bottom: BOTTOM, left: MARGIN, right: MARGIN },
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

    // Largeur utile contenu
    const CONTENT_W = doc.page.width - MARGIN * 2;

    // Compteur de page (la cover est la page 1, qu'on ne décore pas)
    let pageCount = 1;
    let isCoverPage = true;

    // On intercepte chaque création de page pour poser header/footer
    doc.on('pageAdded', () => {
        pageCount++;
        isCoverPage = false;
        drawHeaderFooter(doc, pageCount);
        // Reset curseur sous le header
        doc.x = MARGIN;
        doc.y = TOP;
    });

    function drawHeaderFooter(d, num) {
        const currentY = d.y;
        const currentX = d.x;
        // Header
        d.save();
        d.fontSize(9).fillColor(COLORS.gray500).font('Helvetica')
         .text("Nuvy  ·  Manuel d'onboarding commerçant", MARGIN, 30,
               { align: 'right', width: CONTENT_W, lineBreak: false });
        d.moveTo(MARGIN, 48).lineTo(d.page.width - MARGIN, 48)
         .strokeColor(COLORS.nuvy).lineWidth(1).stroke();
        // Footer
        d.fontSize(9).fillColor(COLORS.gray500).font('Helvetica')
         .text(`Page ${num}  ·  nuvy.pro  ·  contact@nuvy.pro`,
               MARGIN, d.page.height - 40,
               { align: 'center', width: CONTENT_W, lineBreak: false });
        d.restore();
        // Restaurer curseur
        d.x = currentX;
        d.y = currentY;
    }

    // ============================================================
    // HELPERS
    // ============================================================

    function resetX() { doc.x = MARGIN; }

    function newPageIfNeeded(minRemaining) {
        if (doc.y + minRemaining > doc.page.height - BOTTOM - 20) {
            doc.addPage();
        }
    }

    // ============================================================
    // PAGE D'ACTIVATION (insérée si checkoutUrl fourni)
    // ============================================================
    if (checkoutUrl) {
        h2('Activez votre abonnement Nuvy');

        para("Avant de pouvoir utiliser votre tableau de bord, vous devez activer votre abonnement en renseignant un moyen de paiement (carte bancaire ou prélèvement SEPA).");

        callout('Période d\'essai gratuite de 14 jours', [
            "Aucun débit immédiat. Vous pouvez tester Nuvy gratuitement pendant 14 jours.",
            "Vous pouvez résilier à tout moment depuis votre espace de facturation, sans frais.",
            "À l'issue des 14 jours, votre abonnement sera automatiquement activé."
        ], 'success');

        h2('Comment activer en 2 minutes');
        numbered(1, "Cliquez sur le lien ci-dessous (ou copiez-le dans votre navigateur).");
        numbered(2, "Renseignez votre carte bancaire OU votre IBAN (prélèvement SEPA).");
        numbered(3, "Acceptez les conditions générales Stripe et validez.");
        numbered(4, "Vous recevrez une confirmation et pourrez vous connecter à votre tableau de bord.");

        // Lien Checkout dans une boîte mise en valeur
        doc.moveDown(0.5);
        const linkBoxY = doc.y;
        const linkBoxH = 60;
        doc.rect(MARGIN, linkBoxY, doc.page.width - MARGIN * 2, linkBoxH)
           .fillAndStroke(COLORS.nuvyLight, COLORS.nuvy);
        doc.fillColor(COLORS.nuvyDark).font('Helvetica-Bold').fontSize(11)
           .text('Votre lien d\'activation sécurisé :', MARGIN + 12, linkBoxY + 10);
        doc.fillColor(COLORS.nuvy).font('Helvetica').fontSize(9)
           .text(checkoutUrl, MARGIN + 12, linkBoxY + 28, {
               width: doc.page.width - MARGIN * 2 - 24,
               link: checkoutUrl,
               underline: true
           });
        doc.y = linkBoxY + linkBoxH + 14;

        callout('Important', [
            "Ce lien est personnel et valide pendant 30 jours.",
            "Si vous le perdez ou s'il expire, contactez-nous à contact@nuvy.pro pour en obtenir un nouveau."
        ], 'warning');

        doc.addPage();
    }

    function h1(text) {
        newPageIfNeeded(60);
        resetX();
        doc.moveDown(0.5);
        doc.fontSize(22).fillColor(COLORS.sidebar).font('Helvetica-Bold')
           .text(text, { width: CONTENT_W, align: 'left' });
        doc.moveDown(0.5);
        resetX();
    }

    function h2(text) {
        newPageIfNeeded(50);
        resetX();
        doc.moveDown(0.4);
        doc.fontSize(15).fillColor(COLORS.nuvyDark).font('Helvetica-Bold')
           .text(text, { width: CONTENT_W });
        doc.moveDown(0.3);
        resetX();
    }

    function h3(text) {
        newPageIfNeeded(40);
        resetX();
        doc.moveDown(0.3);
        doc.fontSize(12).fillColor(COLORS.sidebar).font('Helvetica-Bold')
           .text(text, { width: CONTENT_W });
        doc.moveDown(0.2);
        resetX();
    }

    function para(text, opts = {}) {
        const { italic = false, bold = false, color = COLORS.gray700, size = 10.5 } = opts;
        const font = bold ? 'Helvetica-Bold' : (italic ? 'Helvetica-Oblique' : 'Helvetica');
        resetX();
        doc.fontSize(size).fillColor(color).font(font)
           .text(text, { width: CONTENT_W, align: 'justify', lineGap: 2 });
        doc.moveDown(0.5);
        resetX();
    }

    function bullet(text, boldPrefix = null) {
        newPageIfNeeded(30);
        resetX();
        const bulletW = 14;
        const textX = MARGIN + bulletW;
        const textW = CONTENT_W - bulletW;
        const startY = doc.y;
        doc.fontSize(10.5).fillColor(COLORS.nuvy).font('Helvetica-Bold')
           .text('•', MARGIN, startY, { width: bulletW, lineBreak: false });
        if (boldPrefix) {
            doc.fillColor(COLORS.gray700).font('Helvetica-Bold').fontSize(10.5)
               .text(boldPrefix, textX, startY, { width: textW, continued: true, lineGap: 2 });
            doc.font('Helvetica').text(' ' + text, { width: textW, lineGap: 2 });
        } else {
            doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10.5)
               .text(text, textX, startY, { width: textW, lineGap: 2 });
        }
        doc.moveDown(0.2);
        resetX();
    }

    function numbered(num, text) {
        newPageIfNeeded(30);
        resetX();
        const numW = 22;
        const textX = MARGIN + numW;
        const textW = CONTENT_W - numW;
        const startY = doc.y;
        doc.fontSize(10.5).fillColor(COLORS.nuvyDark).font('Helvetica-Bold')
           .text(`${num}.`, MARGIN, startY, { width: numW, lineBreak: false });
        doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10.5)
           .text(text, textX, startY, { width: textW, lineGap: 2 });
        doc.moveDown(0.2);
        resetX();
    }

    function callout(title, lines, variant = 'info') {
        const palettes = {
            info:    { bg: COLORS.nuvyLight, titleColor: COLORS.nuvyDark, border: COLORS.nuvy },
            warn:    { bg: COLORS.amberBg, titleColor: COLORS.amberText, border: COLORS.amberBorder },
            success: { bg: COLORS.greenBg, titleColor: COLORS.greenText, border: COLORS.greenBorder }
        };
        const pal = palettes[variant];
        const padding = 12;
        const linesArr = Array.isArray(lines) ? lines : [lines];
        const totalH = 20 + linesArr.length * 22 + padding * 2;

        if (doc.y + totalH > doc.page.height - BOTTOM - 10) doc.addPage();

        resetX();
        const topY = doc.y;
        doc.rect(MARGIN, topY, CONTENT_W, totalH).fillAndStroke(pal.bg, pal.border);

        doc.fillColor(pal.titleColor).font('Helvetica-Bold').fontSize(10.5)
        .text(title, MARGIN + padding, topY + padding, { width: CONTENT_W - padding * 2 });

        let cursorY = topY + padding + 18;
        doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10);
        linesArr.forEach(l => {
            doc.text(l, MARGIN + padding, cursorY, { width: CONTENT_W - padding * 2, lineGap: 2 });
            cursorY += 18;
        });
        doc.y = topY + totalH + 8;
        resetX();
    }

    function credentialRow(label, value) {
        newPageIfNeeded(30);
        resetX();
        const labelW = 180;
        const valueW = CONTENT_W - labelW;
        const y = doc.y;
        const lineH = 16;
        
        // Rect de fond
        doc.rect(MARGIN, y, CONTENT_W, lineH + 8).fillAndStroke(COLORS.gray50, COLORS.gray300);
        
        // Label à gauche
        doc.fontSize(10.5).fillColor(COLORS.gray700).font('Helvetica-Bold')
        .text(label, MARGIN + 8, y + 4, { width: labelW - 16, lineBreak: false });
        
        // Séparateur vertical
        doc.moveTo(MARGIN + labelW, y).lineTo(MARGIN + labelW, y + lineH + 8)
        .strokeColor(COLORS.gray300).lineWidth(0.5).stroke();
        
        // Value à droite
        doc.fontSize(11).fillColor(COLORS.nuvyDark).font('Helvetica-Bold')
        .text(value, MARGIN + labelW + 8, y + 4, { width: valueW - 16, lineBreak: false, ellipsis: true });
        
        doc.y = y + lineH + 12;
        resetX();
    }

    function twoColTable(rows) {
        const leftW = 150;
        const rightW = CONTENT_W - leftW;
        const padding = 8;

        rows.forEach(([label, desc]) => {
            const descLines = Array.isArray(desc) ? desc : [desc];
            const rowH = Math.max(30, descLines.length * 18) + padding * 2;

            if (doc.y + rowH > doc.page.height - BOTTOM - 10) doc.addPage();

            resetX();
            const topY = doc.y;
            doc.rect(MARGIN, topY, leftW, rowH).fillAndStroke(COLORS.gray50, COLORS.gray300);
            doc.rect(MARGIN + leftW, topY, rightW, rowH).fillAndStroke('#FFFFFF', COLORS.gray300);

            doc.fillColor(COLORS.sidebar).font('Helvetica-Bold').fontSize(10)
            .text(label, MARGIN + padding, topY + padding, { width: leftW - padding * 2 });

            let cursorY = topY + padding;
            doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10);
            descLines.forEach(l => {
                doc.text(l, MARGIN + leftW + padding, cursorY, { width: rightW - padding * 2, lineGap: 2 });
                cursorY += 18;
            });

            doc.y = topY + rowH;
            resetX();
        });
        doc.moveDown(0.5);
    }

    function checklistItem(text) {
        newPageIfNeeded(25);
        resetX();
        const y = doc.y;
        doc.rect(MARGIN, y + 2, 10, 10).strokeColor(COLORS.nuvy).lineWidth(1).stroke();
        doc.fillColor(COLORS.gray700).font('Helvetica').fontSize(10.5)
           .text(text, MARGIN + 18, y, { width: CONTENT_W - 18, lineGap: 2 });
        doc.moveDown(0.2);
        resetX();
    }

    // ============================================================
    // PAGE DE GARDE (page 1 — pas de header/footer)
    // ============================================================
    doc.y = 180;
    doc.fontSize(64).fillColor(COLORS.nuvy).font('Helvetica-Bold')
       .text('Nuvy', MARGIN, 180, { width: CONTENT_W, align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(14).fillColor(COLORS.gray500).font('Helvetica-Oblique')
       .text('La fidélité dans le Wallet.', { width: CONTENT_W, align: 'center' });
    doc.moveDown(3);
    doc.fontSize(28).fillColor(COLORS.sidebar).font('Helvetica-Bold')
       .text("MANUEL D'ONBOARDING", { width: CONTENT_W, align: 'center' });
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor(COLORS.gray500).font('Helvetica')
       .text('Guide de démarrage commerçant', { width: CONTENT_W, align: 'center' });

    // Encart infos
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

    doc.fillColor(COLORS.gray500).font('Helvetica').fontSize(10)
       .text('nuvy.pro  ·  contact@nuvy.pro', MARGIN, doc.page.height - 70,
             { align: 'center', width: CONTENT_W });

    // ============================================================
    // INTRO (page 2)
    // ============================================================
    doc.addPage();
    h1(`Bienvenue chez Nuvy, ${nom}`);
    para("Ce manuel vous accompagne pas à pas dans la prise en main de votre nouvelle solution de fidélité. Il est pensé pour être lu une fois, de bout en bout, au moment de la mise en service, puis gardé à portée de main les premières semaines.");
    para("Le parti pris de Nuvy est simple : tout ce qui est complexe a été traité pour vous. Il ne vous reste qu'à paramétrer trois choses — votre identité boutique, votre programme de fidélité, et (si votre plan le permet) l'apparence de votre carte. Comptez 20 minutes pour être pleinement opérationnel.");
    para("Un principe directeur : ne pas reporter ce paramétrage. Chaque champ vide côté dashboard est une information manquante côté client. Les commerçants qui convertissent le mieux sont ceux qui configurent tout dès le premier jour.");
    callout('Le chemin critique à retenir', [
        '1. Vous recevez vos identifiants (page suivante).',
        '2. Vous vous connectez et changez votre mot de passe.',
        '3. Vous complétez votre profil boutique (adresse, téléphone, avis Google).',
        canPersonalize(plan) ? '4. Vous personnalisez votre carte (couleurs, bandeau, emojis).' : '4. Votre carte utilise le thème par défaut de votre catégorie.',
        '5. Vous installez votre tag NFC et vous faites un test réel.'
    ], 'info');

    // ============================================================
    // 1. VOS ACCÈS
    // ============================================================
    doc.addPage();
    h1('1. Vos accès');
    para("Les identifiants ci-dessous sont personnels. Le mot de passe est provisoire et doit être changé lors de votre première connexion.");
    h2('Votre espace de connexion');
    para("L'accès au dashboard se fait depuis un navigateur web, sur mobile ou ordinateur. Aucune application à installer.");
    doc.moveDown(0.3);
    credentialRow('URL de connexion', 'https://nuvy.pro/login');
    credentialRow('Identifiant', username);
    credentialRow('Mot de passe provisoire', passwordPlain);
    credentialRow('Plan souscrit', planLabel(plan));
    credentialRow('Nombre de tampons', `${max_tampons} tampons par carte`);
    if (slug) credentialRow('Votre lien tap (NFC)', `nuvy.pro/tap/${slug}`);
    doc.moveDown(0.5);
    callout('Sécurité', [
        'Ne partagez jamais vos identifiants par email, SMS ou messagerie instantanée.',
        'Changez votre mot de passe dès la première connexion (procédure en section 2).',
        'Si vous suspectez une compromission, contactez immédiatement contact@nuvy.pro.'
    ], 'warn');

    h2('Ce à quoi vous avez accès');
    para("Selon votre plan, les fonctionnalités disponibles diffèrent. Voici ce que vous pouvez faire :");
    twoColTable([
        ['Dashboard temps réel', 'Voir chaque passage client en direct, consulter le classement de vos meilleurs clients, gérer votre base manuellement.'],
        ['Profil boutique', "Renseigner adresse, téléphone, lien d'avis Google, valeur moyenne d'un panier ou d'un tampon."],
        ['Fidélité (tap NFC)', 'Vos clients ajoutent leur carte Wallet en un tap. Le tampon est comptabilisé automatiquement.'],
        ['Notifications push', hasPush(plan) ? "INCLUS dans votre plan. Envoyer un message à l'ensemble de vos clients sur leur carte Wallet." : 'NON INCLUS — réservé aux plans Pro et Multi-site.'],
        ['Personnalisation carte', canPersonalize(plan) ? 'INCLUS dans votre plan. Couleurs, bandeau image, emojis de tampons.' : 'NON INCLUS — réservé aux plans Pro et Multi-site.'],
        ['Dashboard réseau', plan === 'multi-site' ? 'INCLUS. Vue consolidée toutes boutiques, clients dédupliqués, top clients du réseau.' : 'NON INCLUS — réservé au plan Multi-site.']
    ]);

    // ============================================================
    // 2. PREMIÈRE CONNEXION
    // ============================================================
    doc.addPage();
    h1('2. Première connexion et sécurité');
    para("La première connexion poursuit deux objectifs : vérifier que vos accès fonctionnent, et sécuriser votre compte avec un mot de passe personnel.");
    h2('Étape 1 — Se connecter');
    numbered(1, "Ouvrez votre navigateur (Safari, Chrome ou Firefox) et rendez-vous sur nuvy.pro/login.");
    numbered(2, `Saisissez l'identifiant « ${username} » et le mot de passe provisoire qui vous ont été communiqués.`);
    numbered(3, "Cliquez sur « Se connecter ». Vous êtes redirigé directement sur votre tableau de bord.");
    h2('Étape 2 — Changer votre mot de passe');
    para("Cette étape est à faire immédiatement, avant tout autre paramétrage.");
    numbered(1, "Dans la barre latérale, cliquez sur « Mon compte ».");
    numbered(2, "Sélectionnez « Changer mon mot de passe ».");
    numbered(3, "Renseignez votre mot de passe provisoire, puis le nouveau mot de passe.");
    numbered(4, "Validez.");
    callout('Bonnes pratiques de mot de passe', [
        'Au minimum 10 caractères, avec majuscules, minuscules, chiffres et un caractère spécial.',
        "Ne le réutilisez pas d'un autre service (réseaux sociaux, banque, messagerie).",
        'Notez-le dans un gestionnaire de mots de passe (1Password, Bitwarden, trousseau Apple), jamais sur un post-it près de la caisse.'
    ], 'info');
    h2('En cas de mot de passe oublié');
    para("Contactez contact@nuvy.pro avec le nom de votre boutique. Un nouveau mot de passe provisoire vous sera transmis sous 24 heures ouvrées.");

    // ============================================================
    // 3. PROFIL BOUTIQUE
    // ============================================================
    doc.addPage();
    h1('3. Paramétrage du profil boutique');
    para("Chaque information renseignée ici apparaît au dos de la carte Wallet de vos clients. C'est votre identité commerciale embarquée dans leur téléphone — traitez ce paramétrage avec la même rigueur que la devanture de votre boutique.");
    para("Accès : barre latérale → « Mon compte » → section « Profil boutique ».", { italic: true });
    h2('3.1 Adresse de la boutique');
    para("L'adresse sert à deux choses : elle s'affiche au dos de la carte Wallet du client, et elle alimente la géolocalisation d'Apple Wallet — c'est elle qui déclenche l'apparition automatique de la carte sur l'écran verrouillé quand le client passe devant votre boutique.");
    para("Quatre champs à remplir :");
    bullet("Rue et numéro (ex : 12 rue de la Paix)");
    bullet("Code postal (ex : 75002)");
    bullet("Ville (ex : Paris)");
    bullet("Pays (ex : France)");
    callout('Ce qui se passe en coulisses', [
        "À l'enregistrement, Nuvy interroge l'API cartographique pour convertir votre adresse en coordonnées GPS précises.",
        "Si l'adresse est valide : message « Coordonnées GPS trouvées et sauvegardées ».",
        "Si l'adresse est introuvable, vérifiez l'orthographe (évitez « bd » ou « av. »). Le profil est sauvegardé, mais la géolocalisation Wallet ne fonctionnera pas."
    ], 'info');
    h2('3.2 Numéro de téléphone');
    para("Saisissez le numéro sur lequel vos clients peuvent vous joindre (boutique ou portable professionnel). Apple Wallet le rend cliquable : un tap depuis la carte lance directement l'appel.");
    para("Format recommandé : 01 23 45 67 89 ou +33 1 23 45 67 89.", { italic: true });
    h2("3.3 Lien d'avis Google");
    para("Ce champ est l'un des leviers de ROI les plus sous-exploités. Il affiche au dos de la carte Wallet un bouton « Donnez-nous votre avis », qui renvoie directement sur votre fiche Google Business.");
    h3('Comment récupérer votre lien');
    numbered(1, "Rendez-vous sur google.com et cherchez le nom de votre boutique.");
    numbered(2, "Sur votre fiche Google Business, cliquez sur « Rédiger un avis ».");
    numbered(3, "Copiez l'URL de la page qui s'ouvre — c'est ce lien-là qu'il faut coller dans Nuvy.");
    para("Format typique : https://g.page/r/VOTRE-CODE-UNIQUE/review", { italic: true });
    para("Un client qui a pris 30 minutes pour cumuler 10 tampons chez vous est, statistiquement, celui qui laissera l'avis 5 étoiles. Cette mécanique rend le geste évident au moment où il ouvre sa carte pour vérifier son solde.");

    doc.addPage();
    h2('3.4 Paramètres ROI (panier moyen et valeur de tampon)');
    para("Ces deux champs n'apparaissent pas côté client. Ils servent à calculer le chiffre d'affaires généré par le programme de fidélité, visible dans votre section « Statistiques ».");
    para("Vous choisissez un mode de calcul parmi les deux :");
    twoColTable([
        ['Mode Panier moyen', ['Recommandé pour restaurants, cafés, boulangeries, coiffeurs.', "Renseignez le ticket moyen d'un client (ex : 12 €).", 'CA fidélité estimé : nombre de visites × panier moyen.']],
        ['Mode Valeur tampon', ['Recommandé pour activités où un passage = un produit à prix fixe.', 'Renseignez la valeur du produit donné à chaque tampon (ex : 3 € pour un café).', 'CA fidélité estimé : nombre de tampons × valeur tampon.']]
    ]);
    para("Il vaut mieux renseigner une estimation raisonnable qu'un chiffre vide. Vous pourrez affiner à tout moment — seules les statistiques futures seront recalculées.", { italic: true });

    // ============================================================
    // 4. PROGRAMME FIDÉLITÉ
    // ============================================================
    doc.addPage();
    h1('4. Votre programme de fidélité');
    para(`Votre programme est configuré avec ${max_tampons} tampons par carte. Avant de le mettre en circulation, assurez-vous qu'il est cohérent sur trois dimensions : le palier de tampons, la récompense, et la communication en boutique.`);
    h2('4.1 Nombre de tampons');
    para(`Vous êtes configuré sur ${max_tampons} tampons. Pour référence :`);
    twoColTable([
        ['5 tampons', 'Activités haute fréquence ou ticket élevé : restaurant, coiffeur, onglerie.'],
        ['8 tampons', 'Équilibre polyvalent. Valeur par défaut recommandée.'],
        ['10 tampons', 'Activités très haute fréquence et ticket bas : café, boulangerie.']
    ]);
    para("Si vous souhaitez modifier ce nombre, contactez contact@nuvy.pro. Attention : changer le palier en cours de route remet à zéro la perception de vos clients. À faire avec parcimonie.", { italic: true });
    h2('4.2 La récompense');
    para("Nuvy ne définit pas votre récompense — c'est vous qui fixez les règles. Trois principes pour une récompense qui convertit :");
    bullet("« La 10ème boisson offerte » bat « 20 % de réduction sur votre prochaine commande de plus de 15 € hors boissons chaudes ».", "Simplicité :");
    bullet("la récompense doit représenter au moins 80 à 100 % de la valeur d'un passage standard.", "Générosité perçue :");
    bullet("ce que vous offrez doit ramener le client à l'intérieur, idéalement à un moment calme où il consommera autre chose.", "Convertibilité :");
    callout("Conseil d'usage", [
        "La récompense n'est pas un coût — c'est un investissement marketing à ROI mesurable.",
        "Si vous offrez une boisson à 3 € pour 9 passages à 5 € en moyenne, vous investissez 6 % du CA du client fidélisé.",
        "À comparer au coût d'acquisition d'un nouveau client (flyer, Google Ads, Meta Ads : rarement inférieur à 15 €)."
    ], 'success');
    h2('4.3 Communication en boutique');
    para("Le tag NFC, seul, ne suffit pas. Un client ne tap pas un objet qu'il n'identifie pas. Trois supports à mettre en place dès J+0 :");
    bullet("à la caisse avec un message simple : « Approchez votre téléphone pour votre carte de fidélité ».", "Un chevalet");
    bullet("sur le tag NFC avec le logo du tap et une flèche directionnelle.", "Un autocollant");
    bullet("en caisse pour votre équipe : « Vous avez votre carte de fidélité ? Elle est dans votre téléphone maintenant, il suffit d'un tap ici. »", "Un script");
    para("Les premières semaines, formez vos équipes à proposer systématiquement la carte à chaque encaissement. C'est la friction humaine, pas la friction technique, qui fait décroître le taux d'adoption.", { italic: true });

    // ============================================================
    // 5. PERSONNALISATION
    // ============================================================
    doc.addPage();
    h1('5. Personnalisation de la carte');
    if (!canPersonalize(plan)) {
        callout('Non inclus dans votre plan Essentiel', [
            "La personnalisation visuelle (couleurs, bandeau image, emojis) est réservée aux plans Pro et Multi-site.",
            "Votre carte utilise automatiquement le thème par défaut de votre catégorie, optimisé pour votre secteur.",
            "Pour débloquer la personnalisation, contactez contact@nuvy.pro — le passage au plan supérieur prend moins d'une minute et n'interrompt pas votre service."
        ], 'warn');
        para("Vous pouvez sauter cette section et passer directement à la section 6 (Installation du tag NFC).", { italic: true });
    } else {
        para("La personnalisation est ce qui transforme une carte Wallet générique en un prolongement visuel de votre marque. Trois leviers sont à votre disposition : les couleurs, le bandeau image, et les emojis de tampons.");
        para("Accès : barre latérale → « Apparence ».", { italic: true });
        h2('5.1 Les couleurs');
        para("Trois couleurs sont paramétrables :");
        twoColTable([
            ['Fond de la carte', "La couleur dominante. Privilégiez la couleur principale de votre identité (logo, devanture, site)."],
            ['Texte principal', "Nom, prénom, score de tampons. Doit contraster fortement avec le fond pour rester lisible."],
            ['Libellés', "Les petits textes en majuscules. Un ton plus clair que le texte principal donne du raffinement."]
        ]);
        h3('Comment procéder');
        numbered(1, "Dans la section « Couleurs », cliquez sur chaque carré de couleur pour ouvrir le sélecteur.");
        numbered(2, "L'aperçu à droite se met à jour en temps réel — ajustez jusqu'à satisfaction.");
        numbered(3, "Cliquez sur « Enregistrer ».");
        numbered(4, "Vos clients existants reçoivent la mise à jour visuelle automatiquement dans les minutes qui suivent.");
        callout('Conseil design', [
            "Règle de contraste : si vous avez un doute sur la lisibilité, vos clients l'auront aussi.",
            "Évitez les dégradés forts (non supportés par Apple Wallet) et les couleurs fluo.",
            "Pour revenir à la palette par défaut de votre catégorie, utilisez « Réinitialiser »."
        ], 'info');
        h2('5.2 Le bandeau image');
        para("Le bandeau est une photo horizontale qui remplace la zone « Bonjour X » sur le recto de la carte. C'est le levier le plus impactant visuellement.");
        h3("Choix de l'image");
        bullet("Photo de votre devanture en lumière naturelle, prise de face.");
        bullet("Photo d'un produit signature (pizza emblématique, pâtisserie, mise en beauté).");
        bullet("Photo d'ambiance de la boutique.");
        h3('Spécifications techniques');
        twoColTable([
            ['Format', 'JPG, PNG ou WebP.'],
            ['Ratio', 'Paysage. Idéalement 3:1 ou 4:1.'],
            ['Résolution', 'Au moins 1125 × 432 px pour un rendu Retina.'],
            ['Poids', 'Moins de 2 Mo recommandé.']
        ]);
        h3('Comment procéder');
        numbered(1, "Cliquez sur « Choisir un fichier » et sélectionnez votre image.");
        numbered(2, "L'aperçu se met à jour — vérifiez le cadrage.");
        numbered(3, "Cliquez sur « Uploader le bandeau ».");
        numbered(4, "Activez le toggle « Afficher le bandeau ».");
        h2('5.3 Les emojis de tampons');
        para("La barre de fidélité affiche deux symboles : un pour les tampons obtenus, un pour les tampons restants. Nuvy propose une palette adaptée à votre catégorie.");
        numbered(1, "Dans « Emojis de la carte », deux grilles apparaissent : « Tampon rempli » et « Tampon vide ».");
        numbered(2, "Cliquez sur l'emoji souhaité dans chaque grille.");
        numbered(3, "L'aperçu se met à jour en temps réel.");
        numbered(4, "Cliquez sur « Enregistrer ».");
        para("Règle d'or : un emoji plein qui évoque la récompense (cœur, étoile, produit signature), et un emoji vide neutre (rond ou carré) qui n'entre pas en compétition visuelle.", { italic: true });
    }

    // ============================================================
    // 6. INSTALLATION NFC
    // ============================================================
    doc.addPage();
    h1('6. Installation du tag NFC');
    para("Le tag NFC est le point d'entrée physique de votre programme. Son placement conditionne directement le taux d'adoption.");
    h2('6.1 Placement optimal');
    para("Trois critères à respecter :");
    bullet("Un client qui ne voit pas le tag ne demande pas à l'utiliser.", "Visible depuis la file d'attente.");
    bullet("Le client a souvent son portefeuille ou ses achats dans l'autre main — le tag doit être à hauteur de comptoir.", "Accessible d'une seule main.");
    bullet("Le métal perturbe la lecture NFC. Collez le tag sur du bois, plastique ou verre.", "À l'écart des surfaces métalliques.");
    callout('Les trois placements qui fonctionnent', [
        "Sur le chevalet à côté du terminal de paiement (placement n° 1 en taux d'adoption).",
        'À droite de la caisse, au bord du comptoir, avec un pictogramme « Fidélité — Approchez votre téléphone ».',
        "Sur la vitre côté client, face à la file d'attente (idéal pour cafés et boulangeries à fort débit)."
    ], 'success');
    h2('6.2 Test de mise en service');
    para("Ne comptez pas sur le premier vrai client pour découvrir qu'un paramètre est mal configuré. Faites un test complet avant la mise en service.");
    numbered(1, "Prenez votre propre téléphone (iPhone ou Android).");
    numbered(2, "Approchez-le du tag NFC — à 1 ou 2 cm, pas besoin de coller.");
    numbered(3, "Une notification propose d'ouvrir une page web. Tapez dessus.");
    numbered(4, "Un formulaire demande prénom, nom et téléphone. Remplissez-le.");
    numbered(5, "Acceptez les conditions d'utilisation et validez.");
    numbered(6, "Cliquez sur « Ouvrir ma carte » — la carte s'ajoute à votre Wallet.");
    numbered(7, "Retapez le tag : la carte se met à jour, un tampon est ajouté.");
    numbered(8, "Ouvrez votre dashboard : vous devez voir le passage en temps réel.");
    callout('Si quelque chose ne fonctionne pas', [
        'Téléphone ne détecte pas le tag : vérifiez que le NFC est activé (automatique sur iPhone, Paramètres → NFC sur Android).',
        "Formulaire OK mais carte ne s'ajoute pas à Wallet : testez avec Safari (iOS) ou Chrome (Android).",
        'Dashboard ne reflète pas le passage : rafraîchissez la page. Si le problème persiste, contact@nuvy.pro.'
    ], 'warn');

    // ============================================================
    // 7. ANIMATION
    // ============================================================
    doc.addPage();
    h1('7. Animer votre base de clients');
    para("Acquérir des cartes ne suffit pas. Ce qui fait la différence sur la durée, c'est la capacité à faire revenir vos clients fidèles et à réveiller les dormants.");
    h2('7.1 Notifications push');
    if (!hasPush(plan)) {
        callout('Non inclus dans votre plan Essentiel', [
            "Les notifications push sont réservées aux plans Pro et Multi-site.",
            "Pour débloquer cette fonctionnalité, contactez contact@nuvy.pro."
        ], 'warn');
    } else {
        para("Vous envoyez un message qui apparaît directement sur l'écran verrouillé de vos clients, via leur carte Wallet. Aucune application à installer, aucune opt-in complexe — la simple possession de la carte suffit.");
        h3('Comment envoyer');
        numbered(1, "Barre latérale → « Notifications Push ».");
        numbered(2, "Rédigez un message court (maximum 200 caractères, 80 idéalement).");
        numbered(3, "Cliquez sur « Envoyer la notification ».");
        numbered(4, "Le système confirme le nombre d'appareils atteints.");
        h3('Fréquence recommandée');
        bullet("Pas plus de 2 envois par mois. Au-delà, vos clients suppriment la carte.");
        bullet("Évitez dimanche matin, nuit, jours fériés.");
        bullet("Fenêtres idéales : mardi-vendredi, 10h-11h ou 17h-18h.");
        h3('Messages qui fonctionnent');
        twoColTable([
            ['Promotion', "« -20 % sur tout le menu vendredi soir, rien que pour nos fidèles. »"],
            ['Nouveauté produit', "« La pizza truffe est enfin de retour ! Réservez votre table. »"],
            ['Fermeture', "« On ferme samedi pour inventaire — reprise dimanche dès 8h. »"],
            ['Anniversaire', "« 3 ans de Nuvy ! Un croissant offert jeudi à tous nos fidèles. »"]
        ]);
        callout("Ce qu'il ne faut pas faire", [
            "Pas de ventes à rabais à répétition : vous habituez vos clients à ne plus venir au prix plein.",
            "Pas de messages génériques (« Passez nous voir ! ») : aucun trafic généré.",
            "Pas de clickbait : vous cassez la confiance et le client supprime la carte."
        ], 'warn');
    }
    h2('7.2 Segmentation clients');
    para("Le dashboard distingue automatiquement trois segments :");
    twoColTable([
        ['Clients VIP', 'Vos meilleurs clients. Au moins 10 passages cumulés et visite récente. À soigner.'],
        ['Clients Réguliers', 'Visites fréquentes mais pas encore VIP. À faire monter en gamme.'],
        ['Clients Dormants', 'Inactifs depuis plus de 60 jours. À réactiver en priorité.']
    ]);

    // ============================================================
    // 8. STATISTIQUES
    // ============================================================
    doc.addPage();
    h1('8. Lire vos statistiques');
    para("L'onglet « Statistiques » consolide la performance de votre programme. Voici comment interpréter chaque indicateur.");
    h2('8.1 Les trois KPI principaux');
    twoColTable([
        ['Clients inscrits', "Total des cartes Wallet générées. Surveillez la tendance — une courbe plate signale un problème d'acquisition."],
        ['Fréquence moyenne', 'Jours entre deux visites. Objectifs : < 14j pour un café, < 30j pour un restaurant, < 45j pour un coiffeur.'],
        ['Récompenses prêtes', 'Cadeaux disponibles non réclamés. Chaque récompense en attente est un client qui reviendra.']
    ]);
    h2("8.2 Courbe d'évolution");
    para("La courbe sur 30 jours montre l'accumulation de passages. Deux choses à regarder :");
    bullet("La pente : plus elle est raide, plus le programme accélère.");
    bullet("Les discontinuités : chute un lundi = jour de fermeture mal communiqué ; pic un week-end = effet d'une notification push.");
    h2('8.3 ROI estimé');
    para("Le CA généré par le programme est calculé à partir des paramètres renseignés en section 3.4. C'est une estimation — elle n'inclut ni les clients sans carte, ni le bouche-à-oreille.");
    para("Règle de lecture : si le ROI mensuel estimé est au moins 5 fois supérieur au prix de votre abonnement, le programme est largement rentable.", { italic: true });

    // ============================================================
    // 9. CHECKLIST
    // ============================================================
    doc.addPage();
    h1('9. Checklist de lancement');
    para("Imprimez cette page et cochez au fur et à mesure. Les commerçants qui suivent cette checklist convertissent en moyenne 40 % plus de clients fidélisés dans les trois premiers mois.");
    h2('Jour 0 — Mise en service');
    checklistItem('Connexion au dashboard réussie');
    checklistItem('Mot de passe provisoire changé');
    checklistItem('Adresse complète renseignée (GPS validé)');
    checklistItem('Numéro de téléphone renseigné');
    checklistItem("Lien d'avis Google renseigné");
    checklistItem('Panier moyen ou valeur tampon renseigné');
    if (canPersonalize(plan)) checklistItem('Couleurs, bandeau et emojis configurés');
    checklistItem("Tag NFC placé à l'emplacement optimal");
    checklistItem('Test complet réalisé (tap + formulaire + Wallet + dashboard)');
    checklistItem('Chevalet ou affichette de communication en place');
    checklistItem("Équipe briefée sur le script d'encaissement");
    h2('Semaine 1 — Vérifications');
    checklistItem('Au moins 10 premières cartes générées');
    checklistItem('Un passage client réel observé sur le dashboard');
    checklistItem("Aucune anomalie signalée par l'équipe");
    checklistItem('Communication sur les réseaux sociaux (photo du tag)');
    h2('Mois 1 — Optimisations');
    checklistItem('Analyse des statistiques : fréquence, clients inscrits, ROI');
    if (hasPush(plan)) checklistItem('Premier envoi de notification push');
    checklistItem('Identification des clients VIP — un mot personnalisé ne coûte rien');
    checklistItem('Révision éventuelle de la récompense si adoption faible');
    checklistItem("Demande d'avis Google sollicité auprès des meilleurs clients");

    // ============================================================
    // 10. SUPPORT
    // ============================================================
    doc.addPage();
    h1('10. Support et contact');
    para("Nuvy est une équipe française, joignable en français. Le support est inclus dans tous les plans.");
    h2('Comment nous joindre');
    twoColTable([
        ['Email', 'contact@nuvy.pro — réponse sous 24 heures ouvrées.'],
        ['Site web', 'nuvy.pro'],
        ['Changement de plan', 'À tout moment, sans engagement, par email.']
    ]);
    h2("En cas d'incident");
    para("Si votre tag NFC ne répond plus, si un client signale un bug, ou si vous constatez une anomalie :");
    numbered(1, "Vérifiez d'abord votre connexion internet.");
    numbered(2, "Déconnectez-vous et reconnectez-vous.");
    numbered(3, "Si le problème persiste : contact@nuvy.pro avec navigateur utilisé, heure du problème, capture d'écran.");
    callout('Un dernier mot', [
        "Nuvy n'est pas un produit figé — il évolue chaque mois avec les retours des commerçants comme vous.",
        "Si une fonctionnalité vous manque, si une interaction vous semble mal pensée, dites-le-nous.",
        "Bon lancement, et bienvenue dans le réseau."
    ], 'success');

    doc.end();
    return donePromise;
}

module.exports = { generateManuelPdf };