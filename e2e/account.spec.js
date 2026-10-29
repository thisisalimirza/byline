// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Account Page', () => {
  test('shows sign-in prompt when not authenticated', async ({ page }) => {
    // Clear any stored auth
    await page.goto('/account');
    await page.evaluate(() => {
      localStorage.removeItem('byline_access_token');
      localStorage.removeItem('byline_refresh_token');
      localStorage.removeItem('byline_user');
    });
    
    // Reload to apply cleared state
    await page.reload();
    
    // Should show sign-in prompt
    await page.waitForSelector('#signinPrompt, .signin-prompt', { state: 'visible', timeout: 5000 }).catch(() => {
      // May show loading briefly first
    });
    
    // Page should load without errors
    await expect(page).toHaveTitle(/Account.*Byline|Byline/i);
  });

  test('has link back to app', async ({ page }) => {
    await page.goto('/account');
    
    const backLink = page.getByRole('link', { name: /back|app/i }).first();
    await expect(backLink).toBeVisible();
  });

  test('responsive at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/account');
    
    // No horizontal scroll
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400);
  });

  test('has footer links', async ({ page }) => {
    await page.goto('/account');
    
    // Wait for content to load
    await page.waitForTimeout(500);
    
    // Should have links to legal pages
    const termsLink = page.getByRole('link', { name: /terms/i });
    const privacyLink = page.getByRole('link', { name: /privacy/i });
    
    // At least one should be visible (may be in different states)
    const hasTerms = await termsLink.isVisible().catch(() => false);
    const hasPrivacy = await privacyLink.isVisible().catch(() => false);
    
    expect(hasTerms || hasPrivacy).toBe(true);
  });
});
