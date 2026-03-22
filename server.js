require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app = express();

// ── Stripe (only active when STRIPE_SECRET_KEY is set) ────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// ── Credit packs ──────────────────────────────────────────────────────────────
const CREDIT_PACKS = {
  starter: { price: 500,  credits: 10, label: '10 Articles' },
  creator: { price: 1000, credits: 25, label: '25 Articles' },
  studio:  { price: 2500, credits: 75, label: '75 Articles' },
};

// ── Storage abstraction ───────────────────────────────────────────────────────
// Uses Upstash Redis in production (env vars injected by Vercel marketplace).
// Falls back to in-memory Map for local dev — credits reset on server restart,
// which is fine for development.
let redis = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch (e) { /* redis stays null — local dev mode */ }

const _mem = new Map(); // local dev fallback only

async function storageGet(key) {
  if (redis) return redis.get(key);
  return _mem.get(key) ?? null;
}
async function storageSet(key, val, ttlSec) {
  if (redis) return ttlSec ? redis.set(key, val, { ex: ttlSec }) : redis.set(key, val);
  _mem.set(key, val);
  if (ttlSec) setTimeout(() => _mem.delete(key), ttlSec * 1000);
}
async function storageDel(key) {
  if (redis) return redis.del(key);
  _mem.delete(key);
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ── Routing ───────────────────────────────────────────────────────────────────
app.get('/app', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'app.html'))
);
app.use(express.static(path.join(__dirname, 'public')));

// ── GET /api/credits ──────────────────────────────────────────────────────────
app.get('/api/credits', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ valid: false, remaining: 0 });
  const entry = await storageGet(`credit:${token}`);
  if (!entry) return res.json({ valid: false, remaining: 0 });
  res.json({ valid: true, remaining: entry.remaining });
});

// ── POST /api/start-run ───────────────────────────────────────────────────────
// Deducts 1 credit and returns a short-lived run token.
// The 5 agent calls consume the run token (not the credit token) so
// exactly 1 credit is charged per article, regardless of agent count.
app.post('/api/start-run', async (req, res) => {
  const { creditToken } = req.body;
  if (!creditToken) return res.status(400).json({ error: 'Missing credit token' });

  const entry = await storageGet(`credit:${creditToken}`);
  if (!entry || entry.remaining <= 0) {
    return res.status(402).json({ error: 'Insufficient credits' });
  }

  entry.remaining--;
  entry.used = (entry.used || 0) + 1;
  await storageSet(`credit:${creditToken}`, entry);

  const runToken = crypto.randomUUID();
  await storageSet(`run:${runToken}`, { callsLeft: 5 }, 7200); // 2 hr TTL

  res.json({ runToken, remaining: entry.remaining });
});

// ── POST /api/create-checkout ─────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments not configured — add STRIPE_SECRET_KEY to environment variables' });
  }

  const selected = CREDIT_PACKS[req.body.pack] || CREDIT_PACKS.creator;
  const origin   = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency:     'usd',
          unit_amount:  selected.price,
          product_data: { name: `Byline — ${selected.label}` },
        },
        quantity: 1,
      }],
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/app`,
      metadata:    { credits: String(selected.credits) },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /success ──────────────────────────────────────────────────────────────
// Stripe redirects here after payment. We retrieve the session server-side,
// mint a credit token, and redirect to /app with the token in the URL.
// The client then saves it to localStorage — no auth/cookies needed.
app.get('/success', async (req, res) => {
  if (!stripe) return res.redirect('/app?error=payments_not_configured');

  const { session_id } = req.query;
  if (!session_id) return res.redirect('/app');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.redirect('/app?error=payment_not_completed');
    }

    // Idempotency — don't double-issue credits for the same Stripe session
    const existingToken = await storageGet(`session:${session_id}`);
    if (existingToken) {
      const existing = await storageGet(`credit:${existingToken}`);
      return res.redirect(`/app?token=${existingToken}&credits=${existing?.remaining ?? 0}&returning=1`);
    }

    const token   = crypto.randomUUID();
    const credits = parseInt(session.metadata.credits, 10) || 10;

    await storageSet(`credit:${token}`, {
      remaining:  credits,
      used:       0,
      created_at: new Date().toISOString(),
    });
    await storageSet(`session:${session_id}`, token); // idempotency record

    res.redirect(`/app?token=${token}&credits=${credits}&new=1`);
  } catch (err) {
    console.error('Success handler error:', err.message);
    res.redirect('/app?error=something_went_wrong');
  }
});

// ── POST /api/chat ────────────────────────────────────────────────────────────
// Accepts either:
//   { apiKey, ...anthropicBody }      — user's own key, bypasses credits
//   { runToken, ...anthropicBody }    — credits mode, key stays server-side
app.post('/api/chat', async (req, res) => {
  const { apiKey, runToken, ...body } = req.body;

  let keyToUse = apiKey;

  if (!apiKey) {
    if (!runToken) {
      return res.status(400).json({ error: 'Missing API key or run token' });
    }

    // Validate and consume one call from the run token
    const runEntry = await storageGet(`run:${runToken}`);
    if (!runEntry || runEntry.callsLeft <= 0) {
      return res.status(402).json({ error: 'Invalid or expired run token — please start a new run' });
    }
    runEntry.callsLeft--;
    // Update or delete (KV TTL stays unchanged on update)
    if (runEntry.callsLeft > 0) {
      await storageSet(`run:${runToken}`, runEntry, 7200);
    } else {
      await storageDel(`run:${runToken}`);
    }

    keyToUse = process.env.ANTHROPIC_API_KEY;
    if (!keyToUse) {
      return res.status(503).json({ error: 'Server Anthropic key not configured — add ANTHROPIC_API_KEY to environment variables' });
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         keyToUse,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json(err);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Export for Vercel (serverless), listen for local dev ─────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n  Byline → http://localhost:${PORT}`);
    if (!stripe)                        console.log('  ⚠  Stripe not configured');
    if (!process.env.ANTHROPIC_API_KEY) console.log('  ⚠  ANTHROPIC_API_KEY not set');
    if (!redis)                         console.log('  ℹ  No Redis store — using in-memory (local dev mode)');
    console.log();
  });
}
module.exports = app;
