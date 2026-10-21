const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { createClient } = require('@supabase/supabase-js');
const net = require('./net');
const ai = require('./ai');
const qa = require('./qa');
const vision = require('./vision');
const kenya = require('./kenya');
const match = require('./match');
const sitesearch = require('./sitesearch');
const { tokens } = require('./csvmatch');
const { getSettings } = require('./settings');
const { DEFAULT_PROFILE } = require('./profiles');

const ROOT = path.join(__dirname, '..');
const IMAGES = path.join(ROOT, 'images');
const BUCKET = 'product-images';

const slugify = (t) => String(t).toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paras = (s) => String(s || '').split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean);

function createEngine(store, deps = {}) {
  const bus = new EventEmitter();
  const S = () => getSettings(store);
  const products = () => Object.values(store.db.products);
  let sb;
  const supabase = () => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing in .env');
    return sb || (sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
  };

  // ---------- the admin's name and photo are the sources of truth ----------
  // Imported products keep a copy of the name/photo. The admin may fix either on /admin afterwards, so re-read them from the live
  // site before every run. A changed name drops the auto-picked competitor pages (they were matched to the old name); a changed photo drops the photo comparison.
  const readSiteRow = deps.readSiteRow || (async (id) => {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
    const { data, error } = await supabase().from('products').select('name,image_url').eq('id', id).maybeSingle();
    return error ? null : data;
  });
  async function syncFromSite(p) {
    if (!p.supabaseId) return;
    let row;
    try { row = await readSiteRow(p.supabaseId); } catch { return; }
    if (!row) return;
    const patch = {}, name = String(row.name || '').trim(), img = String(row.image_url || '');
    if (name && name !== p.name) {
      Object.assign(patch, { name, visual: null, sourceLinks: p.sourceLinks.filter((l) => !l.auto) });
      if (p.research) p.research.stale = true;
    }
    if (img !== (p.imageUrl || '')) Object.assign(patch, { imageUrl: img, visual: null });
    if (Object.keys(patch).length) { if (patch.imageUrl !== undefined && p.research) p.research.stale = true; touch(p, patch); }
  }

  // ---------- products ----------
  function newProduct(f = {}) {
    const p = {
      id: store.id('p'), name: '', localImage: '', imageUrl: '', supabaseId: null, slug: '',
      major_category: '', sub_category: '', sourceLinks: [], unique: '', profileId: '',
      status: 'new', stage: '', error: '', research: null, facts: null, draft: null, final: null,
      qa: null, snapshot: null, created: Date.now(), updated: Date.now(), ...f,
    };
    store.db.products[p.id] = p;
    store.save();
    bus.emit('product', summary(p));
    return p;
  }
  function summary(p) {
    return {
      id: p.id, name: p.name, status: p.status, stage: p.stage, error: p.error,
      major_category: p.major_category, sub_category: p.sub_category,
      image: p.imageUrl || (p.localImage ? '/images/' + encodeURIComponent(p.localImage) : ''),
      sources: p.sourceLinks.length, hasNotes: !!p.unique, profileId: p.profileId,
      qaPass: p.qa ? p.qa.pass : null, qaErrors: p.qa ? p.qa.issues.filter((i) => i.level === 'error').length : 0,
      confidence: p.review ? p.review.overall : null, needsYou: p.review ? p.review.needsYou : 0,
      photoFlags: p.vqa && p.vqa.checked ? vision.visionIssues(p.vqa).filter((i) => i.level === 'error').length : 0,
      onSite: !!p.supabaseId, localImage: p.localImage, updated: p.updated,
    };
  }
  function touch(p, patch = {}) {
    Object.assign(p, patch, { updated: Date.now() });
    store.save();
    bus.emit('product', summary(p));
  }
  const step = (p, stage) => touch(p, { stage });

  // ---------- 1. identify (photo -> name), same Lens approach as before, categories from your real lists ----------
  async function uploadImage(file) {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const name = `pipeline/${Date.now()}-${path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabase().storage.from(BUCKET).upload(name, buf, { contentType: type, upsert: false });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return supabase().storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
  }

  async function identify(p, s) {
    if (p.name) return;
    if (!p.localImage) throw new Error('Product has no name and no photo');
    step(p, 'Uploading photo');
    if (!p.imageUrl) p.imageUrl = await uploadImage(path.join(IMAGES, p.localImage));
    step(p, 'Identifying with Google Lens');
    const matches = await net.serperLens(p.imageUrl);
    if (!matches.length) throw new Error('Google Lens found no matches. Type the product name in the product panel, then queue it again.');
    const id = await ai.jsonCall({
      model: s.extractModel, label: 'identify', productId: p.id,
      system: 'You identify commercial kitchen products from reverse-image-search titles. JSON only.',
      user: `Titles of visually similar products:\n${matches.map((m) => '- ' + m.title).join('\n')}

Determine:
1. product_name: the most likely specific product name/type (e.g. "Commercial Deep Fryer 20L"), generic, no retailer names
2. major_category: EXACTLY ONE of ${JSON.stringify(s.majorCategories)} or ""
3. sub_category: EXACTLY ONE of ${JSON.stringify(s.subCategories)} or "" if nothing fits
Return {"product_name":"","major_category":"","sub_category":""}`,
    });
    touch(p, {
      name: String(id.product_name || '').trim(),
      major_category: s.majorCategories.includes(id.major_category) ? id.major_category : p.major_category,
      sub_category: s.subCategories.includes(id.sub_category) ? id.sub_category : p.sub_category,
      lensTitles: matches.map((m) => m.title),
    });
    if (!p.name) throw new Error('Could not work out the product name from the photo. Type it in manually.');
  }

  // ---------- competitor catalogues (sites you have read) ----------
  const catalogues = () => Object.values(store.db.catalogue || {}).filter((c) => c.status === 'ready');
  const hostRank = (host, pref) => { const i = (pref || []).findIndex((h) => host === h || host.endsWith('.' + h)); return i < 0 ? 999 : i; };
  const hostMatches = (h, pref) => h === pref || h.endsWith('.' + pref);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  // Sitemap-indexed catalogues hold thousands of bare URLs: a token index narrows them to a few dozen before scoring.
  const idx = new Map();
  function indexFor(c) {
    const n = c.urls.length;
    let x = idx.get(c.id);
    if (x && x.n === n) return x;
    x = { n, inv: new Map() };
    c.urls.forEach((u, i) => { for (const t of tokens(match.slugOf(u))) { if (!x.inv.has(t)) x.inv.set(t, []); x.inv.get(t).push(i); } });
    idx.set(c.id, x);
    return x;
  }
  function urlPool(c, name, n = 40) {
    if (!c.urls || !c.urls.length) return [];
    const x = indexFor(c), counts = new Map();
    for (const t of tokens(name)) for (const i of x.inv.get(t) || []) counts.set(i, (counts.get(i) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([i]) => ({ url: c.urls[i], title: '', h1: '', specs: [], metaDescription: '' }));
  }
  function catalogueCandidates(p, s, { n = 1, weak = false } = {}) {
    const out = [];
    for (const c of catalogues()) {
      const pool = [...(c.pages || []), ...urlPool(c, p.name)];
      const scored = pool.map((pg) => ({ ...match.score(p.name, pg), url: pg.url, title: pg.h1 || pg.title || match.slugTitle(pg.url), host: c.host, site: c.name }))
        .sort((a, b) => b.score - a.score).slice(0, n);
      for (const x of scored) if (weak ? x.score >= 0.35 && x.tok >= 0.34 : x.score >= s.minFit && !x.conflicts.length) out.push(x);
    }
    return out.sort((a, b) => hostRank(a.host, s.preferredSites) - hostRank(b.host, s.preferredSites) || b.score - a.score);
  }
  // Preferred sites with no catalogue: use their own search box
  async function siteSearchCandidates(name, s, haveUrls, { all = false } = {}) {
    const out = [];
    const covered = catalogues().map((c) => c.host);
    for (const h of s.preferredSites || []) {
      if (!all && covered.some((c) => hostMatches(c, h) || hostMatches(h, c))) continue;
      try {
        const known = (store.db.searchTemplates || {})[h];
        const r = await sitesearch.search(h, name, { known });
        if (r.template && r.template !== known) { (store.db.searchTemplates = store.db.searchTemplates || {})[h] = r.template; store.save(); }
        if (all) out.push({ host: h, template: r.template, results: r.results });
        else { const best = r.results.find((x) => !x.conflicts.length && x.score >= 0.5 && !haveUrls.includes(x.url)); if (best) out.push({ ...best, host: h }); }
      } catch { /* a site that blocks us just yields nothing */ }
    }
    return out;
  }
  // "Try it": what would each source give for this product name?
  async function trySources(name) {
    const s = S();
    return {
      catalogue: catalogueCandidates({ name }, s, { n: 3, weak: true }).map((c) => ({ ...c, conflictText: match.conflictText(c.conflicts) })),
      search: s.siteSearch ? (await siteSearchCandidates(name, s, [], { all: true })).map((x) => ({ ...x, results: x.results.map((r) => ({ ...r, conflictText: match.conflictText(r.conflicts) })) })) : [],
    };
  }
  function suggestMatches({ onlyMissing = true } = {}) {
    const s = S(), limit = Math.min(4, Math.max(1, +s.sourcesPerProduct || 3));
    const out = [];
    for (const p of products()) {
      if (!p.name || p.status === 'published' || (onlyMissing && p.sourceLinks.length >= limit)) continue;
      const cands = catalogueCandidates(p, s, { n: 2, weak: true }).filter((c) => !p.sourceLinks.some((l) => l.url === c.url)).slice(0, 4);
      out.push({ id: p.id, name: p.name, have: p.sourceLinks.length, candidates: cands.map((c) => ({ ...c, conflictText: match.conflictText(c.conflicts), strong: c.score >= s.minFit && !c.conflicts.length })) });
    }
    return out;
  }
  function applyMatches(assignments) {
    let n = 0;
    for (const a of assignments) {
      const p = store.db.products[a.id];
      if (!p) continue;
      const add = a.urls.filter((u) => /^https?:\/\//i.test(u) && !p.sourceLinks.some((l) => l.url === u));
      if (!add.length) continue;
      if (p.research) p.research.stale = true;
      touch(p, { sourceLinks: [...p.sourceLinks, ...add.map((url) => ({ url, auto: 'catalogue' }))] });
      n++;
    }
    return n;
  }

  // ---------- 2. research: Kenya search data + competitor pages ----------
  async function research(p, s) {
    if (p.research && !p.research.stale) return;
    step(p, 'Kenya search research');
    const limit = Math.min(4, Math.max(1, +s.sourcesPerProduct || 3));
    const have = () => p.sourceLinks.map((l) => l.url);
    // 1. pages from competitor sites you have already read (free, and checked for size/spec fit)
    for (const c of catalogueCandidates(p, s)) {
      if (p.sourceLinks.length >= limit) break;
      if (!have().includes(c.url)) p.sourceLinks.push({ url: c.url, auto: 'catalogue', title: c.title });
    }
    // 1b. look the product up with the preferred competitor sites' own search box (free)
    if (p.sourceLinks.length < limit && s.siteSearch && (s.preferredSites || []).length) {
      step(p, 'Searching competitor sites');
      for (const c of await siteSearchCandidates(p.name, s, have())) {
        if (p.sourceLinks.length >= limit) break;
        p.sourceLinks.push({ url: c.url, auto: 'site-search', title: c.text });
      }
    }
    // 2. Kenya search data, plus Google results for anything still missing
    const needMore = p.sourceLinks.length < limit && s.autoFindSources;
    const unmet = (s.preferredSites || []).filter((h) => !p.sourceLinks.some((l) => hostMatches(hostOf(l.url), h)));
    const kw = await kenya.harvest(p.name, { preferredHosts: needMore ? unmet : [] });
    const warnings = [...kw.errors];
    if (kw.errors.length >= kw.attempted && !p.sourceLinks.length) throw new Error(kw.errors[0]);
    if (needMore) {
      step(p, 'Choosing best-matching competitor pages');
      for (const c of kenya.pickSources(kw.organic, s.siteUrl, have(), { name: p.name, limit: limit - p.sourceLinks.length, preferredHosts: s.preferredSites, preferred: kw.preferred })) {
        p.sourceLinks.push({ url: c.link, auto: true, title: c.title });
      }
    }
    step(p, 'Reading competitor pages');
    const entries = [];
    for (const l of p.sourceLinks) {
      try {
        const page = await net.fetchPage(l.url);
        const fit = match.score(p.name, page);
        // auto-picked pages describing a different size/model are kept for structure only, never for facts
        const structureOnly = !!fit.conflicts.length && !!l.auto;
        if (fit.conflicts.length) warnings.push(`${page.host} looks like a different size/model (${match.conflictText(fit.conflicts)})${structureOnly ? ', so it is used for page structure only, not for facts.' : '. You added this link yourself, so its specs are still used. Check them.'}`);
        entries.push({ page, fit, structureOnly, auto: !!l.auto });
      } catch (e) { warnings.push(`${l.url}: ${e.message}`); }
    }
    entries.filter((e) => e.page.thin).forEach((e) => warnings.push(`${e.page.host} looks like a JavaScript or blocked page (very little text read). Try a different link.`));
    // Look at the shop's photo first, next to each competitor's main image. A competitor whose picture shows a different product
    // is never used for facts, however well its name matched.
    let look = null;
    try {
      const photo = await vision.productImage(p, IMAGES);
      if (photo) {
        step(p, 'Comparing photos');
        look = await lookAtPhoto(p, s, photo, entries);
        for (const v of look.sources) {
          const e = entries[v.index - 1];
          if (!e) continue;
          e.photo = v.verdict;
          if (v.verdict === 'different') {
            if (e.auto && !e.structureOnly) e.structureOnly = true;
            warnings.push(`${e.page.host}: its main photo shows a different product from yours (${v.reason || 'no reason given'})${e.structureOnly ? ', so it is used for page structure only, not for facts.' : '. You added this link yourself, so its specs are still used. Check them.'}`);
          } else if (v.verdict === 'similar') warnings.push(`${e.page.host}: its photo looks similar but not identical to yours (${v.reason || 'different size or model'}). Check its specs.`);
        }
        if (look.name_check.verdict === 'conflicts') warnings.push(`The product name and your photo disagree: ${look.name_check.reason}`);
      } else warnings.push('No product photo found, so the copy cannot be checked against a picture.');
    } catch (e) { warnings.push(`Could not compare photos: ${e.message}`); }

    const factPages = entries.filter((e) => !e.structureOnly).map((e) => e.page);
    if (!factPages.length && !p.unique) throw new Error(`No usable competitor pages and no product notes. ${warnings.join(' | ')}`);

    let facts = { facts: [], use_cases: [], conflicts: [], variant_warning: '' };
    if (factPages.length) {
      step(p, 'Extracting verified facts');
      const material = factPages.map((pg, i) => `SOURCE ${i + 1} (${pg.host})
Title: ${pg.title}
Spec table:
${pg.specs.slice(0, 40).map((x) => `${x.label}: ${x.value}`).join('\n') || '(none)'}
Feature bullets:
${pg.bullets.slice(0, 25).join('\n') || '(none)'}
Text:
${pg.text.slice(0, 3500)}`).join('\n\n---\n\n');
      facts = await ai.jsonCall({
        model: s.extractModel, label: 'facts', productId: p.id,
        system: 'You extract product facts from competitor pages for a commercial kitchen equipment store. You report only what the sources literally state. JSON only.',
        user: `Our product: ${p.name}\n\n${material}

Return {"facts":[{"label":"","value":"","sources":[1],"confidence":"high|medium|low"}],"use_cases":[""],"conflicts":[{"label":"","values":[""]}],"variant_warning":""}
Rules: keep original units; no prices; no marketing claims or opinions; if sources disagree, put it under conflicts and not facts; confidence "low" if only one source states it and it looks model-specific; variant_warning = one sentence if the sources seem to describe a different size/model than "${p.name}", else "".`,
      });
      (facts.facts || []).forEach((f) => { f.hosts = (f.sources || []).map((n) => (factPages[n - 1] || {}).host).filter(Boolean); });
    }

    touch(p, {
      research: {
        stale: false, at: Date.now(), warnings, keywords: { related: kw.related, questions: kw.questions, titles: kw.organic.slice(0, 8).map((o) => o.title) },
        sources: entries.map(({ page: x, fit, structureOnly, photo }) => ({ url: x.url, host: x.host, title: x.title, h1: x.h1, image: x.image || '', photo: photo || '', headings: x.headings.slice(0, 25), words: x.wordCount, faqs: x.faqCount, specs: x.specs.length, thin: x.thin, fit: fit.score, structureOnly })),
      },
      facts, visual: look || p.visual || null,
    });
  }

  // photo + admin name vs competitor main images (one call)
  async function lookAtPhoto(p, s, photo, entries = []) {
    const imgs = [{ url: photo, detail: s.photoDetail || 'low' }], sent = [];
    for (let i = 0; i < entries.length; i++) {
      const url = entries[i].page.image;
      if (!url) continue;
      const d = await vision.loadImage({ url });
      if (d) { imgs.push({ url: d, detail: 'low' }); sent.push({ index: i + 1, host: entries[i].page.host }); }
    }
    const raw = await ai.jsonCall({ model: s.visionModel || s.writerModel, label: 'look', productId: p.id, system: vision.LOOK_SYSTEM, user: vision.lookPrompt({ name: p.name, sources: sent }), images: imgs });
    return vision.normLook(raw, sent.map((x) => x.index));
  }

  // ---------- 3. write ----------
  const profileOf = (p) => store.db.profiles[p.profileId || S().defaultProfileId] || store.db.profiles.default || DEFAULT_PROFILE;
  const knowledgeOf = (p) => {
    const k = store.db.knowledge;
    return [['Shop-wide', k._global], [p.major_category, k[p.major_category]], [p.sub_category, k[p.sub_category]]]
      .filter(([, t]) => t && t.trim()).map(([n, t]) => `[${n}]\n${t.trim()}`).join('\n\n');
  };
  const factsText = (p) => (p.facts && p.facts.facts || []).map((f) => `- ${f.label}: ${f.value} [${(f.hosts || []).join(', ') || 'source'}; ${f.confidence}]`).join('\n');

  // Prompt order matters for caching: OpenAI only reuses an identical PREFIX. So everything shared between products (rules, Kenya rules,
  // JSON shape, the style profile, length targets, category knowledge) goes first in the system message, and everything that changes per
  // product (name, photo description, search data, facts, notes) goes last in the user message, with owner feedback at the very end.
  function buildPrompt(p, feedback = '') {
    const s = S(), prof = profileOf(p), a = prof.analysis || {}, t = prof.targets;
    const r = (p.research && p.research.keywords) || {};
    const system = `You are a senior e-commerce SEO copywriter and equipment-buying advisor for ${s.siteName}. ${s.siteContext}

HARD RULES
1. Use ONLY facts found in FACTS, PRODUCT NOTES or SHOP KNOWLEDGE. Never invent specs, numbers, models, certifications, warranty terms, delivery times or prices. If something is not known, leave it out.
2. PRODUCT NOTES come from the shop owner's own expertise. Treat them as the most trustworthy content and weave them in prominently. They are what makes this page different from competitors.
3. Competitor material tells you what topics to cover and how deep to go. Never reuse their sentences. Write in fresh, original wording.
4. Follow the STYLE PROFILE exactly for structure, tone, and length.
5. Write for a buyer first, search engine second. No keyword stuffing, no filler.
6. The PHOTO (attached when available) and the ADMIN NAME are the two sources of truth. If any fact, note or competitor detail conflicts with what the photo shows or what the name says, leave it out and say so in "review". Write about the product the photo actually shows. Never write as if you cannot see it.
7. Rate your own work honestly in "review". Give every section, the specs, the dimensions/capacity/power and the FAQs a confidence of high, medium or low, and a note saying exactly what you are unsure of and why. Dimensions, capacity, power and weight are "high" only when FACTS (from pages whose photo matches ours) or PRODUCT NOTES state them. Anything you inferred is never "high". Do not hide doubt: the owner reviews every low and medium item by hand.

${kenya.KENYA_RULES}

Return JSON only, exactly this shape:
{"primary_keyword":"","secondary_keywords":["3-5 long-tail phrases a Kenyan buyer would type, e.g. commercial electric double fryer Kenya"],"seo_title":"max 60 chars","meta_description":"110-155 chars","h1":"","short_description":"2-3 sentence intro containing the primary keyword","sections":[{"heading":"","body":"paragraphs separated by blank lines"}],"specs":[{"label":"","value":""}],"faqs":[{"q":"","a":""}],"alt_text":"","review":{"overall":"high|medium|low","items":[{"key":"short_description | section:<exact section heading> | specs | dimensions | faqs","confidence":"high|medium|low","note":"what you are unsure of; empty only if sure"}],"owner_questions":["things only the owner can confirm"]}}

STYLE PROFILE: ${prof.name}
Title pattern: ${a.title_pattern || ''}
Meta pattern: ${a.meta_pattern || ''}
H1 pattern: ${a.h1_pattern || ''}
Tone: ${a.tone || ''}
Section order: ${(a.structure || []).join(' > ')}
Paragraph style: ${a.paragraph_style || ''}
Specs: ${a.spec_presentation || ''}
FAQ style: ${a.faq_style || ''}
Keyword placement: ${a.keyword_placement || ''}
Do: ${(a.do || []).join('; ')}
Don't: ${(a.dont || []).join('; ')}
${prof.rules ? 'Extra rules from the owner: ' + prof.rules : ''}
Length: ${t.wordsMin}-${t.wordsMax} words across short_description and sections; at least ${t.sectionsMin} sections; at least ${t.faqMin} FAQs.${t.wordsMax >= 900 ? '\nLONG-FORM: all of that length must be useful content, never padding or repetition. Build depth from real material: who it suits and use cases, buying checklist (power, capacity, space), installation and power needs, care and maintenance, common mistakes, what to compare it with, and delivery and support in Kenya, but only where FACTS, PRODUCT NOTES or SHOP KNOWLEDGE support it.' : ''}

SHOP KNOWLEDGE
${knowledgeOf(p) || '(none provided)'}`;

    const user = `PRODUCT: ${p.name}
PHOTO AND NAME (sources of truth: nothing below may contradict them)
Admin name: ${p.name}
${vision.lookText(p.visual) || (p.imageUrl || p.localImage ? 'A photo of the product is attached.' : 'No photo is available: be extra careful and rate unsure parts low.')}
Category: ${[p.major_category, p.sub_category].filter(Boolean).join(' / ') || 'unknown'}

KENYA SEARCH DATA (choose the primary keyword from real search phrasing)
Related searches: ${(r.related || []).join('; ') || 'none'}
People also ask: ${(r.questions || []).join('; ') || 'none'}
Competing page titles in Kenya: ${(r.titles || []).join(' | ') || 'none'}

FACTS (from competitor pages, with source and confidence)
${factsText(p) || '(none found)'}
${p.facts && p.facts.use_cases && p.facts.use_cases.length ? 'Common use cases: ' + p.facts.use_cases.join('; ') : ''}
${p.facts && p.facts.variant_warning ? 'WARNING: ' + p.facts.variant_warning + ' Treat low-confidence facts carefully and do not state them as certain.' : ''}

PRODUCT NOTES (owner's own expertise — highest priority)
${p.unique && p.unique.trim() ? p.unique.trim() : '(none provided)'}

COMPETITOR STRUCTURE (topics and depth only, do not copy)
${((p.research && p.research.sources) || []).map((x) => `${x.host}${x.structureOnly ? ' (different size: structure only)' : ''}: ${x.words} words, ${x.faqs} FAQs, headings: ${x.headings.filter((h) => h.level <= 3).map((h) => h.text).join(' | ')}`).join('\n') || '(none)'}

${feedback ? `\n\nOWNER FEEDBACK ON THE LAST VERSION (apply it): ${feedback}` : ''}`;
    const cacheKey = `seo:${p.profileId || s.defaultProfileId || 'default'}:${p.major_category || 'x'}`;
    return { system, user, cacheKey };
  }

  const normDraft = (d) => ({
    primary_keyword: String(d.primary_keyword || '').trim(),
    secondary_keywords: [].concat(d.secondary_keywords || []).map(String),
    seo_title: String(d.seo_title || '').trim(), meta_description: String(d.meta_description || '').trim(),
    h1: String(d.h1 || '').trim(), short_description: String(d.short_description || '').trim(),
    sections: [].concat(d.sections || []).map((x) => ({ heading: String(x.heading || ''), body: String(x.body || '') })),
    specs: [].concat(d.specs || []).map((x) => ({ label: String(x.label || ''), value: String(x.value || '') })),
    faqs: [].concat(d.faqs || []).map((x) => ({ q: String(x.q || ''), a: String(x.a || '') })),
    alt_text: String(d.alt_text || '').trim(),
  });

  async function runQA(p, draft) {
    const sources = [];
    for (const l of p.sourceLinks) {
      try { const pg = await net.fetchPage(l.url, { allowStale: true }); sources.push({ host: pg.host, text: pg.text }); } catch {}
    }
    const others = products()
      .filter((o) => o.id !== p.id && (o.final || o.draft) && o.major_category === p.major_category)
      .slice(0, 400).map((o) => ({ name: o.name, text: qa.bodyText(o.final || o.draft) }));
    return qa.check(draft, {
      primary: draft.primary_keyword, targets: profileOf(p).targets,
      allowedText: [p.name, factsText(p), p.unique, knowledgeOf(p)].join('\n'),
      sourceTexts: sources, otherBodies: others,
    });
  }

  const allowedFor = (p) => [p.name, factsText(p), p.unique, knowledgeOf(p), vision.lookText(p.visual)].join('\n');
  const remerge = (p, fin) => vision.mergeReview({ ai: p.aiReview, draft: fin, allowedText: allowedFor(p), vq: p.vqa, checked: p.reviewChecked || {} });

  // The QA AI: separate prompt, runs last, looks only at the photo, the admin name and the finished copy.
  async function visualQA(p, s, draft, photo) {
    if (!photo) return { checked: false, reason: 'No product photo to check against. The copy was not checked visually.', at: Date.now() };
    try {
      const raw = await ai.jsonCall({ model: s.qaModel || s.visionModel || s.writerModel, label: 'qa-photo', productId: p.id, system: vision.QA_SYSTEM, user: vision.qaPrompt({ name: p.name, draft }), images: [{ url: photo, detail: s.qaDetail || 'low' }] });
      return vision.normQA(raw);
    } catch (e) { return { checked: false, reason: `Photo check failed: ${e.message}`, at: Date.now() }; }
  }
  const visErrors = (vq) => vision.visionIssues(vq).filter((i) => i.level === 'error');

  async function write(p, s, feedback = '') {
    const photo = await vision.productImage(p, IMAGES);
    if (photo && !p.visual) { // products researched before photo checks existed
      step(p, 'Looking at the photo');
      try { p.visual = await lookAtPhoto(p, s, photo, []); } catch { /* the writer still gets the photo itself */ }
    }
    step(p, 'Writing');
    const base = buildPrompt(p, '');
    const prompt = feedback ? buildPrompt(p, feedback) : base;
    const tgt = profileOf(p).targets;
    let sawPhoto = !!photo && s.writerSeesPhoto !== false;
    // The photo goes with the first draft and with the photo-mismatch rewrite only. The length and quality retries edit an existing draft
    // against text rules, so they are sent text-only (the QA AI still checks the result against the photo afterwards).
    const callWriter = async (args, { photo: withPhoto = false, label = 'write' } = {}) => {
      const meta = { cacheKey: prompt.cacheKey, label, productId: p.id };
      if (withPhoto && sawPhoto) {
        try { return await ai.jsonCall({ model: s.writerModel, ...args, ...meta, images: [{ url: photo, detail: s.photoDetail || 'low' }] }); }
        catch { sawPhoto = false; } // this writing model cannot take images: carry on without, and say so
      }
      return ai.jsonCall({ model: s.writerModel, ...args, ...meta });
    };
    let raw = await callWriter({ system: prompt.system, user: prompt.user }, { photo: true, label: 'write' });
    let draft = normDraft(raw);
    const wc0 = qa.countWords(draft);
    if (tgt.wordsMin && wc0 < tgt.wordsMin * 0.85) {
      step(p, `Expanding (${wc0} of ${tgt.wordsMin} words)`);
      const have = new Set(draft.sections.map((x) => x.heading.toLowerCase()));
      const topics = [...new Set(((p.research && p.research.sources) || []).flatMap((x) => x.headings.filter((h) => h.level >= 2 && h.level <= 3).map((h) => h.text)))].filter((h) => !have.has(h.toLowerCase())).slice(0, 15);
      raw = await callWriter({
        system: prompt.system,
        user: `${prompt.user}\n\nYOUR DRAFT IS TOO SHORT (${wc0} words; this style needs ${tgt.wordsMin}-${tgt.wordsMax}). Expand it into a fuller, more useful page: deepen sections and add the sections a buyer would want (use cases, buying checklist, installation and power needs, care and maintenance, comparisons, common mistakes). Topics competitors cover that you may address if the facts support them: ${topics.join(' | ') || 'none'}. Use ONLY the facts, notes and knowledge above. No padding, no repetition. Same JSON shape, including "review".\n\nDRAFT:\n${JSON.stringify(draft)}`,
      }, { label: 'write-expand' });
      draft = normDraft(raw);
    }
    step(p, 'Checking quality');
    let result = await runQA(p, draft);
    const errs = result.issues.filter((i) => i.level === 'error');
    if (errs.length) {
      step(p, 'Fixing quality issues');
      const fixedRaw = await callWriter({
        system: prompt.system,
        user: `${prompt.user}\n\nYOUR PREVIOUS DRAFT FAILED THESE CHECKS:\n${errs.map((e) => '- ' + e.msg).join('\n')}\n\nPREVIOUS DRAFT:\n${JSON.stringify(draft)}\n\nRewrite it to fix every issue. Remove any number that is not in FACTS, PRODUCT NOTES or SHOP KNOWLEDGE. Use fresh wording. Same JSON shape, including "review".`,
      }, { label: 'write-fix' });
      const fixed = normDraft(fixedRaw);
      const r2 = await runQA(p, fixed);
      if (r2.issues.filter((i) => i.level === 'error').length <= errs.length) { draft = fixed; result = r2; raw = fixedRaw; }
    }

    // last step: the QA AI compares the finished copy with the photo
    step(p, 'Checking against the photo');
    let vq = await visualQA(p, s, draft, photo);
    const vErrs = vq.checked ? visErrors(vq) : [];
    if (vErrs.length) {
      step(p, 'Fixing photo mismatches');
      try {
        const fixedRaw = await callWriter({
          system: prompt.system,
          user: `${prompt.user}\n\nA PHOTO CHECK FOUND THESE PROBLEMS IN YOUR DRAFT:\n${vErrs.map((e) => '- ' + e.msg).join('\n')}\n\nPREVIOUS DRAFT:\n${JSON.stringify(draft)}\n\nRewrite it so nothing contradicts the photo or the admin name. Remove any claim you cannot support. If the name and the photo disagree, follow the photo and say so in "review". Same JSON shape, including "review".`,
        }, { photo: true, label: 'write-photofix' });
        const fixed = normDraft(fixedRaw);
        const vq2 = await visualQA(p, s, fixed, photo);
        if (vq2.checked && visErrors(vq2).length <= vErrs.length) { draft = fixed; vq = vq2; raw = fixedRaw; result = await runQA(p, draft); }
      } catch { /* keep the first draft; its photo flags stay visible to the owner */ }
    }

    const aiReview = vision.normAiReview(raw && raw.review);
    const fin = JSON.parse(JSON.stringify(draft));
    const patch = { draft, final: fin, qa: result, vqa: vq, aiReview, reviewChecked: {}, wrote: { sawPhoto, hadPhoto: !!photo }, snapshot: base, status: 'review', stage: 'Ready for review', error: '' };
    p.vqa = vq; p.aiReview = aiReview; p.reviewChecked = {};
    patch.review = remerge(p, fin);
    touch(p, patch);
  }

  async function processProduct(id, opts = {}) {
    const p = store.db.products[id];
    if (!p) return;
    const s = S();
    try {
      touch(p, { status: 'working', error: '' });
      await syncFromSite(p);
      await identify(p, s);
      await research(p, s);
      await write(p, s, opts.feedback || '');
    } catch (e) {
      touch(p, { status: 'error', error: e.message, stage: 'Failed' });
    }
  }

  // ---------- token usage ----------
  // Every AI call reports its tokens (see lib/ai.js). Totals are kept per step and per product so the Settings page can show
  // what a batch really cost and how often the prompt cache was hit (cached / input).
  const blankUsage = () => ({ calls: 0, prompt: 0, cached: 0, completion: 0 });
  const addTo = (t, u) => { t.calls = (t.calls || 0) + 1; t.prompt = (t.prompt || 0) + u.prompt; t.cached = (t.cached || 0) + u.cached; t.completion = (t.completion || 0) + u.completion; };
  ai.onUsage((u) => {
    const db = store.db, t = db.usage || (db.usage = { since: Date.now(), ...blankUsage(), byLabel: {} });
    addTo(t, u);
    addTo(t.byLabel[u.label] || (t.byLabel[u.label] = blankUsage()), u);
    const p = u.productId && db.products[u.productId];
    if (p) addTo(p.usage || (p.usage = blankUsage()), u);
    store.save();
  });
  const usage = () => store.db.usage || { since: Date.now(), ...blankUsage(), byLabel: {} };
  const resetUsage = () => { store.db.usage = { since: Date.now(), ...blankUsage(), byLabel: {} }; products().forEach((p) => { delete p.usage; }); store.save(); };

  // ---------- queue ----------
  const queue = [];
  let active = false, running = 0, lastKey = '';
  const qstats = () => ({ active, running, waiting: queue.length });
  // Products with the same style profile and category share the long start of the writing prompt. Running them back to back
  // keeps that prefix in OpenAI's cache (it expires after a few minutes idle), so prefer the next waiting product that matches the last one.
  const cacheGroup = (id) => { const q = store.db.products[id]; return q ? `${q.profileId || S().defaultProfileId}|${q.major_category || ''}` : ''; };
  function nextId() {
    const i = lastKey ? queue.findIndex((id) => cacheGroup(id) === lastKey) : -1;
    const [id] = queue.splice(i < 0 ? 0 : i, 1);
    lastKey = cacheGroup(id);
    return id;
  }
  function pump() {
    while (active && running < Math.max(1, S().concurrency) && queue.length) {
      const id = nextId();
      running++;
      processProduct(id).finally(() => { running--; pump(); bus.emit('queue', qstats()); });
    }
    bus.emit('queue', qstats());
  }
  function enqueue(ids) {
    let n = 0;
    for (const id of ids) {
      const p = store.db.products[id];
      if (!p || ['working', 'queued', 'published'].includes(p.status) || queue.includes(id)) continue;
      touch(p, { status: 'queued', stage: 'Waiting in queue', error: '' });
      queue.push(id); n++;
    }
    return n;
  }
  // Redo published (or approved) items: run them through the whole pipeline again (fresh name + photo, photo comparison, photo QA).
  // The live site is NOT touched: the new copy lands in review and only goes live when you publish it.
  function redo(ids) {
    let n = 0;
    for (const id of ids) {
      const p = store.db.products[id];
      if (!p || !['published', 'approved'].includes(p.status) || queue.includes(id)) continue;
      if (p.research) p.research.stale = true;
      touch(p, { status: 'queued', stage: 'Waiting in queue (redo)', error: '', redo: true });
      queue.push(id); n++;
    }
    return n;
  }
  const redoable = (statuses = ['published']) => products().filter((p) => statuses.includes(p.status)).map((p) => p.id);
  const start = () => { active = true; pump(); };
  const pause = () => { active = false; bus.emit('queue', qstats()); };
  products().forEach((p) => { // recover after a restart
    if (p.status === 'working' || p.status === 'queued') { p.status = 'queued'; queue.push(p.id); }
  });

  // ---------- review actions ----------
  function setFinal(p, fin) {
    return runQA(p, fin).then((result) => touch(p, { final: fin, qa: result, review: remerge(p, fin) }));
  }
  // One click: everything waiting in review is approved as it stands (failed checks included).
  // Nothing is published. Approved items can still be edited afterwards.
  function approveAll() {
    let approved = 0, skipped = 0;
    for (const p of products()) {
      if (p.status !== 'review') continue;
      if (!p.final) { skipped++; continue; }
      touch(p, { status: 'approved', stage: 'Approved' });
      approved++;
    }
    return { approved, skipped };
  }
  // Re-run the photo QA on the copy as it stands now (after the owner has edited it)
  async function photoCheck(id) {
    const p = store.db.products[id];
    if (!p || !p.final) throw new Error('Nothing to check yet');
    const photo = await vision.productImage(p, IMAGES);
    const vq = await visualQA(p, S(), p.final, photo);
    p.vqa = vq;
    touch(p, { vqa: vq, review: remerge(p, p.final) });
    return { vqa: vq, review: p.review };
  }
  // The owner ticks a row in the AI notes as checked
  function setReviewChecked(id, key, checked) {
    const p = store.db.products[id];
    if (!p || !p.final) throw new Error('Nothing to review yet');
    p.reviewChecked = { ...(p.reviewChecked || {}), [key]: !!checked };
    touch(p, { reviewChecked: p.reviewChecked, review: remerge(p, p.final) });
    return p.review;
  }
  async function regenerate(id, { feedback = '', refresh = false } = {}) {
    const p = store.db.products[id];
    if (refresh && p.research) p.research.stale = true;
    touch(p, { status: 'working', error: '' });
    try { await syncFromSite(p); await research(p, S()); await write(p, S(), feedback); } catch (e) { touch(p, { status: 'error', error: e.message }); }
  }

  // ---------- publish (only place that touches your live products table) ----------
  function buildDescription(f, format) {
    const html = format === 'html';
    const out = [];
    const P = (t) => paras(t).map((x) => (html ? `<p>${esc(x)}</p>` : x)).join(html ? '\n' : '\n\n');
    if (f.short_description) out.push(P(f.short_description));
    for (const s of f.sections || []) out.push((html ? `<h2>${esc(s.heading)}</h2>\n` : `${s.heading}\n`) + P(s.body));
    if ((f.specs || []).length) {
      out.push(html
        ? `<h2>Specifications</h2>\n<table><tbody>${f.specs.map((x) => `<tr><th scope="row">${esc(x.label)}</th><td>${esc(x.value)}</td></tr>`).join('')}</tbody></table>`
        : 'Specifications\n' + f.specs.map((x) => `${x.label}: ${x.value}`).join('\n'));
    }
    if ((f.faqs || []).length) {
      out.push(html
        ? '<h2>Frequently asked questions</h2>\n' + f.faqs.map((x) => `<h3>${esc(x.q)}</h3>\n<p>${esc(x.a)}</p>`).join('\n')
        : 'Frequently asked questions\n\n' + f.faqs.map((x) => `${x.q}\n${x.a}`).join('\n\n'));
    }
    return out.join(html ? '\n' : '\n\n');
  }
  function jsonLd(p, f, url) {
    const ld = [{ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: f.meta_description, image: p.imageUrl || undefined, url }];
    if ((f.faqs || []).length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: f.faqs.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
    return JSON.stringify(ld);
  }

  async function getUniqueSlug(base, existingId = null) {
    let slug = base, n = 2;
    for (;;) {
      const { data, error } = await supabase().from('products').select('id').eq('slug', slug).maybeSingle();
      if (error) throw new Error(`Slug check failed: ${error.message}`);
      if (!data || data.id === existingId) return slug;
      slug = `${base}-${n++}`;
    }
  }

  async function publish(id) {
    const p = store.db.products[id];
    const f = p && p.final;
    if (!f) throw new Error('Nothing to publish yet');
    const s = S();
    step(p, 'Publishing');
    const fields = {
      description: buildDescription(f, s.descriptionFormat), meta_title: f.seo_title,
      meta_description: f.meta_description, alt_text: f.alt_text,
    };
    if (p.major_category) fields.major_category = p.major_category;
    if (p.sub_category) fields.sub_category = p.sub_category;
    const extraFor = (url) => {
      const vals = { h1: f.h1, short_description: f.short_description, faqs_json: JSON.stringify(f.faqs), specs_json: JSON.stringify(f.specs), jsonld: jsonLd(p, f, url), primary_keyword: f.primary_keyword, tags: (f.secondary_keywords || []).join(', '), secondary_keywords: JSON.stringify(f.secondary_keywords || []) };
      const extra = {};
      for (const [col, key] of Object.entries(s.extraColumns || {})) if (key in vals) extra[col] = vals[key];
      return extra;
    };
    let url;
    if (p.supabaseId) {
      const slug = await getUniqueSlug(slugify(p.name), p.supabaseId);
      url = `${s.siteUrl}/product/${slug}`;
      const { error } = await supabase().from('products')
        .update({ name: p.name, slug, canonical_url: url, ...fields, ...extraFor(url) })
        .eq('id', p.supabaseId);
      if (error) throw new Error(`Supabase update failed: ${error.message}`);
      p.slug = slug;
    } else {
      const slug = await getUniqueSlug(slugify(p.name));
      url = `${s.siteUrl}/product/${slug}`;
      const { data, error } = await supabase().from('products')
        .insert({ name: p.name, slug, image_url: p.imageUrl || null, canonical_url: url, stock_quantity: 10, ...fields, ...extraFor(url) })
        .select('id, slug').single();
      if (error) throw new Error(`Supabase insert failed: ${error.message}`);
      p.supabaseId = data.id; p.slug = data.slug;
    }
    touch(p, { status: 'published', stage: 'Published', publishedAt: Date.now(), publishedUrl: url, error: '' });
    return url;
  }

  async function importFromSupabase() {
    const have = new Set(products().map((p) => p.supabaseId).filter(Boolean));
    let from = 0, added = 0;
    for (;;) {
      const { data, error } = await supabase().from('products').select('*').range(from, from + 999);
      if (error) throw new Error(`Could not read products: ${error.message}`);
      for (const r of data) {
        if (have.has(r.id)) continue;
        newProduct({ name: r.name || '', supabaseId: r.id, slug: r.slug || '', imageUrl: r.image_url || '', major_category: r.major_category || '', sub_category: r.sub_category || '', current: { description: r.description || '', meta_title: r.meta_title || '', meta_description: r.meta_description || '' } });
        added++;
      }
      if (data.length < 1000) break;
      from += 1000;
    }
    return added;
  }

  // ---------- fine-tune / export ----------
  function exportRows(statuses) {
    return products().filter((p) => statuses.includes(p.status) && p.final && p.snapshot).map((p) => ({
      product: p.name, category: [p.major_category, p.sub_category].filter(Boolean).join(' / '),
      profile: profileOf(p).name, source_links: p.sourceLinks.map((l) => l.url).join(' | '), notes: p.unique || '',
      system: p.snapshot.system, input: p.snapshot.user, output: JSON.stringify(p.aiReview ? { ...p.final, review: p.aiReview } : p.final),
      ...p.final, specs_json: JSON.stringify(p.final.specs), faqs_json: JSON.stringify(p.final.faqs), sections_json: JSON.stringify(p.final.sections),
    }));
  }
  const toJsonl = (rows) => rows.map((r) => JSON.stringify({ messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.input }, { role: 'assistant', content: r.output }] })).join('\n');

  return {
    bus, store, S, newProduct, summary, touch, products, enqueue, redo, redoable, start, pause, qstats, processProduct, usage, resetUsage,
    regenerate, approveAll, setFinal, runQA, photoCheck, setReviewChecked, remerge, publish, catalogueCandidates, suggestMatches, applyMatches, trySources, importFromSupabase, buildDescription, buildPrompt, exportRows, toJsonl, profileOf, slugify, IMAGES,
  };
}
module.exports = { createEngine, slugify };
