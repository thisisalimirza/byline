require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const selfserve = require('./lib/selfserve');

const app = express();

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION & INITIALIZATION
// ══════════════════════════════════════════════════════════════════════════════

// ── Stripe (only active when STRIPE_SECRET_KEY is set) ────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

// ── Supabase (only active when configured) ────────────────────────────────────
let supabase = null;
let supabaseAdmin = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      supabaseAdmin = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
    }
  }
} catch (e) { /* supabase stays null — local dev mode */ }

// ── PostHog (only active when configured) ─────────────────────────────────────
let posthog = null;
try {
  if (process.env.POSTHOG_API_KEY) {
    const { PostHog } = require('posthog-node');
    posthog = new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
} catch (e) { /* posthog stays null */ }

// ── Credit packs ──────────────────────────────────────────────────────────────
const CREDIT_PACKS = {
  starter: { price: 500,  credits: 10, label: '10 Articles' },
  creator: { price: 1000, credits: 25, label: '25 Articles' },
  studio:  { price: 2500, credits: 75, label: '75 Articles' },
};

// ── Rate limiting configuration ───────────────────────────────────────────────
const RATE_LIMITS = {
  generation: { windowMs: 60 * 60 * 1000, max: 20 },  // 20 generations per hour
  auth:       { windowMs: 15 * 60 * 1000, max: 10 },  // 10 auth attempts per 15 min
  api:        { windowMs: 60 * 1000, max: 60 },       // 60 requests per minute
  verify:     { windowMs: 15 * 60 * 1000, max: 5 },   // codes and checks
  refund:     { windowMs: 60 * 60 * 1000, max: 8 },
  contact:    { windowMs: 60 * 60 * 1000, max: 5 },
  track:      { windowMs: 60 * 1000, max: 120 },
};

// ── Storage abstraction (Redis/KV for sessions and rate limits) ───────────────
let redis = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch (e) { /* redis stays null */ }

const _mem = new Map();

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
async function storageIncr(key, ttlSec) {
  if (redis) {
    const val = await redis.incr(key);
    if (val === 1 && ttlSec) await redis.expire(key, ttlSec);
    return val;
  }
  const curr = (_mem.get(key) || 0) + 1;
  _mem.set(key, curr);
  if (ttlSec && curr === 1) setTimeout(() => _mem.delete(key), ttlSec * 1000);
  return curr;
}

// ══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

// Raw body parser for Stripe webhooks (must be before express.json)
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }));

// JSON parser for all other routes
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting middleware ──────────────────────────────────────────────────
function rateLimit(category) {
  const config = RATE_LIMITS[category] || RATE_LIMITS.api;
  return async (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const key = `ratelimit:${category}:${ip}`;
    const windowSec = Math.ceil(config.windowMs / 1000);
    
    try {
      const count = await storageIncr(key, windowSec);
      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, config.max - count));
      
      if (count > config.max) {
        return res.status(429).json({ 
          error: 'Too many requests. Please wait a few minutes and try again.' 
        });
      }
    } catch (e) {
      // Don't block requests if rate limiting fails
      console.error('Rate limit error:', e.message);
    }
    next();
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  if (!supabase) {
    return res.status(503).json({ error: 'Authentication not configured' });
  }
  
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sign in to continue' });
  }
  
  const token = authHeader.slice(7);
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

// Optional auth - sets req.user if authenticated, continues otherwise
async function optionalAuth(req, res, next) {
  if (!supabase) return next();
  
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  
  const token = authHeader.slice(7);
  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) req.user = user;
  } catch (e) { /* ignore */ }
  next();
}

// ── Analytics helper ──────────────────────────────────────────────────────────
function trackEvent(distinctId, event, properties = {}) {
  if (!posthog) return;
  try {
    posthog.capture({
      distinctId: distinctId || 'anonymous',
      event,
      properties: {
        ...properties,
        $current_url: properties.url,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('PostHog error:', e.message);
  }
}

async function trackOnce(keys, distinctId, event, properties = {}) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  try {
    for (const key of list) {
      if (await storageGet(key)) return;
    }
    for (const key of list) {
      await storageSet(key, '1', 60 * 60 * 24 * 45);
    }
  } catch (e) {
    console.error('Analytics dedupe:', e.message);
  }
  trackEvent(distinctId, event, properties);
}

async function trackCheckoutComplete(session) {
  if (!session?.id) return;
  const distinctId = session.metadata?.user_id
    || session.metadata?.guest_token
    || session.customer_details?.email
    || session.id;
  await trackOnce(`funnel:checkout:${session.id}`, distinctId, 'checkout_complete', {
    credits: parseInt(session.metadata?.credits, 10) || 0,
    amount: (session.amount_total || 0) / 100,
  });
}

async function trackRefund(ids, distinctId, properties = {}) {
  const keys = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(id => `funnel:refund:${id}`);
  await trackOnce(keys, distinctId, 'refund', properties);
}

// ══════════════════════════════════════════════════════════════════════════════
// STATIC ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/app', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'app.html'))
);

app.get('/account', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'account.html'))
);

app.get('/refund', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'refund.html'))
);

app.get('/terms', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'terms.html'))
);

app.get('/privacy', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'))
);

app.get('/help', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'help.html'))
);

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/auth/status ──────────────────────────────────────────────────────
// Returns whether authentication is configured and available
app.get('/api/auth/status', (req, res) => {
  res.json({
    enabled: !!supabase,
    // Google sign-in stays off until it is explicitly turned on.
    google: false,
  });
});

