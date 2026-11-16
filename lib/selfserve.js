'use strict';

const crypto = require('crypto');

const SUPPORT_EMAIL = 'ali@braskgroup.com';
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hmacKey() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_SECRET_KEY || '';
  return crypto.createHash('sha256').update(`byline-self-serve:${secret}`).digest();
}

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', hmacKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', hmacKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function signAccess(email) {
  return `bl_${signPayload({ e: normalizeEmail(email), v: 1, iat: Date.now() })}`;
}

function readAccess(token) {
  if (typeof token !== 'string' || !token.startsWith('bl_')) return null;
  const payload = readPayload(token.slice(3));
  if (!payload || payload.v !== 1 || !isEmail(payload.e || '')) return null;
  return payload;
}

function hashCode(email, code) {
  return crypto.createHmac('sha256', hmacKey()).update(`${normalizeEmail(email)}:${code}`).digest('hex');
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function quoteRefund({ amountCents, credits, creditsUsed, createdAtMs, refunded, now = Date.now() }) {
  const total = Number(credits) || 0;
  const used = Math.max(0, Number(creditsUsed) || 0);
  const remaining = Math.max(0, total - used);
  const ageMs = now - Number(createdAtMs || 0);
  if (refunded) return { eligible: false, reason: 'This pack was already refunded' };
  if (!total || remaining <= 0) return { eligible: false, reason: 'All credits from this pack have been used' };
  if (ageMs > 30 * DAY_MS) return { eligible: false, reason: 'Refunds are available for 30 days after purchase' };
  const full = ageMs <= 14 * DAY_MS && used === 0;
  const refundCents = full ? amountCents : Math.round((amountCents * remaining) / total);
  if (!refundCents || refundCents < 1) {
    return { eligible: false, reason: 'The unused balance is too small to refund' };
  }
  return {
    eligible: true,
    refundCents,
    remaining,
    used,
    total,
    full,
    kind: full ? 'full' : 'partial',
  };
}

function packFromSession(session) {
  const meta = session.metadata || {};
  const credits = parseInt(meta.credits, 10) || 0;
  const used = parseInt(meta.credits_used || '0', 10) || 0;
  const refunded = meta.refunded === '1' || meta.refund_pending === '1';
  const quote = quoteRefund({
    amountCents: session.amount_total || 0,
    credits,
    creditsUsed: used,
    createdAtMs: (session.created || 0) * 1000,
    refunded: meta.refunded === '1',
  });
  return {
    id: session.id,
    created: session.created,
    amountCents: session.amount_total || 0,
    currency: (session.currency || 'usd').toUpperCase(),
    credits,
    used,
    remaining: Math.max(0, credits - used),
    refunded: meta.refunded === '1',
    pending: meta.refund_pending === '1',
    email: meta.email || session.customer_details?.email || '',
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    receiptUrl: meta.receipt_url || '',
    accountOwned: !!meta.user_id,
    quote,
    blocked: refunded,
  };
}

async function searchSessions(stripe, email) {
  const query = `customer_details.email:'${email.replace(/'/g, '')}' AND status:'complete'`;
  const found = [];
  let page = await stripe.checkout.sessions.search({ query, limit: 100 });
  found.push(...page.data);
  while (page.has_more && page.next_page) {
    page = await stripe.checkout.sessions.search({ query, limit: 100, page: page.next_page });
    found.push(...page.data);
  }
  return found.filter(s => s.payment_status === 'paid' || s.metadata?.refunded === '1');
}

function spendableRemaining(packs) {
  return packs
    .filter(p => !p.accountOwned && !p.refunded && !p.pending)
    .reduce((sum, p) => sum + p.remaining, 0);
}

async function listPacks(stripe, email) {
  const sessions = await searchSessions(stripe, normalizeEmail(email));
  return sessions
    .map(packFromSession)
    .filter(p => p.credits > 0)
    .sort((a, b) => a.created - b.created);
}

async function adjustUsed(stripe, sessionId, delta) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const meta = session.metadata || {};
  if (meta.refunded === '1' || meta.refund_pending === '1') {
    const err = new Error('This pack is no longer available');
    err.status = 402;
    throw err;
  }
  const total = parseInt(meta.credits, 10) || 0;
  const used = parseInt(meta.credits_used || '0', 10) || 0;
  const next = used + delta;
  if (next < 0 || (delta > 0 && next > total)) {
    const err = new Error('Credit balance changed');
    err.status = 402;
    throw err;
  }
  await stripe.checkout.sessions.update(sessionId, {
    metadata: { credits_used: String(next) },
  });
  return { used: next, total, remaining: Math.max(0, total - next) };
}

async function spendFromEmail(stripe, email) {
  const packs = await listPacks(stripe, email);
  const open = packs.filter(p => !p.accountOwned && !p.refunded && !p.pending && p.remaining > 0);
  if (!open.length) return { remaining: 0, empty: true };
  const pack = open[0];
  await adjustUsed(stripe, pack.id, 1);
  const remaining = open.reduce((sum, p) => sum + p.remaining, 0) - 1;
  return { remaining: Math.max(0, remaining), sessionId: pack.id, email: normalizeEmail(email) };
}

async function returnToSession(stripe, sessionId) {
  if (!stripe || !sessionId) return;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const meta = session.metadata || {};
  if (meta.refunded === '1') return;
  const used = parseInt(meta.credits_used || '0', 10) || 0;
  if (used <= 0) return;
  await stripe.checkout.sessions.update(sessionId, {
    metadata: { credits_used: String(used - 1) },
  });
}

async function spendForUser(stripe, userId) {
  if (!stripe || !userId) return { sessionId: null };
  const query = `metadata['user_id']:'${String(userId).replace(/'/g, '')}' AND status:'complete'`;
  let page;
  try {
    page = await stripe.checkout.sessions.search({ query, limit: 100 });
  } catch {
    return { sessionId: null };
  }
  const packs = (page.data || [])
    .map(packFromSession)
    .filter(p => p.accountOwned && !p.refunded && !p.pending && p.remaining > 0)
    .sort((a, b) => a.created - b.created);
  if (!packs.length) return { sessionId: null };
  await adjustUsed(stripe, packs[0].id, 1);
  return { sessionId: packs[0].id };
}

async function customersForEmail(stripe, email) {
  const normalized = normalizeEmail(email);
  const list = await stripe.customers.list({ email: normalized, limit: 10 });
  if (list.data.length) return list.data;
  try {
    const searched = await stripe.customers.search({ query: `email:'${normalized.replace(/'/g, '')}'`, limit: 10 });
    return searched.data || [];
  } catch {
    return [];
  }
}

async function sendEmail({ to, subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    const err = new Error('Email is not configured');
    err.code = 'email_unconfigured';
    throw err;
  }
  const from = process.env.EMAIL_FROM || `Byline <${SUPPORT_EMAIL}>`;
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, text };
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = new Error('Could not send email');
    err.code = 'email_failed';
    throw err;
  }
}

function codeMessage(code) {
  return `Your Byline code is ${code}. It expires in 10 minutes. If you did not ask for this, you can ignore this email.`;
}

module.exports = {
  SUPPORT_EMAIL,
  CODE_TTL_MS,
  CODE_MAX_TRIES,
  normalizeEmail,
  isEmail,
  signAccess,
  readAccess,
  hashCode,
  makeCode,
  quoteRefund,
  packFromSession,
  searchSessions,
  listPacks,
  spendableRemaining,
  adjustUsed,
  spendFromEmail,
  spendForUser,
  returnToSession,
  customersForEmail,
  sendEmail,
  codeMessage,
};
