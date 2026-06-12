/**
 * Local static renderer for the docs/ site — a no-Ruby way to PREVIEW the
 * command-bar site without installing Jekyll (this machine's Ruby is too old).
 *
 *   npm run site:preview      → renders docs/ into docs/_site/
 *   then serve docs/_site (e.g. python3 -m http.server --directory docs/_site)
 *
 * NOTE: production still builds with real Jekyll on GitHub Pages.  This renderer
 * mirrors the same layouts/output for local visual checks; if you change the
 * Jekyll layouts substantially, update the templates here too.  It uses `marked`
 * (already a dependency) for Markdown and reads docs/_data/apps.yml for the
 * downloads/PWA list.
 */

import { readFile, writeFile, mkdir, readdir, rm, cp, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const OUT  = join(DOCS, '_site');

const SITE = { title: 'Unifile', description: 'A universal file format for ideas', baseurl: '' };
const rel = (p) => SITE.baseurl + p;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

// ── layouts (mirror docs/_layouts/*.html) ───────────────────────────────────
function pageHead(title) {
  const full = title && title !== SITE.title ? `${title} — ${SITE.title}` : SITE.title;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(full)}</title>
<script>(function(){var t=localStorage.getItem('uf-theme')||'light';document.documentElement.setAttribute('data-theme',t);})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${rel('/assets/css/style.css')}">
</head><body>`;
}
function pageFoot() {
  return `<script>window.SITE_BASEURL = ${JSON.stringify(SITE.baseurl)};</script>
<script src="${rel('/assets/js/search.js')}"></script></body></html>`;
}
const navBar = () => `<nav id="site-nav">
  <span class="prompt-glyph">&gt;</span>
  <div class="nav-search-wrap">
    <span id="nav-display"></span>
    <input id="nav-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="type to navigate..." style="display:none">
  </div>
  <button id="theme-toggle" aria-label="Toggle theme"></button>
</nav>`;

function layoutHome() {
  return pageHead(SITE.title) + `
<button id="home-theme-toggle" aria-label="Toggle theme"></button>
<div id="home-wrap">
  <div id="home-wordmark">unifile.app</div>
  <div id="home-prompt-row">
    <span id="home-prompt-glyph">&gt;</span>
    <div id="home-search-wrap">
      <input id="home-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="type to navigate...">
    </div>
  </div>
  <div id="home-hint">↑↓ to move &nbsp;·&nbsp; ↵ to go &nbsp;·&nbsp; esc to clear</div>
</div>` + pageFoot();
}
function layoutPage(meta, contentHtml) {
  const nav = navBar().replace('<span id="nav-display"></span>', `<span id="nav-display">${esc(meta.url)}</span>`);
  const dateLine = meta.date ? `<div class="post-meta">${esc(meta.date)}</div>` : '';
  return pageHead(meta.title) + nav +
    `<div class="page-body"><h1>${esc(meta.title)}</h1>${dateLine}<div class="content">${contentHtml}</div></div>` +
    pageFoot();
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

  // Render pages.
  for (const p of pages) {
    if (p.isHome) { await write('index.html', layoutHome()); continue; }
    let body = p.body;
    if (/\{%\s*for\s+post/.test(body)) body = body.replace(/\{%\s*for[\s\S]*?\{%\s*endfor\s*%\}/, renderPostList(posts));
    if (/\{%\s*for\s+app/.test(body))  body = body.replace(/<ul class="app-list">[\s\S]*?<\/ul>/, renderAppList(apps));
    const html = marked.parse(body);
    const outPath = p.url === '/' ? 'index.html' : p.url.replace(/^\//, '').replace(/\/$/, '') + '/index.html';
    await write(outPath, layoutPage(p, html));
  }

  // Render posts.
  for (const p of posts) {
    const html = marked.parse(p.body);
    await write(p.url.replace(/^\//, '') + 'index.html', layoutPage(p, html));
  }

  // search.json (pages + posts + apps) — mirrors docs/search.json output.
  const idx = [];
  for (const p of pages) idx.push({ title: p.title, url: p.url, excerpt: '', date: null, type: 'page', pinned: p.pinned === 'true' || p.pinned === true });
  for (const p of posts) idx.push({ title: p.title, url: p.url, excerpt: '', date: p.dateISO, type: 'post', pinned: false });
  for (const a of apps)  idx.push({ title: a.title, url: a.url, excerpt: a.excerpt || '', date: null, type: a.kind || 'app', pinned: !!a.pinned });
  await write('search.json', JSON.stringify(idx, null, 2));

  // Static passthrough: assets + downloads + PWAs + CNAME.
  await cp(join(DOCS, 'assets'), join(OUT, 'assets'), { recursive: true });
  for (const d of ['dl', 'pwa', 'pwa-abc']) {
    if (await exists(join(DOCS, d))) await cp(join(DOCS, d), join(OUT, d), { recursive: true });
  }
  if (await exists(join(DOCS, 'CNAME'))) await cp(join(DOCS, 'CNAME'), join(OUT, 'CNAME'));

  console.log(`  ✓ rendered ${pages.length} pages + ${posts.length} posts → docs/_site/`);
  console.log(`    preview:  python3 -m http.server 8780 --directory docs/_site`);
}

main().catch(e => { console.error('render-site failed:', e.message); process.exit(1); });
