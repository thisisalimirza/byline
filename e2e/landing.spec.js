// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Landing Page', () => {
  test('displays hero section with CTA', async ({ page }) => {
    await page.goto('/');
    
    // Check page title
    await expect(page).toHaveTitle(/Byline/);
    
    // Hero headline should be visible
    const headline = page.locator('h1').first();
    await expect(headline).toBeVisible();
    
    // Primary CTA should exist
    const ctaButton = page.getByRole('link', { name: /start writing|try it|get started/i });
    await expect(ctaButton).toBeVisible();
  });

  test('navigation links work', async ({ page }) => {
    await page.goto('/');
    
    // Logo should link to home
    const logo = page.locator('.nav-logo, .logo').first();
    await expect(logo).toBeVisible();
    
    // Should have link to app
    const appLink = page.getByRole('link', { name: /app|start|write/i }).first();
    await expect(appLink).toBeVisible();
  });

  test('responsive layout at mobile width (390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    
    // Page should not have horizontal overflow
    const body = page.locator('body');
    const box = await body.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(390);
    
    // Hero should still be visible
    const headline = page.locator('h1').first();
    await expect(headline).toBeVisible();
  });

  test('responsive layout at laptop width (1180px)', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto('/');
    
    // Navigation should be visible
    const nav = page.locator('nav').first();
    await expect(nav).toBeVisible();
    
    // No horizontal scrollbar
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(1180);
  });

  test('responsive layout at desktop width (1512px)', async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.goto('/');
    
    // Content should be centered and not stretched
    const main = page.locator('main, section').first();
    const box = await main.boundingBox();
    expect(box?.width).toBeLessThan(1400); // Max content width
  });
});
