require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

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

// ── Refund policy ─────────────────────────────────────────────────────────────
const REFUND_MIN_REMAINING_PCT = 0.5;

// ── Rate limiting configuration ───────────────────────────────────────────────
const RATE_LIMITS = {
  generation: { windowMs: 60 * 60 * 1000, max: 20 },  // 20 generations per hour
  auth:       { windowMs: 15 * 60 * 1000, max: 10 },  // 10 auth attempts per 15 min
  api:        { windowMs: 60 * 1000, max: 60 },       // 60 requests per minute
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

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

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
      await storageSet(`run:${runToken}`, { callsLeft: 6, userId: req.user.id }, 7200);
      
      trackEvent(req.user.id, 'generation_started', { credits_remaining: newBalance });
      return res.json({ runToken, remaining: newBalance, authenticated: true });
    } catch (e) {
      console.error('Start run error:', e.message);
      return res.status(500).json({ error: 'Something went wrong' });
    }
  }
  
  // Guest token flow
  if (!creditToken) return res.status(400).json({ error: 'Sign in or purchase credits to generate' });
  
  const entry = await storageGet(`credit:${creditToken}`);
  if (!entry || entry.remaining <= 0) {
    return res.status(402).json({ error: 'You\'re out of credits' });
  }
  
  entry.remaining--;
  entry.used = (entry.used || 0) + 1;
  await storageSet(`credit:${creditToken}`, entry);
  
  const runToken = crypto.randomUUID();
  await storageSet(`run:${runToken}`, { callsLeft: 6 }, 7200);
  
  trackEvent(creditToken, 'generation_started', { credits_remaining: entry.remaining, guest: true });
  res.json({ runToken, remaining: entry.remaining, authenticated: false });
});

// ── POST /api/create-checkout ─────────────────────────────────────────────────
app.post('/api/create-checkout', optionalAuth, async (req, res) => {
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
      metadata: { 
        credits: String(selected.credits),
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
      
      trackEvent(userId, 'checkout_completed', { credits, amount: session.amount_total / 100 });
      return res.redirect(`/app?credits=${credits}&new=1`);
    }
    
    // Guest flow — mint a credit token
    const existingToken = await storageGet(`session:${session_id}`);
    if (existingToken) {
      const existing = await storageGet(`credit:${existingToken}`);
      return res.redirect(`/app?token=${existingToken}&credits=${existing?.remaining ?? 0}&returning=1`);
    }
    
    const token = guestToken || crypto.randomUUID();
    
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
    
    trackEvent(token, 'checkout_completed', { credits, amount: session.amount_total / 100, guest: true });
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
      
      // Find and void the purchase
      if (supabaseAdmin && paymentIntent) {
        const { data: purchase } = await supabaseAdmin
          .from('purchases')
          .select('*')
          .eq('stripe_payment_intent', paymentIntent)
          .single();
        
        if (purchase) {
          // Update purchase status
          await supabaseAdmin
            .from('purchases')
            .update({ status: 'refunded' })
            .eq('id', purchase.id);
          
          // Deduct credits if user has them
          if (purchase.user_id) {
            const { data: balance } = await supabaseAdmin
              .from('credit_balances')
              .select('balance')
              .eq('user_id', purchase.user_id)
              .single();
            
            if (balance) {
              const newBalance = Math.max(0, balance.balance - purchase.credits_purchased);
              await supabaseAdmin
                .from('credit_balances')
                .update({ balance: newBalance })
                .eq('user_id', purchase.user_id);
              
              await supabaseAdmin
                .from('credit_transactions')
                .insert({
                  user_id: purchase.user_id,
                  amount: -purchase.credits_purchased,
                  balance_after: newBalance,
                  type: 'refund',
                  reference_id: paymentIntent,
                  description: 'Refund processed',
                });
            }
          }
          
          // Invalidate guest token if exists
          if (purchase.guest_token) {
            await storageDel(`credit:${purchase.guest_token}`);
          }
          
          console.log(`Webhook: Processed refund for purchase ${purchase.id}`);
        }
      }
      break;
    }
  }
  
  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// REFUND ENDPOINTS (existing)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/refund-eligible', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ eligible: false, reason: 'Missing token' });
  const entry = await storageGet(`credit:${token}`);
  if (!entry) return res.json({ eligible: false, reason: 'Purchase not found on this device' });
  if (!entry.stripeSessionId) return res.json({ eligible: false, reason: 'Email us for a manual refund' });
  const usedCredits = entry.used || 0;
  const totalCredits = entry.remaining + usedCredits;
  const remainingPct = totalCredits > 0 ? entry.remaining / totalCredits : 1;
  if (remainingPct < REFUND_MIN_REMAINING_PCT) {
    return res.json({ eligible: false, reason: `${usedCredits} of ${totalCredits} credits used` });
  }
  let amount = null;
  if (stripe) {
    try {
      const session = await stripe.checkout.sessions.retrieve(entry.stripeSessionId);
      amount = session.amount_total / 100;
    } catch (_) {}
  }
  res.json({ eligible: true, remaining: entry.remaining, amount });
});

app.post('/api/refund', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  
  const { creditToken } = req.body;
  if (!creditToken) return res.status(400).json({ error: 'Missing credit token' });
  
  const entry = await storageGet(`credit:${creditToken}`);
  if (!entry) return res.status(404).json({ error: 'Token not found. Use the same device where you purchased.' });
  if (!entry.stripeSessionId) return res.status(400).json({ error: 'No purchase found for this token' });
  
  const usedCredits = entry.used || 0;
  const originalCredits = entry.remaining + usedCredits;
  const remainingPct = originalCredits > 0 ? entry.remaining / originalCredits : 1;
  if (remainingPct < REFUND_MIN_REMAINING_PCT) {
    const threshold = Math.floor(REFUND_MIN_REMAINING_PCT * 100);
    return res.status(400).json({
      error: `You've used ${usedCredits} of ${originalCredits} credits. Refunds available while ${threshold}%+ remain.`
    });
  }
  
  try {
    const session = await stripe.checkout.sessions.retrieve(entry.stripeSessionId);
    const paymentIntent = session.payment_intent;
    if (!paymentIntent) return res.status(400).json({ error: 'No payment found' });
    
    const pi = await stripe.paymentIntents.retrieve(paymentIntent);
    if (pi.status === 'canceled' || pi.amount_received === 0) {
      return res.status(400).json({ error: 'Already refunded' });
    }
    
    const refund = await stripe.refunds.create({ payment_intent: paymentIntent });
    await storageDel(`credit:${creditToken}`);
    
    trackEvent(creditToken, 'refund_processed', { amount: refund.amount / 100 });
    res.json({ success: true, amount: refund.amount / 100, currency: refund.currency.toUpperCase() });
  } catch (err) {
    console.error('Refund error:', err.message);
    res.status(500).json({ error: 'Refund failed: ' + err.message });
  }
});

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
      return res.status(503).json({ error: 'Server API key not configured' });
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
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS ENDPOINT
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/track', optionalAuth, (req, res) => {
  const { event, properties } = req.body;
  if (!event) return res.status(400).json({ error: 'Missing event' });
  
  const distinctId = req.user?.id || properties?.distinctId || 'anonymous';
  trackEvent(distinctId, event, properties);
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