// ── POST /api/auth/magic-link ─────────────────────────────────────────────────
app.post('/api/auth/magic-link', rateLimit('auth'), async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Sign-in not available yet. Your work is saved locally.' });
  }
  
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }
  
  const origin = req.headers.origin || `https://${req.headers.host}`;
  
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin}/app?auth=callback`,
      },
    });
    
    if (error) throw error;
    
    trackEvent(email, 'magic_link_sent', { email });
    res.json({ success: true, message: 'Check your email for the sign-in link' });
  } catch (e) {
    console.error('Magic link error:', e.message);
    res.status(500).json({ error: 'Could not send sign-in link. Try again.' });
  }
});

// ── GET /api/auth/google ──────────────────────────────────────────────────────
app.get('/api/auth/google', rateLimit('auth'), async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Sign-in not available yet' });
  }
  
  const origin = req.headers.origin || `https://${req.headers.host}`;
  
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/app?auth=callback`,
      },
    });
    
    if (error) throw error;
    res.json({ url: data.url });
  } catch (e) {
    console.error('Google auth error:', e.message);
    res.status(500).json({ error: 'Could not start Google sign-in' });
  }
});

// ── POST /api/auth/session ────────────────────────────────────────────────────
// Exchange auth code for session (called after OAuth redirect)
app.post('/api/auth/session', rateLimit('auth'), async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Sign-in not available' });
  }
  
  const { access_token, refresh_token } = req.body;
  
  if (!access_token) {
    return res.status(400).json({ error: 'Missing token' });
  }
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(access_token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    
    trackEvent(user.id, 'sign_in', { method: 'session_exchange', email: user.email });
    
    res.json({ 
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name,
        avatar: user.user_metadata?.avatar_url,
      },
      access_token,
      refresh_token,
    });
  } catch (e) {
    res.status(500).json({ error: 'Session error' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    // Get profile from database
    let profile = null;
    let credits = 0;
    
    if (supabaseAdmin) {
      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', req.user.id)
        .single();
      profile = profileData;
      
      const { data: balanceData } = await supabaseAdmin
        .from('credit_balances')
        .select('balance')
        .eq('user_id', req.user.id)
        .single();
      credits = balanceData?.balance || 0;
    }
    
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: profile?.full_name || req.user.user_metadata?.full_name || req.user.user_metadata?.name,
        avatar: profile?.avatar_url || req.user.user_metadata?.avatar_url,
      },
      credits,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load profile' });
  }
});

// ── POST /api/auth/sign-out ───────────────────────────────────────────────────
app.post('/api/auth/sign-out', async (req, res) => {
  // Sign-out is client-side (clear tokens), but we track it
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && supabase) {
    try {
      const token = authHeader.slice(7);
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) trackEvent(user.id, 'sign_out');
    } catch (e) { /* ignore */ }
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// USER DATA ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/user/drafts ──────────────────────────────────────────────────────
app.get('/api/user/drafts', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('drafts')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    res.json({ drafts: data || [] });
  } catch (e) {
    console.error('Drafts fetch error:', e.message);
    res.status(500).json({ error: 'Could not load drafts' });
  }
});

// ── POST /api/user/drafts ─────────────────────────────────────────────────────
app.post('/api/user/drafts', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { title, topic, keyword, meta, body } = req.body;
  if (!title && !body) {
    return res.status(400).json({ error: 'Draft must have a title or body' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('drafts')
      .insert({
        user_id: req.user.id,
        title: title || 'Untitled',
        topic,
        keyword,
        meta,
        body,
      })
      .select()
      .single();
    
    if (error) throw error;
    res.json({ draft: data });
  } catch (e) {
    console.error('Draft create error:', e.message);
    res.status(500).json({ error: 'Could not save draft' });
  }
});

// ── PUT /api/user/drafts/:id ──────────────────────────────────────────────────
app.put('/api/user/drafts/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { id } = req.params;
  const { title, topic, keyword, meta, body } = req.body;
  
  try {
    const { data, error } = await supabaseAdmin
      .from('drafts')
      .update({ title, topic, keyword, meta, body })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Draft not found' });
    res.json({ draft: data });
  } catch (e) {
    console.error('Draft update error:', e.message);
    res.status(500).json({ error: 'Could not update draft' });
  }
});

// ── DELETE /api/user/drafts/:id ───────────────────────────────────────────────
app.delete('/api/user/drafts/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { id } = req.params;
  
  try {
    const { error } = await supabaseAdmin
      .from('drafts')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('Draft delete error:', e.message);
    res.status(500).json({ error: 'Could not delete draft' });
  }
});

// ── GET /api/user/products ────────────────────────────────────────────────────
app.get('/api/user/products', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    
    if (error) throw error;
    res.json({ products: data || [] });
  } catch (e) {
    console.error('Products fetch error:', e.message);
    res.status(500).json({ error: 'Could not load products' });
  }
});

// ── POST /api/user/products ───────────────────────────────────────────────────
app.post('/api/user/products', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { name, description, url, benefits } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Product name is required' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .insert({
        user_id: req.user.id,
        name,
        description,
        url,
        benefits: benefits || [],
      })
      .select()
      .single();
    
    if (error) throw error;
    res.json({ product: data });
  } catch (e) {
    console.error('Product create error:', e.message);
    res.status(500).json({ error: 'Could not save product' });
  }
});

// ── PUT /api/user/products/:id ────────────────────────────────────────────────
app.put('/api/user/products/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { id } = req.params;
  const { name, description, url, benefits } = req.body;
  
  try {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ name, description, url, benefits })
      .eq('id', id)
      .eq('user_id', req.user.id)
      .select()
      .single();
    
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: data });
  } catch (e) {
    console.error('Product update error:', e.message);
    res.status(500).json({ error: 'Could not update product' });
  }
});

// ── DELETE /api/user/products/:id ─────────────────────────────────────────────
app.delete('/api/user/products/:id', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { id } = req.params;
  
  try {
    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .eq('id', id)
      .eq('user_id', req.user.id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error('Product delete error:', e.message);
    res.status(500).json({ error: 'Could not delete product' });
  }
});

// ── GET /api/user/credits ─────────────────────────────────────────────────────
app.get('/api/user/credits', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('credit_balances')
      .select('balance')
      .eq('user_id', req.user.id)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    res.json({ credits: data?.balance || 0 });
  } catch (e) {
    console.error('Credits fetch error:', e.message);
    res.status(500).json({ error: 'Could not load credits' });
  }
});

// ── GET /api/user/purchases ───────────────────────────────────────────────────
app.get('/api/user/purchases', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  try {
    const { data, error } = await supabaseAdmin
      .from('purchases')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    
    if (error) throw error;
    res.json({ purchases: data || [] });
  } catch (e) {
    console.error('Purchases fetch error:', e.message);
    res.status(500).json({ error: 'Could not load purchase history' });
  }
});

// ── POST /api/user/migrate ────────────────────────────────────────────────────
// Migrate local data to user account on first sign-in
app.post('/api/user/migrate', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const { drafts, products, creditToken, preferences } = req.body;
  const results = { drafts: 0, products: 0, credits: 0 };
  
  try {
    // Migrate drafts
    if (drafts && Array.isArray(drafts) && drafts.length > 0) {
      const draftsToInsert = drafts.slice(0, 30).map(d => ({
        user_id: req.user.id,
        title: d.title || 'Untitled',
        topic: d.topic,
        keyword: d.keyword,
        meta: d.meta,
        body: d.body,
        created_at: d.savedAt || new Date().toISOString(),
      }));
      
      const { data } = await supabaseAdmin
        .from('drafts')
        .insert(draftsToInsert)
        .select();
      
      results.drafts = data?.length || 0;
    }
    
    // Migrate products
    if (products && Array.isArray(products) && products.length > 0) {
      const productsToInsert = products.slice(0, 20).map(p => ({
        user_id: req.user.id,
        name: p.name,
        description: p.description,
        url: p.url,
        benefits: p.benefits || [],
      }));
      
      const { data } = await supabaseAdmin
        .from('products')
        .insert(productsToInsert)
        .select();
      
      results.products = data?.length || 0;
    }
    
    // Migrate credits from guest token
    if (creditToken) {
      const entry = await storageGet(`credit:${creditToken}`);
      if (entry && entry.remaining > 0) {
        // Add credits to user balance
        await supabaseAdmin.rpc('add_credits', {
          p_user_id: req.user.id,
          p_amount: entry.remaining,
          p_type: 'migration',
          p_description: 'Migrated from guest purchase',
        }).catch(() => {
          // Fallback if RPC doesn't exist
          return supabaseAdmin
            .from('credit_balances')
            .upsert({
              user_id: req.user.id,
              balance: entry.remaining,
            }, { onConflict: 'user_id' });
        });
        
        results.credits = entry.remaining;
        
        // Record the migration in purchases if we have stripe session
        if (entry.stripeSessionId) {
          await supabaseAdmin
            .from('purchases')
            .update({ user_id: req.user.id })
            .eq('stripe_session_id', entry.stripeSessionId)
            .eq('user_id', null);
        }
        
        // Invalidate the guest token
        await storageDel(`credit:${creditToken}`);
      }
    }
    
    // Update preferences
    if (preferences) {
      await supabaseAdmin
        .from('profiles')
        .update({ preferences })
        .eq('id', req.user.id);
    }
    
    trackEvent(req.user.id, 'data_migrated', results);
    res.json({ success: true, migrated: results });
  } catch (e) {
    console.error('Migration error:', e.message);
    res.status(500).json({ error: 'Migration partially failed', migrated: results });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CREDITS & CHECKOUT (supports both guest and authenticated)
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/credits ──────────────────────────────────────────────────────────
app.get('/api/credits', optionalAuth, async (req, res) => {
  // If authenticated, return user credits
  if (req.user && supabaseAdmin) {
    try {
      const { data } = await supabaseAdmin
        .from('credit_balances')
        .select('balance')
        .eq('user_id', req.user.id)
        .single();
      return res.json({ valid: true, remaining: data?.balance || 0, authenticated: true });
    } catch (e) { /* fall through to guest token check */ }
  }
  
  // Guest token flow
  const { token } = req.query;
  if (!token) return res.json({ valid: false, remaining: 0 });
  const entry = await storageGet(`credit:${token}`);
  if (!entry) return res.json({ valid: false, remaining: 0 });
  res.json({ valid: true, remaining: entry.remaining, authenticated: false });
});

// ── POST /api/start-run ───────────────────────────────────────────────────────
app.post('/api/start-run', optionalAuth, rateLimit('generation'), async (req, res) => {
  const { creditToken } = req.body;
  
  // Authenticated user flow
  if (req.user && supabaseAdmin) {
    try {
      const { data: balance } = await supabaseAdmin
        .from('credit_balances')
        .select('balance')
        .eq('user_id', req.user.id)
        .single();
      
      if (!balance || balance.balance <= 0) {
        return res.status(402).json({ error: 'You\'re out of credits' });
      }
      
      // Deduct credit
      const newBalance = balance.balance - 1;
      await supabaseAdmin
        .from('credit_balances')
        .update({ balance: newBalance })
        .eq('user_id', req.user.id);
      
      // Record transaction
      await supabaseAdmin
        .from('credit_transactions')
        .insert({
          user_id: req.user.id,
          amount: -1,
          balance_after: newBalance,
          type: 'usage',
          description: 'Article generation',
        });
      
      // Record generation for rate limiting/history
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      await supabaseAdmin
        .from('generation_history')
        .insert({
          user_id: req.user.id,
          topic: req.body.topic,
          keyword: req.body.keyword,
          ip_address: ip,
        });
      
      const runToken = crypto.randomUUID();
      let sessionId = null;
      if (stripe) {
        try {
          const attributed = await selfserve.spendForUser(stripe, req.user.id);
          sessionId = attributed.sessionId;
        } catch (err) {
          console.error('Credit attribution:', err.message);
        }
      }
      await storageSet(`run:${runToken}`, { callsLeft: 6, userId: req.user.id }, 7200);
      await storageSet(`runcharge:${runToken}`, { userId: req.user.id, sessionId, returned: false }, 7200);
      
      trackEvent(req.user.id, 'generate', { credits_remaining: newBalance });
      return res.json({ runToken, remaining: newBalance, authenticated: true });
    } catch (e) {
      console.error('Start run error:', e.message);
      return res.status(500).json({ error: 'Something went wrong' });
    }
  }
  
  // Guest token flow
  if (!creditToken) return res.status(400).json({ error: 'Sign in or purchase credits to generate' });

  const access = selfserve.readAccess(creditToken);
  if (access) {
    if (!stripe) return res.status(503).json({ error: 'Payments not available. Try again later.' });
    try {
      const spent = await selfserve.spendFromEmail(stripe, access.e);
      if (spent.empty) return res.status(402).json({ error: 'You\'re out of credits' });
      const runToken = crypto.randomUUID();
      await storageSet(`run:${runToken}`, { callsLeft: 6 }, 7200);
      await storageSet(`runcharge:${runToken}`, {
        email: access.e, sessionId: spent.sessionId, returned: false,
      }, 7200);
      trackEvent(access.e, 'generate', { credits_remaining: spent.remaining, guest: true });
      return res.json({ runToken, remaining: spent.remaining, authenticated: false });
    } catch (e) {
      console.error('Spend error:', e.message);
      return res.status(e.status || 500).json({ error: e.status === 402 ? 'You\'re out of credits' : 'Something went wrong' });
    }
  }
  
  let entry = await storageGet(`credit:${creditToken}`);
  if (!entry && stripe) {
    try {
      const found = await stripe.checkout.sessions.search({
        query: `metadata['guest_token']:'${String(creditToken).replace(/'/g, '')}' AND status:'complete'`,
        limit: 1,
      });
      const session = found.data?.[0];
      if (session) {
        const pack = selfserve.packFromSession(session);
        entry = {
          remaining: pack.remaining,
          used: pack.used,
          stripeSessionId: session.id,
          email: selfserve.normalizeEmail(pack.email),
          created_at: new Date().toISOString(),
        };
      }
    } catch (e) { /* search unavailable */ }
  }
  if (!entry || entry.remaining <= 0) {
    return res.status(402).json({ error: 'You\'re out of credits' });
  }

  let sessionId = entry.stripeSessionId || null;
  if (sessionId && stripe) {
    try {
      if ((entry.used || 0) > 0) {
        const current = await stripe.checkout.sessions.retrieve(sessionId);
        if ((current.metadata?.credits_used || '0') === '0') {
          await stripe.checkout.sessions.update(sessionId, {
            metadata: { credits_used: String(entry.used) },
          });
        }
      }
      const result = await selfserve.adjustUsed(stripe, sessionId, 1);
      entry.remaining = result.remaining;
      entry.used = result.used;
    } catch (e) {
      return res.status(402).json({ error: 'You\'re out of credits' });
    }
  } else {
    entry.remaining--;
    entry.used = (entry.used || 0) + 1;
  }
  await storageSet(`credit:${creditToken}`, entry);
  
  const runToken = crypto.randomUUID();
  await storageSet(`run:${runToken}`, { callsLeft: 6 }, 7200);
  await storageSet(`runcharge:${runToken}`, {
    creditToken, sessionId, email: entry.email || '', returned: false,
  }, 7200);
  
  trackEvent(creditToken, 'generate', { credits_remaining: entry.remaining, guest: true });
  res.json({ runToken, remaining: entry.remaining, authenticated: false });
});

