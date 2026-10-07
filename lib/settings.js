const DEFAULTS = {
  siteName: 'KitchenAll',
  siteUrl: process.env.SITE_URL || 'https://kitchenandall.com',
  siteContext:
    'KitchenAll is a commercial kitchen equipment store in Nairobi, Kenya, selling to restaurants, hotels, ' +
    'butcheries, bakeries and catering businesses across Kenya. Prices are in KES.',
  majorCategories: ['Cooking', 'Refrigeration', 'Food Prep', 'Stainless Steel'],
  subCategories: [
    'Bakery Appliances', 'Burners/Jikos/Stoves', 'Cooking Appliances', 'Small Appliances',
    'Large Appliances', 'Hotel Appliances', 'Office Kitchen', 'Butchery Equipment',
    'Food Processors', 'Measuring Tools', 'Home Kitchen', 'Juakali Fabrications',
  ],
  extractModel: 'gpt-4o-mini',
  writerModel: 'gpt-4o', // paste a fine-tuned model id (ft:...) here after you fine-tune
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

function getSettings(store) {
  return { ...DEFAULTS, ...(store.db.settings || {}) };
}
module.exports = { DEFAULTS, getSettings };
