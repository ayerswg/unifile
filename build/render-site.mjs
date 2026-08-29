/**
 * Static renderer for the docs/ site — **this is the production site build**
 * (Cloudflare Pages runs `npm run build:site && npm run site:preview` and
 * serves docs/_site).  No Jekyll, no Ruby: plain Node + `marked`.
 *
 *   npm run site:preview      → renders docs/ into docs/_site/
 *   then serve docs/_site (e.g. python3 -m http.server --directory docs/_site)
 *
 * Design: old-school mainframe terminal (green phosphor on black, monospace,
 * ISPF-style option menu).  The home page is a static listing of the apps —
 * each row shows its U-border icon (build/icons.mjs) + codename (uDoc, uPub…)
 * and three actions: INSTALL (per-device walkthrough modal, assets/js/install.js),
 * OPEN (the PWA) and DOWNLOAD (the single-file quine).
 */

import { readFile, writeFile, mkdir, readdir, rm, cp, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { GUIDE_MD } from '../src/writer/guide-content.js';
import { ICONS, iconSvg } from './icons.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const OUT  = join(DOCS, '_site');

const SITE = { title: 'Unifile', description: 'Single-file, offline, version-controlled document apps', baseurl: '' };
const rel = (p) => SITE.baseurl + p;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// types.yml ids → icons.mjs keys (which are DSL ids).
const TYPE_TO_ICON = { markdown: 'markdown', mermaid: 'mermaid', writer: 'writer', abc: 'abcjs' };

// Site favicon: the bare U border, phosphor green.
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">` +
  `<rect width="96" height="96" fill="#0a0f0a"/>` +
  `<path d="M 14 10 L 14 62 A 24 24 0 0 0 38 86 L 58 86 A 24 24 0 0 0 82 62 L 82 10"` +
  ` fill="none" stroke="#4af626" stroke-width="11" stroke-linecap="round"/></svg>`);

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
  try { return JSON.parse(await readFile(join(DOCS, 'version.json'), 'utf8')).version || ''; }
  catch { return ''; }
}
let VERSION = '';

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

/** F-key bar — the footer on every page (links dressed as PF keys). */
function fkeyBar() {
  const v = VERSION ? `<span class="fk-ver">UNIFILE V${esc(VERSION)}</span>` : '';
  return `<footer class="fkeys">
  <a href="${rel('/')}"><b>F1</b>=APPS</a>
  <a href="${rel('/posts/')}"><b>F2</b>=POSTS</a>
  <a href="${rel('/about/')}"><b>F3</b>=ABOUT</a>
  <a href="${rel('/writer/guide/')}"><b>F4</b>=WRITER GUIDE</a>
  ${v}
</footer>`;
}

/** Header strip for inner pages: system name + current path + nav. */
function navBar(url) {
  return `<header class="tbar">
  <a class="tbar-sys" href="${rel('/')}">UNIFILE</a>
  <span class="tbar-path">${esc(url || '')}</span>
  <nav class="tbar-nav">
    <a href="${rel('/')}">APPS</a>
    <a href="${rel('/posts/')}">POSTS</a>
    <a href="${rel('/about/')}">ABOUT</a>
  </nav>
</header>`;
}

// ── home: the primary option menu ───────────────────────────────────────────
function layoutHome(types) {
  const shortName = (t) => t.title.replace(/^Unifile\s+/i, '').toUpperCase();
  // The sysline already says FULLY OFFLINE — drop the redundant tagline suffix
  // so the one-line descriptions fit without truncating.
  const menuDesc = (t) => (t.tagline || '').replace(/\s*[—-]\s*(fully\s+)?offline\.?\s*$/i, '.');
  const rows = types.map((t, i) => {
    const ic = ICONS[TYPE_TO_ICON[t.id]] || {};
    const hub = t.id === 'markdown' ? '/get/' : `/${t.id}/`;
    const dlName = (t.download || '').split('/').pop();
    return `<li class="menu-row">
  <a class="menu-app" href="${rel(hub)}" title="About ${esc(t.title)}">
    <span class="menu-opt">${i + 1}</span>
    <span class="menu-icon">${iconSvg(ic.glyph, { size: 40 })}</span>
    <span class="menu-code">${esc(ic.codename || '')}</span>
    <span class="menu-id">
      <span class="menu-name">${shortName(t)}</span>
      <span class="menu-desc">${esc(menuDesc(t))}</span>
    </span>
  </a>
  <span class="menu-actions">
    <button class="act act-install" data-install data-app="${esc(shortName(t))}"
      data-pwa="${rel(t.pwa)}" data-dl="${rel(t.download)}">INSTALL</button>
    <a class="act" href="${rel(t.pwa)}">OPEN</a>
    <a class="act" href="${rel(t.download)}" download="${esc(dlName)}">DOWNLOAD</a>
  </span>
</li>`;
  }).join('\n');

  return pageHead(SITE.title) + `
<div class="frame">
  <header class="tbar tbar-home">
    <span class="tbar-sys">UNIFILE</span>
    <span class="tbar-title">PRIMARY OPTION MENU</span>
    <span class="tbar-ready">READY<span class="cursor"></span></span>
  </header>

  <p class="sysline">SINGLE-FILE DOCUMENT APPS WITH BUILT-IN VERSION HISTORY.
FULLY OFFLINE &mdash; NO SERVER, NO ACCOUNT, NOTHING LEAVES YOUR DEVICE.</p>

  <div class="rule">SELECT AN APPLICATION</div>

  <ul class="menu">
${rows}
  </ul>

  <div class="rule">NOTES</div>
  <dl class="notes">
    <dt>INSTALL</dt><dd>step-by-step guide for your device &mdash; the app goes on your home screen or dock, works with no connection.</dd>
    <dt>OPEN</dt><dd>run it in the browser; you can install it from there too.</dd>
    <dt>DOWNLOAD</dt><dd>one <code>.html</code> file that <em>is</em> the whole app plus your document and its history &mdash; open it anywhere.</dd>
  </dl>

  ${fkeyBar()}
</div>` + pageFoot();
}