// ── POST /api/create-checkout ─────────────────────────────────────────────────
app.post('/api/create-checkout', optionalAuth, rateLimit('api'), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments not available. Try again later.' });
  }
  
  const selected = CREDIT_PACKS[req.body.pack] || CREDIT_PACKS.creator;
  const origin   = req.headers.origin || `https://${req.headers.host}`;
  
  // Generate a guest token for non-authenticated users
  const guestToken = !req.user ? crypto.randomUUID() : null;
  
  try {
    const sessionConfig = {
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
      customer_creation: 'always',
      metadata: { 
        credits: String(selected.credits),
        credits_used: '0',
        user_id: req.user?.id || '',
        guest_token: guestToken || '',
      },
    };
    
    // Pre-fill email for authenticated users
    if (req.user?.email) {
      sessionConfig.customer_email = req.user.email;
    }
    
    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    trackEvent(req.user?.id || guestToken, 'checkout_started', { 
      pack: req.body.pack,
      credits: selected.credits,
      amount: selected.price,
    });
    
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

// ── GET /success ──────────────────────────────────────────────────────────────
app.get('/success', async (req, res) => {
  if (!stripe) return res.redirect('/app?error=payments_not_configured');
  
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/app');
  
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    
    if (session.payment_status !== 'paid') {
      return res.redirect('/app?error=payment_not_completed');
    }
    
    const credits = parseInt(session.metadata.credits, 10) || 10;
    const userId = session.metadata.user_id;
    const guestToken = session.metadata.guest_token;
    
    // If authenticated user, credits are added via webhook
    if (userId && supabaseAdmin) {
      // Check if credits already added (idempotency)
      const { data: existingPurchase } = await supabaseAdmin
        .from('purchases')
        .select('id')
        .eq('stripe_session_id', session_id)
        .single();
      
      if (!existingPurchase) {
        // Webhook might not have fired yet, add credits now
        await addCreditsToUser(userId, credits, session_id, session.payment_intent, session.amount_total, guestToken);
      }
      
      await trackCheckoutComplete(session);
      return res.redirect(`/app?credits=${credits}&new=1`);
    }
    
    // Guest flow — mint a credit token
    const existingToken = await storageGet(`session:${session_id}`);
    if (existingToken) {
      const existing = await storageGet(`credit:${existingToken}`);
      return res.redirect(`/app?token=${existingToken}&credits=${existing?.remaining ?? 0}&returning=1`);
    }
    
    const token = guestToken || crypto.randomUUID();

    if (!session.metadata?.credits_used) {
      await stripe.checkout.sessions.update(session.id, {
        metadata: {
          credits_used: '0',
          email: session.customer_details?.email || '',
        },
      });
    }
    
    await storageSet(`credit:${token}`, {
      remaining:       credits,
      used:            0,
      created_at:      new Date().toISOString(),
      stripeSessionId: session_id,
    });
    await storageSet(`session:${session_id}`, token);
    
    // Also record in database if available (for later account attachment)
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('purchases')
        .insert({
          stripe_session_id: session_id,
          stripe_payment_intent: session.payment_intent,
          credits_purchased: credits,
          amount_cents: session.amount_total,
          guest_token: token,
          status: 'completed',
        })
        .onConflict('stripe_session_id')
        .ignore();
    }
    
    await trackCheckoutComplete(session);
    res.redirect(`/app?token=${token}&credits=${credits}&new=1`);
  } catch (err) {
    console.error('Success handler error:', err.message);
    res.redirect('/app?error=something_went_wrong');
  }
});

