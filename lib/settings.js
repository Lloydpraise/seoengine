const DEFAULTS = {
  siteName: 'KitchenAll',
  siteUrl: process.env.SITE_URL || 'https://kitchenandall.co.ke',
  siteContext:
    'KitchenAll is a commercial kitchen equipment store in Nairobi, Kenya, selling to restaurants, hotels, ' +
    'butcheries, bakeries and catering businesses across Kenya. Prices are in KES.',
  majorCategories: ['Cooking', 'Refrigeration', 'Food Prep', 'Stainless Steel'],
  subCategories: [
    'Bakery Appliances', 'Burners/Jikos/Stoves', 'Cooking Appliances', 'Small Appliances',
    'Large Appliances', 'Hotel Appliances', 'Office Kitchen', 'Butchery Equipment',
    'Food Processors', 'Measuring Tools', 'Home Kitchen', 'Juakali Fabrications',
  ],
  extractModel: 'gpt-4.1-mini',
  writerModel: 'gpt-4.1-mini', // paste a fine-tuned model id (ft:...) here after you fine-tune
  visionModel: 'gpt-4.1-mini', // looks at the photo before writing (needs image input)
  qaModel: 'gpt-4.1-mini', // the separate QA AI that checks the finished copy against the photo
  writerSeesPhoto: true, // attach the product photo to the FIRST writing call (retries are text-only; turned off automatically if the writing model cannot take images)
  photoDetail: 'low', // image detail for your product photo in the look and writing calls: 'low' (cheapest) | 'auto' | 'high'
  qaDetail: 'low', // image detail for the photo QA check. Switch to 'high' if QA misses small things like burner or door counts
  concurrency: 2,
  sourcesPerProduct: 3, // competitor pages read per product (1-4)
  preferredSites: [], // e.g. ["jumia.co.ke","kilimall.co.ke"]: tried first, in this order
  siteSearch: true, // look products up on preferred competitor sites using their own search box (free)
  useBrowser: false, // headless browser for JavaScript-only sites (needs: npm i playwright && npx playwright install chromium)
  minFit: 0.6, // how closely a competitor page must match your product to be used automatically
  autoFindSources: true,
  // 'text' is safe for any site. Switch to 'html' once your product page renders description as HTML.
  descriptionFormat: 'text',
  defaultProfileId: 'default',
  // Optional extra Supabase columns, e.g. {"h1":"h1","faq_json":"faqs_json","schema_jsonld":"jsonld"}
  // Left side = column in your products table. Right side = h1 | short_description | faqs_json | specs_json | jsonld | primary_keyword | tags | secondary_keywords
  extraColumns: {},
};

// Models saved by an earlier version of the settings page were the old defaults. Treat those as "not chosen" so the new
// defaults apply. Anything else (a fine-tuned ft:... id, or a model you typed yourself) is kept.
const OLD_DEFAULT_MODELS = new Set(['gpt-4o', 'gpt-4o-mini']);
const MODEL_KEYS = ['extractModel', 'writerModel', 'visionModel', 'qaModel'];
const DETAILS = new Set(['low', 'auto', 'high']);

function getSettings(store) {
  const saved = { ...(store.db.settings || {}) };
  for (const k of MODEL_KEYS) if (OLD_DEFAULT_MODELS.has(saved[k])) delete saved[k];
  for (const k of ['photoDetail', 'qaDetail']) if (k in saved && !DETAILS.has(saved[k])) delete saved[k];
  return { ...DEFAULTS, ...saved };
}
module.exports = { DEFAULTS, getSettings };
