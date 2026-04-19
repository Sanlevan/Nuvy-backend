const { logger, jwt, MASTER_CEO_KEY, JWT_SECRET, googleCredentials, GOOGLE_ISSUER_ID, supabase, STEREOTYPES, SYMBOLS, PLAN_LIMITS } = require('./config');

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const http = require('http');
const rateLimit = require('express-rate-limit');

// Services
const { generatePassBuffer, refreshAllPasses, sendPushToDevices } = require('./services/applePass');
const { generateGoogleWalletLink, updateGoogleWalletPass, pushMessageToAllGoogleCards } = require('./services/googleWallet');

// Routers
const adminRouter = require('./routes/admin');
const reseauxRouter = require('./routes/reseaux');
const authRouter = require('./routes/auth');
const boutiquesRouter = require('./routes/boutiques');
const clientsRouter = require('./routes/clients');
const walletRouter = require('./routes/wallet');
const { router: tapRouter, createTapNotifyRoute } = require('./routes/tap');
const createJoinRoutes = require('./routes/join');
const accountRouter = require('./routes/account');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ["https://nuvy.pro", "https://nuvy-production.up.railway.app"] } });

app.use(express.json());
app.use(express.static('public'));

const limiterStrict = rateLimit({
    windowMs: 15 * 60 * 1000, max: 30,
    message: { error: "Trop de requêtes. Réessayez dans quelques minutes." }
});
const limiterLogin = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});

// ==========================================
// PAGES HTML STATIQUES
// ==========================================
// Landing page publique (nouveau)
app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, 'public', 'index.html')));
// Page de connexion commerçant
app.get('/login', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard.html')));
app.get('/cgv', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'cgv.html')));
app.get('/cgu', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'cgu.html')));
app.get('/confidentialite', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'confidentialite.html')));
app.get('/mentions-legales', (req, res) => res.sendFile(path.resolve(__dirname, 'legal', 'mentions-legales.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.resolve(__dirname, 'public', 'admin-login.html')));
app.get('/nuvy-ceo-portal', (req, res) => {
    if (req.query.key !== MASTER_CEO_KEY) return res.redirect('/admin-login?error=1');
    res.sendFile(path.resolve(__dirname, 'admin.html'));
});
app.get('/reseau-login', (req, res) => res.sendFile(path.resolve(__dirname, 'reseau-login.html')));
app.get('/reseau-dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'reseau-dashboard.html')));

// ==========================================
// ROUTERS
// ==========================================
app.use('/auth', limiterLogin, authRouter);
app.use('/admin', adminRouter);
app.use('/', reseauxRouter);
app.use('/boutiques', boutiquesRouter);
app.use('/clients', clientsRouter);
app.use('/', walletRouter);
app.use('/', tapRouter);
app.post('/tap/:slug/notify', limiterStrict, createTapNotifyRoute(io));
app.use('/join', createJoinRoutes(io));
app.use('/mon-compte', accountRouter);

// ==========================================
// SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
    socket.on('join-boutique', (slug) => { socket.join(slug.toLowerCase().trim()); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`=== MOTEUR NUVY PRÊT SUR LE PORT ${PORT} ===`));