// ── Helper: Add credits to user ───────────────────────────────────────────────
async function addCreditsToUser(userId, credits, stripeSessionId, paymentIntent, amountCents, guestToken = null) {
  if (!supabaseAdmin) return;
  
  // Check idempotency
  const { data: existing } = await supabaseAdmin
    .from('purchases')
    .select('id')
    .eq('stripe_session_id', stripeSessionId)
    .single();
  
  if (existing) return; // Already processed
  
  // Get current balance
  const { data: balanceData } = await supabaseAdmin
    .from('credit_balances')
    .select('balance')
    .eq('user_id', userId)
    .single();
  
  const currentBalance = balanceData?.balance || 0;
  const newBalance = currentBalance + credits;
  
  // Update balance
  await supabaseAdmin
    .from('credit_balances')
    .upsert({
      user_id: userId,
      balance: newBalance,
    }, { onConflict: 'user_id' });
  
  // Record transaction
  await supabaseAdmin
    .from('credit_transactions')
    .insert({
      user_id: userId,
      amount: credits,
      balance_after: newBalance,
      type: 'purchase',
      reference_id: stripeSessionId,
      description: `Purchased ${credits} credits`,
    });
  
  // Record purchase
  await supabaseAdmin
    .from('purchases')
    .insert({
      user_id: userId,
      stripe_session_id: stripeSessionId,
      stripe_payment_intent: paymentIntent,
      credits_purchased: credits,
      amount_cents: amountCents,
      guest_token: guestToken,
      status: 'completed',
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/webhook/stripe', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  
  let event;
  
  // Verify webhook signature if secret is configured
  if (STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // No signature verification in dev
    event = JSON.parse(req.body.toString());
  }
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      
      if (session.payment_status === 'paid') {
        const credits = parseInt(session.metadata?.credits, 10) || 10;
        const userId = session.metadata?.user_id;
        const guestToken = session.metadata?.guest_token;

        if (!session.metadata?.credits_used || !session.metadata?.email) {
          try {
            await stripe.checkout.sessions.update(session.id, {
              metadata: {
                credits_used: session.metadata?.credits_used || '0',
                email: session.customer_details?.email || session.metadata?.email || '',
              },
            });
          } catch (e) {
            console.error('Webhook metadata update:', e.message);
          }
        }

        await trackCheckoutComplete(session);
        
        if (userId && supabaseAdmin) {
          await addCreditsToUser(
            userId, 
            credits, 
            session.id, 
            session.payment_intent,
            session.amount_total,
            guestToken
          );
          console.log(`Webhook: Added ${credits} credits to user ${userId}`);
        } else if (guestToken) {
          // Guest purchase - ensure token is set up
          const existing = await storageGet(`credit:${guestToken}`);
          if (!existing) {
            await storageSet(`credit:${guestToken}`, {
              remaining: credits,
              used: 0,
              created_at: new Date().toISOString(),
              stripeSessionId: session.id,
            });
            await storageSet(`session:${session.id}`, guestToken);
          }
          
          // Record in database for later attachment
          if (supabaseAdmin) {
            await supabaseAdmin
              .from('purchases')
              .insert({
                stripe_session_id: session.id,
                stripe_payment_intent: session.payment_intent,
                credits_purchased: credits,
                amount_cents: session.amount_total,
                guest_token: guestToken,
                status: 'completed',
              })
              .onConflict('stripe_session_id')
              .ignore();
          }
          console.log(`Webhook: Created guest token ${guestToken} with ${credits} credits`);
        }
      }
      break;
    }
    
    case 'charge.refunded': {
      const charge = event.data.object;
      const paymentIntent = charge.payment_intent;
      
      if (supabaseAdmin && paymentIntent) {
        const { data: purchase } = await supabaseAdmin
          .from('purchases')
          .select('*')
          .eq('stripe_payment_intent', paymentIntent)
          .maybeSingle();
        
        if (purchase && purchase.status !== 'refunded') {
          const paid = charge.amount || purchase.amount_cents || 0;
          const refundedCents = charge.amount_refunded || 0;
          const fraction = paid > 0 ? Math.min(1, refundedCents / paid) : 1;
          const creditsToRemove = Math.min(
            purchase.credits_purchased,
            Math.max(0, Math.round(purchase.credits_purchased * fraction))
          );

          const { data: locked } = await supabaseAdmin
            .from('purchases')
            .update({ status: 'refunded' })
            .eq('id', purchase.id)
            .neq('status', 'refunded')
            .select('id')
            .maybeSingle();

          if (locked) {
            if (purchase.user_id && creditsToRemove > 0) {
              const { data: balance } = await supabaseAdmin
                .from('credit_balances')
                .select('balance')
                .eq('user_id', purchase.user_id)
                .single();
              
              if (balance) {
                const newBalance = Math.max(0, balance.balance - creditsToRemove);
                await supabaseAdmin
                  .from('credit_balances')
                  .update({ balance: newBalance })
                  .eq('user_id', purchase.user_id);
                
                await supabaseAdmin
                  .from('credit_transactions')
                  .insert({
                    user_id: purchase.user_id,
                    amount: -creditsToRemove,
                    balance_after: newBalance,
                    type: 'refund',
                    reference_id: paymentIntent,
                    description: 'Refund processed',
                  });
              }
            }
            
            if (purchase.guest_token) {
              await storageDel(`credit:${purchase.guest_token}`);
            }

            await trackRefund(
              [paymentIntent, purchase.stripe_session_id],
              purchase.user_id || purchase.guest_token || 'guest',
              { amount: refundedCents / 100, credits_removed: creditsToRemove }
            );
          }
        }
      }
      break;
    }
  }
  
  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// RESTORE, REFUNDS, DATA, CONTACT
// Purchases live on the Stripe checkout session. A one-time code proves the
// purchase email. Works while accounts are off.
// ══════════════════════════════════════════════════════════════════════════════

function publicPack(pack) {
  return {
    id: pack.id,
    created: pack.created,
    amount: (pack.amountCents || 0) / 100,
    currency: pack.currency,
    credits: pack.credits,
    used: pack.used,
    remaining: pack.remaining,
    refunded: pack.refunded,
    eligible: !!(pack.quote && pack.quote.eligible),
    refundAmount: pack.quote && pack.quote.eligible ? pack.quote.refundCents / 100 : 0,
    kind: pack.quote ? pack.quote.kind || null : null,
    reason: pack.quote && !pack.quote.eligible ? pack.quote.reason : '',
    receiptUrl: pack.receiptUrl || '',
  };
}

async function withReceipts(packs) {
  if (!stripe) return packs;
  await Promise.all(packs.map(async (pack) => {
    if (!pack.paymentIntent || pack.receiptUrl) return;
    try {
      const pi = await stripe.paymentIntents.retrieve(pack.paymentIntent, { expand: ['latest_charge'] });
      pack.receiptUrl = pi.latest_charge?.receipt_url || '';
    } catch { /* receipt is optional */ }
  }));
  return packs;
}

async function saveVerifyCode(email, code) {
  const record = {
    hash: selfserve.hashCode(email, code),
    exp: Date.now() + selfserve.CODE_TTL_MS,
    tries: 0,
  };
  await storageSet(`verify:${email}`, record, 600);
  try {
    const customers = await selfserve.customersForEmail(stripe, email);
    if (customers[0]) {
      await stripe.customers.update(customers[0].id, {
        metadata: {
          verify_hash: record.hash,
          verify_exp: String(record.exp),
          verify_tries: '0',
        },
      });
    }
  } catch (e) {
    console.error('Verify code store:', e.message);
  }
  return record;
}

async function readVerifyCode(email) {
  const stored = await storageGet(`verify:${email}`);
  if (stored && stored.hash) return stored;
  try {
    const customers = await selfserve.customersForEmail(stripe, email);
    const meta = customers[0]?.metadata;
    if (meta?.verify_hash) {
      return {
        hash: meta.verify_hash,
        exp: parseInt(meta.verify_exp, 10) || 0,
        tries: parseInt(meta.verify_tries, 10) || 0,
        customerId: customers[0].id,
      };
    }
  } catch { /* no customer */ }
  return null;
}

async function writeVerifyTries(email, record) {
  await storageSet(`verify:${email}`, record, 600);
  if (record.customerId) {
    try {
      await stripe.customers.update(record.customerId, {
        metadata: { verify_tries: String(record.tries) },
      });
    } catch { /* best effort */ }
  }
}

app.post('/api/restore/request', rateLimit('verify'), async (req, res) => {
  const email = selfserve.normalizeEmail(req.body?.email);
  if (!selfserve.isEmail(email)) return res.status(400).json({ error: 'Enter the email you used at checkout' });
  if (!stripe) return res.status(503).json({ error: 'Payments are not available right now' });

  const generic = { ok: true, message: 'If that email has a purchase, we sent a code. It expires in 10 minutes.' };
  try {
    const packs = await selfserve.listPacks(stripe, email);
    if (!packs.length) return res.json(generic);
    const code = selfserve.makeCode();
    await saveVerifyCode(email, code);
    await selfserve.sendEmail({
      to: email,
      subject: 'Your Byline code',
      text: selfserve.codeMessage(code),
    });
    return res.json(generic);
  } catch (err) {
    if (err.code === 'email_unconfigured' || err.code === 'email_failed') {
      return res.status(503).json({ error: `We couldn't send a code. Email ${selfserve.SUPPORT_EMAIL} and we'll sort it out.` });
    }
    console.error('Restore request:', err.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/restore/verify', rateLimit('verify'), async (req, res) => {
  const email = selfserve.normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').replace(/\s/g, '');
  if (!selfserve.isEmail(email) || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the email and the 6-digit code' });
  }
  if (!stripe) return res.status(503).json({ error: 'Payments are not available right now' });

  const record = await readVerifyCode(email);
  if (!record || !record.hash || Date.now() > record.exp) {
    return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  }
  if (record.tries >= selfserve.CODE_MAX_TRIES) {
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }
  const expected = selfserve.hashCode(email, code);
  const match = expected.length === record.hash.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(record.hash));
  if (!match) {
    record.tries += 1;
    await writeVerifyTries(email, record);
    return res.status(400).json({ error: 'That code does not match' });
  }
  await storageDel(`verify:${email}`);

  const packs = await withReceipts(await selfserve.listPacks(stripe, email));
  const token = selfserve.signAccess(email);
  const remaining = selfserve.spendableRemaining(packs);
  res.json({ token, email, remaining, purchases: packs.map(publicPack) });
});

app.get('/api/purchases', async (req, res) => {
  const access = selfserve.readAccess(req.query.token);
  if (!access) return res.status(401).json({ error: 'Verify your email to see purchases' });
  if (!stripe) return res.status(503).json({ error: 'Payments are not available right now' });
  try {
    const packs = await withReceipts(await selfserve.listPacks(stripe, access.e));
    const remaining = selfserve.spendableRemaining(packs);
    res.json({ email: access.e, remaining, purchases: packs.map(publicPack) });
  } catch (err) {
    console.error('Purchases:', err.message);
    res.status(500).json({ error: 'Could not load purchases' });
  }
});

async function refundSession(sessionId, email) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const owner = selfserve.normalizeEmail(session.metadata?.email || session.customer_details?.email || '');
  if (!owner || owner !== email) {
    return { status: 403, body: { error: 'That purchase belongs to a different email' } };
  }
  const pack = selfserve.packFromSession(session);
  if (session.metadata?.refunded === '1') {
    return { status: 400, body: { error: 'This pack was already refunded' } };
  }
  const pi = pack.paymentIntent
    ? await stripe.paymentIntents.retrieve(pack.paymentIntent)
    : null;
  if (pi && pi.amount_refunded > 0) {
    await stripe.checkout.sessions.update(sessionId, { metadata: { refunded: '1', refund_pending: '' } });
    return { status: 400, body: { error: 'This pack was already refunded' } };
  }
  if (!pack.quote.eligible) {
    return { status: 400, body: { error: pack.quote.reason } };
  }
  const usedBefore = pack.used;
  await stripe.checkout.sessions.update(sessionId, {
    metadata: { refund_pending: '1', credits_used: String(pack.credits) },
  });
  try {
    const refund = await stripe.refunds.create({
      payment_intent: pack.paymentIntent,
      amount: pack.quote.refundCents,
    }, { idempotencyKey: `refund_${sessionId}` });
    await stripe.checkout.sessions.update(sessionId, {
      metadata: { refunded: '1', refund_pending: '', refund_id: refund.id, credits_used: String(pack.credits) },
    });
    return {
      status: 200,
      paymentIntent: pack.paymentIntent,
      body: {
        success: true,
        amount: refund.amount / 100,
        currency: refund.currency.toUpperCase(),
        kind: pack.quote.kind,
      },
    };
  } catch (err) {
    await stripe.checkout.sessions.update(sessionId, {
      metadata: { refund_pending: '', credits_used: String(usedBefore) },
    }).catch(() => {});
    console.error('Refund error:', err.message);
    return { status: 500, body: { error: 'The refund did not go through. Your credits are unchanged.' } };
  }
}

app.get('/api/refund-eligible', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ eligible: false, reason: 'Missing token' });
  const access = selfserve.readAccess(token);
  if (access && stripe) {
    try {
      const packs = await selfserve.listPacks(stripe, access.e);
      const eligible = packs.filter(p => p.quote.eligible);
      if (!eligible.length) return res.json({ eligible: false, reason: 'No refundable pack on this email' });
      return res.json({
        eligible: true,
        remaining: eligible[0].remaining,
        amount: eligible[0].quote.refundCents / 100,
      });
    } catch {
      return res.json({ eligible: false, reason: 'Could not check purchases' });
    }
  }
  const entry = await storageGet(`credit:${token}`);
  if (!entry || !entry.stripeSessionId || !stripe) {
    return res.json({ eligible: false, reason: 'Purchase not found. Verify the email you used at checkout.' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(entry.stripeSessionId);
    const pack = selfserve.packFromSession(session);
    if (!pack.quote.eligible) return res.json({ eligible: false, reason: pack.quote.reason });
    res.json({ eligible: true, remaining: pack.remaining, amount: pack.quote.refundCents / 100 });
  } catch {
    res.json({ eligible: false, reason: 'Purchase not found' });
  }
});

