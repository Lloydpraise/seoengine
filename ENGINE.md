# SEO Engine

Start: `npm start`, then open http://127.0.0.1:3000  (your old pipeline still runs with `npm run legacy`).
Tests: `npm test`

## How a product moves through
1. **Add** it: photo (Google Lens names it), by name, from your live Supabase products, or from a CSV.
2. **Research** (automatic): Google Kenya searches (price/buy/specs queries, related searches, People Also Ask) and 1 Kenyan + 1 international competitor page, unless you supplied links.
3. **Facts**: specs are extracted from the competitor pages with confidence ratings. Conflicts and wrong-variant warnings are flagged.
4. **Write**: the AI gets the facts, YOUR product notes, shop/category knowledge, Kenya keywords, and the reference style, with a rule to use only those facts.
5. **Check** (automatic): title/meta length, keyword placement, length vs the style, numbers not in your facts, wording copied from competitors, similarity to your other pages. One automatic rewrite if checks fail.
6. **Review** (you): the Review screen is four columns side by side: the product list, the editor, a live preview (product photo on top), and the sources and checks (each card collapsible; the list and sources columns collapse to a thin rail). Edit, rewrite with a note, approve, or approve and publish. The big **Approve all** button at the top approves everything waiting for review in one click (failed checks included, nothing is published), so you can let the engine run, approve in bulk, then come back through the Approved tab and fix what needs it.
7. **Publish**: only then does anything touch your live `products` table.

Existing products (imported from Supabase) are updated in place: only description, meta_title, meta_description, alt_text and categories change. Name, slug, price, image stay.
New products are inserted (same columns your old pipeline used).

## Photo first: bad data is the cause of bad SEO
Two things are the sources of truth: **the product photo** and **the name the admin typed on /admin**. Before every run the engine re-reads both from your live site, so a rename or a new photo is never missed.
1. **Look first** (during research): the AI looks at your photo next to each competitor page's main image. A competitor page whose picture shows a different product is never used for facts (structure only), however well its name matched. If the admin name and the photo disagree, that is flagged instead of guessed.
2. **Write with eyes open**: the writer gets the photo and a description of what is visible, plus a rule that photo + name outrank every other fact. If the writing model cannot take images it falls back to text and the review says so.
3. **Rate itself**: the writer rates every section, the specs, the dimensions/capacity/power and the FAQs (confident / fairly sure / not sure) with a note on what it doubts, and lists questions only you can answer.
4. **Not trusted on its own word**: in code, every number in the copy is checked against the facts, your notes and the name. An unsupported dimension is forced to "not sure" even if the AI said it was confident, and a part the AI forgot to rate shows as "not rated".
5. **QA AI goes last**: a separate AI sees only the photo, the admin name and the finished copy and lists anything the photo contradicts (burner or door counts, finish, type) or cannot confirm. A contradiction triggers one rewrite, then it checks again. It does not judge dimensions (a photo cannot show them), which is why step 4 exists.
6. **Review**: the first card in Sources & checks is **AI notes & confidence**, worst items first, each with a "checked" tick for you. Under it is **Photo check** (with a re-check button for after you edit). Small pills beside Intro, each section, Specifications and FAQs show the same ratings in the editor. The review list shows "N for you to check" and "photo mismatch".
Settings: `visionModel`, `qaModel`, `writerSeesPhoto`. The notes are stored beside the copy, never inside it, so they are never published. Fine-tune exports include the AI notes so a tuned model keeps writing them.

## Choosing competitor pages (not just "whoever ranks first")
- **Sources per product** (Settings, 1-4, default 3).
- **Preferred sites** (Settings): tried first, in your order. One extra Google search per site per product.
- **Competitors page**: read a whole competitor site (category page or sitemap). Products are then matched to its pages locally, free, with no search needed.
- Matching is **attribute-aware**: sizes and counts (20L, 4 burner, 6kW, 900mm) must agree. A page for a different size is never used for facts; if auto-picked it is kept for page structure only and flagged.
- Put the size/model in the product name so matching can see it.

## Getting to the right competitor page (cheapest first)
1. **Sitemap index** (Competitors > Add a competitor site > Quick index). Type just the domain: the engine finds the sitemap (robots.txt, then common paths), lists every product link in seconds, and matches your product from the URL (`deep-fryer-20l`). Only the matching page is opened.
2. **Site search** (Settings > preferred sites). For preferred sites you have not indexed, the engine uses the site's own search box (WooCommerce, Shopify, Magento, OpenCart patterns) and remembers which pattern worked. Free.
3. **Google** (Serper) only for anything still missing.
4. **Headless browser** (optional, Settings): for sites whose content only appears with JavaScript. Install once: `npm i playwright` then `npx playwright install chromium`. Not tested here, so try it on one product first.
Use **Competitors > Try it on one product** to see what each source would return before running a batch.
Style learning needs page content, so use "Read the pages now" for a site you want a style from.

## Competitors already checked (WordPress + WooCommerce shops)
shinekitchenware.co.ke, beefabricators.co.ke and dkkitchenappliances.com all use `/product/<name>/` pages and WooCommerce search, which the engine supports. Shine publishes a Yoast sitemap index (`/sitemap_index.xml`) with a separate product sitemap. The category and tag sitemaps are skipped automatically.
Competitors > Quick fill > Add this site > Try it on one product.

## Styles included
- **Default Kenya product page**
- **Long-form buying guide page** (1000-1600 words)
- **Kenya long-tail product page (Shine-style)**: what, benefits, applications, spec table, why buy, 8-10 FAQs, closing CTA, "[product] Kenya" tag phrases (secondary keywords; map them to a tags column in Settings > extra columns as `tags`). Improved where Shine is weak: exact specs only, no vague ranges, varied wording.

## Long pages
Reference styles > **Long-form buying guide page** (1000-1600 words, 7+ sections, 5+ FAQs). Set it as default or per product. If a draft comes back short, the engine expands it once. Length only comes from real material (your notes, facts, knowledge). Without those it would be padding, and the checks flag padding.

## Reference styles
Reference styles > paste 1-5 pages whose SEO you want matched. It learns structure, title/meta patterns, depth, tone and FAQ style. Edit anything it learned. Pick a style per product or set a default.

## CSV format
Any headers containing these words work: product / name, filename, link (any column with link, url, competitor or source), knowledge / notes, category, sub_category, style.
Rows are matched by file name or product name (fuzzy, "20 L" = "20L"). You confirm before anything is applied.

## Fine-tuning
Export > .jsonl is OpenAI chat fine-tune format: system + exact input + the version YOU approved. Approve 30-50 carefully edited products, fine-tune, paste the `ft:` model id in Settings > Writing model.

## Files
- `engine-server.js` API + server (listens on 127.0.0.1 only)
- `lib/` pipeline (engine, extract, qa, kenya, profiles, csvmatch, net, ai, store)
- `ui/` the interface
- `data/store.json` all engine data (back this up). `data/cache/` fetched pages.
