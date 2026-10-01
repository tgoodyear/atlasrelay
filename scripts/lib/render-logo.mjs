// Renders the site's icon (web/public/favicon.svg) to a square PNG, for the Microsoft Entra app
// registration's logo (scripts/register-signin.sh). Entra shows the logo on the consent screen and
// in My Apps, and takes a PNG of 215x215 pixels, 100 KB at most.
//
//   node scripts/lib/render-logo.mjs <out.png> [size]
//
// Uses the Playwright Chromium the browser tests install (npx -w web playwright install chromium).
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [out, sizeArg = '215'] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/lib/render-logo.mjs <out.png> [size]');
  process.exit(2);
}
const size = Number(sizeArg);
if (!Number.isInteger(size) || size < 16 || size > 1024) {
  console.error(`render-logo: bad size ${sizeArg}`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const svg = readFileSync(join(root, 'web', 'public', 'favicon.svg'), 'utf8');
// Playwright is a dependency of the web workspace, so resolve it from there.
const { chromium } = createRequire(join(root, 'web', 'package.json'))('@playwright/test');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  // The icon fills the square; its own rounded background is the logo's background.
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#fff">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
} finally {
  await browser.close();
}
const bytes = statSync(out).size;
if (bytes > 100 * 1024) {
  console.error(`render-logo: ${out} is ${bytes} bytes, over Entra's 100 KB limit`);
  process.exit(1);
}
console.log(`${out}: ${size}x${size}, ${bytes} bytes`);
