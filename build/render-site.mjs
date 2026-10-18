/**
 * Static renderer for the docs/ site — **this is the production site build**
 * (Cloudflare Pages runs `npm run build:site && npm run site:preview` and
 * serves docs/_site).  No Jekyll, no Ruby: plain Node + `marked`.
 *
 *   npm run site:preview      → renders docs/ into docs/_site/
 *   then serve docs/_site (e.g. python3 -m http.server --directory docs/_site)
 *
 * Design: a plain white document rendered the way a DSL editor shows Markdown
 * source — one monospaced size, the syntax marks (`#`, `**`, backticks, list
 * dashes) left visible in grey via CSS pseudo-elements, links as plain blue
 * hyperlinks (see assets/css/style.css).  The home page is a static listing of
 * the apps — each row shows its `{glyph}` mark + `{name}` (src/core/brand.js:
 * `{♪} {compose}`, `{¶} {document}`…) and three actions: Install (per-device
 * walkthrough modal, assets/js/install.js), Open (the PWA) and Download (the
 * single-file quine).
 */

import { readFile, writeFile, mkdir, readdir, rm, cp, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { GUIDE_MD } from '../src/upub/guide-content.js';
import { GUIDE_MD as UDRAFT_GUIDE_MD } from '../src/udraft/guide-content.js';
import { APPS, appMark, appName, faviconSvg } from './icons.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const OUT  = join(DOCS, '_site');

const SITE = { title: '{unifile}', description: 'Single-file, offline, version-controlled document apps', baseurl: '' };
const rel = (p) => SITE.baseurl + p;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// types.yml ids → icons.mjs keys (which are DSL ids).
const TYPE_TO_ICON = { markdown: 'markdown', mermaid: 'mermaid', upub: 'upub', abc: 'abcjs', udraft: 'udraft', slides: 'slides', spreadsheet: 'spreadsheet' };

// Site favicon: the bare `{}`, black on white.
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(faviconSvg());

// ── front matter ───────────────────────────────────────────────────────────
function parseFrontMatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

// ── minimal apps.yml parser (list of flat maps) ─────────────────────────────
async function loadApps() {
  const raw = await readFile(join(DOCS, '_data', 'apps.yml'), 'utf8');
  const apps = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const item = line.match(/^-\s+(\w+):\s*(.*)$/);
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (item) { cur = {}; apps.push(cur); cur[item[1]] = clean(item[2]); }
    else if (kv && cur) cur[kv[1]] = clean(kv[2]);
  }
  return apps;
  function clean(v) {
    v = v.replace(/^["']|["']$/g, '').trim();
    if (v === 'true') return true; if (v === 'false') return false;
    return v;
  }
}

// Minimal parser for _data/types.yml (list of maps with a folded `overview:` and
// a nested `features:` list).
async function loadTypes() {
  const raw = await readFile(join(DOCS, '_data', 'types.yml'), 'utf8');
  const types = [];
  let cur = null, mode = null;
  for (const line of raw.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const item = line.match(/^-\s+(\w+):\s*(.*)$/);
    if (item) { cur = { features: [] }; types.push(cur); cur[item[1]] = item[2].trim(); mode = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s{2}(\w+):\s*(.*)$/);
    if (kv) {
      const [, k, v] = kv;
      if (k === 'features') { mode = 'features'; }
      else if (v === '>' || v === '|') { cur[k] = ''; mode = 'fold:' + k; }
      else { cur[k] = v.replace(/^["']|["']$/g, '').trim(); mode = null; }
      continue;
    }
    const feat = line.match(/^\s{4}-\s+(.*)$/);
    if (feat && mode === 'features') { cur.features.push(feat[1].trim()); continue; }
    if (mode && mode.startsWith('fold:') && line.trim()) {
      const k = mode.slice(5);
      cur[k] = (cur[k] ? cur[k] + ' ' : '') + line.trim();
    }
  }
  return types;
}

// ── version (footer stamp) ──────────────────────────────────────────────────
async function loadVersion() {
  try { return JSON.parse(await readFile(join(DOCS, 'version.json'), 'utf8')); }
  catch { return {}; }
}
let VERSION = '';
let BUILD_STAMP = '';   // dev channel: the commit (the identity there) beside the version

// ── shared page chrome ──────────────────────────────────────────────────────
function pageHead(title) {
  const full = title && title !== SITE.title ? `${title} — ${SITE.title}` : SITE.title;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(full)}</title>
<meta name="description" content="${esc(SITE.description)}">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="${rel('/assets/css/style.css')}">
</head><body>`;
}
function pageFoot() {
  return `<script src="${rel('/assets/js/install.js')}" defer></script></body></html>`;
}

/** Footer on every page: a rule, the version, the guides. */
function footer() {
  const v = VERSION ? `unifile v${esc(VERSION)}${BUILD_STAMP ? ` ${esc(BUILD_STAMP)}` : ''} <span class="sep">·</span> ` : '';
  return `<footer class="foot"><hr>
  <p>${v}<a href="${rel('/upub/guide/')}">${esc(appName('upub'))} guide</a> <span class="sep">·</span> <a href="${rel('/udraft/guide/')}">${esc(appName('udraft'))} guide</a></p>
</footer>`;
}

/** Top line on every page: the site name + its few pages. */
function nav() {
  return `<nav class="nav">
  <a class="nav-home" href="${rel('/')}">{unifile}</a>
  <a href="${rel('/')}">apps</a>
  <a href="${rel('/posts/')}">posts</a>
  <a href="${rel('/about/')}">about</a>
</nav>`;
}

// ── home: the app list ──────────────────────────────────────────────────────
function layoutHome(types) {
  const rows = types.map((t) => {
    const id = TYPE_TO_ICON[t.id];
    const name = APPS[id] ? appName(id) : t.title;     // {compose}
    const mark = APPS[id] ? appMark(id) : '{}';        // {♪}
    const hub = t.id === 'markdown' ? '/get/' : `/${t.id}/`;
    const dlName = (t.download || '').split('/').pop();
    // What it edits (the install modal's "Install Markdown" heading too).
    const kind = APPS[id]?.edits || t.title;
    // The intro already says FULLY OFFLINE — drop the taglines' redundant suffix.
    const desc = (t.tagline || '').replace(/\s*[—-]\s*(fully\s+)?offline\.?\s*$/i, '.');
    return `<li class="app">
  <a class="app-name" href="${rel(hub)}" title="About ${esc(name)}"><span class="app-icon">${esc(mark)}</span><strong>${esc(name)}</strong></a> ${esc(kind)} — ${esc(desc)}
  <span class="app-links"><button class="link" data-install data-app="${esc(name)}"
      data-pwa="${rel(t.pwa)}" data-dl="${rel(t.download)}">Install</button>
    <span class="sep">·</span> <a href="${rel(t.pwa)}">Open</a>
    <span class="sep">·</span> <a href="${rel(t.download)}" download="${esc(dlName)}">Download</a></span>
</li>`;
  }).join('\n');

  return pageHead(SITE.title) + `
<div class="doc">
  ${nav()}
  <div class="content">
  <h1>{unifile}</h1>
  <p>Single-file document apps with built-in version history. Fully offline: no server, no account, nothing leaves your device.</p>

  <h2>Apps</h2>
  <ul class="apps">
${rows}
  </ul>

  <h2>Notes</h2>
  <ul>
    <li><strong>Install</strong> — a step-by-step guide for your device. The app goes on your home screen or dock and works with no connection.</li>
    <li><strong>Open</strong> — run it in the browser; you can install it from there too.</li>
    <li><strong>Download</strong> — one <code>.html</code> file that <em>is</em> the whole app plus your document and its history. Open it anywhere.</li>
  </ul>
  </div>
  ${footer()}
</div>` + pageFoot();
}

// ── inner pages ─────────────────────────────────────────────────────────────
function layoutPage(meta, contentHtml) {
  const dateLine = meta.date ? `<p class="dim post-meta">${esc(meta.date)}</p>` : '';
  return pageHead(meta.title) + `
<div class="doc">
  ${nav()}
  <div class="content"><h1>${esc(meta.title)}</h1>${dateLine}${contentHtml}</div>
  ${footer()}
</div>` + pageFoot();
}

// ── content special-cases (Liquid for-loops the renderer fills in) ───────────
function renderPostList(posts) {
  const items = posts.map(p =>
    `<li><span class="post-date">${esc(p.dateISO)}</span><a href="${rel(p.url)}">${esc(p.title)}</a></li>`
  ).join('\n');
  return `<ul class="post-list">\n${items}\n</ul>`;
}
function renderAppList(apps) {
  const items = apps.map(a =>
    `<li><a href="${rel(a.url)}">${esc(a.title)}</a> <span class="app-kind app-kind--${esc(a.kind)}">${esc(a.kind)}</span> — <span class="app-desc">${esc(a.excerpt)}</span></li>`
  ).join('\n');
  return `<ul class="app-list">\n${items}\n</ul>`;
}

function renderLauncher(t) {
  if (!t) return '<p>(unknown type)</p>';
  const id = TYPE_TO_ICON[t.id];
  const name = APPS[id] ? appName(id) : t.title;
  const mark = APPS[id] ? appMark(id) : '{}';
  const feats = (t.features || []).map(f => `<li>${esc(f)}</li>`).join('\n');
  const dlName = (t.download || '').split('/').pop();
  return `<div class="launcher">
  <div class="launch-identity">
    <span class="launch-icon">${esc(mark)}</span>
    <div>
      <div><strong>${esc(name)}</strong></div>
      <p class="launch-tagline"><em>${esc(t.tagline || '')}</em></p>
    </div>
  </div>
  <div id="launch" class="launch-actions" data-pwa="${rel(t.pwa)}" data-download="${rel(t.download)}" data-title="${esc(t.title)}">
    <a class="launch-btn primary" href="${rel(t.pwa)}">Open / install the app</a>
    <a class="launch-btn" href="${rel(t.download)}" download="${esc(dlName)}">Download single .html</a>
  </div>
  <p class="launch-howto">Not sure how to install it?
    <a href="#" data-install data-app="${esc(name)}" data-pwa="${rel(t.pwa)}" data-dl="${rel(t.download)}">Step-by-step guide for your device</a>.</p>
  <div class="launch-overview"><p>${esc(t.overview || '')}</p>
    <ul class="launch-features">\n${feats}\n</ul>
  </div>
</div>
<script src="${rel('/assets/js/launch.js')}" defer></script>`;
}

async function write(outRelPath, html) {
  const dest = join(OUT, outRelPath);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, html, 'utf8');
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const apps = await loadApps();
  const types = await loadTypes();
  const vinfo = await loadVersion();
  VERSION = vinfo.version || '';
  BUILD_STAMP = vinfo.channel === 'dev' && vinfo.commit ? `(dev ${vinfo.commit})` : '';

  // Posts (filename: YYYY-MM-DD-slug.md → /posts/slug/).
  const postFiles = (await readdir(join(DOCS, '_posts'))).filter(f => f.endsWith('.md')).sort().reverse();
  const posts = [];
  for (const f of postFiles) {
    const { meta, body } = parseFrontMatter(await readFile(join(DOCS, '_posts', f), 'utf8'));
    const m = f.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/);
    const dateISO = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
    const slug = m ? m[4] : f.replace(/\.md$/, '');
    const url = `/posts/${slug}/`;
    posts.push({ ...meta, url, dateISO, body });
  }

  // Pages (top-level *.md).
  const pageFiles = (await readdir(DOCS)).filter(f => f.endsWith('.md'));
  const pages = [];
  for (const f of pageFiles) {
    const { meta, body } = parseFrontMatter(await readFile(join(DOCS, f), 'utf8'));
    const isHome = (meta.layout === 'home') || f === 'index.md';
    const url = isHome ? '/' : (meta.permalink || `/${f.replace(/\.md$/, '')}/`);
    pages.push({ ...meta, url, body, isHome, file: f });
  }

  // Synthetic page: the uPub guide is authored ONCE in src/upub/guide-content.js
  // (the app renders the same Markdown in its Guide sheet) and published here.
  pages.push({ title: `${appName('upub')} guide`, url: '/upub/guide/', body: GUIDE_MD, isHome: false, file: '(generated)' });
  pages.push({ title: `${appName('udraft')} guide`, url: '/udraft/guide/', body: UDRAFT_GUIDE_MD, isHome: false, file: '(generated)' });

  // Render pages.
  for (const p of pages) {
    if (p.isHome) { await write('index.html', layoutHome(types)); continue; }
    let body = p.body;
    if (/\{%\s*for\s+post/.test(body)) body = body.replace(/\{%\s*for[\s\S]*?\{%\s*endfor\s*%\}/, renderPostList(posts));
    if (/\{%\s*for\s+app/.test(body))  body = body.replace(/<ul class="app-list">[\s\S]*?<\/ul>/, renderAppList(apps));
    // Launcher include → rendered inline (marked passes the raw HTML through).
    const launcherHtml = /\{%\s*include\s+launcher\.html\s*%\}/.test(body)
      ? renderLauncher(types.find(t => t.id === p.type)) : null;
    if (launcherHtml) body = body.replace(/\{%\s*include\s+launcher\.html\s*%\}/, launcherHtml);
    const html = marked.parse(body);
    const outPath = p.url === '/' ? 'index.html' : p.url.replace(/^\//, '').replace(/\/$/, '') + '/index.html';
    await write(outPath, layoutPage(p, html));
  }

  // Render posts.
  for (const p of posts) {
    const html = marked.parse(p.body);
    await write(p.url.replace(/^\//, '') + 'index.html', layoutPage(p, html));
  }

  // search.json — still published: the in-app site-nav strip (src/ui/site-nav.js)
  // fetches it from the hosted origin to offer quick links.
  const idx = [];
  for (const p of pages) { if (p.nav_exclude === 'true' || p.nav_exclude === true) continue; idx.push({ title: p.title, url: p.url, excerpt: '', date: null, type: 'page', pinned: p.pinned === 'true' || p.pinned === true }); }
  for (const p of posts) idx.push({ title: p.title, url: p.url, excerpt: '', date: p.dateISO, type: 'post', pinned: false });
  for (const a of apps)  idx.push({ title: a.title, url: a.url, excerpt: a.excerpt || '', date: null, type: a.kind || 'app', pinned: !!a.pinned });
  await write('search.json', JSON.stringify(idx, null, 2));

  // Static passthrough: assets + downloads + PWAs + CNAME.
  await cp(join(DOCS, 'assets'), join(OUT, 'assets'), { recursive: true });
  for (const d of ['dl', 'pwa-md', 'pwa-mer', 'pwa-abc', 'pwa-upub', 'pwa-dft', 'pwa-sld', 'pwa-sht']) {
    if (await exists(join(DOCS, d))) await cp(join(DOCS, d), join(OUT, d), { recursive: true });
  }
  if (await exists(join(DOCS, 'CNAME'))) await cp(join(DOCS, 'CNAME'), join(OUT, 'CNAME'));
  if (await exists(join(DOCS, 'version.json'))) await cp(join(DOCS, 'version.json'), join(OUT, 'version.json'));

  console.log(`  ✓ rendered ${pages.length} pages + ${posts.length} posts → docs/_site/`);
  console.log(`    preview:  python3 -m http.server 8780 --directory docs/_site`);
}

main().catch(e => { console.error('render-site failed:', e.message); process.exit(1); });
