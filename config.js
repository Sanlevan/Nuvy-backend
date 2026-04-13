require('dotenv').config();
const pino = require('pino');
const logger = pino({ level: 'info' });
console.log("=== NUVY ENGINE V2.0 (PRODUCTION) ===");

const jwt = require('jsonwebtoken');

// ── SECRETS (crash si absent) ─────────────────────────────
const MASTER_CEO_KEY = process.env.CEO_KEY;
if (!MASTER_CEO_KEY) { console.error("FATAL : CEO_KEY manquante."); process.exit(1); }

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error("FATAL : JWT_SECRET manquante."); process.exit(1); }

// ── GOOGLE CREDENTIALS ────────────────────────────────────
let googleCredentials = null;
try {
    if (process.env.GOOGLE_CREDENTIALS) {
        googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        console.log("Clé Google chargée");
    } else {
        logger.warn("Aucune clé Google trouvée");
    }
} catch (e) {
    console.error({ err: e }, "GOOGLE_CREDENTIALS mal formaté");
}
const GOOGLE_ISSUER_ID = '3388000000023094987';

// ── SUPABASE ──────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// ── CONSTANTES MÉTIER ─────────────────────────────────────
const STEREOTYPES = {
    default:     { bg: "#FAF8F5", text: "#2A8C9C", label: "#AFE3E0" },
    boulangerie: { bg: "#ffcb9b", text: "#8B4513", label: "#CD853F" },
    pizza:       { bg: "#ff8080", text: "#CD5C5C", label: "#FFA07A" },
    onglerie:    { bg: "#fbadc7", text: "#C71585", label: "#FFB6C1" },
    coiffeur:    { bg: "#e4e4e4", text: "#2727b4", label: "#B0C4DE" },
    cafe:        { bg: "#F5F5DC", text: "#4B3621", label: "#A0522D" }
};

const SYMBOLS = {
    pizza:       { full: "🍕", empty: "◽" },
    onglerie:    { full: "💅", empty: "⚪" },
    cafe:        { full: "☕", empty: "▫️" },
    boulangerie: { full: "🥐", empty: "◽" },
    coiffeur:    { full: "✂️", empty: "▫️" },
    default:     { full: "●",  empty: "○" }
};

const PLAN_LIMITS = {
    essentiel: {
        max_clients: 500, max_boutiques: 1,
        push_notifications: false, analytics_avances: false,
        geolocalisation: false, rapport_pdf: false, personnalisation: false,
    },
    pro: {
        max_clients: 2000, max_boutiques: 1,
        push_notifications: true, analytics_avances: true,
        geolocalisation: false, rapport_pdf: false, personnalisation: true,
    },
    'multi-site': {
        max_clients: Infinity, max_boutiques: Infinity,
        push_notifications: true, analytics_avances: true,
        geolocalisation: true, rapport_pdf: true, personnalisation: true,
    },
};

// ── UPLOAD MULTER (mémoire, pas disque) ───────────────────
const multer = require('multer');
const uploadStrip = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Format non supporté (PNG/JPEG/WEBP uniquement)'));
    }
});

module.exports = {
    logger, jwt, MASTER_CEO_KEY, JWT_SECRET, googleCredentials,
    GOOGLE_ISSUER_ID, supabase, STEREOTYPES, SYMBOLS, PLAN_LIMITS,
    uploadStrip
};