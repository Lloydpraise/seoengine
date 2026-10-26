/* SEO Engine UI — plain JS, no build step. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (p, b) => api(p, { method: 'POST', body: b || {} });
let toastT;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), bad ? 6000 : 2600);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

const STATUS = ['new', 'queued', 'working', 'review', 'approved', 'published', 'error'];
const LABEL = { new: 'New', queued: 'Queued', working: 'Working', review: 'To review', approved: 'Approved', published: 'Published', error: 'Needs attention' };
const badge = (s) => `<span class="badge b-${s}">${LABEL[s] || s}</span>`;

/* review-screen layout memory: which side panels are collapsed, which source cards are open */
const loadPanes = () => { try { return JSON.parse(localStorage.getItem('seoengine.panes')) || {}; } catch (e) { return {}; } };
const savePanes = () => { try { localStorage.setItem('seoengine.panes', JSON.stringify(S.panes)); } catch (e) { /* storage unavailable: layout just won't persist */ } };

const S = { products: [], profiles: [], knowledge: {}, settings: {}, keys: {}, queue: {}, view: 'queue', filter: 'all', q: '', sel: new Set(), drawer: null, rv: null, rvTab: 'review', csv: null, panes: loadPanes() };

async function load() {
  Object.assign(S, await api('/state'));
  render();
}

/* ---------- nav ---------- */
const NAV = [['queue', 'Queue'], ['add', 'Add products'], ['competitors', 'Competitors'], ['review', 'Review'], ['styles', 'Reference styles'], ['knowledge', 'Knowledge'], ['csv', 'Import sheet'], ['export', 'Export'], ['settings', 'Settings']];
function renderNav() {
  const n = { queue: S.products.length, review: S.products.filter((p) => p.status === 'review').length };
  const miss = Object.entries(S.keys).filter(([, v]) => !v).map(([k]) => k);
  $('#nav').innerHTML = `<div class="brand">SEO Engine<small>Kenya product pages</small></div>` +
    NAV.map(([id, l]) => `<button data-act="go" data-v="${id}" ${S.view === id ? 'aria-current="page"' : ''}>${l}${n[id] ? `<span class="count">${n[id]}</span>` : ''}</button>`).join('') +
    `<div class="spacer"></div><a href="/productprices.html">Configure prices</a>` +
    (miss.length ? `<div class="keys">Missing in .env: <b>${miss.join(', ')}</b></div>` : '');
}
function render() { main.className = S.view === 'review' ? 'wide' : ''; renderNav(); ({ queue: viewQueue, add: viewAdd, competitors: viewCompetitors, review: viewReview, styles: viewStyles, knowledge: viewKnowledge, csv: viewCsv, export: viewExport, settings: viewSettings })[S.view](); }

/* ---------- live updates ---------- */
let tblT;
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'catalogue') { const i = S.catalogues.findIndex((c) => c.id === m.catalogue.id); if (i >= 0) S.catalogues[i] = m.catalogue; else S.catalogues.push(m.catalogue); if (S.view === 'competitors') paintCatalogues(); return; }
    if (m.type === 'queue') { S.queue = m.queue; if (S.view === 'queue') renderBar(); return; }
    const i = S.products.findIndex((p) => p.id === m.product.id);
    const was = i >= 0 ? S.products[i].status : null;
    if (i >= 0) S.products[i] = m.product; else S.products.unshift(m.product);
    renderNav();
    if (S.view === 'queue') { clearTimeout(tblT); tblT = setTimeout(() => { renderChips(); renderTable(); }, 120); }
    if (S.view === 'review') {
      renderReviewList();
      if (S.rv && S.rv.id === m.product.id && was !== m.product.status && m.product.status === 'review') openReview(S.rv.id);
      if (S.rv && S.rv.id === m.product.id && m.product.status === 'working') paintEditor();
    }
  };
}

/* ---------- queue ---------- */
const visible = () => S.products.filter((p) => (S.filter === 'all' || (S.filter === 'claude' ? p.origin === 'claude' && p.status === 'review' : p.status === S.filter)) && (!S.q || (p.name || p.localImage || '').toLowerCase().includes(S.q.toLowerCase())));
function viewQueue() {
  main.innerHTML = `<h1>Queue</h1>
  <p class="lede">Every product the AI will work on. Each one is researched against Kenyan search results and competitor pages, checked, and then waits for your review. Nothing reaches your live site until you approve it.</p>
  <div class="stats" id="chips"></div><div class="bar"><input type="text" id="search" placeholder="Search products" aria-label="Search products"><span class="row" id="qctl" style="flex:1"></span></div><div id="tbl"></div><div id="drawer"></div>`;
  const sb = $('#search'); sb.value = S.q; sb.oninput = () => { S.q = sb.value; renderTable(); };
  renderChips(); renderBar(); renderTable(); if (S.drawer) openDrawer(S.drawer);
}
function renderChips() {
  const el = $('#chips'); if (!el) return;
  const c = {}; S.products.forEach((p) => (c[p.status] = (c[p.status] || 0) + 1));
  const fromClaude = S.products.filter((p) => p.origin === 'claude' && p.status === 'review').length;
  el.innerHTML = [['all', 'All', S.products.length], ...STATUS.map((s) => [s, LABEL[s], c[s] || 0]), ...(fromClaude ? [['claude', 'Claude drafts to review', fromClaude]] : [])]
    .map(([k, l, n]) => `<button class="chip" data-act="filter" data-v="${k}" aria-pressed="${S.filter === k}">${l} ${n}</button>`).join('');
}
function renderBar() {
  const el = $('#qctl'); if (!el) return;
  const q = S.queue || {};
  el.innerHTML = `<button class="btn" data-act="queueSel" ${S.sel.size ? '' : 'disabled'}>Queue selected (${S.sel.size})</button>
  <button class="btn" data-act="queueNew">Queue all new</button>
  <button class="btn" data-act="redoPub" title="Runs published items through the photo-first pipeline again. Your live site is not changed until you publish the new copy.">Redo published items${S.sel.size ? ' (selected)' : ''}</button>
  <button class="btn danger" data-act="delSel" ${S.sel.size ? '' : 'disabled'}>Delete selected</button>
  <span style="flex:1"></span>
  <span class="muted small"><span class="pulse ${q.active ? '' : 'off'}"></span>${q.active ? 'AI is working' : 'AI is paused'} · ${q.running || 0} running, ${q.waiting || 0} waiting</span>
  ${q.active ? '<button class="btn" data-act="qpause">Pause</button>' : '<button class="btn primary" data-act="qstart">Start AI</button>'}`;
}
function renderTable() {
  const el = $('#tbl'); if (!el) return;
  const rows = visible();
  if (!S.products.length) { el.innerHTML = `<div class="empty">No products yet.<br><br><button class="btn primary" data-act="go" data-v="add">Add products</button></div>`; return; }
  if (!rows.length) { el.innerHTML = `<div class="empty">No products match this filter.</div>`; return; }
  el.innerHTML = `<table><thead><tr><th><input type="checkbox" data-act="selAll" aria-label="Select all"></th><th></th><th>Product</th><th>Category</th><th>Inputs</th><th>Status</th></tr></thead><tbody>` +
    rows.slice(0, 600).map((p) => `<tr class="click" data-act="open" data-id="${p.id}">
      <td><input type="checkbox" data-act="sel" data-id="${p.id}" ${S.sel.has(p.id) ? 'checked' : ''} aria-label="Select"></td>
      <td class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span></span>'}</td>
      <td><b>${esc(p.name || '(photo, not identified yet)')}</b>${p.onSite ? ' <span class="tag">on site</span>' : ''}</td>
      <td class="muted">${esc([p.major_category, p.sub_category].filter(Boolean).join(' / ')) || '—'}</td>
      <td class="small muted">${p.sources} link${p.sources === 1 ? '' : 's'}${p.hasNotes ? ' · notes' : ''}</td>
      <td>${badge(p.status)}${p.status === 'working' || p.status === 'queued' ? `<div class="stage">${p.status === 'working' ? '<span class="spin"></span>' : ''}${esc(p.stage)}</div>` : ''}${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}${p.status === 'review' && p.qaErrors ? `<div class="err">${p.qaErrors} check${p.qaErrors > 1 ? 's' : ''} failed</div>` : ''}</td></tr>`).join('') +
    `</tbody></table>${rows.length > 600 ? `<p class="muted small">Showing the first 600 of ${rows.length}. Use search or a status filter.</p>` : ''}`;
}