app.post('/api/refund', rateLimit('refund'), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { creditToken, token, sessionId } = req.body || {};
  const accessToken = token || (selfserve.readAccess(creditToken) ? creditToken : null);

  try {
    if (accessToken && sessionId) {
      const access = selfserve.readAccess(accessToken);
      if (!access) return res.status(401).json({ error: 'Verify your email again' });
      const result = await refundSession(sessionId, access.e);
      if (result.status === 200) {
        await trackRefund([sessionId, result.paymentIntent], access.e, { amount: result.body.amount, sessionId });
        const packs = await selfserve.listPacks(stripe, access.e);
        result.body.remaining = selfserve.spendableRemaining(packs);
      }
      return res.status(result.status).json(result.body);
    }

    if (!creditToken) return res.status(400).json({ error: 'Missing credit token' });
    const entry = await storageGet(`credit:${creditToken}`);
    if (!entry?.stripeSessionId) {
      return res.status(404).json({ error: 'Verify the email you used at checkout to refund this purchase.' });
    }
    const session = await stripe.checkout.sessions.retrieve(entry.stripeSessionId);
    const email = selfserve.normalizeEmail(session.metadata?.email || session.customer_details?.email || entry.email || '');
    if (!email) return res.status(400).json({ error: 'This purchase has no email on it. Email ' + selfserve.SUPPORT_EMAIL });
    const result = await refundSession(entry.stripeSessionId, email);
    if (result.status === 200) {
      entry.remaining = 0;
      await storageSet(`credit:${creditToken}`, entry);
      await trackRefund([entry.stripeSessionId, result.paymentIntent], email, { amount: result.body.amount });
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Refund error:', err.message);
    res.status(500).json({ error: 'The refund did not go through. Your credits are unchanged.' });
  }
});

