// ============================================================
// services/stripe.js
// Centralisation de toute la logique Stripe pour Nuvy
// ============================================================

const Stripe = require('stripe');
const { logger } = require('../config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.NUVY_BASE_URL || 'https://nuvy.pro';

// ------------------------------------------------------------
// Mapping plan + engagement → Price ID Stripe
// ------------------------------------------------------------
function getPriceId(plan, engagement) {
    const priceMap = {
        'essentiel_mensuel': process.env.STRIPE_PRICE_ESSENTIEL_MENSUEL,
        'essentiel_annuel': process.env.STRIPE_PRICE_ESSENTIEL_ANNUEL,
        'pro_mensuel': process.env.STRIPE_PRICE_PRO_MENSUEL,
        'pro_annuel': process.env.STRIPE_PRICE_PRO_ANNUEL,
        'multi-site_mensuel': process.env.STRIPE_PRICE_MULTISITE_MENSUEL,
        'multi-site_annuel': process.env.STRIPE_PRICE_MULTISITE_ANNUEL
    };
    const key = `${plan}_${engagement}`;
    const priceId = priceMap[key];
    if (!priceId) throw new Error(`Price ID manquant pour ${key}. Vérifie tes env vars Railway.`);
    return priceId;
}

// ------------------------------------------------------------
// Créer un customer Stripe (sans subscription)
// ------------------------------------------------------------
async function createCustomer({ nom, email, slug }) {
    const customer = await stripe.customers.create({
        email: email || `${slug}@nuvy.pro`,
        name: nom,
        metadata: { boutique_name: nom, slug }
    });
    logger.info(`Stripe customer créé : ${customer.id} (${nom})`);
    return customer;
}

// ------------------------------------------------------------
// Créer une session Stripe Checkout (trial 14j, CB + SEPA, lien valide 30j)
// ------------------------------------------------------------
async function createCheckoutSession({
    customerId,
    boutiqueId,
    plan,
    engagement,
    slug
}) {
    const priceId = getPriceId(plan, engagement);

    // Lien valide 30 jours (max Stripe). Permet au merchant de cliquer
    // dans le PDF même plusieurs jours après la démo.
    const expiresAt = Math.floor(Date.now() / 1000) + (23 * 60 * 60);

    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        payment_method_types: ['card', 'sepa_debit'],
        line_items: [{
            price: priceId,
            quantity: 1
        }],
        subscription_data: {
            trial_period_days: 14,
            metadata: {
                plan,
                engagement,
                boutique_id: String(boutiqueId)
            }
        },
        metadata: {
            boutique_id: String(boutiqueId),
            plan,
            engagement,
            slug
        },
        success_url: `${BASE_URL}/login?paid=1&slug=${slug}`,
        cancel_url: `${BASE_URL}/`,
        locale: 'fr',
        consent_collection: {
            terms_of_service: 'required'
        },
        allow_promotion_codes: true,
        expires_at: expiresAt
    });

    logger.info(`Checkout session créée : ${session.id} pour boutique ${boutiqueId}`);
    return session;
}

// ------------------------------------------------------------
// Customer Portal (Phase 4)
// ------------------------------------------------------------
async function createPortalSession({ customerId, returnUrl }) {
    return await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl || `${BASE_URL}/dashboard`
    });
}

// ------------------------------------------------------------
// Helpers subscription
// ------------------------------------------------------------
async function getSubscription(subscriptionId) {
    return await stripe.subscriptions.retrieve(subscriptionId);
}

async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
    return await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
    });
}

async function reactivateSubscription(subscriptionId) {
    return await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false
    });
}

// ------------------------------------------------------------
// Webhook signature
// ------------------------------------------------------------
function verifyWebhookSignature(rawBody, signature) {
    return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// ------------------------------------------------------------
// Mapping Stripe status → notre plan_status
// ------------------------------------------------------------
function mapStripeStatus(status) {
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
}

module.exports = {
    stripe,
    getPriceId,
    createCustomer,
    createCheckoutSession,
    createPortalSession,
    getSubscription,
    cancelSubscriptionAtPeriodEnd,
    reactivateSubscription,
    verifyWebhookSignature,
    mapStripeStatus
};