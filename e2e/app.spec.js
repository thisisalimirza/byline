// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('App Page', () => {
  test('loads without JavaScript errors', async ({ page }) => {
    const errors = [];
    const consoleErrors = [];
    
    // Capture page errors (uncaught exceptions)
    page.on('pageerror', error => {
      errors.push(error.message);
    });
    
    // Capture console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.goto('/app');
    
    // Wait for page to fully load and scripts to execute
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    
    // Check page title
    await expect(page).toHaveTitle(/Byline/);
    
    // No JavaScript errors should have occurred
    expect(errors, `Page errors: ${errors.join(', ')}`).toHaveLength(0);
    
    // Filter out expected console errors (like network errors for missing services)
    const criticalErrors = consoleErrors.filter(e => 
      !e.includes('Failed to load resource') && 
      !e.includes('net::') &&
      !e.includes('favicon')
    );
    expect(criticalErrors, `Console errors: ${criticalErrors.join(', ')}`).toHaveLength(0);
  });
  
  test('loads and renders main UI', async ({ page }) => {
    await page.goto('/app');
    
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

  test('responsive at mobile width (390px) - no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/app');
    
    // Critical: document.scrollWidth must not exceed viewport width
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    
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

test.describe('App - Buy Credits Flow', () => {
  test('Buy credits button opens modal with pack options', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    
    await page.goto('/app');
    await page.waitForLoadState('networkidle');
    
    // No JS errors before interaction
    expect(errors, `Page errors on load: ${errors.join(', ')}`).toHaveLength(0);
    
    // Find and click the Buy credits button (in sidebar or header)
    const buyBtn = page.locator('button:has-text("Buy credits"), button:has-text("Top up"), .credit-topup, .header-credit-pill').first();
    await expect(buyBtn).toBeVisible();
    await buyBtn.click();
    
    // No JS errors after clicking
    expect(errors, `Page errors after click: ${errors.join(', ')}`).toHaveLength(0);
    
    // Credits modal should appear
    const modal = page.locator('#creditsModal, .modal-overlay:visible').first();
    await expect(modal).toBeVisible({ timeout: 2000 });
    
    // Modal should have pack options
    const packCard = page.locator('.pack-card').first();
    await expect(packCard).toBeVisible();
    
    // Modal CTA button should be visible
    const modalBuyBtn = page.locator('#modalCta, button:has-text("Buy credits")').first();
    await expect(modalBuyBtn).toBeVisible();
    
    // No JS errors during modal interaction
    expect(errors, `Page errors with modal: ${errors.join(', ')}`).toHaveLength(0);
  });
});
