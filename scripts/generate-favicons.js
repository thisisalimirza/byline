const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const sizes = [
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-16x16.png', size: 16 },
];

function getHtml(size) {
  const padding = Math.round(size * 0.15);
  const fontSize = Math.round(size * 0.55);
  const borderRadius = Math.round(size * 0.22);
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: ${size}px;
      height: ${size}px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon {
      width: ${size}px;
      height: ${size}px;
      background: #d4854a;
      border-radius: ${borderRadius}px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .letter {
      font-family: 'Fraunces', Georgia, serif;
      font-size: ${fontSize}px;
      font-weight: 600;
      color: #0d0c09;
      line-height: 1;
      padding-top: ${padding * 0.3}px;
    }
  </style>
</head>
<body>
  <div class="icon">
    <span class="letter">B</span>
  </div>
</body>
</html>`;
}

async function generateFavicons() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  for (const { name, size } of sizes) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(getHtml(size), { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    
    const outputPath = path.join(__dirname, '..', 'public', name);
    await page.screenshot({ path: outputPath, type: 'png', omitBackground: true });
    console.log(`Generated ${name} (${size}x${size})`);
  }
  
  await browser.close();
  
  // Create favicon.ico from the 32x32 PNG
  // Note: For a proper ICO file, you'd use a library like png-to-ico
  // For now, we'll copy the 32x32 PNG as a workaround and note that
  // a proper ICO should be generated
  const png32Path = path.join(__dirname, '..', 'public', 'favicon-32x32.png');
  const icoPath = path.join(__dirname, '..', 'public', 'favicon.ico');
  
  // Most browsers accept PNG files named .ico, but for proper support
  // you'd use a library. For now, copy the PNG.
  fs.copyFileSync(png32Path, icoPath);
  console.log('Created favicon.ico (copied from 32x32 PNG)');
}

generateFavicons().catch(console.error);
