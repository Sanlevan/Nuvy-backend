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

    // 1. Vérification de signature
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        logger.error('Webhook signature vérification échouée:', err.message);
        return res.sendStatus(400);
    }

    // 2. Idempotence : on a déjà traité cet event ?
    const { data: existingEvent } = await supabase
        .from('stripe_webhook_events')
        .select('id')
        .eq('stripe_event_id', event.id)
        .maybeSingle();

    if (existingEvent) {
        logger.info(`Event ${event.id} déjà traité, skip.`);
        return res.json({ received: true, duplicate: true });
    }

    // 3. Mapping Stripe status → notre plan_status
    const mapStripeStatus = (status) => {
        const map = {
            'trialing': 'trialing',
            'active': 'active',
            'past_due': 'past_due',
            'canceled': 'canceled',
            'unpaid': 'past_due',
            'incomplete': 'pending_payment',
            'incomplete_expired': 'inactive'
        };
        return map[status] || 'inactive';
    };

    // 4. Traitement
    try {
        switch (event.type) {

            // -------- CHECKOUT TERMINÉ : le merchant a payé / setup CB --------
            case 'checkout.session.completed': {
                const session = event.data.object;
                const customerId = session.customer;
                const subscriptionId = session.subscription;
                const boutiqueId = session.metadata?.boutique_id;

                if (!subscriptionId || !boutiqueId) {
                    logger.warn(`checkout.session.completed sans subscription/boutique_id (session ${session.id})`);
                    break;
                }

                // Récupérer la subscription pour avoir status + trial_end
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                const trialEndsAt = subscription.trial_end
                    ? new Date(subscription.trial_end * 1000).toISOString()
                    : null;

                await supabase
                    .from('boutiques')
                    .update({
                        stripe_customer_id: customerId,
                        stripe_subscription_id: subscriptionId,
                        plan_status: mapStripeStatus(subscription.status),
                        trial_ends_at: trialEndsAt
                    })
                    .eq('id', boutiqueId);

                logger.info(`✅ Boutique ${boutiqueId} activée (subscription ${subscriptionId}, status ${subscription.status})`);
                break;
            }

            // -------- SUBSCRIPTION CRÉÉE OU MISE À JOUR --------
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const plan = subscription.metadata?.plan;

                const updatePayload = {
                    stripe_subscription_id: subscription.id,
                    plan_status: mapStripeStatus(subscription.status)
                };
                if (plan) updatePayload.plan = plan;
                if (subscription.trial_end) {
                    updatePayload.trial_ends_at = new Date(subscription.trial_end * 1000).toISOString();
                }

                await supabase
                    .from('boutiques')
                    .update(updatePayload)
                    .eq('stripe_customer_id', customerId);

                logger.info(`Subscription ${subscription.id} => ${subscription.status} (plan_status: ${updatePayload.plan_status})`);
                break;
            }

            // -------- SUBSCRIPTION SUPPRIMÉE --------
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                await supabase
                    .from('boutiques')
                    .update({ plan_status: 'canceled' })
                    .eq('stripe_customer_id', subscription.customer);

                logger.info(`Subscription ${subscription.id} supprimée`);
                break;
            }

            // -------- PAIEMENT RÉUSSI --------
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                await supabase
                    .from('boutiques')
                    .update({
                        plan_status: 'active',
                        last_payment_error: null,
                        payment_failed_at: null,
                        payment_failed_count: 0
                    })
                    .eq('stripe_customer_id', invoice.customer);

                logger.info(`💰 Paiement réussi customer ${invoice.customer} (${invoice.amount_paid / 100}€)`);
                break;
            }

            // -------- PAIEMENT ÉCHOUÉ : warning → suspended après 3 tentatives --------
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const attemptCount = invoice.attempt_count || 1;
                const errorMsg = invoice.last_finalization_error?.message
                    || invoice.last_payment_error?.message
                    || 'Paiement refusé';

                const newStatus = attemptCount >= 3 ? 'suspended' : 'payment_warning';

                await supabase
                    .from('boutiques')
                    .update({
                        plan_status: newStatus,
                        last_payment_error: errorMsg,
                        payment_failed_at: new Date().toISOString(),
                        payment_failed_count: attemptCount
                    })
                    .eq('stripe_customer_id', invoice.customer);

                if (newStatus === 'suspended') {
                    logger.error(`🚫 Customer ${invoice.customer} SUSPENDU (tentative ${attemptCount}): ${errorMsg}`);
                } else {
                    logger.warn(`⚠️ Paiement échoué customer ${invoice.customer} (tentative ${attemptCount}): ${errorMsg}`);
                }
                break;
            }

            default:
                logger.info(`Event non traité: ${event.type}`);
        }

        // 5. Marquer l'event comme traité (idempotence)
        await supabase
            .from('stripe_webhook_events')
            .insert({
                stripe_event_id: event.id,
                event_type: event.type,
                payload: event.data.object
            });

        res.json({ received: true });
    } catch (err) {
        logger.error('Erreur traitement webhook Stripe:', err);
        // On ne marque PAS l'event comme traité → Stripe va retry
        res.sendStatus(500);
    }
});

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