/**
 * {slides} deck engine — pure (no DOM), Node-tested.
 *
 * Bare Marpit turns a Markdown deck into `<div class="marpit">` of inline
 * SVG slides (one `<svg data-marpit-svg viewBox="0 0 1280 720">` per slide,
 * each holding a `<foreignObject><section>`), plus one CSS string.  The SVG
 * scales with its container, so the same markup is the live preview, the
 * exported HTML and the PDF print body — no script needed.
 *
 * Why bare Marpit and not marp-core: marp-core's extras (twemoji, KaTeX
 * math, highlight.js) fetch from CDNs and add ~1 MB; Marpit is markdown-it +
 * postcss and makes no network call.  The three marp-core themes are vendored
 * as plain CSS (themes.js, web-font @imports stripped) so `theme: gaia` works
 * offline.
 *
 * Source conventions (see preprocess):
 *   • `---` separates slides (Marp's own rule).  A blank line is inserted
 *     before every separator so `text\n---` never becomes a setext heading.
 *   • `===` (unifile's page break in the other apps) is a separator too.
 *   • Images are `![alt](name.png)` where `name.png` is a DOCUMENT ASSET —
 *     stored in `data.assets` (base64, outside the text) and resolved to a
 *     data: URI at render time (resolveAssets).  Marp's own image options
 *     (`![bg]`, `![bg left]`, `![w:300]`, filters) all keep working because
 *     the substitution happens before markdown-it sees the source.  markdown-it
 *     refuses `data:image/svg+xml` links by default, so the Marpit instance
 *     gets a validateLink that allows every `data:image/*`.
 */

import { Marpit } from '@marp-team/marpit';
import { THEMES } from './themes.js';
import { resolveAssets } from '../assets.js';

export const DEFAULT_THEME = 'default';
export const THEME_NAMES = Object.keys(THEMES);

/** Slide canvas (Marpit's default `size: 16:9`). */
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

// Asset helpers live in ../assets.js (Marpit-free, so app.js can import them
// without dragging Marpit into every build); re-exported here for callers.
export {
  assetDataUri, parseDataUri, assetNameFor, uniqueAssetName,
  referencedAssets, resolveAssets, unreferencedAssets, pruneAssets,
} from '../assets.js';

// ---------------------------------------------------------------------------
// Source preprocessing
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const SEP_RE   = /^(-{3,}|={3,})\s*$/;

/**
 * Normalise the slide separators and compute each slide's source range.
 *
 * Returns `{ text, slides }`: `text` is what Marpit renders (every `===` or
 * `---` outside the front matter / code fences becomes `---` preceded by a
 * blank line); `slides[i] = { from, to }` is the i-th slide's char range in
 * the ORIGINAL source (the front matter belongs to the first slide), so the
 * shell can map a cursor to a slide and a slide click back to the source.
 */
export function preprocess(src) {
  const text = String(src || '');
  const lines = text.split('\n');
  const out = [];
  const slides = [];
  let offset = 0;             // char offset of the current line in `src`
  let slideFrom = 0;
  let inFence = false, fenceChar = '';
  let inFrontMatter = false, frontMatterDone = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);

    if (!frontMatterDone) {
      if (i === 0 && /^-{3}\s*$/.test(line)) { inFrontMatter = true; out.push(line); offset += lineLen; continue; }
      if (inFrontMatter) {
        if (/^(-{3}|\.{3})\s*$/.test(line)) { inFrontMatter = false; frontMatterDone = true; }
        out.push(line); offset += lineLen; continue;
      }
      frontMatterDone = true;   // no front matter at all
    }

    const fm = FENCE_RE.exec(line);
    if (fm) {
      const ch = fm[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar) inFence = false;
      out.push(line); offset += lineLen; continue;
    }

    if (!inFence && SEP_RE.test(line)) {
      slides.push({ from: slideFrom, to: offset });
      slideFrom = offset + lineLen;
      if (out.length && out[out.length - 1].trim() !== '') out.push('');
      out.push('---');
      offset += lineLen; continue;
    }

    out.push(line); offset += lineLen;
  }
  slides.push({ from: slideFrom, to: text.length });
  return { text: out.join('\n'), slides };
}