app.get('/api/account/export', async (req, res) => {
  const access = selfserve.readAccess(req.query.token);
  if (!access) return res.status(401).json({ error: 'Verify your email to download your data' });
  if (!stripe) return res.status(503).json({ error: 'Payments are not available right now' });
  try {
    const packs = await withReceipts(await selfserve.listPacks(stripe, access.e));
    res.setHeader('Content-Disposition', 'attachment; filename="byline-data.json"');
    res.json({
      email: access.e,
      exported_at: new Date().toISOString(),
      purchases: packs.map(publicPack),
      note: 'Article drafts saved in this browser are not on the server. Use Download drafts on this browser to save those.',
    });
  } catch (err) {
    console.error('Export error:', err.message);
    res.status(500).json({ error: 'Could not prepare your download' });
  }
});

app.post('/api/account/delete', rateLimit('verify'), async (req, res) => {
  const access = selfserve.readAccess(req.body?.token);
  if (!access) return res.status(401).json({ error: 'Verify your email before deleting data' });
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (!stripe) return res.status(503).json({ error: 'Payments are not available right now' });
  try {
    const customers = await selfserve.customersForEmail(stripe, access.e);
    for (const customer of customers) {
      await stripe.customers.del(customer.id);
    }
    await storageDel(`verify:${access.e}`);
    trackEvent(access.e, 'data_deleted', {});
    res.json({
      success: true,
      message: 'The customer profile for this email was deleted. Payment records stay with Stripe for accounting. Clear this browser to remove drafts stored here.',
    });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ error: 'Could not delete the profile. Email ' + selfserve.SUPPORT_EMAIL });
  }
});

