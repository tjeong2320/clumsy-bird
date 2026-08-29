/**
 * Clumsy Bird — Neon Hosted Checkout backend (simplified)
 *
 *
 * Responsibilities:
 *   1. Serve the melonJS game as static assets.
 *   2. POST /api/checkout                  -> create Neon Hosted Checkout session
 *   3. GET  /api/checkout/:checkoutId      -> polled by the in-game Shop modal
 *   4. POST /api/checkout/:checkoutId/expire -> expire an in-flight checkout
 *   5. GET  /api/entitlements?accountId=... -> returns { heartsPurchased }
 *   6. POST /api/webhook                   -> Neon -> game server. Verifies x-neon-digest
 *                                             HMAC-SHA256 and grants hearts on
 *                                             purchase.completed.
 *   7. GET  /_debug/state                  -> dev-only snapshot of in-memory state.
 *
 * Reference: https://docs.neonpay.com/docs/checkout
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NEON_API_KEY = process.env.NEON_API_KEY || '';
const NEON_WEBHOOK_SECRET = process.env.NEON_WEBHOOK_SECRET || '';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const COUNTRY_TO_LOCALE = {
    US: 'en-US', CA: 'en-CA', GB: 'en-GB',
    JP: 'ja-JP', KR: 'ko-KR', CN: 'zh-CN',
};
const CATALOG = {
    offer_extra_heart_sku: {
        name: 'Extra Heart',
        price: 1, // prices.1.price from GET price response
        grants: { hearts: 1 }
    },
    offer_heart_box_sku: {
        name: 'Heart Box',
        price: 4, // prices.4.price from GET price response
        grants: { hearts: 4 }
    }    
};
const MAX_HEARTS_PURCHASED = 4;
const SANDBOX = {
    is_sandbox: process.env.IS_SANDBOX === 'true',
    ip: process.env.SANDBOX_IP || '8.8.8.8',
    locale: process.env.SANDBOX_LOCALE || 'en-US',
}

// ---------------------------------------------------------------------------
// In-memory state — checkouts + purchases + grants. Lost on server restart
// ---------------------------------------------------------------------------
const checkouts = new Map();
const purchases = new Map();
const grants = new Map();
const processedEventIds = new Set(); // webhook idempotency

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function getAccountGrants(accountId) {
    if (!grants.has(accountId)) {
        grants.set(accountId, { heartsPurchased: 0 });
    }
    return grants.get(accountId);
}

function clampHearts(n) {
    return Math.max(0, Math.min(MAX_HEARTS_PURCHASED, n | 0));
}

function localeFor(country) {
    return COUNTRY_TO_LOCALE[country] || SANDBOX.locale;
}

// ---------------------------------------------------------------------------
// App + middleware
// ---------------------------------------------------------------------------
const app = express();

app.set('trust proxy', 1);
app.post('/api/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    handleWebhook
);
app.use(express.json({ limit: '64kb' }));

// ---------------------------------------------------------------------------
// Neon API helper
// ---------------------------------------------------------------------------
async function getNeonPrices(ip, item, priceOffset) {
    if (!NEON_API_KEY || !ip) return null;
    try {
        const qs = (SANDBOX.is_sandbox) ? new URLSearchParams({ ip: SANDBOX.ip }) : new URLSearchParams({ ip });
        const res = await fetch('https://api.neonpay.com/prices?' + qs.toString(), {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'X-API-Key': NEON_API_KEY
            }
        });
        if (res.status !== 200) {
            console.warn(`Neon /prices returned ${res.status} for ip=${ip}`);
            return null;
        }
        const body = await res.json();
        const country = body.country;
        const currency = body.currency;
        const price = body.prices[item.price - priceOffset].price;
        if (!country || !currency || !price) return null;
        return {
            country: String(country).toUpperCase(),
            currency: String(currency).toUpperCase(),
            price
        };
    } catch (err) {
        console.warn('Neon /prices lookup failed:', err.message || err);
        return null;
    }
}

async function createNeonCheckout(payload) {
    const res = await fetch('https://api.neonpay.com/checkout', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'X-API-Key': NEON_API_KEY
        },
        body: JSON.stringify(payload)
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    console.log(`Neon /checkout returned ${res.status} for ${JSON.stringify(payload)}: ${JSON.stringify(body)}`);
    return { status: res.status, body };
}

async function getNeonCheckout(checkoutId) {
    const res = await fetch(`https://api.neonpay.com/checkout/${checkoutId}`, {
        method: 'GET',
        headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'X-API-Key': NEON_API_KEY
        },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    // console.log(`Neon /checkout/${checkoutId} returned ${res.status}`);
    return { status: res.status, body };
}

async function expireNeonCheckout(checkoutId) {
    const res = await fetch(`https://api.neonpay.com/checkout/${checkoutId}/expire`, {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'X-API-Key': NEON_API_KEY
        },
        body: JSON.stringify({})    
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    console.log(`Neon /checkout/${checkoutId}/expire returned ${res.status} for ${checkoutId}`);
    return { status: res.status, body };
}

async function getLocalizedPrice(ip, item, heartsPurchased) {
    if (!ip) return null;
    let priceOffset = 0;
    if (item.name === 'Heart Box') {
        priceOffset = heartsPurchased;
    }
    const fresh = await getNeonPrices(ip, item, priceOffset);

    const resolved = fresh
        ? { country: fresh.country, 
            currency: fresh.currency, 
            locale: localeFor(fresh.country), 
            item: item.name, 
            price: fresh.price 
        }
        : null;
    console.log('resolved', resolved);
    return resolved;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
// https://docs.neonpay.com/reference/createcheckout
app.post('/api/checkout', async (req, res) => {
    if (!NEON_API_KEY) {
        return res.status(500).json({
            error: 'NEON_API_KEY is not configured. See README.md.'
        });
    }
    const accountId = (req.body && req.body.accountId) || '';
    if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
    }

    const sku = (req.body && req.body.sku) || '';
    if (!sku) {
        return res.status(400).json({ error: 'sku is required' });
    }

    const item = CATALOG[sku];
        if (!item) {
        return res.status(400).json({ error: 'Unknown sku', sku });
    }

    const g = getAccountGrants(accountId);

    if (g.heartsPurchased >= MAX_HEARTS_PURCHASED) {
        return res.status(409).json({
            error: 'Maximum heart count reached'
        });
    }

    const get_price = await getLocalizedPrice(req.ip, item, g.heartsPurchased);

    const payload = {
        items: [{
            sku: sku,
            name: item.name,
            quantity: 1,
            price: get_price.price,
            bundleContents: []
        }],
        accountId: accountId,
        successUrl: PUBLIC_URL,
        playerCountry: get_price.country,
        currency: get_price.currency,
        languageLocale: get_price.locale
    };

    try {
        const { status, body } = await createNeonCheckout(payload);
        if (status !== 200 && status !== 201) {
            console.error('Neon POST checkout API error', status, body);
            // order.status = 'cancelled';
            return res.status(502).json({
                error: 'Neon API rejected the checkout request',
                details: body
            });
        }
        if (!body || !body.redirectUrl) {
            // order.status = 'cancelled';
            return res.status(502).json({
                error: 'Neon response missing redirectUrl',
                details: body
            });
        }
        const checkout = {
            id: body.id, // ID of the created checkout
            accountId: accountId,
            itemId: sku,
            status: 'open',
            createdAt: new Date().toISOString(),
            country: get_price.country,
            currency: get_price.currency,
            locale: get_price.locale,
            price: get_price.price,
            clientIp: req.ip
        };
        checkouts.set(checkout.id, checkout); 
        return res.json({
            id: checkout.id, // ID of the created checkout
            itemId: sku,
            status: checkout.status,
            redirectUrl: body.redirectUrl,
            country: checkout.country,
            currency: checkout.currency,
            locale: checkout.locale
        });
    } catch (err) {
        console.error('Failed to call Neon checkout API', err);
        return res.status(502).json({ error: 'Failed to reach Neon API', detail: String(err) });
    }
});

// https://docs.neonpay.com/reference/getcheckout
app.get('/api/checkout/:checkoutId', async (req, res) => {
    try {
        const { status, body } = await getNeonCheckout(req.params.checkoutId);
        if (status !== 200 && status !== 201) {
            console.error('Neon GET checkout API error', status, body);
            // order.status = 'cancelled';
            return res.status(502).json({
                error: 'Neon API rejected the checkout request',
                details: body
            });
        }

        const checkoutId = body.id;

        const checkout = checkouts.get(checkoutId);
        if (checkout) {
            checkout.status = body.status;
        }
        // console.log(`checkout ${checkoutId} updated to ${body.status}`);
        checkouts.set(checkoutId, checkout);


        return res.json({
            id: checkoutId, // ID of the created checkout
            status: body.status
        });
    } catch (err) {
        console.error('Failed to call Neon checkout API', err);
        return res.status(502).json({ error: 'Failed to reach Neon API', detail: String(err) });
    }    
});

// https://docs.neonpay.com/reference/expirecheckout
app.post('/api/checkout/:checkoutId/expire', async (req, res) => {
    try {
        const { status, body } = await expireNeonCheckout(req.params.checkoutId);
        if (status !== 200 && status !== 201) {
            console.error('Neon POST expire checkout API error', status, body);
            // order.status = 'cancelled';
            return res.status(502).json({
                error: 'Neon API rejected the checkout request',
                details: body
            });
        }

        const checkoutId = body.checkoutId

        const checkout = checkouts.get(checkoutId);
        if (checkout) {
            checkout.status = 'expired';
        }
        checkouts.set(checkoutId, checkout);
        
        return res.json({
            id: checkoutId,
            message: body.message,
        });
    } catch (err) {
        console.error('Failed to call Neon checkout API', err);
        return res.status(502).json({ error: 'Failed to reach Neon API', detail: String(err) });
    }
});

app.get('/api/entitlements', (req, res) => {
    const accountId = req.query.accountId || '';
    const g = accountId ? getAccountGrants(accountId) : { heartsPurchased: 0 };
    return res.json({
        heartsPurchased: g.heartsPurchased,
        totalHearts: 1 + g.heartsPurchased
    });
});

// ---------------------------------------------------------------------------
// Debug endpoint: Returns the in-memory Maps/Sets for inspection during development.
// ---------------------------------------------------------------------------
app.get('/_debug/state', (req, res) => {
    const checkoutsArr = [];
    for (const [id, c] of checkouts) checkoutsArr.push(c);
    const purchasesArr = [];
    for (const [id, p] of purchases) purchasesArr.push(p);
    const grantsArr = [];
    for (const [accountId, g] of grants) grantsArr.push({ accountId, ...g });
    res.json({
        checkouts: checkoutsArr,
        purchases: purchasesArr,
        grants: grantsArr,
        processedEventIds: [...processedEventIds],
        counts: {
            checkouts: checkouts.size,
            purchases: purchases.size,
            grants: grants.size,
            processedEventIds: processedEventIds.size
        }
    });
});

// ---------------------------------------------------------------------------
// Webhook handler (Neon to Game server)
// ---------------------------------------------------------------------------
function findCheckoutForPurchase(purchase) {
    console.log('findCheckoutForPurchase', purchase);
    if (purchase.checkoutId) {
        for (const c of checkouts.values()) {
            if (c.id === purchase.checkoutId) return c;
        }
    }
    // Fallback: most recent pending order for this account.
    let latest = null;
    for (const c of checkouts.values()) {
        if (c.accountId !== purchase.accountId) continue;
        if (c.status !== 'open') continue;
        if (!latest || c.createdAt > latest.createdAt) latest = c;
    }
    return latest;
}

function handleWebhook(req, res) {
    const rawBody = req.body;
    const signature = req.headers['x-neon-digest'];

    if (!NEON_WEBHOOK_SECRET) {
        console.warn('NEON_WEBHOOK_SECRET not configured; rejecting webhook.');
        return res.status(500).send('webhook secret not configured');
    }

    if (!signature || typeof signature !== 'string') {
        return res.status(400).send('missing x-neon-digest header');
    }

    const expected = crypto
        .createHmac('sha256', NEON_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    let a, b;
    try {
        a = Buffer.from(expected, 'hex');
        b = Buffer.from(signature, 'hex');
    } catch (e) {
        return res.status(400).send('invalid signature format');
    }
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).send('invalid signature');
    }

    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); }
    catch (e) { return res.status(400).send('invalid JSON body'); }
    // console.log(`rawBody=${rawBody}`);
    // console.log(`event=${event}`);
    // console.log(`event stringify=${JSON.stringify(event)}`);

    // Idempotency: skip duplicates.
    if (event.id && processedEventIds.has(event.id)) {
        console.log(`[webhook] ignoring duplicate event id=${event.id}`);
        return res.status(200).send('duplicate');
    }

    // handle account.getInventory callback
    if (!event || event.type === undefined) {
        console.log(`[webhook] ignoring event type=${event.type}`);
        if (event.id) processedEventIds.add(event.id);
        const g = getAccountGrants(event.account);
        return res.status(200).json([
            {
                "sku": "offer_extra_heart_sku",
                "purchased": g.heartsPurchased,
                "limit": MAX_HEARTS_PURCHASED
            },
            {
                "sku": "offer_heart_box_sku",
                "purchased": (g.heartsPurchased === MAX_HEARTS_PURCHASED ? 1 : 0),
                "limit": 1
            }
        ]);
    }    

    // Acknowledge non-purchase events so Neon doesn't retry.
    if (!event || event.type !== 'purchase.completed') {
        console.log(`[webhook] ignoring event type=${event.type}`);
        if (event.id) processedEventIds.add(event.id);
        return res.status(200).send('ignored');
    }

    const purchaseData = event.data.purchase;
    if (!purchaseData || !purchaseData.accountId) {
        console.log(`[webhook] missing purchase.accountId`);
        return res.status(400).send('missing purchase.accountId');
    }

    // Try to find the checkout created at checkout time so we can mark it fulfilled.
    const matchedCheckout = findCheckoutForPurchase(purchaseData);
    if (!matchedCheckout) {
        console.log(`[webhook] no checkout found for purchase ${JSON.stringify(purchaseData)}`);
        return res.status(400).send('no checkout found');
    }

    const purchase = {
            id: purchaseData.id, // Purchase ID
            orderNumber: purchaseData.orderNumber,
            checkoutId: purchaseData.checkoutId,
            status: purchaseData.status,
            accountId: purchaseData.accountId,
            date: purchaseData.date,
            items: purchaseData.items,
    }
    purchases.set(purchase.id, purchase);

    // Grant hearts (idempotent per purchase.id).
    const items = Array.isArray(purchaseData.items) ? purchaseData.items : [];
    for (const it of items) {
        if (it.sku === 'offer_extra_heart_sku') {
            const g = getAccountGrants(purchaseData.accountId);
            g.heartsPurchased = clampHearts(g.heartsPurchased + 1);
            grants.set(purchaseData.accountId, { heartsPurchased: g.heartsPurchased });
            console.log(`[webhook] extra_heart ${it.sku} purchased ${g.heartsPurchased}`);
        }
        if (it.sku === 'offer_heart_box_sku') {
            const g = getAccountGrants(purchaseData.accountId);
            g.heartsPurchased = MAX_HEARTS_PURCHASED;
            grants.set(purchaseData.accountId, { heartsPurchased: g.heartsPurchased });
            console.log(`[webhook] heart_box ${it.sku} purchased ${g.heartsPurchased}`);
        }
    }

    if (matchedCheckout) {
        console.log(`[webhook] found checkout ${matchedCheckout.id} for accountId ${purchaseData.accountId}`);
        matchedCheckout.status = 'complete';
        checkouts.set(matchedCheckout.id, matchedCheckout);
        console.log(`checkout ${matchedCheckout.id} updated to ${matchedCheckout.status}`);
    }
    if (event.id) processedEventIds.add(event.id);

    console.log(`[fulfillment] accountId=${purchaseData.accountId} checkout=${matchedCheckout.id} grants=${purchaseData.accountId}=${grants.get(purchaseData.accountId).heartsPurchased}`);
    return res.status(200).send('ok');
}

// ---------------------------------------------------------------------------
// Static files for the game (everything else).
// ---------------------------------------------------------------------------
const path = require('path');
app.use(express.static(path.join(__dirname, '..')));

app.listen(PORT, () => {
    console.log(`Clumsy Bird + Neon backend listening on ${PUBLIC_URL}`);
    if (!NEON_API_KEY) {
        console.warn('  ! NEON_API_KEY is not set. Set it in .env before testing checkout.');
    }
    if (!NEON_WEBHOOK_SECRET) {
        console.warn('  ! NEON_WEBHOOK_SECRET is not set. Webhook will reject all requests until it is set.');
    }
});