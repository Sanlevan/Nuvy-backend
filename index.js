const { logger, jwt, MASTER_CEO_KEY, JWT_SECRET, googleCredentials, GOOGLE_ISSUER_ID, supabase, STEREOTYPES, SYMBOLS, PLAN_LIMITS } = require('./config');

const express = require('express');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const http = require('http');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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

// ==========================================
// WEBHOOK STRIPE (doit être AVANT express.json())
// ==========================================
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        logger.error('Webhook signature vérification échouée:', err.message);
        return res.sendStatus(400);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
    // ✅ Le commerçant vient de payer ! On active sa boutique
    const session = event.data.object;
    const customerId = session.customer;
    const boutiqueId = session.metadata?.boutique_id;
    
    if (boutiqueId) {
        await supabase
            .from('boutiques')
            .update({
                plan_status: 'active',
                stripe_subscription_id: session.subscription
            })
            .eq('id', boutiqueId);
        
        logger.info(`✅ Boutique ${boutiqueId} activée après paiement`);
    }
    break;
}

case 'invoice.payment_failed': {
    // ⚠️ Un paiement a échoué
    const invoice = event.data.object;
    const customerId = invoice.customer;
    const attemptCount = invoice.attempt_count || 1;
    
    logger.warn(`💳 Paiement échoué (tentative ${attemptCount}) pour customer ${customerId}`);
    
    // Récupérer la boutique
    const { data: boutique } = await supabase
        .from('boutiques')
        .select('id, nom, username, plan_status')
        .eq('stripe_customer_id', customerId)
        .single();
    
    if (!boutique) break;
    
    // Mettre à jour le statut selon le nombre de tentatives
    let newStatus = 'payment_warning'; // 1ère tentative
    if (attemptCount >= 3) {
        newStatus = 'suspended'; // 🚨 SUSPENSION après 3 échecs
        logger.error(`🚫 Boutique ${boutique.nom} (ID ${boutique.id}) SUSPENDUE`);
    }
    
    await supabase
        .from('boutiques')
        .update({
            plan_status: newStatus,
            payment_failed_count: attemptCount,
            payment_failed_at: new Date().toISOString()
        })
        .eq('id', boutique.id);
    
    break;
}

case 'invoice.payment_succeeded': {
    // ✅ Paiement régularisé : on réactive
    const invoice = event.data.object;
    const customerId = invoice.customer;
    
    const { data: boutique } = await supabase
        .from('boutiques')
        .select('id, nom, plan_status')
        .eq('stripe_customer_id', customerId)
        .single();
    
    if (!boutique) break;
    
    // Si la boutique était suspendue ou en warning, on réactive
    if (['suspended', 'payment_warning'].includes(boutique.plan_status)) {
        await supabase
            .from('boutiques')
            .update({
                plan_status: 'active',
                payment_failed_count: 0,
                payment_failed_at: null
            })
            .eq('id', boutique.id);
        
        logger.info(`✅ Boutique ${boutique.nom} RÉACTIVÉE après régularisation`);
    }
    break;
}

case 'customer.subscription.updated': {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const status = subscription.status;
    const plan = subscription.metadata?.plan || 'essentiel';

    await supabase
        .from('boutiques')
        .update({
            plan: plan,
            plan_status: (status === 'active' || status === 'trialing') ? 'active' : 'inactive'
        })
        .eq('stripe_customer_id', customerId);

    logger.info(`Subscription ${subscription.id} => ${status}`);
    break;
}

case 'customer.subscription.deleted': {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    await supabase
        .from('boutiques')
        .update({ plan_status: 'inactive' })
        .eq('stripe_customer_id', customerId);

    logger.info(`Subscription ${subscription.id} supprimée`);
    break;
}
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const status = subscription.status;
                const plan = subscription.metadata?.plan || 'essentiel';

                await supabase
                    .from('boutiques')
                    .update({
                        stripe_customer_id: customerId,
                        stripe_subscription_id: subscription.id,
                        plan: plan,
                        plan_status: status === 'active' || status === 'trialing' ? 'active' : 'inactive'
                    })
                    .eq('stripe_customer_id', customerId);

                logger.info(`Subscription ${subscription.id} => ${status}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const customerId = subscription.customer;

                await supabase
                    .from('boutiques')
                    .update({
                        plan_status: 'inactive'
                    })
                    .eq('stripe_customer_id', customerId);

                logger.info(`Subscription ${subscription.id} supprimée`);
                break;
            }

            default:
                logger.info(`Event non traité: ${event.type}`);
        }

        res.json({ received: true });
    } catch (err) {
        logger.error('Erreur traitement webhook Stripe:', err);
        res.sendStatus(500);
    }
});

app.use(express.json());

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