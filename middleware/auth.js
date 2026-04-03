const { jwt, JWT_SECRET, supabase, PLAN_LIMITS } = require('../config');

function verifyAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Non authentifié. Token manquant." });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.auth = decoded; // { boutiqueId, slug, nom }
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

async function requireFeature(req, res, feature) {
    const boutiqueId = req.params.id || req.params.boutiqueId;
    const { data: boutique } = await supabase
        .from('boutiques')
        .select('plan')
        .eq('id', boutiqueId)
        .single();

    const plan = boutique?.plan || 'essentiel';
    const limits = PLAN_LIMITS[plan];

    if (!limits || !limits[feature]) {
        return res.status(403).json({
            error: "Cette fonctionnalité nécessite un plan supérieur.",
            feature,
            plan_actuel: plan,
            upgrade_required: plan === 'essentiel' ? 'pro' : 'multi-site',
        });
    }
    return true;
}

module.exports = { verifyAuth, verifyAuthOwner, requireFeature };
