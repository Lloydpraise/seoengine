// OPTIONAL headless browser for competitor sites that only show content with JavaScript.
// Not installed by default:  npm i playwright && npx playwright install chromium
let pw, browser;
function available() { try { require.resolve('playwright'); return true; } catch { return false; } }
async function render(url) {
  if (!available()) throw new Error('Headless browser not installed. Run: npm i playwright && npx playwright install chromium');
  pw = pw || require('playwright');
  browser = browser || (await pw.chromium.launch());
  const ctx = await browser.newContext({ locale: 'en-KE', userAgent: 'Mozilla/5.0 (compatible; KitchenAll-SEO-Research/1.0)' });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    return { html: await page.content(), url: page.url() };
  } finally { await ctx.close(); }
}
module.exports = { available, render };
