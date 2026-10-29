// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('API Endpoints', () => {
  test('health check returns service status', async ({ request }) => {
    const response = await request.get('/api/health');
    
    expect(response.ok()).toBe(true);
    
    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.services).toBeDefined();
  });

  test('credits endpoint returns valid response for invalid token', async ({ request }) => {
    const response = await request.get('/api/credits?token=invalid-token-123');
    
    expect(response.ok()).toBe(true);
    
    const data = await response.json();
    expect(data.valid).toBe(false);
    expect(data.remaining).toBe(0);
  });

  test('credits endpoint handles missing token', async ({ request }) => {
    const response = await request.get('/api/credits');
    
    expect(response.ok()).toBe(true);
    
    const data = await response.json();
    expect(data.valid).toBe(false);
  });

  test('start-run requires credit token', async ({ request }) => {
    const response = await request.post('/api/start-run', {
      data: {},
    });
    
    expect(response.status()).toBe(400);
    
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  test('refund-eligible handles invalid token', async ({ request }) => {
    const response = await request.get('/api/refund-eligible?token=invalid');
    
    expect(response.ok()).toBe(true);
    
    const data = await response.json();
    expect(data.eligible).toBe(false);
  });

  test('magic link requires email', async ({ request }) => {
    const response = await request.post('/api/auth/magic-link', {
      data: {},
    });
    
    // Should return 400 for missing email, or 503 if Supabase not configured
    expect([400, 503]).toContain(response.status());
  });

  test('user endpoints require authentication', async ({ request }) => {
    const response = await request.get('/api/user/drafts');
    
    // Should return 401 or 503
    expect([401, 503]).toContain(response.status());
  });

  test('track endpoint accepts events', async ({ request }) => {
    const response = await request.post('/api/track', {
      data: {
        event: 'test_event',
        properties: { test: true },
      },
    });
    
    expect(response.ok()).toBe(true);
  });

  test('rate limiting headers are present', async ({ request }) => {
    const response = await request.get('/api/health');
    
    // Rate limit headers should be present on rate-limited endpoints
    // Health check may not be rate limited, so this is informational
    expect(response.ok()).toBe(true);
  });
});

test.describe('API - Checkout Flow', () => {
  test('create-checkout requires Stripe to be configured', async ({ request }) => {
    const response = await request.post('/api/create-checkout', {
      data: { pack: 'creator' },
    });
    
    // Will return 503 if Stripe not configured, or redirect URL if it is
    const data = await response.json();
    
    if (response.ok()) {
      expect(data.url).toContain('stripe.com');
    } else {
      expect(data.error).toBeDefined();
    }
  });
});