app.post('/api/contact', rateLimit('contact'), async (req, res) => {
  const email = selfserve.normalizeEmail(req.body?.email);
  const message = String(req.body?.message || '').trim();
  if (!selfserve.isEmail(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (message.length < 8 || message.length > 4000) {
    return res.status(400).json({ error: 'Write a short message, under 4000 characters' });
  }
  try {
    await selfserve.sendEmail({
      to: selfserve.SUPPORT_EMAIL,
      replyTo: email,
      subject: 'Byline help',
      text: `From: ${email}\n\n${message}`,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'email_unconfigured' || err.code === 'email_failed') {
      return res.status(503).json({ error: `We couldn't send that. Email ${selfserve.SUPPORT_EMAIL} instead.` });
    }
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/abort-run', rateLimit('api'), async (req, res) => {
  const { runToken } = req.body || {};
  if (!runToken) return res.status(400).json({ error: 'Missing run' });
  try {
    const remaining = await returnRunCredit(runToken);
    res.json({ ok: true, remaining });
  } catch (err) {
    console.error('Abort run:', err.message);
    res.status(500).json({ error: 'Could not return the credit' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CREDIT RETURN WHEN A RUN FAILS
// ══════════════════════════════════════════════════════════════════════════════

async function returnRunCredit(runToken) {
  if (!runToken) return null;
  const charge = await storageGet(`runcharge:${runToken}`);
  if (!charge || charge.returned) {
    return charge ? creditRemaining(charge) : null;
  }
  charge.returned = true;
  await storageSet(`runcharge:${runToken}`, charge, 7200);

  if (charge.userId && supabaseAdmin) {
    if (charge.sessionId && stripe) {
      await selfserve.returnToSession(stripe, charge.sessionId).catch(() => {});
    }
    const { data: balance } = await supabaseAdmin
      .from('credit_balances')
      .select('balance')
      .eq('user_id', charge.userId)
      .single();
    const newBalance = (balance?.balance || 0) + 1;
    await supabaseAdmin.from('credit_balances').upsert({
      user_id: charge.userId,
      balance: newBalance,
    }, { onConflict: 'user_id' });
    await supabaseAdmin.from('credit_transactions').insert({
      user_id: charge.userId,
      amount: 1,
      balance_after: newBalance,
      type: 'usage',
      description: 'Credit returned. The article did not finish.',
    });
    return newBalance;
  }

  if (charge.sessionId && stripe) {
    await selfserve.returnToSession(stripe, charge.sessionId).catch(() => {});
  }
  if (charge.creditToken) {
    const entry = await storageGet(`credit:${charge.creditToken}`);
    if (entry) {
      entry.remaining = (entry.remaining || 0) + 1;
      entry.used = Math.max(0, (entry.used || 0) - 1);
      await storageSet(`credit:${charge.creditToken}`, entry);
    }
  }
  return creditRemaining(charge);
}

async function creditRemaining(charge) {
  if (!charge) return null;
  if (charge.userId && supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from('credit_balances')
      .select('balance')
      .eq('user_id', charge.userId)
      .single();
    return data?.balance ?? null;
  }
  if (charge.email && stripe) {
    const packs = await selfserve.listPacks(stripe, charge.email);
    return selfserve.spendableRemaining(packs);
  }
  if (charge.sessionId && stripe) {
    const session = await stripe.checkout.sessions.retrieve(charge.sessionId);
    return selfserve.packFromSession(session).remaining;
  }
  if (charge.creditToken) {
    const entry = await storageGet(`credit:${charge.creditToken}`);
    return entry?.remaining ?? null;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// AI ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/seo-score', rateLimit('api'), async (req, res) => {
  const { articleText, keyword, apiKey, title, metaDescription } = req.body;
  if (!articleText) return res.status(400).json({ error: 'Missing articleText' });
  
  const keyToUse = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!keyToUse) return res.status(503).json({ error: 'API key not configured' });
  
  const prompt = `You are an expert SEO content analyst. Analyze this article and return an honest, calibrated JSON score.

Target keyword: "${keyword || '(none provided)'}"
${title ? `\nTitle: ${title}` : ''}
${metaDescription ? `\nMeta description: ${metaDescription}` : ''}

Article body:
${articleText.slice(0, 7000)}

Return ONLY valid JSON — no markdown fences, no explanation, no prose:
{
  "overall": <integer 0-100>,
  "badges": [
    {"id": "keyword_opt",     "label": "Keyword Optimization",  "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "search_intent",  "label": "Search Intent Match",   "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "content_depth",  "label": "Content Depth",         "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "hook_strength",  "label": "Opening Hook",          "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "subheading_qual","label": "Subheading Quality",    "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "originality",    "label": "Angle & Originality",   "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "meta_quality",   "label": "Meta Description",      "color": "<green|amber|red>", "note": "<one crisp sentence>"},
    {"id": "readability",    "label": "Readability & Flow",    "color": "<green|amber|red>", "note": "<one crisp sentence>"}
  ]
}

Scoring calibration — be honest:
- 85-95: genuinely excellent across nearly all dimensions
- 65-80: solid well-written article with a few fixable gaps
- 45-65: decent but clearly missing things
- below 45: real structural or quality problems`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         keyToUse,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 900,
        stream:     false,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json(err);
    }
    
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: 'Unexpected response format' });
    res.json(JSON.parse(match[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 529]);

async function anthropicStream(body, apiKey) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ ...body, stream: true }),
      });
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt === 2) return response;
      await response.arrayBuffer().catch(() => {});
    } catch (err) {
      lastError = err;
      if (attempt === 2) throw err;
    }
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw lastError || new Error('The article did not finish');
}

app.post('/api/chat', rateLimit('api'), async (req, res) => {
  const { apiKey, runToken, ...body } = req.body;
  
  let keyToUse = apiKey;
  
  if (!apiKey) {
    if (!runToken) {
      return res.status(400).json({ error: 'Missing API key or run token' });
    }
    
    const runEntry = await storageGet(`run:${runToken}`);
    if (!runEntry || runEntry.callsLeft <= 0) {
      return res.status(402).json({ error: 'Invalid or expired run token — start a new run' });
    }
    runEntry.callsLeft--;
    if (runEntry.callsLeft > 0) {
      await storageSet(`run:${runToken}`, runEntry, 7200);
    } else {
      await storageDel(`run:${runToken}`);
    }
    
    keyToUse = process.env.ANTHROPIC_API_KEY;
    if (!keyToUse) {
      const remaining = await returnRunCredit(runToken);
      return res.status(503).json({ error: 'Server API key not configured', remaining });
    }
  }
  
  try {
    const response = await anthropicStream(body, keyToUse);
    
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (runToken && !apiKey) {
        const remaining = await returnRunCredit(runToken);
        return res.status(response.status).json({
          error: 'The article did not finish. The credit was returned.',
          remaining,
        });
      }
      return res.status(response.status).json(err);
    }
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (err) {
    let remaining = null;
    if (runToken && !apiKey) remaining = await returnRunCredit(runToken);
    if (res.headersSent) return;
    if (runToken && !apiKey) {
      return res.status(500).json({ error: 'The article did not finish. The credit was returned.', remaining });
    }
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/track', optionalAuth, rateLimit('track'), (req, res) => {
  const event = req.body?.event;
  const properties = req.body?.properties && typeof req.body.properties === 'object' ? req.body.properties : {};
  if (!event || typeof event !== 'string' || event.length > 64) {
    return res.status(400).json({ error: 'Missing event' });
  }
  
  const distinctId = req.user?.id || properties.distinctId || 'anonymous';
  const { distinctId: _ignored, ...rest } = properties;
  trackEvent(distinctId, event, rest);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: {
      stripe: !!stripe,
      supabase: !!supabase,
      redis: !!redis,
      posthog: !!posthog,
    },
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 404 HANDLER
// ══════════════════════════════════════════════════════════════════════════════

app.use((req, res, next) => {
  // API routes return JSON 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // All other routes return styled 404 page
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ══════════════════════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(500).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ══════════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n  Byline → http://localhost:${PORT}`);
    console.log();
    console.log('  Services:');
    console.log(`    Stripe:   ${stripe ? '✓' : '✗ (add STRIPE_SECRET_KEY)'}`);
    console.log(`    Supabase: ${supabase ? '✓' : '✗ (add SUPABASE_URL, SUPABASE_ANON_KEY)'}`);
    console.log(`    Redis:    ${redis ? '✓' : '○ (in-memory mode)'}`);
    console.log(`    PostHog:  ${posthog ? '✓' : '○ (analytics disabled)'}`);
    console.log(`    Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗ (add ANTHROPIC_API_KEY)'}`);
    console.log();
  });
}

module.exports = app;
