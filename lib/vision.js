// Everything that involves the product PHOTO: loading it, the "look at it first" step,
// the last-step photo QA, and the confidence notes the owner reviews.
// The two sources of truth are the photo and the product name the admin typed. Everything else
// (competitor facts, research) must agree with them or be dropped / flagged.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { numbersIn } = require('./qa');

const UA = 'Mozilla/5.0 (compatible; KitchenAll-SEO-Research/1.0)';
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

// ---------- loading images (data URLs, so the AI never depends on hotlink rules) ----------
async function loadImage(src) {
  try {
    if (src.file) {
      if (!fs.existsSync(src.file)) return null;
      const buf = fs.readFileSync(src.file);
      if (buf.length > 8e6) return null;
      return `data:${MIME[path.extname(src.file).toLowerCase()] || 'image/jpeg'};base64,${buf.toString('base64')}`;
    }
    if (!/^https?:\/\//i.test(src.url || '')) return null;
    const res = await fetch(src.url, { headers: { 'User-Agent': UA, Accept: 'image/*' }, timeout: 15000, size: 8e6, redirect: 'follow' });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    return `data:${type};base64,${(await res.buffer()).toString('base64')}`;
  } catch { return null; }
}

// The shop's own photo: local file first, then the stored URL. If we cannot download it, hand the public URL to the AI instead.
async function productImage(p, imagesDir) {
  if (p.localImage) { const d = await module.exports.loadImage({ file: path.join(imagesDir, p.localImage) }); if (d) return d; }
  if (p.imageUrl) { const d = await module.exports.loadImage({ url: p.imageUrl }); return d || (/^https?:/i.test(p.imageUrl) ? p.imageUrl : null); }
  return null;
}

// ---------- JSON helpers ----------
const LEVELS = ['high', 'medium', 'low'];
const lvl = (v, dflt = '') => { const x = String(v || '').toLowerCase().trim(); return LEVELS.includes(x) ? x : dflt; };
const str = (v) => String(v == null ? '' : v).trim();
const arr = (v) => (Array.isArray(v) ? v : []);

// ---------- 1. look at the product BEFORE writing ----------
const LOOK_SYSTEM = `You are a careful visual inspector for a commercial kitchen equipment store. You describe only what you can actually SEE in the images. You never guess dimensions, capacity, power, weight or any other number that cannot be read off the photo. If something is not visible, say so. JSON only.`;

function lookPrompt({ name, sources }) {
  return `ADMIN PRODUCT NAME (written by the shop owner, a source of truth): ${name}

IMAGE 1 is the shop's own photo of the product (a source of truth).
${sources.length ? sources.map((s, i) => `IMAGE ${i + 2} is the main image of competitor page ${s.index} (${s.host}).`).join('\n') : 'There are no competitor images.'}

Do three things:
1. Describe IMAGE 1: product type, what is clearly visible (count burners, doors, drawers, shelves, trays, wheels, controls, glass, finish, colour, gas vs electric only if visible), and which usual spec facts CANNOT be determined from a photo.
2. Does the admin name agree with IMAGE 1? Say "matches", "partly", "conflicts" or "unclear" and why (for example the name says 4 burners but the photo shows 6).
3. For each competitor image, is it the SAME product, a SIMILAR one (same type, different size/model), or a DIFFERENT product from IMAGE 1?

Return {"seen":{"product_type":"","visible_features":[""],"finish_colour":"","not_visible":[""]},"name_check":{"verdict":"matches|partly|conflicts|unclear","reason":""},"sources":[{"index":1,"verdict":"same|similar|different|unclear","reason":""}]}`;
}

function normLook(raw, validIdx = []) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const seen = r.seen && typeof r.seen === 'object' ? r.seen : {};
  const nc = r.name_check && typeof r.name_check === 'object' ? r.name_check : {};
  const verdict = ['matches', 'partly', 'conflicts', 'unclear'].includes(str(nc.verdict).toLowerCase()) ? str(nc.verdict).toLowerCase() : 'unclear';
  return {
    at: Date.now(),
    seen: { product_type: str(seen.product_type), visible_features: arr(seen.visible_features).map(str).filter(Boolean).slice(0, 20), finish_colour: str(seen.finish_colour), not_visible: arr(seen.not_visible).map(str).filter(Boolean).slice(0, 12) },
    name_check: { verdict, reason: str(nc.reason) },
    sources: arr(r.sources).map((s) => ({ index: +s.index, verdict: ['same', 'similar', 'different', 'unclear'].includes(str(s.verdict).toLowerCase()) ? str(s.verdict).toLowerCase() : 'unclear', reason: str(s.reason) })).filter((s) => validIdx.includes(s.index)),
  };
}

