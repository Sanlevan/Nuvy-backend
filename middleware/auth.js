const { jwt, JWT_SECRET, supabase, PLAN_LIMITS } = require('../config');

async function verifyAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Non authentifié. Token manquant." });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.auth = decoded;
        
        // 🆕 Vérifier le statut de la boutique
        const { data: boutique } = await supabase
            .from('boutiques')
            .select('plan_status')
            .eq('id', decoded.boutiqueId)
            .single();
        
        if (boutique?.plan_status === 'suspended') {
            return res.status(402).json({ 
                error: "Votre boutique est suspendue suite à un défaut de paiement. Régularisez votre situation pour réactiver l'accès.",
                suspended: true
            });
        }
        
        next();
    } catch (e) {
        return res.status(401).json({ error: "Session expirée. Reconnectez-vous." });
    }
}

function verifyAuthOwner(req, res, next) {
    verifyAuth(req, res, () => {
        if (String(req.auth.boutiqueId) !== String(req.params.id)) {
            return res.status(403).json({ error: "Accès interdit à cette boutique." });
        }
        next();
    });
}

// Labels lisibles pour les messages d'erreur côté frontend
const FEATURE_LABELS = {
    push_notifications: 'Notifications push',
    analytics_avances: 'Statistiques avancées',
    segments: 'Segmentation clients',
    personnalisation: 'Personnalisation visuelle',
    geolocalisation: 'Géolocalisation',
    rapport_pdf: 'Rapports PDF',
};

async function requireFeature(req, res, feature) {
    try {
        const boutiqueId = req.params.id || req.params.boutiqueId || req.auth?.boutiqueId;
        
        if (!boutiqueId) {
            res.status(400).json({ error: "Identifiant boutique manquant." });
            return false;
        }

        const { data: boutique, error } = await supabase
            .from('boutiques')
            .select('plan')
            .eq('id', boutiqueId)
            .single();

        if (error || !boutique) {
            res.status(404).json({ error: "Boutique introuvable." });
            return false;
        }

        const plan = boutique.plan || 'essentiel';
        const limits = PLAN_LIMITS[plan];

        if (!limits || !limits[feature]) {
            res.status(403).json({
                error: `${FEATURE_LABELS[feature] || feature} : fonctionnalité non incluse dans votre plan.`,
                feature,
                plan_actuel: plan,
                upgrade_required: plan === 'essentiel' ? 'pro' : 'multi-site',
            });
            return false;
        }
        return true;
    } catch (e) {
        console.error("Erreur requireFeature:", e);
        res.status(500).json({ error: "Erreur lors de la vérification du plan." });
        return false;
    }
}

module.exports = { verifyAuth, verifyAuthOwner, requireFeature };