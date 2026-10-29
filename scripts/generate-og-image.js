const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1200px;
      height: 630px;
      background: linear-gradient(135deg, #0d0c09 0%, #181611 100%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
    }
    .logo {
      width: 80px;
      height: 80px;
      background: #d4854a;
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
      box-shadow: 0 8px 32px rgba(212, 133, 74, 0.3);
    }
    .logo-letter {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 48px;
      font-weight: 600;
      color: #0d0c09;
    }
    .brand {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 72px;
      font-weight: 600;
      color: #ede9e0;
      letter-spacing: -0.03em;
      margin-bottom: 16px;
    }
    .tagline {
      font-size: 28px;
      color: #8a8478;
      margin-bottom: 48px;
    }
    .divider {
      width: 400px;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(212, 133, 74, 0.4), transparent);
      margin-bottom: 48px;
    }
    .features {
      display: flex;
      gap: 48px;
    }
    .feature {
      font-size: 18px;
      color: #5e5b54;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .feature::before {
      content: '✦';
      color: #d4854a;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="logo">
    <span class="logo-letter">B</span>
  </div>
  <div class="brand">Byline</div>
  <div class="tagline">Articles that rank and sound human</div>
  <div class="divider"></div>
  <div class="features">
    <div class="feature">6-stage pipeline</div>
    <div class="feature">SEO-optimized</div>
    <div class="feature">From $0.33/article</div>
  </div>
</body>
</html>`;

async function generateOgImage() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  
  // Wait for fonts to load
  await page.waitForTimeout(1000);
  
  const outputPath = path.join(__dirname, '..', 'public', 'og-image.png');
  await page.screenshot({ path: outputPath, type: 'png' });
  
  await browser.close();
  
  console.log('Generated og-image.png at', outputPath);
  
  // Verify file exists and has content
  const stats = fs.statSync(outputPath);
  console.log('File size:', stats.size, 'bytes');
}

generateOgImage().catch(console.error);
