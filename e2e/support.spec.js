// @ts-check
const { test, expect } = require('@playwright/test');
const { quoteRefund } = require('../lib/selfserve');

const DAY = 24 * 60 * 60 * 1000;

test.describe('Refund quotes', () => {
  test('unused pack within 14 days is a full refund', () => {
    const now = Date.now();
    const quote = quoteRefund({
      amountCents: 1000,
      credits: 25,
      creditsUsed: 0,
      createdAtMs: now - 3 * DAY,
      refunded: false,
      now,
    });
    expect(quote.eligible).toBe(true);
    expect(quote.kind).toBe('full');
    expect(quote.refundCents).toBe(1000);
  });

  test('partly used pack within 30 days is pro-rata', () => {
    const now = Date.now();
    const quote = quoteRefund({
      amountCents: 1000,
      credits: 25,
      creditsUsed: 10,
      createdAtMs: now - 20 * DAY,
      refunded: false,
      now,
    });
    expect(quote.eligible).toBe(true);
    expect(quote.kind).toBe('partial');
    expect(quote.refundCents).toBe(600);
  });

  test('a pack older than 30 days is not refundable', () => {
    const now = Date.now();
    const quote = quoteRefund({
      amountCents: 500,
      credits: 10,
      creditsUsed: 0,
      createdAtMs: now - 31 * DAY,
      refunded: false,
      now,
    });
    expect(quote.eligible).toBe(false);
  });
});

test.describe('Help and refund pages', () => {
  test('help center answers the common questions', async ({ page }) => {
    await page.goto('/help');
    await expect(page).toHaveTitle(/Help/);
    await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Credits' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failed generations' })).toBeVisible();
    await expect(page.getByText(/credit is returned automatically/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Receipts and invoices' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Contact' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Message')).toBeVisible();
  });

  test('refund page states the 14-day and 30-day policy', async ({ page }) => {
    await page.goto('/refund');
    await expect(page).toHaveTitle(/Refund policy/i);
    await expect(page.getByRole('heading', { name: 'Refund policy' })).toBeVisible();
    await expect(page.getByText(/within 14 days if you have not used the pack/i)).toBeVisible();
    await expect(page.getByText(/pro-rata for 30 days/i)).toBeVisible();
    await expect(page.getByLabel('Purchase email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
  });

  test('help and refund do not overflow at 390, 1180, or 1512', async ({ page }) => {
    for (const width of [390, 1180, 1512]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/help', '/refund']) {
        await page.goto(path);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
      }
    }
  });
});

test.describe('Self-serve API', () => {
  test('restore rejects a missing email', async ({ request }) => {
    const response = await request.post('/api/restore/request', { data: {} });
    expect(response.status()).toBe(400);
  });

  test('contact rejects a short message', async ({ request }) => {
    const response = await request.post('/api/contact', {
      data: { email: 'reader@example.com', message: 'hi' },
    });
    expect(response.status()).toBe(400);
  });

  test('purchases require a verified token', async ({ request }) => {
    const response = await request.get('/api/purchases');
    expect(response.status()).toBe(401);
  });

  test('funnel events are accepted when analytics is off', async ({ request }) => {
    for (const event of ['landing_view', 'start', 'generate', 'buy_click', 'checkout_complete', 'refund']) {
      const response = await request.post('/api/track', {
        data: { event, properties: { distinctId: 'e2e' } },
      });
      expect(response.ok()).toBe(true);
    }
    const limited = await request.post('/api/track', { data: { event: 'landing_view' } });
    expect(limited.headers()['x-ratelimit-limit']).toBeTruthy();
  });
});

test.describe('Buy, restore, and refund', () => {
  test('buying a pack asks checkout for that pack', async ({ page }) => {
    let pack = '';
    await page.route('**/api/create-checkout', async (route) => {
      pack = route.request().postDataJSON().pack;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: '/help?bought=1' }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app');
    await page.locator('.header-credit-pill').click();
    await page.locator('#pack-starter').click();
    await page.locator('#modalCta').click();
    await page.waitForURL('**/help?bought=1');
    expect(pack).toBe('starter');
  });

  test('a verified email can restore credits and refund a pack', async ({ page }) => {
    await page.route('**/api/restore/request', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          message: 'If that email has a purchase, we sent a code. It expires in 10 minutes.',
        }),
      });
    });
    await page.route('**/api/restore/verify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token: 'bl_e2e',
          email: 'reader@example.com',
          remaining: 10,
          purchases: [{
            id: 'cs_e2e',
            created: Math.floor(Date.now() / 1000),
            amount: 5,
            currency: 'USD',
            credits: 10,
            used: 0,
            remaining: 10,
            refunded: false,
            eligible: true,
            refundAmount: 5,
            kind: 'full',
            reason: '',
            receiptUrl: '',
          }],
        }),
      });
    });
    await page.route('**/api/refund', async (route) => {
      const body = route.request().postDataJSON();
      expect(body.sessionId).toBe('cs_e2e');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, amount: 5, currency: 'USD', kind: 'full', remaining: 0 }),
      });
    });

    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto('/refund');
    await page.getByLabel('Purchase email').fill('reader@example.com');
    await page.getByRole('button', { name: 'Send code' }).click();
    await expect(page.getByLabel('Code')).toBeVisible();
    await page.getByLabel('Code').fill('123456');
    await page.getByRole('button', { name: 'Verify email' }).click();
    await expect(page.getByText('Credits restored')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download my data' })).toBeVisible();
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    await expect(page.getByText('Refund issued')).toBeVisible();
    await expect(page.getByText(/returning to the original payment/i)).toBeVisible();
  });
});