/* ---------- product drawer ---------- */
const catSelect = (id, list, val) => `<select id="${id}"><option value="">—</option>${list.map((c) => `<option ${c === val ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
const profSelect = (id, val) => `<select id="${id}"><option value="">Default (${esc((S.profiles.find((p) => p.id === S.settings.defaultProfileId) || {}).name || 'built-in')})</option>${S.profiles.map((p) => `<option value="${p.id}" ${p.id === val ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;

async function openDrawer(id) {
  S.drawer = id;
  const p = await api('/products/' + id);
  const el = $('#drawer'); if (!el) return;
  el.innerHTML = `<div class="drawer" role="dialog" aria-label="Product inputs">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Product inputs</h2><button class="btn" data-act="closeDrawer">Close</button></div>
    ${p.localImage || p.imageUrl ? `<img src="${esc(p.imageUrl || '/images/' + encodeURIComponent(p.localImage))}" alt="" style="max-height:150px;border-radius:6px;margin-top:10px">` : ''}
    <div class="row" style="margin-top:8px">${badge(p.status)} <span class="stage">${esc(p.stage)}</span></div>
    ${p.error ? `<p class="err">${esc(p.error)}</p>` : ''}
    <label for="d-name">Product name</label><input type="text" id="d-name" value="${esc(p.name)}" placeholder="Leave empty to identify from the photo">
    <div class="row" style="align-items:flex-start"><div style="flex:1"><label>Major category</label>${catSelect('d-major', S.settings.majorCategories, p.major_category)}</div><div style="flex:1"><label>Sub category</label>${catSelect('d-sub', S.settings.subCategories, p.sub_category)}</div></div>
    <label>Reference style</label>${profSelect('d-prof', p.profileId)}
    <label for="d-links">Competitor / source links (one per line)</label>
    <textarea id="d-links" placeholder="Leave empty and the AI will find one Kenyan and one international page itself">${esc(p.sourceLinks.map((l) => l.url).join('\n'))}</textarea>
    <div class="row"><button class="btn" data-act="findSrc" data-id="${id}">Find competitor links</button><span id="cands" class="small muted"></span></div>
    <div id="candlist"></div>
    <label for="d-unique">Your product knowledge (what makes this one different)</label>
    <textarea id="d-unique" style="min-height:130px" placeholder="Power needs, who it suits, build quality, installation, what you have seen customers get wrong…">${esc(p.unique)}</textarea>
    <div class="row" style="margin-top:14px"><button class="btn primary" data-act="saveDrawer" data-id="${id}" data-q="0">Save</button><button class="btn" data-act="saveDrawer" data-id="${id}" data-q="1">Save and queue</button>
    ${['review', 'approved', 'published'].includes(p.status) ? `<button class="btn" data-act="toReview" data-id="${id}">Open in review</button>` : ''}<span style="flex:1"></span><button class="btn danger" data-act="delOne" data-id="${id}">Delete</button></div></div>`;
}
const saveDrawer = guard(async (id, queue) => {
  await api('/products/' + id, { method: 'PATCH', body: { name: $('#d-name').value, major_category: $('#d-major').value, sub_category: $('#d-sub').value, profileId: $('#d-prof').value, links: $('#d-links').value.split('\n'), unique: $('#d-unique').value } });
  if (queue) { await post('/products/bulk', { ids: [id], action: 'queue' }); }
  toast(queue ? 'Saved and queued' : 'Saved'); S.drawer = null; $('#drawer').innerHTML = '';
});

/* ---------- add products ---------- */
function viewAdd() {
  main.innerHTML = `<h1>Add products</h1><p class="lede">Three ways in. Photos are identified with Google Lens, named products skip straight to research, and products already on your site can be pulled in to rewrite their SEO.</p>
  <div class="grid2">
  <div class="card"><h2>Product photos</h2><div class="drop" id="drop">Drop photos here, or <label style="display:inline;color:var(--blue);cursor:pointer;font-weight:600"><input type="file" id="files" accept="image/*" multiple hidden>choose files</label><div class="small" style="margin-top:6px">JPG, PNG or WEBP. Each photo becomes one product.</div></div>
    <div class="row" style="margin-top:12px"><button class="btn" data-act="scan">Add photos already in the images folder</button></div><p id="upmsg" class="small muted"></p></div>
  <div class="card"><h2>Add by name</h2>
    <label for="a-name">Product name</label><input type="text" id="a-name" placeholder="e.g. Commercial Deep Fryer 20L">
    <div class="row" style="align-items:flex-start"><div style="flex:1"><label>Major category</label>${catSelect('a-major', S.settings.majorCategories, '')}</div><div style="flex:1"><label>Sub category</label>${catSelect('a-sub', S.settings.subCategories, '')}</div></div>
    <label for="a-links">Competitor links (optional, one per line)</label><textarea id="a-links" style="min-height:60px"></textarea>
    <label for="a-unique">Your product knowledge (optional)</label><textarea id="a-unique"></textarea>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addOne" data-q="0">Add product</button><button class="btn" data-act="addOne" data-q="1">Add and queue</button></div></div>
  <div class="card"><h2>Products already on your site</h2><p class="muted">Reads your Supabase products table and brings each product in for an SEO rewrite. Publishing later updates only the SEO fields. Names, URLs and prices stay untouched.</p><button class="btn" data-act="importSite">Import from Supabase</button></div>
  <div class="card"><h2>Drafts written by Claude</h2><p class="muted">Loads the SEO drafts in the claude-drafts folder into To review, each with Claude's photo and competitor notes. Nothing is published until you approve and publish it.</p><button class="btn" data-act="importClaude">Import Claude drafts</button></div>
  </div>`;
  const drop = $('#drop'), fi = $('#files');
  fi.onchange = () => upload([...fi.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); };
}
const upload = guard(async (files) => {
  files = files.filter((f) => /^image\//.test(f.type)); let ok = 0, dup = 0;
  for (const [i, f] of files.entries()) {
    $('#upmsg').innerHTML = `<span class="spin"></span>Uploading ${i + 1} of ${files.length}`;
    const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    const j = await r.json(); if (!r.ok) throw new Error(j.error); j.duplicate ? dup++ : ok++;
  }
  $('#upmsg').innerHTML = `${ok} added${dup ? `, ${dup} already existed` : ''}. <button class="btn" data-act="queueNew">Queue all new</button>`;
});

/* ---------- review ---------- */
const reviewable = () => S.products.filter((p) => (S.rvTab === 'review' ? ['review', 'working'].includes(p.status) : ['approved', 'published'].includes(p.status)));
const toggleBtn = (k, label, glyph) => `<button class="paneToggle" data-act="togglePane" data-v="${k}" aria-expanded="${!S.panes[k]}" title="Show or hide ${esc(label.toLowerCase())}"><span class="chev" aria-hidden="true">${glyph}</span><span class="lbl">${esc(label)}</span></button>`;
function viewReview() {
  main.innerHTML = `<div id="aabar"></div>
  <div class="review ${S.panes.rl ? 'rl-off' : ''} ${S.panes.ev ? 'ev-off' : ''}" id="rvgrid">
    <div class="pane pane-rl">${toggleBtn('rl', 'Products', '‹')}<div class="rlbody"><div class="row" style="margin-bottom:8px"><button class="chip" data-act="rvTab" data-v="review" aria-pressed="${S.rvTab === 'review'}">To review</button><button class="chip" data-act="rvTab" data-v="approved" aria-pressed="${S.rvTab === 'approved'}">Approved</button></div><div class="rlist" id="rl"></div></div></div>
    <div class="pane pane-ed" id="ed"></div>
    <div class="pane pane-pv" id="pvp"></div>
    <div class="pane pane-ev">${toggleBtn('ev', 'Sources & checks', '›')}<div class="ev" id="ev"></div></div>
  </div>`;
  renderReviewList();
  const list = reviewable();
  if (S.rv && list.some((p) => p.id === S.rv.id)) paintReview();
  else if (list.length) openReview(list[0].id);
  else { S.rv = null; $('#ed').innerHTML = `<div class="empty">${S.rvTab === 'review' ? 'Nothing waiting for review.<br>Queue products and start the AI, then come back.' : 'Nothing approved yet.'}</div>`; $('#pvp').innerHTML = ''; $('#ev').innerHTML = ''; }
}
// Publishes one product at a time through the same endpoint as the single Publish button, so progress can be shown.
async function bulkPublish(label, ids, approveFirst) {
  const name = (id) => (S.products.find((p) => p.id === id) || {}).name || id;
  S.bulk = { label, total: ids.length, done: 0, ok: 0, failed: [], running: true };
  paintApproveAll();
  for (const id of ids) {
    try {
      if (approveFirst) await post(`/products/${id}/approve`);
      await post(`/products/${id}/publish`);
      S.bulk.ok++;
    } catch (e) { S.bulk.failed.push(`${name(id)}: ${e.message}`); }
    S.bulk.done++;
    paintApproveAll();
  }
  S.bulk.running = false;
  S.rv = null; await load();
}
function paintApproveAll() {
  const el = $('#aabar'); if (!el) return;
  const b = S.bulk;
  // While a bulk publish runs (and after it ends) the bar shows its progress and result instead of the buttons
  if (b) {
    el.innerHTML = b.running
      ? `<div class="card" style="flex:1"><span class="spin"></span><b>${esc(b.label)}: ${b.done} of ${b.total}</b> <span class="muted small">${b.ok} published${b.failed.length ? `, ${b.failed.length} failed` : ''}. Keep this tab open until it finishes.</span></div>`
      : `<div class="card" style="flex:1"><b>${b.ok} of ${b.total} published.</b>${b.failed.length ? ` ${b.failed.length} failed:<ul class="small" style="margin:6px 0 0;padding-left:18px">${b.failed.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ' Everything went live.'} <button class="btn" data-act="bulkDone" style="margin-left:8px">OK</button></div>`;
    return;
  }
  if (S.rvTab !== 'review') {
    const m = S.products.filter((p) => p.status === 'approved').length;
    el.innerHTML = `<button class="btn good giant" data-act="publishApproved" ${m ? '' : 'disabled'}>${m ? `Publish all ${m} approved` : 'Nothing approved waiting to publish'}<small>${m ? 'Sends every approved page to your live site, one at a time.' : 'Approved pages appear here until you publish them.'}</small></button>`;
    return;
  }
  const ready = S.products.filter((p) => p.status === 'review');
  const bad = ready.filter((p) => p.qaErrors).length;
  const busy = S.products.filter((p) => p.status === 'working' || p.status === 'queued').length;
  const n = ready.length;
  el.innerHTML = `<button class="btn good giant" data-act="approveAll" ${n ? '' : 'disabled'}>${n ? `Approve all ${n} product${n === 1 ? '' : 's'}` : 'Nothing to approve yet'}<small>${n ? `${bad ? `${bad} with failed checks will be approved too. ` : ''}Nothing is published. Edit any of them afterwards under Approved.` : 'Pages appear here as the AI finishes them.'}</small></button>`
    + (n ? `<button class="btn primary giant" data-act="approvePublishAll">Approve and publish all ${n}<small>${bad ? `${bad} with failed checks will go live too. ` : ''}Every page goes to your live site, one at a time.</small></button>` : '')
    + `${busy ? `<span class="muted small"><span class="spin"></span>${busy} still being written</span>` : ''}`;
}
function renderReviewList() {
  paintApproveAll();
  const el = $('#rl'); if (!el) return;
  const list = reviewable();
  el.innerHTML = list.length ? list.map((p) => `<button data-act="openRv" data-id="${p.id}" ${S.rv && S.rv.id === p.id ? 'aria-current="true"' : ''}><span class="nm">${p.status === 'working' ? '<span class="spin"></span>' : `<span class="dot ${p.qaPass === false || p.photoFlags || p.confidence === 'low' ? 'bad' : p.confidence === 'medium' || p.confidence === 'unrated' ? 'mid' : ''}"></span>`}${esc(p.name)}</span><span class="small muted">${p.status === 'published' ? 'Published' : p.status === 'approved' ? 'Approved' : [p.photoFlags ? 'photo mismatch' : '', p.needsYou ? p.needsYou + ' for you to check' : '', p.qaErrors ? p.qaErrors + ' check(s) failed' : ''].filter(Boolean).join(' · ') || 'Checks passed'}</span></button>`).join('') : '<div class="small muted" style="padding:12px">Empty</div>';
}
const openReview = guard(async (id) => {
  await flushSave();
  const p = await api('/products/' + id);
  S.rv = { id, p, final: p.final ? JSON.parse(JSON.stringify(p.final)) : null, timer: null, saved: true, regen: false };
  renderReviewList(); paintReview();
});
const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const setp = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const CONF = { low: 'Not sure', unrated: 'Not rated', medium: 'Fairly sure', high: 'Confident' };
const revItem = (key) => { const r = S.rv && S.rv.p.review; return r && r.items.find((i) => i.key === key); };
// small pill beside a section label: how sure the AI was, and a tick once the owner has checked it
const pill = (key) => { const it = revItem(key); return it ? `<span class="pill ${it.confidence}${it.checked ? ' done' : ''}" title="${esc(it.notes.map((n) => n.text).join(' | '))}">${it.checked ? 'Checked' : CONF[it.confidence]}</span>` : ''; };
const cnt = (v, max) => `<span class="cnt ${v.length > max ? 'over' : ''}" data-cnt>${v.length}/${max}</span>`;
const inp = (path, val, ph = '') => `<input type="text" data-f="${path}" value="${esc(val)}" placeholder="${esc(ph)}">`;

function paintReview() { paintEditor(); paintEvidence(); }
function paintEditor() {
  const el = $('#ed'); if (!el || !S.rv) return;
  const { p, final: f } = S.rv;
  if (p.status === 'working' || !f) { el.innerHTML = `<div class="empty"><span class="spin"></span>${esc(p.stage || 'Working')}…</div>`; const pv = $('#pvp'); if (pv) pv.innerHTML = ''; return; }
  const url = prodUrl(p);
  el.innerHTML = `<div class="editor"><div class="top">
    <strong style="font-size:16px;margin-right:6px">${esc(p.name)}</strong>${badge(p.status)}<span class="small muted" id="savestate">${S.rv.saved ? 'Saved' : 'Unsaved changes…'}</span><span style="flex:1"></span>
    ${p.status === 'published' ? `<span class="small muted">Live: ${esc(p.publishedUrl || '')}</span><button class="btn" data-act="publish">Publish again</button>` :
      `<button class="btn" data-act="regenToggle">Rewrite…</button><button class="btn" data-act="approve" data-go="0">Approve</button><button class="btn good" data-act="approve" data-go="2">Approve and publish</button><button class="btn primary" data-act="approve" data-go="1">Approve, next</button>`}
    </div>
    ${S.rv.regen ? `<div class="block" style="background:var(--blue-bg)"><label>What should change?</label><textarea id="fb" placeholder="e.g. Lead with the power requirements. Shorter intro. Mention it suits butcheries."></textarea><div class="row" style="margin-top:8px"><label style="margin:0;font-weight:400"><input type="checkbox" id="fbr"> Re-read competitor pages first</label><span style="flex:1"></span><button class="btn primary" data-act="regen">Rewrite</button></div></div>` : ''}
    <label>Primary keyword</label>${inp('primary_keyword', f.primary_keyword)}
    <label>Other keywords</label><input type="text" data-f="secondary_keywords" value="${esc(f.secondary_keywords.join(', '))}">
    <label>SEO title ${cnt(f.seo_title, 60)}</label>${inp('seo_title', f.seo_title)}
    <label>Meta description ${cnt(f.meta_description, 155)}</label><textarea data-f="meta_description" style="min-height:88px">${esc(f.meta_description)}</textarea>
    <div class="snippet" aria-label="Google result preview"><div class="u">${esc(url)}</div><div class="t" id="sn-t">${esc(f.seo_title)}</div><div class="m" id="sn-m">${esc(f.meta_description)}</div></div>
    <label>H1</label>${inp('h1', f.h1)}
    <label>Intro ${pill('short_description')}</label><textarea data-f="short_description" style="min-height:80px">${esc(f.short_description)}</textarea>
    <label>Sections</label>${f.sections.map((s, i) => `<div class="block">${pill('section:' + i)}${inp(`sections.${i}.heading`, s.heading, 'Heading')}<textarea class="body" data-f="sections.${i}.body" style="margin-top:6px">${esc(s.body)}</textarea><div class="row end"><button class="btn danger" data-act="delRow" data-k="sections" data-i="${i}">Remove section</button></div></div>`).join('')}
    <button class="btn" data-act="addRow" data-k="sections" style="margin-top:8px">Add section</button>
    <label>Specifications ${pill('specs')} ${pill('dimensions')}</label>${f.specs.map((s, i) => `<div class="row" style="margin-bottom:4px"><div style="flex:1">${inp(`specs.${i}.label`, s.label)}</div><div style="flex:1">${inp(`specs.${i}.value`, s.value)}</div><button class="btn danger" data-act="delRow" data-k="specs" data-i="${i}" aria-label="Remove spec">Remove</button></div>`).join('')}
    <button class="btn" data-act="addRow" data-k="specs">Add spec</button>
    <label>FAQs ${pill('faqs')}</label>${f.faqs.map((s, i) => `<div class="block">${inp(`faqs.${i}.q`, s.q, 'Question')}<textarea data-f="faqs.${i}.a" style="margin-top:6px;min-height:64px">${esc(s.a)}</textarea><div class="row end"><button class="btn danger" data-act="delRow" data-k="faqs" data-i="${i}">Remove FAQ</button></div></div>`).join('')}
    <button class="btn" data-act="addRow" data-k="faqs" style="margin-top:8px">Add FAQ</button>
    <label>Image alt text</label>${inp('alt_text', f.alt_text)}</div>`;
  paintPreviewPane();
}
const prodUrl = (p) => `${String(S.settings.siteUrl || '').replace(/\/+$/, '')}/product/${p.slug || '…'}`;
// The preview sits in its own column beside the editor, with the product photo on top.
function paintPreviewPane() {
  const el = $('#pvp'); if (!el || !S.rv) return;
  const { p, final: f } = S.rv;
  if (p.status === 'working' || !f) { el.innerHTML = ''; return; }
  const img = p.imageUrl || (p.localImage ? '/images/' + encodeURIComponent(p.localImage) : '');
  el.innerHTML = `<div class="pvpane"><div class="pvhead">Preview${['published', 'approved'].includes(p.status) ? ' <button class="btn" data-act="redoOne" style="float:right;margin-top:-4px">Redo this item</button>' : ''}</div>${img ? `<img class="pvimg" src="${esc(img)}" alt="${esc(f.alt_text || p.name)}">` : '<div class="pvimg none">No image</div>'}<div class="pvurl">${esc(prodUrl(p))}</div><div class="pv" id="pv"></div></div>`;
  paintPreview();
}
function paintPreview() {
  const el = $('#pv'); if (!el || !S.rv) return; const f = S.rv.final;
  const P = (t) => String(t || '').split(/\n+/).filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('');
  el.innerHTML = `<h1 style="font-family:var(--sans)">${esc(f.h1)}</h1>${P(f.short_description)}${f.sections.map((s) => `<h2>${esc(s.heading)}</h2>${P(s.body)}`).join('')}${f.specs.length ? `<h2>Specifications</h2><table><tbody>${f.specs.map((x) => `<tr><th>${esc(x.label)}</th><td>${esc(x.value)}</td></tr>`).join('')}</tbody></table>` : ''}${f.faqs.length ? `<h2>Frequently asked questions</h2>${f.faqs.map((x) => `<h3>${esc(x.q)}</h3><p>${esc(x.a)}</p>`).join('')}` : ''}`;
}
// Each card is collapsible; open/closed state is remembered between products and reloads.
const EV_DEFAULT_OPEN = { 'AI notes & confidence': true, 'Photo check': true, 'Quality checks': true, 'Competitor pages read': true };
const evCard = (title, body) => {
  const saved = S.panes.open && title in S.panes.open ? S.panes.open[title] : !!EV_DEFAULT_OPEN[title];
  return `<details class="card evc" data-evk="${esc(title)}" ${saved ? 'open' : ''}><summary>${esc(title)}</summary><div class="evb">${body}</div></details>`;
};
function aiNotesHtml(p) {
  const r = p.review;
  if (!r) return '<span class="muted">No AI notes for this product yet.</span>';
  const w = p.wrote || {};
  const head = `<div class="row" style="margin-bottom:8px"><span class="pill big ${r.overall}">${CONF[r.overall]} overall</span><span class="small muted">${r.needsYou ? `${r.needsYou} part${r.needsYou === 1 ? '' : 's'} for you to check` : 'Nothing left for you to check'}</span></div>`
    + (w.hadPhoto && !w.sawPhoto && !w.viaDescription ? '<div class="issue warn">The writing AI could not see the photo (the writing model does not take images). The photo check below still ran.</div>' : '')
    + (!w.hadPhoto && w.hadPhoto !== undefined ? '<div class="issue error">There was no photo, so the AI wrote blind. Check everything.</div>' : '');
  const rows = r.items.map((i) => `<div class="nrow ${i.confidence}${i.checked ? ' done' : ''}"><div class="row" style="gap:6px"><span class="pill ${i.confidence}">${CONF[i.confidence]}</span><b style="flex:1">${esc(i.title)}</b><label class="small" style="margin:0;font-weight:400"><input type="checkbox" data-act="checkItem" data-key="${esc(i.key)}" ${i.checked ? 'checked' : ''}> checked</label></div>${i.notes.map((n) => `<div class="small note ${n.from}">${n.from === 'ai' ? 'AI: ' : n.from === 'photo' ? 'Photo: ' : 'Check: '}${esc(n.text)}</div>`).join('') || (i.confidence === 'high' ? '' : '<div class="small muted">No note given</div>')}</div>`).join('');
  const qs = (r.owner_questions || []).length ? `<div class="small" style="margin-top:8px"><b>Only you can confirm:</b>${r.owner_questions.map((q) => `<div>${esc(q)}</div>`).join('')}</div>` : '';
  return head + rows + qs;
}
function photoHtml(p) {
  const v = p.vqa, look = p.visual;
  const img = p.imageUrl || (p.localImage ? '/images/' + encodeURIComponent(p.localImage) : '');
  const seen = look && look.seen ? `<div class="small" style="margin-bottom:8px"><b>What the AI saw in your photo:</b> ${esc(look.seen.product_type)}${look.seen.visible_features.length ? '<br>' + esc(look.seen.visible_features.join(' · ')) : ''}${look.seen.not_visible.length ? `<br><span class="muted">Cannot tell from a photo: ${esc(look.seen.not_visible.join(', '))}</span>` : ''}</div>` : '';
  let body;
  if (!v) body = '<span class="muted">Not checked against the photo yet.</span>';
  else {
    const iss = (v.checked ? photoIssues(v) : [{ level: 'warn', msg: v.reason || 'Not checked' }]);
    body = (iss.length ? iss.map((i) => `<div class="issue ${i.level}">${esc(i.msg)}</div>`).join('') : '<div class="okbox">Photo matches the copy</div>') + (v.summary ? `<div class="small muted" style="margin-top:4px">${esc(v.summary)}</div>` : '');
  }
  return `${img ? `<img src="${esc(img)}" alt="" class="thumb">` : ''}${seen}${body}<div class="row" style="margin-top:8px"><button class="btn" data-act="photoCheck">Re-check against photo</button><span class="small muted">Run after you edit</span></div>`;
}
// same wording as the server (lib/vision.js visionIssues)
function photoIssues(vq) {
  const out = [];
  if (vq.image_matches_copy === 'no') out.push({ level: 'error', msg: 'The photo does not look like the product this copy describes' });
  else if (vq.image_matches_copy === 'cannot_tell') out.push({ level: 'warn', msg: 'The photo is too unclear to confirm the copy. Check it yourself' });
  if (vq.name_vs_image.verdict === 'conflicts') out.push({ level: 'error', msg: `The product name and the photo disagree: ${vq.name_vs_image.reason}` });
  vq.contradictions.forEach((c) => out.push({ level: c.severity === 'medium' ? 'warn' : 'error', msg: `${c.where || 'Copy'}: says "${c.claim}" but the photo shows ${c.image_shows || 'something different'}` }));
  vq.unconfirmed.forEach((c) => out.push({ level: 'warn', msg: `${c.where || 'Copy'}: "${c.claim}" cannot be confirmed from the photo${c.why ? ` (${c.why})` : ''}` }));
  return out;
}
function paintEvidence() {
  const el = $('#ev'); if (!el || !S.rv) return; const { p } = S.rv; const q = p.qa; const r = p.research || {}; const facts = (p.facts && p.facts.facts) || [];
  const checks = q ? (q.issues.length ? q.issues.map((i) => `<div class="issue ${i.level}">${esc(i.msg)}</div>`).join('') : '<div class="okbox">All checks passed</div>') + `<div class="small muted" style="margin-top:6px">${q.stats.words} words · wording overlap ${Math.round(q.stats.overlap * 100)}% · similarity to your other pages ${Math.round(q.stats.duplicate * 100)}%</div>` : '<span class="muted">Not checked yet</span>';
  const factsHtml = (facts.length ? facts.map((f) => `<div class="fact"><span><b>${esc(f.label)}:</b> ${esc(f.value)}</span><span class="${f.confidence === 'low' ? 'lo' : 'muted'}">${esc(f.confidence)}</span><span class="small muted" style="grid-column:1/-1">${esc((f.hosts || []).join(', '))}</span></div>`).join('') : '<span class="muted">None found. The copy relies on your notes.</span>') + (p.facts && p.facts.variant_warning ? `<div class="issue warn" style="margin-top:6px">${esc(p.facts.variant_warning)}</div>` : '') + ((p.facts && p.facts.conflicts) || []).map((c) => `<div class="issue warn" style="margin-top:6px">Sources disagree on ${esc(c.label)}: ${esc((c.values || []).join(' vs '))}</div>`).join('');
  const sources = ((r.sources || []).map((s) => `<div class="small" style="margin-bottom:6px"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a><br><span class="muted">${s.claude ? 'Read by Claude for Kenyan wording, keywords and market specs. Its photo does not match yours.' : `${s.words} words · ${s.faqs} FAQs · ${s.specs} specs · ${Math.round((s.fit || 0) * 100)}% match`}</span>${s.photo === 'different' ? '<br><span class="lo">Its photo shows a different product</span>' : s.photo === 'similar' ? '<br><span class="lo">Its photo looks similar, not identical</span>' : s.photo === 'same' ? '<br><span class="muted">Its photo matches yours</span>' : ''}${s.structureOnly ? '<br><span class="lo">Different size or model: used for structure only</span>' : ''}</div>`).join('') || '<span class="muted">None</span>') + (r.warnings || []).map((w) => `<div class="issue warn">${esc(w)}</div>`).join('');
  const kw = (r.keywords && r.keywords.related || []).length ? `<div class="tags">${r.keywords.related.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : '';
  const qs = (r.keywords && r.keywords.questions || []).map((k) => `<div class="small" style="margin-top:4px">${esc(k)}</div>`).join('');
  el.innerHTML = evCard('AI notes & confidence', aiNotesHtml(p)) +
    evCard('Photo check', photoHtml(p)) +
    evCard('Quality checks', checks) +
    evCard('Competitor pages read', sources) +
    evCard('Facts the AI was allowed to use', factsHtml) +
    (p.unique ? evCard('Your product knowledge', `<div class="small" style="white-space:pre-wrap">${esc(p.unique)}</div>`) : '') +
    evCard('Kenya search data', kw + qs || '<span class="muted">None</span>') +
    (p.current && p.current.description ? evCard('Current text on your site', `<div class="small muted" style="white-space:pre-wrap;max-height:180px;overflow:auto">${esc(p.current.description)}</div>`) : '');
}
function onField(t) {
  if (!S.rv || !S.rv.final) return;
  const path = t.dataset.f; const v = t.value;
  if (path === 'secondary_keywords') S.rv.final.secondary_keywords = v.split(',').map((x) => x.trim()).filter(Boolean); else setp(S.rv.final, path, v);
  if (path === 'seo_title') { $('#sn-t').textContent = v; const c = t.closest('label') || t.previousElementSibling; if (c) { const e = $('[data-cnt]', c); if (e) { e.textContent = `${v.length}/60`; e.classList.toggle('over', v.length > 60); } } }
  if (path === 'meta_description') { $('#sn-m').textContent = v; const c = t.previousElementSibling; const e = c && $('[data-cnt]', c); if (e) { e.textContent = `${v.length}/155`; e.classList.toggle('over', v.length > 155); } }
  if (path === 'alt_text') { const im = $('.pvimg'); if (im) im.alt = v; }
  S.rv.saved = false; const ss = $('#savestate'); if (ss) ss.textContent = 'Unsaved changes…';
  paintPreview(); clearTimeout(S.rv.timer); S.rv.timer = setTimeout(() => flushSave().catch((e) => toast(e.message, true)), 1200);
}
async function flushSave() {
  const rv = S.rv; if (!rv || rv.saved || !rv.final) return;
  clearTimeout(rv.timer); rv.saved = true;
  const r = await post(`/products/${rv.id}/final`, { final: rv.final });
  rv.p.qa = r.qa; rv.p.final = rv.final; if (r.review) rv.p.review = r.review;
  const ss = $('#savestate'); if (ss) ss.textContent = 'Saved';
  if (S.rv === rv) paintEvidence();
}
const BLANK = { sections: { heading: '', body: '' }, specs: { label: '', value: '' }, faqs: { q: '', a: '' } };
const nextReview = () => { const l = reviewable(); const i = l.findIndex((p) => p.id === (S.rv && S.rv.id)); return l[i + 1] || l[i - 1] || null; };
const approve = guard(async (go) => {
  await flushSave();
  const id = S.rv.id, next = nextReview();
  await post(`/products/${id}/approve`);
  if (go === 2) {
    toast('Publishing…');
    try { const r = await post(`/products/${id}/publish`); toast('Published: ' + r.url); } catch (e) { toast(`Approved, but publishing failed: ${e.message}. It is under Approved; try Publish all approved.`, true); await openReview(id); return; }
  } else toast('Approved');
  if (go === 1 || go === 2) { if (next) await openReview(next.id); else { S.rv = null; viewReview(); } } else { await openReview(id); }
});

/* ---------- competitors ---------- */
function viewCompetitors() {
  main.innerHTML = `<h1>Competitors</h1><p class="lede">Read a whole competitor site once. The engine keeps every product page it finds, then matches your products to the right pages by size and specs, so a 20L fryer gets the 20L page, never the 30L one. You can also learn a style from the richest pages on a site.</p>
  <div class="card"><h2>Add a competitor site</h2><div class="grid2" style="gap:14px"><div><label for="cp-name">Name</label><input type="text" id="cp-name" placeholder="e.g. Jumia Kenya">
  <label for="cp-url">Site address (the engine finds its sitemap itself)</label><input type="text" id="cp-url" placeholder="competitor.co.ke"></div>
  <div><label for="cp-mode">How to read it</label><select id="cp-mode"><option value="index">Quick index from the sitemap (recommended)</option><option value="pages">Read the pages now (needed to learn a style)</option></select>
  <label for="cp-filter">Only links containing (optional)</label><input type="text" id="cp-filter" placeholder="/product/"></div></div>
  <div class="row" style="margin:10px 0 0"><span class="small muted">Quick fill:</span>${[['Shine Kitchenware', 'shinekitchenware.co.ke'], ['Bee Fabricators', 'beefabricators.co.ke'], ['DK Kitchen Appliances', 'dkkitchenappliances.com']].map(([n, u]) => `<button class="chip" data-act="fillComp" data-n="${n}" data-u="${u}">${n}</button>`).join('')}</div>\n  <p class="small muted">Quick index lists every product link in seconds and only opens the pages that match your products. Reading pages now follows a category page (paste its link above) and keeps up to <input type="number" id="cp-max" value="60" min="5" max="300" style="width:70px;display:inline;padding:2px 6px"> product pages. Sites that need JavaScript to show content can only be read with the headless browser option in Settings.</p>
  <button class="btn primary" data-act="crawl">Add this site</button></div>
  <div id="cplist"></div>
  <div class="card"><h2>Try it on one product</h2><p class="muted" style="margin-top:-4px">Type a product name to see which competitor page each source would give you, before you run hundreds.</p><div class="row"><input type="text" id="try-name" placeholder="Commercial Deep Fryer 20L" style="max-width:380px"><button class="btn" data-act="tryIt">Check</button></div><div id="tryres"></div></div>
  <div class="card"><h2>Match my products to competitor pages</h2><p class="muted" style="margin-top:-4px">Checks every product against every site you have read. Strong matches are pre-ticked. Anything with a size or spec conflict is shown in red and left unticked.</p>
  <div class="row"><label style="margin:0;font-weight:400"><input type="checkbox" id="mm-missing" checked> Only products that still need links</label><button class="btn" data-act="matchAll">Find matches</button></div><div id="mres"></div></div>`;
  paintCatalogues(); if (S.mm) paintMatches();
}
function paintCatalogues() {
  const el = $('#cplist'); if (!el) return;
  el.innerHTML = S.catalogues.map((c) => `<div class="card"><div class="row" style="justify-content:space-between"><div><h2 style="margin:0">${esc(c.name)} <span class="tag">${esc(c.host)}</span></h2>
  <div class="small muted">${c.status === 'crawling' ? `<span class="spin"></span>${c.kind === 'index' ? 'Finding the sitemap…' : `Reading… ${c.tried} pages checked, ${c.found} product pages kept`}` : c.status === 'ready' ? (c.kind === 'index' ? `${c.found.toLocaleString()} product links indexed. Pages are opened only when one matches your product.` : `${c.found} product pages kept${c.failed ? `, ${c.failed} could not be read` : ''}`) : `<span class="err">${esc(c.error || 'Failed')}</span>`}</div></div>
  <div class="row">${c.status === 'ready' && c.kind !== 'index' ? `<button class="btn" data-act="learnStyle" data-id="${c.id}" data-name="${esc(c.name)}">Learn style from its richest pages</button>` : ''}<button class="btn danger" data-act="delCat" data-id="${c.id}">Remove</button></div></div></div>`).join('') ||
  '<div class="empty" style="margin-bottom:16px">No competitor sites read yet.</div>';
}
function paintMatches() {
  const r = S.mm, el = $('#mres'); if (!el || !r) return;
  if (!r.catalogues) { el.innerHTML = '<p class="muted">Read at least one competitor site first.</p>'; return; }
  const withC = r.results.filter((x) => x.candidates.length);
  const strong = withC.filter((x) => x.candidates.some((c) => c.strong)).length;
  el.innerHTML = `<p style="margin-top:12px"><b>${r.results.length}</b> products checked: ${strong} have a strong match, ${withC.length - strong} only weak or conflicting matches, ${r.results.length - withC.length} found nothing.</p>
  ${withC.length ? `<table><thead><tr><th>Your product</th><th>Competitor pages</th></tr></thead><tbody>${withC.map((x) => { const seen = new Set(); return `<tr><td style="width:30%"><b>${esc(x.name)}</b><div class="small muted">${x.have} link(s) already</div></td><td>${x.candidates.map((c) => { const pre = c.strong && !seen.has(c.host); if (pre) seen.add(c.host);
    return `<label style="font-weight:400;margin:0 0 6px"><input type="checkbox" data-mc="${x.id}" value="${esc(c.url)}" ${pre ? 'checked' : ''}> <b>${Math.round(c.score * 100)}%</b> ${esc(c.title)} <span class="tag">${esc(c.host)}</span>${c.conflictText ? `<br><span class="err small">Different: ${esc(c.conflictText)}</span>` : ''}<br><a class="small" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></label>`; }).join('')}</td></tr>`; }).join('')}</tbody></table>
  <div class="row end" style="margin-top:12px"><button class="btn primary" data-act="applyMatches">Add ticked pages as sources</button></div>` : ''}`;
}

/* ---------- reference styles (ingestor) ---------- */
function viewStyles() {
  main.innerHTML = `<h1>Reference styles</h1><p class="lede">Give the engine product pages whose SEO you want to match. It reads their titles, meta descriptions, heading structure, depth, specs and FAQs, and learns the pattern. New copy then follows that pattern with your products and your facts. It learns structure, never wording.</p>
  <div class="card"><h2>Learn a new style</h2><label for="st-name">Style name</label><input type="text" id="st-name" placeholder="e.g. Jumia-style detailed page">
  <label for="st-urls">Reference page links (1 to 5, one per line)</label><textarea id="st-urls" placeholder="https://…"></textarea>
  <div class="row" style="margin-top:10px"><button class="btn primary" data-act="ingest">Learn this style</button><span id="st-msg" class="small muted"></span></div></div>
  ${S.profiles.map((p) => `<div class="card" data-prof="${p.id}"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(p.name)} ${S.settings.defaultProfileId === p.id ? '<span class="tag">default</span>' : ''}</h2><div class="row">${S.settings.defaultProfileId === p.id ? '' : `<button class="btn" data-act="setDefault" data-id="${p.id}">Make default</button>`}${p.builtin ? '' : `<button class="btn danger" data-act="delProf" data-id="${p.id}">Delete</button>`}</div></div>
    ${p.stats ? `<p class="small muted">Learned from ${p.stats.pages} page(s): about ${p.stats.avgWords} words, ${p.stats.avgSections} sections, ${p.stats.avgSpecs} spec rows, ${p.stats.avgFaqs} FAQs.${p.stats.thinPages ? ` ${p.stats.thinPages} page(s) had very little readable text, so results may be rough.` : ''}</p>` : ''}
    ${(p.failed || []).map((f) => `<div class="issue warn">${esc(f)}</div>`).join('')}
    <div class="grid2" style="margin-top:8px"><div><label>Title pattern</label><input type="text" data-pf="analysis.title_pattern" value="${esc(p.analysis.title_pattern)}"><label>Meta description pattern</label><input type="text" data-pf="analysis.meta_pattern" value="${esc(p.analysis.meta_pattern)}"><label>H1 pattern</label><input type="text" data-pf="analysis.h1_pattern" value="${esc(p.analysis.h1_pattern)}"><label>Tone</label><textarea data-pf="analysis.tone" style="min-height:60px">${esc(p.analysis.tone)}</textarea></div>
    <div><label>Section order (one per line)</label><textarea data-pf="analysis.structure" style="min-height:120px">${esc((p.analysis.structure || []).join('\n'))}</textarea><label>Your extra rules for this style</label><textarea data-pf="rules" style="min-height:60px">${esc(p.rules)}</textarea></div></div>
    <div class="row" style="margin-top:8px">${[['wordsMin', 'Words min'], ['wordsMax', 'Words max'], ['sectionsMin', 'Sections min'], ['faqMin', 'FAQs min']].map(([k, l]) => `<div style="width:110px"><label>${l}</label><input type="number" data-pf="targets.${k}" value="${p.targets[k]}"></div>`).join('')}<span style="flex:1"></span><button class="btn primary" data-act="saveProf" data-id="${p.id}">Save changes</button></div>
    ${p.urls && p.urls.length ? `<p class="small muted">Sources: ${p.urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`).join(', ')}</p>` : ''}</div>`).join('')}`;
}

/* ---------- knowledge ---------- */
function viewKnowledge() {
  const k = S.knowledge; const box = (key, title, hint) => `<div class="card"><h2>${esc(title)}</h2>${hint ? `<p class="small muted" style="margin-top:-4px">${hint}</p>` : ''}<textarea data-kn="${esc(key)}" style="min-height:90px">${esc(k[key] || '')}</textarea></div>`;
  main.innerHTML = `<h1>Knowledge</h1><p class="lede">What you know that competitors do not. The AI may use anything written here, and nothing it cannot find here or in competitor facts. It saves as you click away from a box.</p>
  ${box('_global', 'Shop-wide', 'Delivery areas and times, payment (M-Pesa, bank), warranty, installation service, after-sales support, years in business.')}
  <h2 style="margin-top:20px">By major category</h2><div class="grid2">${S.settings.majorCategories.map((c) => box(c, c)).join('')}</div>
  <h2 style="margin-top:8px">By sub category</h2><div class="grid2">${S.settings.subCategories.map((c) => box(c, c)).join('')}</div>`;
}

/* ---------- import sheet ---------- */
function viewCsv() {
  main.innerHTML = `<h1>Import sheet</h1><p class="lede">Upload a CSV with your products, competitor links and knowledge. Rows are matched to products you already have by name or file name. Use any headers like <b>product</b>, <b>filename</b>, <b>link 1</b>, <b>link 2</b>, <b>knowledge</b>, <b>category</b>, <b>sub_category</b>, <b>style</b>. Every column with "link", "url" or "competitor" in its header is read as source links.</p>
  <div class="card"><input type="file" id="csvfile" accept=".csv,text/csv,.tsv,text/plain"> <span class="muted small">or paste below</span><textarea id="csvtext" style="margin-top:8px;min-height:100px;font-family:monospace;font-size:12px"></textarea><div class="row" style="margin-top:8px"><button class="btn primary" data-act="csvMatch">Match rows</button></div></div><div id="csvres"></div>`;
  $('#csvfile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#csvtext').value = await f.text(); };
  if (S.csv) paintCsv();
}
function paintCsv() {
  const r = S.csv, el = $('#csvres'); if (!r || !el) return;
  const c = { high: 0, low: 0, none: 0 }; r.results.forEach((x) => c[x.confidence]++);
  el.innerHTML = `<div class="card"><p><b>${r.total}</b> rows: ${c.high} matched, ${c.low} need a look, ${c.none} not found (will be created as new products). Change any row before applying.</p>
  <table><thead><tr><th>Sheet row</th><th>Links</th><th>Knowledge</th><th>Do this</th></tr></thead><tbody>${r.results.map((x) => {
    const def = x.confidence === 'high' ? 'update:' + x.match.id : x.confidence === 'none' && (x.parsed.name || x.parsed.filename) ? 'create' : 'skip';
    return `<tr><td><b>${esc(x.parsed.name || x.parsed.filename || '(blank)')}</b></td><td class="small">${x.parsed.links.length}</td><td class="small muted">${esc((x.parsed.knowledge || '').slice(0, 70))}</td>
    <td><select data-csv="${x.index}" style="${x.confidence === 'low' ? 'border-color:var(--amber)' : ''}">${x.alternatives.map((a) => `<option value="update:${a.id}" ${def === 'update:' + a.id ? 'selected' : ''}>Add to: ${esc(a.name)} (${Math.round(a.score * 100)}%)</option>`).join('')}<option value="create" ${def === 'create' ? 'selected' : ''}>Create new product</option><option value="skip" ${def === 'skip' ? 'selected' : ''}>Skip this row</option></select></td></tr>`;
  }).join('')}</tbody></table>
  <div class="row" style="margin-top:12px"><label style="margin:0;font-weight:400"><input type="checkbox" id="csvq" checked> Queue these products for the AI</label><label style="margin:0;font-weight:400"><input type="checkbox" id="csvs" checked> Start the AI right away</label><span style="flex:1"></span><button class="btn primary" data-act="csvApply">Apply sheet</button></div></div>`;
}

/* ---------- export ---------- */
function viewExport() {
  main.innerHTML = `<h1>Export</h1><p class="lede">Every approved page is saved with the exact input the AI saw and the final text you approved, including your edits. That pairing is what you fine-tune on.</p>
  <div class="card"><label for="ex-st">Which products</label><select id="ex-st" style="max-width:320px"><option value="approved">Approved and published</option><option value="all">Everything that has copy (including still in review)</option></select>
  <p id="ex-n" class="muted"></p><div class="row"><a class="btn primary" id="ex-j" style="text-decoration:none">Download for fine-tuning (.jsonl)</a><a class="btn" id="ex-c" style="text-decoration:none">Download input and output (.csv)</a></div></div>
  <div class="card"><h2>How to fine-tune on a few products</h2><ol style="margin:0;padding-left:18px;line-height:1.7"><li>Review 30 to 50 products carefully and fix everything you do not like. Approve them. Your edits are what the model learns.</li><li>Download the .jsonl and upload it to OpenAI fine-tuning (use a model that supports fine-tuning).</li><li>When training finishes, paste the new model id (it starts with <code>ft:</code>) into <b>Settings → Writing model</b>.</li><li>Queue the rest. Every new page now follows your approved style and expertise.</li></ol></div>`;
  const upd = guard(async () => { const st = $('#ex-st').value; $('#ex-j').href = '/api/export.jsonl?status=' + st; $('#ex-c').href = '/api/export.csv?status=' + st; const r = await api('/export-count?status=' + st); $('#ex-n').textContent = `${r.count} product${r.count === 1 ? '' : 's'} in this export.`; });
  $('#ex-st').onchange = upd; upd();
}

/* ---------- settings ---------- */
function viewSettings() {
  const s = S.settings; const t = (k, l, ph = '') => `<label>${l}</label><input type="text" data-set="${k}" value="${esc(s[k])}" placeholder="${esc(ph)}">`;
  main.innerHTML = `<h1>Settings</h1><div class="grid2"><div class="card"><h2>Site</h2>${t('siteName', 'Store name')}${t('siteUrl', 'Site URL')}<label>About the business (the AI reads this every time)</label><textarea data-set="siteContext" style="min-height:110px">${esc(s.siteContext)}</textarea>
  <label>Description format saved to your site</label><select data-set="descriptionFormat"><option value="text" ${s.descriptionFormat === 'text' ? 'selected' : ''}>Plain text (safe on any page)</option><option value="html" ${s.descriptionFormat === 'html' ? 'selected' : ''}>HTML with headings and a spec table (page must render HTML)</option></select>
  <label>Extra Supabase columns (optional, JSON)</label><textarea data-set="extraColumns" style="min-height:70px;font-family:monospace;font-size:12px" placeholder='{"h1":"h1","schema_jsonld":"jsonld"}'>${esc(Object.keys(s.extraColumns || {}).length ? JSON.stringify(s.extraColumns, null, 1) : '')}</textarea><p class="small muted">Left is a column in your products table. Right is one of h1, short_description, faqs_json, specs_json, jsonld, primary_keyword, tags. Only add columns that exist.</p></div>
  <div class="card"><h2>AI</h2>${t('writerModel', 'Writing model', 'gpt-4.1-mini, or your ft:… model')}${t('extractModel', 'Research model', 'gpt-4.1-mini')}${t('visionModel', 'Photo look model (needs image input)', 'gpt-4.1-mini')}${t('qaModel', 'Photo QA model (needs image input)', 'gpt-4.1-mini')}
  <label>Picture use</label><select data-set="imageMode"><option value="once" ${s.imageMode !== 'full' ? 'selected' : ''}>Once (cheapest): the AI looks at your photo one time and the writer reads its description</option><option value="full" ${s.imageMode === 'full' ? 'selected' : ''}>Full: also compares competitor photos, writer sees the photo, QA re-checks it (about 6 images per product)</option></select>
  <label>Research</label><select data-set="researchMode"><option value="separate" ${s.researchMode !== 'merged' ? 'selected' : ''}>Separate: look at the photo, then extract facts (two calls)</option><option value="merged" ${s.researchMode === 'merged' ? 'selected' : ''}>Merged (test it): one call looks at the photo, judges each competitor page and extracts facts</option></select>
  <label>Stop the queue when estimated spend reaches (USD, 0 = no limit)</label><input type="number" min="0" step="0.5" data-set="maxSpendUsd" value="${s.maxSpendUsd || 0}">
    <label>Photo detail sent to the AI (look and writing)</label><select data-set="photoDetail">${['low', 'auto', 'high'].map((d) => `<option value="${d}" ${s.photoDetail === d ? 'selected' : ''}>${d}${d === 'low' ? ' (cheapest)' : d === 'high' ? ' (most tokens)' : ''}</option>`).join('')}</select>
  <label>Photo detail for the QA check</label><select data-set="qaDetail">${['low', 'auto', 'high'].map((d) => `<option value="${d}" ${s.qaDetail === d ? 'selected' : ''}>${d}</option>`).join('')}</select><p class="small muted">Low is enough for matching a product to its photo. If the QA misses small things such as burner or door counts, set the QA check to high.</p><label>Products processed at once</label><input type="number" min="1" max="5" data-set="concurrency" value="${s.concurrency}">
  <label>Competitor pages to read per product (1 to 4)</label><input type="number" min="1" max="4" data-set="sourcesPerProduct" value="${s.sourcesPerProduct}">
  <label>Preferred competitor sites, tried first, in this order (one per line)</label><textarea data-set="preferredSites" style="min-height:70px" placeholder="jumia.co.ke&#10;kilimall.co.ke">${esc((s.preferredSites || []).join('\n'))}</textarea><p class="small muted">Preferred sites you have indexed cost nothing. Others are looked up with their own search box (free) and only fall back to one Google search each.</p>
  <label><input type="checkbox" data-set="siteSearch" ${s.siteSearch ? 'checked' : ''}> Look products up with each preferred site's own search box</label>
  <label><input type="checkbox" data-set="useBrowser" ${s.useBrowser ? 'checked' : ''}> Use a headless browser for JavaScript-only sites</label><p class="small muted">Needs a one-time install: <code>npm i playwright</code> then <code>npx playwright install chromium</code>. Slower, so leave it off unless a site shows no content.</p>
  <label><input type="checkbox" data-set="autoFindSources" ${s.autoFindSources ? 'checked' : ''}> Find competitor pages automatically when none are given</label>
  <label>Default reference style</label><select data-set="defaultProfileId">${S.profiles.map((p) => `<option value="${p.id}" ${p.id === s.defaultProfileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
  <div class="card"><h2>Categories (must match your site exactly)</h2><label>Major categories, one per line</label><textarea data-set="majorCategories" style="min-height:80px">${esc(s.majorCategories.join('\n'))}</textarea><label>Sub categories, one per line</label><textarea data-set="subCategories" style="min-height:160px">${esc(s.subCategories.join('\n'))}</textarea></div></div>
  <div class="card" id="usage-card" style="margin-top:14px"><h2>Token usage</h2><p class="small muted">Loading…</p></div>
  <button class="btn primary" data-act="saveSettings">Save settings</button>`;
  loadUsage();
}

// Tokens used so far, per step. "Cached" is the part of the input that OpenAI charged at the cached rate: cached / input is the cache hit rate.
const loadUsage = guard(async () => {
  const u = await api('/usage'); const el = $('#usage-card'); if (!el) return;
  const n = (x) => Number(x || 0).toLocaleString(), pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '-');
  const rows = Object.entries(u.byLabel || {}).sort((a, b) => b[1].prompt - a[1].prompt)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${n(v.calls)}</td><td>${n(v.prompt)}</td><td>${pct(v.cached, v.prompt)}</td><td>${n(v.completion)}</td></tr>`).join('');
  el.innerHTML = `<h2>Token usage</h2><p class="small muted">Since ${new Date(u.since).toLocaleString()}. ${n(u.calls)} calls (est. $${(u.cost || 0).toFixed(3)}${u.productsDone ? `; about $${u.perProduct.toFixed(4)} per finished product, so roughly $${u.projected.toFixed(2)} for the ${u.productsLeft} still to do` : ''}), ${n(u.prompt)} input tokens (${pct(u.cached, u.prompt)} served from the cache), ${n(u.completion)} output tokens.</p>
    ${rows ? `<table><thead><tr><th>Step</th><th>Calls</th><th>Input</th><th>Cached</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="small muted">Nothing recorded yet. Run a few products.</p>'}
    <div class="row" style="margin-top:10px"><button class="btn" data-act="resetUsage">Reset counters</button></div>`;
});

/* ---------- actions ---------- */
const ACTS = {
  go: (a) => { flushSave().catch(() => {}); S.view = a.dataset.v; S.drawer = null; render(); },
  filter: (a) => { S.filter = a.dataset.v; renderChips(); renderTable(); },
  open: (a, e) => { if (e.target.closest('input')) return; guard(openDrawer)(a.dataset.id); },
  closeDrawer: () => { S.drawer = null; $('#drawer').innerHTML = ''; },
  sel: (a) => { a.checked ? S.sel.add(a.dataset.id) : S.sel.delete(a.dataset.id); renderBar(); },
  selAll: (a) => { visible().forEach((p) => (a.checked ? S.sel.add(p.id) : S.sel.delete(p.id))); renderTable(); renderBar(); },
  queueSel: guard(async () => { const r = await post('/products/bulk', { ids: [...S.sel], action: 'queue' }); S.sel.clear(); toast(`${r.queued} queued. Press Start AI to begin.`); renderBar(); }),
  queueNew: guard(async () => { const ids = S.products.filter((p) => p.status === 'new').map((p) => p.id); const r = await post('/products/bulk', { ids, action: 'queue' }); toast(`${r.queued} queued. Press Start AI to begin.`); }),
  delSel: guard(async () => { if (!confirm(`Delete ${S.sel.size} product(s) from the engine? Products already on your site are not touched.`)) return; const ids = [...S.sel]; await post('/products/bulk', { ids, action: 'delete' }); S.products = S.products.filter((p) => !ids.includes(p.id)); S.sel.clear(); render(); }),
  delOne: guard(async (a) => { if (!confirm('Delete this product from the engine? A product already on your site is not touched.')) return; await api('/products/' + a.dataset.id, { method: 'DELETE' }); S.products = S.products.filter((p) => p.id !== a.dataset.id); S.drawer = null; render(); }),
  qstart: guard(async () => { S.queue = await post('/queue/start'); renderBar(); toast('AI started'); }),
  qpause: guard(async () => { S.queue = await post('/queue/pause'); renderBar(); toast('Paused. Running items will finish first.'); }),
  saveDrawer: (a) => saveDrawer(a.dataset.id, a.dataset.q === '1'),
  findSrc: guard(async (a) => {
    $('#cands').innerHTML = '<span class="spin"></span>Searching Google Kenya…';
    const r = await post(`/products/${a.dataset.id}/find-sources`);
    $('#cands').textContent = r.candidates.length ? 'Tick the ones to use:' : 'Nothing suitable found. Paste links manually.';
    $('#candlist').innerHTML = r.all.map((c) => `<label style="font-weight:400;margin:6px 0"><input type="checkbox" data-cand="${esc(c.link)}" ${r.candidates.some((x) => x.link === c.link) ? 'checked' : ''}> <b>${esc(c.title)}</b><br><span class="small muted">${esc(c.link)}</span></label>`).join('') + '<button class="btn" data-act="addCands">Add ticked links</button>';
  }),
  addCands: () => { const ta = $('#d-links'); const have = ta.value.split('\n').map((x) => x.trim()).filter(Boolean); $$('[data-cand]:checked').forEach((c) => !have.includes(c.dataset.cand) && have.push(c.dataset.cand)); ta.value = have.join('\n'); },
  toReview: (a) => { S.view = 'review'; S.rvTab = S.products.find((p) => p.id === a.dataset.id).status === 'review' ? 'review' : 'approved'; S.rv = null; S.drawer = null; render(); openReview(a.dataset.id); },
  addOne: guard(async (a) => {
    const name = $('#a-name').value; const r = await post('/products', { name, major_category: $('#a-major').value, sub_category: $('#a-sub').value, links: $('#a-links').value.split('\n'), unique: $('#a-unique').value });
    S.products.unshift(r); if (a.dataset.q === '1') await post('/products/bulk', { ids: [r.id], action: 'queue' });
    toast(a.dataset.q === '1' ? 'Added and queued' : 'Added'); ['a-name', 'a-links', 'a-unique'].forEach((i) => ($('#' + i).value = '')); renderNav();
  }),
  scan: guard(async () => { const r = await post('/scan-images', {}); toast(`${r.added} photo(s) added${r.skippedOld ? `. ${r.skippedOld} already done by the old pipeline were skipped.` : ''}`); }),
  importClaude: guard(async () => { toast('Loading Claude drafts…'); const r = await post('/import-claude-drafts'); toast(`${r.added + r.updated + (r.inReview || 0)} drafts ready to review${r.unchanged ? `, ${r.unchanged} unchanged and already approved or published` : ''}${r.skipped.length - (r.unchanged || 0) ? `, ${r.skipped.length - (r.unchanged || 0)} skipped` : ''}`); await load(); S.view = 'queue'; S.filter = 'claude'; render(); }),
  importSite: guard(async () => { toast('Reading your products…'); const r = await post('/import-supabase'); toast(`${r.added} products imported`); await load(); S.view = 'add'; render(); }),
  rvTab: (a) => { S.rvTab = a.dataset.v; S.rv = null; viewReview(); },
  openRv: (a) => openReview(a.dataset.id),
  addRow: (a) => { if (!S.rv || !S.rv.final) return; S.rv.final[a.dataset.k].push({ ...BLANK[a.dataset.k] }); S.rv.saved = false; paintEditor(); },
  delRow: (a) => { S.rv.final[a.dataset.k].splice(+a.dataset.i, 1); S.rv.saved = false; paintEditor(); clearTimeout(S.rv.timer); S.rv.timer = setTimeout(() => flushSave().catch((e) => toast(e.message, true)), 800); },
  checkItem: guard(async (a) => { const r = await post(`/products/${S.rv.id}/review-item`, { key: a.dataset.key, checked: a.checked }); S.rv.p.review = r.review; paintEvidence(); const f = $('#ed'); if (f) { const sv = S.rv.saved; paintEditor(); S.rv.saved = sv; } }),
  photoCheck: guard(async () => { toast('Checking against the photo…'); await flushSave(); const r = await post(`/products/${S.rv.id}/photo-check`); S.rv.p.vqa = r.vqa; S.rv.p.review = r.review; paintEvidence(); paintEditor(); toast('Photo check done'); }),
  redoOne: guard(async () => { if (!confirm('Redo this item? It goes back through the AI and lands in To review. Your live page stays as it is until you publish the new copy.')) return; await flushSave(); await post(`/products/${S.rv.id}/redo`); toast('Queued for redo'); S.rv = null; await load(); viewReview(); }),
  redoPub: guard(async () => { const ids = [...S.sel].filter((id) => (S.products.find((p) => p.id === id) || {}).status === 'published'); const n = ids.length || S.products.filter((p) => p.status === 'published').length; if (!n) return toast('No published items to redo', true); if (!confirm(`Redo ${n} published item${n === 1 ? '' : 's'}? Each goes back through the AI into To review. Your live pages stay as they are until you publish the new copy.`)) return; const r = await post('/redo-published', { ids }); toast(`${r.queued} queued for redo`); await load(); }),
  regenToggle: () => { S.rv.regen = !S.rv.regen; paintEditor(); },
  regen: guard(async () => { await post(`/products/${S.rv.id}/regenerate`, { feedback: $('#fb').value, refresh: $('#fbr').checked }); S.rv.p.status = 'working'; S.rv.p.stage = 'Rewriting'; S.rv.regen = false; S.rv.saved = true; paintEditor(); toast('Rewriting with your notes'); }),
  approve: (a) => approve(+a.dataset.go),
  approveAll: guard(async () => {
    await flushSave();
    const r = await post('/approve-all');
    toast(`${r.approved} approved${r.skipped ? `, ${r.skipped} skipped (nothing written yet)` : ''}. Edit any of them under Approved.`);
    S.rvTab = 'approved'; S.rv = null; await load();
  }),
  approvePublishAll: guard(async () => {
    const ids = S.products.filter((p) => p.status === 'review').map((p) => p.id);
    if (!ids.length || !confirm(`Approve and publish all ${ids.length} products to your live site now?`)) return;
    await flushSave();
    await bulkPublish('Approving and publishing', ids, true);
  }),
  publishApproved: guard(async () => {
    const ids = S.products.filter((p) => p.status === 'approved').map((p) => p.id);
    if (!ids.length || !confirm(`Publish all ${ids.length} approved products to your live site now?`)) return;
    await bulkPublish('Publishing', ids, false);
  }),
  bulkDone: () => { S.bulk = null; paintApproveAll(); },
  togglePane: (a) => {
    const k = a.dataset.v; S.panes[k] = !S.panes[k]; savePanes();
    const g = $('#rvgrid'); if (g) g.classList.toggle(k + '-off', !!S.panes[k]);
    a.setAttribute('aria-expanded', String(!S.panes[k]));
  },
  publish: guard(async () => { const r = await post(`/products/${S.rv.id}/publish`); toast('Published: ' + r.url); }),
  ingest: guard(async () => { $('#st-msg').innerHTML = '<span class="spin"></span>Reading pages and learning the pattern…'; try { await post('/profiles/ingest', { name: $('#st-name').value, urls: $('#st-urls').value.split('\n') }); await load(); toast('Style learned'); } catch (e) { $('#st-msg').textContent = ''; throw e; } }),
  setDefault: guard(async (a) => { await api('/settings', { method: 'PUT', body: { defaultProfileId: a.dataset.id } }); await load(); }),
  delProf: guard(async (a) => { if (!confirm('Delete this style?')) return; await api('/profiles/' + a.dataset.id, { method: 'DELETE' }); await load(); }),
  saveProf: guard(async (a) => {
    const card = $(`[data-prof="${a.dataset.id}"]`); const body = { analysis: {}, targets: {} };
    $$('[data-pf]', card).forEach((el) => { const [g, k] = el.dataset.pf.split('.'); if (!k) body[g] = el.value; else body[g][k] = g === 'analysis' && k === 'structure' ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : el.value; });
    await api('/profiles/' + a.dataset.id, { method: 'PATCH', body }); toast('Style saved'); await load();
  }),
  crawl: guard(async () => {
    const c = await post('/catalogue/crawl', { name: $('#cp-name').value, url: $('#cp-url').value, filter: $('#cp-filter').value, max: $('#cp-max').value, mode: $('#cp-mode').value });
    if (!S.catalogues.some((x) => x.id === c.id)) S.catalogues.push(c); paintCatalogues(); toast('Working on it. You can keep using the app.');
  }),
  delCat: guard(async (a) => { if (!confirm('Remove this competitor site? Pages already used in drafts stay as sources.')) return; await api('/catalogue/' + a.dataset.id, { method: 'DELETE' }); S.catalogues = S.catalogues.filter((c) => c.id !== a.dataset.id); paintCatalogues(); }),
  learnStyle: guard(async (a) => {
    const name = prompt('Name for this style', `${a.dataset.name} style`); if (!name) return;
    toast('Learning the style from its richest pages…'); const r = await post(`/catalogue/${a.dataset.id}/style`, { name, count: 8 });
    await load(); S.view = 'competitors'; render(); toast(`Style "${r.name}" learned from ${r.pages} pages. Find it under Reference styles.`);
  }),
  fillComp: (a) => { $('#cp-name').value = a.dataset.n; $('#cp-url').value = a.dataset.u; },
  tryIt: guard(async () => {
    const el = $('#tryres'); el.innerHTML = '<p><span class="spin"></span>Checking…</p>';
    let r; try { r = await post('/catalogue/try', { name: $('#try-name').value }); } catch (e) { el.innerHTML = ''; throw e; }
    const row = (c) => `<div style="margin:6px 0"><b>${Math.round(c.score * 100)}%</b> ${esc(c.title || c.text || '')} <span class="tag">${esc(c.host || '')}</span>${c.conflictText ? `<br><span class="err small">Different: ${esc(c.conflictText)}</span>` : ''}<br><a class="small" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></div>`;
    el.innerHTML = `<h3 style="font-size:13px;margin:14px 0 4px">From sites you have added</h3>${r.catalogue.map(row).join('') || '<span class="muted small">No match in your indexed sites.</span>'}
    <h3 style="font-size:13px;margin:14px 0 4px">From preferred sites' own search</h3>${r.search.map((x) => `<div class="small"><b>${esc(x.host)}</b> ${x.template ? '' : '<span class="muted">(search box could not be used)</span>'}</div>${x.results.map(row).join('')}`).join('') || '<span class="muted small">No preferred sites set, or site search is off in Settings.</span>'}`;
  }),
  matchAll: guard(async () => { $('#mres').innerHTML = '<p><span class="spin"></span>Matching…</p>'; S.mm = await post('/catalogue/match', { onlyMissing: $('#mm-missing').checked }); paintMatches(); }),
  applyMatches: guard(async () => {
    const by = {}; $$('[data-mc]:checked').forEach((c) => (by[c.dataset.mc] ||= []).push(c.value));
    const r = await post('/catalogue/apply', { assignments: Object.entries(by).map(([id, urls]) => ({ id, urls })) });
    toast(`Sources added to ${r.updated} product(s)`); S.mm = null; $('#mres').innerHTML = '';
  }),
  csvMatch: guard(async () => { S.csv = await post('/csv/preview', { text: $('#csvtext').value }); paintCsv(); }),
  csvApply: guard(async () => {
    const rows = S.csv.results.map((x) => { const v = $(`[data-csv="${x.index}"]`).value; return { parsed: x.parsed, action: v.split(':')[0], matchId: v.split(':')[1] }; });
    const r = await post('/csv/apply', { rows, queue: $('#csvq').checked, start: $('#csvs').checked });
    toast(`${r.updated} updated, ${r.created} created, ${r.skipped} skipped${r.queued ? `, ${r.queued} queued` : ''}`); S.csv = null; await load(); S.view = 'queue'; render();
  }),
  resetUsage: guard(async () => { await api('/usage/reset', { method: 'POST' }); toast('Counters reset'); loadUsage(); }),
  saveSettings: guard(async () => {
    const body = {}; $$('[data-set]').forEach((el) => { body[el.dataset.set] = el.type === 'checkbox' ? el.checked : el.value; });
    await api('/settings', { method: 'PUT', body }); toast('Settings saved'); await load();
  }),
};
document.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (a && a.type !== 'checkbox' && ACTS[a.dataset.act]) ACTS[a.dataset.act](a, e); });
document.addEventListener('change', (e) => { const a = e.target; if (a.type === 'checkbox' && a.dataset.act && ACTS[a.dataset.act]) ACTS[a.dataset.act](a, e);
  if (a.dataset.kn !== undefined) guard(() => api('/knowledge', { method: 'PUT', body: { key: a.dataset.kn, text: a.value } }).then(() => { S.knowledge[a.dataset.kn] = a.value; toast('Saved'); }))(); });
document.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.f) onField(e.target); });
// <details> "toggle" does not bubble, so listen in the capture phase to remember which source cards are open
document.addEventListener('toggle', (e) => { const d = e.target; if (d.dataset && d.dataset.evk !== undefined) { (S.panes.open = S.panes.open || {})[d.dataset.evk] = d.open; savePanes(); } }, true);
window.addEventListener('beforeunload', (e) => { if (S.rv && !S.rv.saved) e.preventDefault(); });

load().then(connect).catch((e) => { main.innerHTML = `<div class="empty">Could not reach the engine: ${esc(e.message)}</div>`; });
