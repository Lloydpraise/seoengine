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
  // How much the AI looks at pictures.
  //  'once' (default, cheapest): your photo goes to the AI exactly ONE time, in the look step. It writes a structured description (type, counts of
  //         burners/doors/shelves, finish) that the writer then reads as text. No competitor photos, no photo in the writing call, no automatic photo QA
  //         (the \"Re-check against photo\" button in the review still runs it on demand).
  //  'full' (old behaviour, about 6 images per product): look compares your photo with each competitor's main image, the writer sees the photo, and the
  //         QA AI re-checks the finished copy against it (plus a rewrite if it finds a contradiction).
  imageMode: 'once',
  // 'separate' (default): a photo-look call, then a facts call. 'merged': ONE research call returns the photo description, a same/similar/different
  // verdict for each competitor page (judged from its text) and the facts, so it also replaces the competitor-photo comparison. One call fewer; test it on the same 10 products first.
  researchMode: 'separate',
  writerSeesPhoto: true, // 'full' mode only: attach the photo to the FIRST writing call (retries are text-only)
  photoDetail: 'low', // image detail for your photo in the look (and, in 'full' mode, writing) calls: 'low' (cheapest) | 'auto' | 'high'
  qaDetail: 'low', // image detail for the photo QA check (on-demand button, or automatic in 'full' mode). 'high' if it misses burner or door counts
  expandBelow: 0.75, // a draft shorter than this share of the profile's minimum word count gets ONE append-only expansion (adds sections, never rewrites)
  maxSpendUsd: 0, // stop the queue when the estimated OpenAI spend since the counters were reset reaches this (0 = no limit)
  // USD per 1M tokens, used only for the estimates on the Token usage card and the spend limit. Check platform.openai.com/pricing and edit if they change.
  prices: {
    'gpt-4.1-mini': { in: 0.40, cached: 0.10, out: 1.60 },
    'gpt-4.1-nano': { in: 0.10, cached: 0.025, out: 0.40 },
    'gpt-4.1': { in: 2.00, cached: 0.50, out: 8.00 },
    'gpt-4o': { in: 2.50, cached: 1.25, out: 10.00 },
    'gpt-4o-mini': { in: 0.15, cached: 0.075, out: 0.60 },
  },
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
const IMAGE_MODES = new Set(['once', 'full']);
const RESEARCH_MODES = new Set(['separate', 'merged']);

function getSettings(store) {
  const saved = { ...(store.db.settings || {}) };
  for (const k of MODEL_KEYS) if (OLD_DEFAULT_MODELS.has(saved[k])) delete saved[k];
  for (const k of ['photoDetail', 'qaDetail']) if (k in saved && !DETAILS.has(saved[k])) delete saved[k];
  if ('researchMode' in saved && !RESEARCH_MODES.has(saved.researchMode)) delete saved.researchMode;
  if ('imageMode' in saved && !IMAGE_MODES.has(saved.imageMode)) delete saved.imageMode;
  if ('maxSpendUsd' in saved && !(+saved.maxSpendUsd >= 0)) delete saved.maxSpendUsd;
  if ('expandBelow' in saved && !(+saved.expandBelow > 0 && +saved.expandBelow <= 1)) delete saved.expandBelow;
  return { ...DEFAULTS, ...saved, prices: { ...DEFAULTS.prices, ...(saved.prices || {}) } };
}
module.exports = { DEFAULTS, getSettings };