/** Index of the slide whose source range covers `offset` (last slide past the end). */
export function slideIndexAt(slides, offset) {
  for (let i = 0; i < slides.length; i++) if (offset < slides[i].to || i === slides.length - 1) return i;
  return 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let _marpit = null;

/** The shared Marpit instance (themes registered once). */
export function getMarpit() {
  if (_marpit) return _marpit;
  const m = new Marpit({
    inlineSVG: true,
    looseYAML: true,
    // Raw HTML stays OFF: the deck is Markdown, and nothing needs sanitising
    // afterwards.  Comment directives (`<!-- _class: lead -->`) and `<style>`
    // tweaks still work — Marpit parses those itself.
    markdown: { html: false, breaks: true, linkify: false },
  });
  // markdown-it drops `data:` links unless they are gif/png/jpeg/webp — allow
  // every image data URI (svg+xml is the one we care about).
  m.markdown.validateLink = (url) => {
    const u = String(url).trim().toLowerCase();
    if (/^(vbscript|javascript|file):/.test(u)) return false;
    if (/^data:/.test(u)) return /^data:image\//.test(u);
    return true;
  };
  for (const [name, css] of Object.entries(THEMES)) {
    const theme = m.themeSet.add(css);
    if (name === DEFAULT_THEME) m.themeSet.default = theme;
  }
  _marpit = m;
  return m;
}

/**
 * Render a deck.  `{ html, css, slides }` — `html` is Marpit's
 * `<div class="marpit">…</div>`, `css` its stylesheet (scoped to
 * `div.marpit`, includes the `@page` size), `slides` the source ranges.
 */
export function renderDeck(src, { assets } = {}) {
  const { text, slides } = preprocess(src);
  const { html, css } = getMarpit().render(resolveAssets(text, assets));
  return { html, css, slides };
}

// ---------------------------------------------------------------------------
// Standalone documents (HTML export, PDF print body)
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The deck's own page chrome — stacked slides, a present mode, and print rules. */
export const DECK_PAGE_CSS = `
html, body { margin: 0; padding: 0; background: #202124; }
body { font-family: system-ui, sans-serif; }
div.marpit { max-width: 1100px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
div.marpit > svg[data-marpit-svg] {
  display: block; width: 100%; height: auto; margin: 0 0 24px;
  border-radius: 6px; box-shadow: 0 6px 28px rgba(0,0,0,.45); cursor: pointer;
}
body.present { background: #000; overflow: hidden; }
body.present div.marpit { max-width: none; padding: 0; margin: 0; }
body.present div.marpit > svg[data-marpit-svg] {
  display: none; position: fixed; inset: 0; width: 100vw; height: 100vh; margin: 0;
  border-radius: 0; box-shadow: none; cursor: default;
}
body.present div.marpit > svg[data-marpit-svg].current { display: block; }
.uf-deck-hint { position: fixed; right: 12px; bottom: 10px; font: 12px/1.4 system-ui, sans-serif;
  color: #bbb; background: rgba(0,0,0,.55); padding: 4px 8px; border-radius: 4px; pointer-events: none; }
body.present .uf-deck-hint { display: none; }
@media print {
  html, body { background: #fff; }
  div.marpit { max-width: none; padding: 0; margin: 0; }
  div.marpit > svg[data-marpit-svg] { margin: 0; border-radius: 0; box-shadow: none;
    break-after: page; page-break-after: always; }
  div.marpit > svg[data-marpit-svg]:last-child { break-after: auto; page-break-after: auto; }
  .uf-deck-hint { display: none; }
}
`;

/** Keyboard / click navigation for the exported HTML (no dependencies). */
export const DECK_PAGE_SCRIPT = `
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('div.marpit > svg[data-marpit-svg]'));
  if (!slides.length) return;
  var cur = 0;
  function show(i) {
    cur = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach(function (s, j) { s.classList.toggle('current', j === cur); });
    if (document.body.classList.contains('present')) location.hash = '#' + (cur + 1);
  }
  function present(on, i) {
    document.body.classList.toggle('present', on);
    if (on) { show(i == null ? cur : i); }
    else { history.replaceState(null, '', location.pathname + location.search); slides[cur].scrollIntoView({ block: 'center' }); }
  }
  slides.forEach(function (s, i) {
    s.addEventListener('click', function () {
      if (document.body.classList.contains('present')) show(cur + 1); else present(true, i);
    });
  });
  document.addEventListener('keydown', function (e) {
    var on = document.body.classList.contains('present');
    if (e.key === 'Escape' && on) return present(false);
    if ((e.key === 'f' || e.key === 'F' || e.key === 'Enter') && !on) return present(true);
    if (!on) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); show(cur + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); show(cur - 1); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
  });
  var m = /^#(\\d+)$/.exec(location.hash);
  if (m) present(true, parseInt(m[1], 10) - 1);
})();
`;

/**
 * A self-contained HTML page for the deck: stacked slides that click into a
 * full-screen presentation (arrow keys, Esc), and prints one slide per page.
 */
export function deckDocument({ html, css, title = 'Slides' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>${DECK_PAGE_CSS}</style>
<style>${css}</style>
</head>
<body>
${html}
<div class="uf-deck-hint">Click a slide or press F to present · ← → · Esc</div>
<script>${DECK_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * The print body: one slide per page at the deck's own `@page` size (Marpit
 * emits `@page { size: 1280px 720px; margin: 0 }` in `css`), colours forced.
 */
export function deckPrintDocument({ html, css, title = 'Slides' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escHtml(title)}</title>
<style>
html, body { margin: 0; padding: 0; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
div.marpit > svg[data-marpit-svg] { display: block; width: 100vw; height: 100vh; break-after: page; page-break-after: always; }
div.marpit > svg[data-marpit-svg]:last-child { break-after: auto; page-break-after: auto; }
@page { margin: 0; }
</style>
<style>${css}</style>
</head>
<body>${html}</body>
</html>
`;
}
