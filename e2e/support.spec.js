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
});
