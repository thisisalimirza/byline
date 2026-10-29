// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Legal Pages', () => {
  test('terms page loads and has required content', async ({ page }) => {
    await page.goto('/terms');
    
    await expect(page).toHaveTitle(/Terms/i);
    
    // Should have key sections (use .first() since text appears in multiple elements)
    await expect(page.getByText(/Agreement to Terms/i).first()).toBeVisible();
    await expect(page.getByText(/Payment/i).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Contact/i })).toBeVisible();
    
    // Back link should work
    const backLink = page.getByRole('link', { name: /back/i }).first();
    await expect(backLink).toBeVisible();
  });

  test('privacy page loads and has required content', async ({ page }) => {
    await page.goto('/privacy');
    
    await expect(page).toHaveTitle(/Privacy/i);
    
    // Should have key sections (use .first() since text appears in multiple elements)
    await expect(page.getByText(/Information We Collect/i).first()).toBeVisible();
    await expect(page.getByText(/Third-Party/i).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Contact/i })).toBeVisible();
  });

  test('refund page loads', async ({ page }) => {
    await page.goto('/refund');
    
    await expect(page).toHaveTitle(/Refund/i);
    
    // Should explain the policy
    await expect(page.getByText(/refund/i).first()).toBeVisible();
  });

  test('legal pages link to each other', async ({ page }) => {
    await page.goto('/terms');
    
    // Should have link to privacy
    const privacyLink = page.getByRole('link', { name: /privacy/i });
    await expect(privacyLink).toBeVisible();
    
    // Navigate and verify
    await privacyLink.click();
    await expect(page).toHaveURL(/privacy/);
  });

  test('legal pages are responsive at 390px - no overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    
    // Test all legal pages
    for (const path of ['/terms', '/privacy', '/refund']) {
      await page.goto(path);
      
      // Critical: document.scrollWidth must not exceed viewport width
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);
      
      // Content should be readable
      const content = page.locator('.card, main').first();
      await expect(content).toBeVisible();
    }
  });
});
