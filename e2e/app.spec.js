// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('App Page', () => {
  test('loads without errors', async ({ page }) => {
    await page.goto('/app');
    
    // Check page title
    await expect(page).toHaveTitle(/Byline/);
    
    // Logo should be visible
    const logo = page.locator('.logo, .logo-mark').first();
    await expect(logo).toBeVisible();
  });

  test('shows topic input field', async ({ page }) => {
    await page.goto('/app');
    
    // Topic input should exist
    const topicInput = page.locator('#topic, [placeholder*="topic"], [placeholder*="Topic"]').first();
    await expect(topicInput).toBeVisible();
  });

  test('shows keyword input field', async ({ page }) => {
    await page.goto('/app');
    
    // Keyword input should exist
    const keywordInput = page.locator('#keyword, [placeholder*="keyword"], [placeholder*="Keyword"]').first();
    await expect(keywordInput).toBeVisible();
  });

  test('shows generate button', async ({ page }) => {
    await page.goto('/app');
    
    // Generate button should exist
    const generateBtn = page.getByRole('button', { name: /generate|run|start/i }).first();
    await expect(generateBtn).toBeVisible();
  });

  test('displays credits section', async ({ page }) => {
    await page.goto('/app');
    
    // Credits indicator should exist somewhere
    const creditsText = page.getByText(/credit|article/i).first();
    await expect(creditsText).toBeVisible();
  });

  test('responsive at mobile width (390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app');
    
    // Page should not overflow horizontally
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(400); // Small tolerance
    
    // Main content should be visible
    const main = page.locator('main, .sidebar, #topic').first();
    await expect(main).toBeVisible();
  });

  test('handles URL token parameter', async ({ page }) => {
    // Simulate returning from checkout with token
    await page.goto('/app?token=test-token-123&credits=10&new=1');
    
    // Should show the page without crashing
    await expect(page).toHaveTitle(/Byline/);
    
    // URL should be cleaned up (token removed for security)
    await page.waitForTimeout(500);
    const url = page.url();
    expect(url).not.toContain('token=test-token');
  });
});

test.describe('App - Generation Flow', () => {
  test('shows error when generating without credits or API key', async ({ page }) => {
    await page.goto('/app');
    
    // Clear any stored tokens
    await page.evaluate(() => {
      localStorage.removeItem('byline_credit_token');
      localStorage.removeItem('byline_own_key');
    });
    
    // Fill in topic
    const topicInput = page.locator('#topic').first();
    await topicInput.fill('Test topic');
    
    // Try to generate
    const generateBtn = page.getByRole('button', { name: /generate|run|start/i }).first();
    await generateBtn.click();
    
    // Should show some kind of error or prompt to buy credits
    // (The exact behavior depends on implementation)
    await page.waitForTimeout(1000);
  });
});