// ── inner pages ─────────────────────────────────────────────────────────────
function layoutPage(meta, contentHtml) {
  const dateLine = meta.date ? `<div class="post-meta">${esc(meta.date)}</div>` : '';
  return pageHead(meta.title) + `
<div class="frame">
  ${navBar(meta.url)}
  <div class="page-body"><h1>${esc(meta.title)}</h1>${dateLine}<div class="content">${contentHtml}</div></div>
  ${fkeyBar()}
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
    `<li><a href="${rel(a.url)}">${esc(a.title)}</a> <span class="app-kind app-kind--${esc(a.kind)}">${esc(a.kind)}</span> <span class="app-desc">${esc(a.excerpt)}</span></li>`
  ).join('\n');
  return `<ul class="app-list">\n${items}\n</ul>`;
}

function renderLauncher(t) {
  if (!t) return '<p>(unknown type)</p>';
  const ic = ICONS[TYPE_TO_ICON[t.id]] || {};
  const feats = (t.features || []).map(f => `<li>${esc(f)}</li>`).join('\n');
  const dlName = (t.download || '').split('/').pop();
  const appName = t.title.replace(/^Unifile\s+/i, '');
  return `<div class="launcher">
  <div class="launch-identity">
    <span class="launch-icon">${iconSvg(ic.glyph, { size: 64 })}</span>
    <div>
      <div class="launch-code">${esc(ic.codename || '')}</div>
      <p class="launch-tagline">${esc(t.tagline || '')}</p>
    </div>
  </div>
  <div id="launch" class="launch-actions" data-pwa="${rel(t.pwa)}" data-download="${rel(t.download)}" data-title="${esc(t.title)}">
    <a class="launch-btn primary" href="${rel(t.pwa)}">Open / install the app</a>
    <a class="launch-btn" href="${rel(t.download)}" download="${esc(dlName)}">Download single .html</a>
  </div>
  <p class="launch-howto">Not sure how to install it?
    <a href="#" data-install data-app="${esc(appName)}" data-pwa="${rel(t.pwa)}" data-dl="${rel(t.download)}">Step-by-step guide for your device</a>.</p>
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
  VERSION = await loadVersion();

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

  // Synthetic page: the Writer guide is authored ONCE in src/writer/guide-content.js
  // (the app renders the same Markdown in its Guide sheet) and published here.
  pages.push({ title: 'Writer Guide', url: '/writer/guide/', body: GUIDE_MD, isHome: false, file: '(generated)' });

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
  for (const d of ['dl', 'pwa-md', 'pwa-mer', 'pwa-abc', 'pwa-wr']) {
    if (await exists(join(DOCS, d))) await cp(join(DOCS, d), join(OUT, d), { recursive: true });
  }
  if (await exists(join(DOCS, 'CNAME'))) await cp(join(DOCS, 'CNAME'), join(OUT, 'CNAME'));
  if (await exists(join(DOCS, 'version.json'))) await cp(join(DOCS, 'version.json'), join(OUT, 'version.json'));

  console.log(`  ✓ rendered ${pages.length} pages + ${posts.length} posts → docs/_site/`);
  console.log(`    preview:  python3 -m http.server 8780 --directory docs/_site`);
}

main().catch(e => { console.error('render-site failed:', e.message); process.exit(1); });