// One short block the writer reads. The photo and the admin name outrank every other fact.
function lookText(look) {
  if (!look || !look.seen) return '';
  const s = look.seen;
  return [
    s.product_type ? `Product type in the photo: ${s.product_type}` : '',
    s.visible_features.length ? `Clearly visible: ${s.visible_features.join('; ')}` : '',
    s.finish_colour ? `Finish / colour: ${s.finish_colour}` : '',
    s.not_visible.length ? `NOT determinable from the photo (only state if FACTS or NOTES give it): ${s.not_visible.join('; ')}` : '',
    look.name_check && look.name_check.verdict !== 'matches' && look.name_check.verdict !== 'unclear' ? `NAME vs PHOTO: ${look.name_check.verdict}. ${look.name_check.reason}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- 2. QA AI: last step, checks the finished copy against the photo ----------
const QA_SYSTEM = `You are a strict quality inspector for a commercial kitchen equipment store. Your job is to catch copy that describes a different product from the one in the photo. Assume the copy may be wrong until the photo supports it. The two sources of truth are the PHOTO and the ADMIN NAME. Check visible things: product type, number of burners / doors / drawers / shelves / trays / wheels, glass or solid doors, material and finish, colour, gas vs electric if visible, countertop vs floor-standing, with or without a cabinet or stand. Do NOT judge dimensions, capacity, power, weight or other numbers that a photo cannot show; those are checked elsewhere. Be specific and brief. JSON only.`;

const copyText = (d) => [
  `SEO title: ${d.seo_title}`, `Meta description: ${d.meta_description}`, `H1: ${d.h1}`, `Intro: ${d.short_description}`,
  ...(d.sections || []).map((s, i) => `Section ${i + 1} "${s.heading}": ${s.body}`),
  `Specs: ${(d.specs || []).map((s) => `${s.label}: ${s.value}`).join(' | ')}`,
  ...(d.faqs || []).map((f, i) => `FAQ ${i + 1}: ${f.q} ${f.a}`),
  `Image alt text: ${d.alt_text}`,
].join('\n');

function qaPrompt({ name, draft }) {
  return `ADMIN PRODUCT NAME (source of truth): ${name}
The attached image is the shop's own photo of this product (source of truth).

COPY TO CHECK
${copyText(draft)}

Check:
1. Does the photo match the product the copy describes? ("yes", "partly", "no" or "cannot_tell")
2. Does the admin name agree with the photo? Flag a conflict between the two instead of picking a side.
3. List every statement in the copy about something VISIBLE that the photo contradicts. "where" must say which part (e.g. "section 2", "specs", "title", "intro", "faq 3", "alt text").
4. List statements about something VISIBLE that the photo cannot confirm (not dimensions or numbers).

Return {"image_matches_copy":"yes|partly|no|cannot_tell","name_vs_image":{"verdict":"matches|conflicts|unclear","reason":""},"contradictions":[{"where":"","claim":"","image_shows":"","severity":"high|medium"}],"unconfirmed":[{"where":"","claim":"","why":""}],"summary":"one sentence"}`;
}

function normQA(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = str(r.image_matches_copy).toLowerCase();
  const nv = r.name_vs_image && typeof r.name_vs_image === 'object' ? r.name_vs_image : {};
  return {
    at: Date.now(), checked: true,
    image_matches_copy: ['yes', 'partly', 'no', 'cannot_tell'].includes(m) ? m : 'cannot_tell',
    name_vs_image: { verdict: ['matches', 'conflicts', 'unclear'].includes(str(nv.verdict).toLowerCase()) ? str(nv.verdict).toLowerCase() : 'unclear', reason: str(nv.reason) },
    contradictions: arr(r.contradictions).map((c) => ({ where: str(c.where), claim: str(c.claim), image_shows: str(c.image_shows), severity: str(c.severity).toLowerCase() === 'medium' ? 'medium' : 'high' })).filter((c) => c.claim),
    unconfirmed: arr(r.unconfirmed).map((c) => ({ where: str(c.where), claim: str(c.claim), why: str(c.why) })).filter((c) => c.claim),
    summary: str(r.summary),
  };
}

// QA result -> issue list shown in the Sources column
function visionIssues(vq) {
  if (!vq) return [];
  if (!vq.checked) return [{ level: 'warn', code: 'photo_unchecked', msg: vq.reason || 'Not checked against the photo' }];
  const out = [];
  if (vq.image_matches_copy === 'no') out.push({ level: 'error', code: 'photo_mismatch', msg: 'The photo does not look like the product this copy describes' });
  else if (vq.image_matches_copy === 'cannot_tell') out.push({ level: 'warn', code: 'photo_unclear', msg: 'The photo is too unclear to confirm the copy. Check it yourself' });
  if (vq.name_vs_image.verdict === 'conflicts') out.push({ level: 'error', code: 'name_photo_conflict', msg: `The product name and the photo disagree: ${vq.name_vs_image.reason}` });
  for (const c of vq.contradictions) out.push({ level: c.severity === 'medium' ? 'warn' : 'error', code: 'photo_contradiction', msg: `${c.where || 'Copy'}: says "${c.claim}" but the photo shows ${c.image_shows || 'something different'}`, where: c.where });
  for (const c of vq.unconfirmed) out.push({ level: 'warn', code: 'photo_unconfirmed', msg: `${c.where || 'Copy'}: "${c.claim}" cannot be confirmed from the photo${c.why ? ` (${c.why})` : ''}`, where: c.where });
  return out;
}

// ---------- 3. confidence notes the owner reviews ----------
// The writer rates its own sections, but the owner should not have to trust that alone:
// every number is also checked against the facts in code, and the photo QA can lower a rating.
const ORDER = ['low', 'unrated', 'medium', 'high']; // unrated (the AI skipped it) is treated as worse than medium
const RANK = Object.fromEntries(ORDER.map((k, i) => [k, i]));
const worst = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const DIM_LABEL = /\b(dimension|dimensions|size|capacity|volume|weight|power|wattage|voltage|current|height|width|depth|length|diameter|thickness|gauge|output|rating|input|consumption)\b/i;
const NUM_UNIT = /\d\s?(mm|cm|m|kg|g|l|ltr|litres?|liters?|kw|w|v|hz|°c)\b/i;
const isCritical = (s) => DIM_LABEL.test(s.label || '') || NUM_UNIT.test(s.value || '');

function normAiReview(r) {
  const x = r && typeof r === 'object' ? r : {};
  return {
    overall: lvl(x.overall),
    items: arr(x.items).map((i) => ({ key: str(i.key), confidence: lvl(i.confidence, 'low'), note: str(i.note) })).filter((i) => i.key),
    owner_questions: arr(x.owner_questions).map(str).filter(Boolean).slice(0, 6),
  };
}

// Numbers in `text` that appear nowhere in `allowedText`
// strict = for spec rows, where even a two-digit number matters; prose only counts units, decimals and 3+ digit numbers (same rule as the text QA)
function ungrounded(text, allowedText, strict = false) {
  const allowed = new Set(numbersIn(allowedText || '').map((n) => n.num));
  return [...new Set(numbersIn(text).filter((n) => !allowed.has(n.num) && (n.unit || n.num.includes('.') || n.num.length >= (strict ? 2 : 3))).map((n) => n.num + (n.unit ? ' ' + n.unit : '')))];
}

function resolveKey(key, draft) {
  const k = String(key || '').trim();
  const low = k.toLowerCase();
  if (/^dimension/.test(low)) return 'dimensions';
  if (/^(spec|specification)/.test(low)) return 'specs';
  if (/^faq/.test(low)) return 'faqs';
  if (/^(title|meta|h1|seo)/.test(low)) return 'title';
  if (/^(intro|short)/.test(low)) return 'short_description';
  if (/^alt/.test(low)) return 'alt_text';
  if (/^(photo|image)/.test(low)) return 'photo';
  const m = low.match(/^section\s*[:#-]?\s*(.*)$/);
  if (m) {
    const rest = m[1].trim();
    const secs = draft.sections || [];
    if (/^\d+$/.test(rest) && secs[+rest]) return `section:${+rest}`;
    const i = secs.findIndex((s) => s.heading.trim().toLowerCase() === rest || (rest && s.heading.toLowerCase().includes(rest)));
    if (i >= 0) return `section:${i}`;
  }
  return null;
}

function whereKey(where, draft) {
  const w = String(where || '').toLowerCase();
  const m = w.match(/section\s*(\d+)/);
  if (m && (draft.sections || [])[+m[1] - 1]) return `section:${+m[1] - 1}`;
  if (/spec|dimension/.test(w)) return 'specs';
  if (/faq/.test(w)) return 'faqs';
  if (/intro|short/.test(w)) return 'short_description';
  if (/title|h1|meta/.test(w)) return 'title';
  if (/alt/.test(w)) return 'alt_text';
  return null;
}

/**
 * ai: normAiReview output (or null). draft: the current final copy. allowedText: name + facts + notes + knowledge + photo description.
 * vq: normQA output (or null). checked: { key: true } items the owner has ticked off.
 */
function mergeReview({ ai, draft, allowedText = '', vq = null, checked = {} }) {
  const A = ai || normAiReview(null);
  const items = new Map();
  const order = [];
  const label = (key) => {
    if (key === 'title') return 'SEO title, meta description & H1';
    if (key === 'short_description') return 'Intro';
    if (key === 'specs') return 'Specifications';
    if (key === 'dimensions') return 'Dimensions, capacity & power';
    if (key === 'faqs') return 'FAQs';
    if (key === 'alt_text') return 'Image alt text';
    if (key === 'photo') return 'Photo check';
    const i = +key.split(':')[1];
    return `Section: ${((draft.sections || [])[i] || {}).heading || i + 1}`;
  };
  const touch = (key) => {
    if (!items.has(key)) { items.set(key, { key, title: label(key), confidence: 'unrated', notes: [], checked: !!checked[key], rated: false }); order.push(key); }
    return items.get(key);
  };
  const rate = (key, confidence, from, text) => {
    const it = touch(key);
    it.confidence = it.rated ? worst(it.confidence, confidence) : confidence;
    it.rated = true;
    if (text) it.notes.push({ from, text });
  };
  const lower = rate; // a code check or the photo QA can only ever lower a rating, never raise it

  // every part the owner should look at gets a row, in page order
  touch('short_description');
  (draft.sections || []).forEach((_, i) => touch(`section:${i}`));
  touch('specs');
  const crit = (draft.specs || []).filter(isCritical);
  if (crit.length) touch('dimensions');
  touch('faqs');

  // 1. what the AI said about itself
  for (const r of A.items) {
    const key = resolveKey(r.key, draft);
    if (!key) continue;
    rate(key, r.confidence, 'ai', r.note);
  }
  // 2. checked in code: numbers in the copy that are in no fact, note, name or photo description
  for (const s of crit) {
    const bad = ungrounded(`${s.label} ${s.value}`, allowedText, true);
    if (bad.length) lower('dimensions', 'low', 'check', `${s.label}: ${s.value}. ${bad.join(', ')} is not in any source, note or the product name. It may be invented`);
  }
  for (const s of (draft.specs || []).filter((x) => !isCritical(x))) {
    const bad = ungrounded(`${s.label} ${s.value}`, allowedText, true);
    if (bad.length) lower('specs', 'low', 'check', `${s.label}: ${s.value}. ${bad.join(', ')} is not in any source or note`);
  }
  (draft.sections || []).forEach((s, i) => { const bad = ungrounded(s.body, allowedText); if (bad.length) lower(`section:${i}`, 'low', 'check', `Numbers not found in any source, note or the name: ${bad.slice(0, 6).join(', ')}`); });
  { const bad = ungrounded(draft.short_description, allowedText); if (bad.length) lower('short_description', 'low', 'check', `Numbers not found in any source, note or the name: ${bad.slice(0, 6).join(', ')}`); }
  (draft.faqs || []).forEach((f, i) => { const bad = ungrounded(`${f.q} ${f.a}`, allowedText); if (bad.length) lower('faqs', 'low', 'check', `FAQ ${i + 1}: numbers not found in any source, note or the name: ${bad.slice(0, 6).join(', ')}`); });
  // dimensions are the part that hurts most when wrong: an unrated dimensions row is never trusted
  if (items.has('dimensions') && !items.get('dimensions').rated) { const it = items.get('dimensions'); it.confidence = 'unrated'; it.notes.push({ from: 'check', text: 'The AI did not rate these. Check them against the product label or supplier sheet' }); }

  // 3. photo QA
  if (vq) {
    const p = touch('photo');
    if (!vq.checked) rate('photo', 'low', 'photo', vq.reason || 'Not checked against the photo');
    else {
      const bad = vq.image_matches_copy === 'no' || vq.name_vs_image.verdict === 'conflicts';
      rate('photo', bad || vq.contradictions.some((c) => c.severity !== 'medium') ? 'low' : vq.contradictions.length || vq.unconfirmed.length || vq.image_matches_copy !== 'yes' ? 'medium' : 'high', 'photo', vq.summary);
      for (const iss of visionIssues(vq).filter((x) => x.code !== 'photo_unchecked')) {
        const k = whereKey(iss.where, draft);
        if (k) lower(k, iss.level === 'error' ? 'low' : 'medium', 'photo', iss.msg);
        else p.notes.push({ from: 'photo', text: iss.msg });
      }
    }
  }

  const list = order.map((k) => items.get(k)).map(({ rated, ...r }) => r);
  list.sort((a, b) => RANK[a.confidence] - RANK[b.confidence]);
  let overall = 'high';
  for (const it of list) overall = worst(overall, it.confidence);
  if (A.overall) overall = worst(overall, A.overall);
  return {
    overall, items: list, owner_questions: A.owner_questions,
    needsYou: list.filter((i) => i.confidence !== 'high' && !i.checked).length,
    low: list.filter((i) => i.confidence === 'low' && !i.checked).length,
  };
}

module.exports = { loadImage, productImage, LOOK_SYSTEM, lookPrompt, normLook, lookText, QA_SYSTEM, qaPrompt, normQA, visionIssues, normAiReview, mergeReview, ungrounded, isCritical, copyText };
