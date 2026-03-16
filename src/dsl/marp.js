/**
 * MARP DSL Plugin for unifile-2
 *
 * MARP (Markdown Presentation Ecosystem) turns Markdown into slide decks.
 * Slides are separated by `---`. Directives can be set in YAML front matter
 * or per-slide via HTML comments (`<!-- _class: lead -->`).
 *
 * marp-core v3+ / Marpit v2 outputs SVG-based slides:
 *   <div class="marpit">
 *     <svg data-marpit-svg viewBox="0 0 1280 720">
 *       <foreignObject>…<section>…</section>…</foreignObject>
 *       …possibly multiple foreignObjects for bg-split layouts…
 *     </svg>
 *     …one <svg data-marpit-svg> per slide…
 *   </div>
 *
 * Known markdown-it / Marpit quirk
 * ---------------------------------
 * `---` immediately after a paragraph line is parsed as a setext H2 heading,
 * consuming the `---` before the slide-separator rule can claim it. We
 * pre-process the source to insert a blank line before every `---` separator
 * (outside front matter and code fences) so the separator always wins.
 *
 * Exports
 * -------
 *   PDF   – browser print, one page per slide, sized to the slide viewBox
 *   PPTX  – pptxgenjs, each slide captured to PNG via SVG → canvas
 *
 * File extension: .marp
 */

import { syntaxHighlighting } from '@codemirror/language';
import { markdown as cmMarkdown, markdownKeymap } from '@codemirror/lang-markdown';
import { keymap, ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { catppuccinHighlight } from '../ui/editor-theme.js';
import { Marp } from '@marp-team/marp-core';
import PptxGenJS from 'pptxgenjs';
import { registerDSL } from './registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_W = 1280;
const DEFAULT_H = 720;

// ── Marp factory ─────────────────────────────────────────────────────────────

function makeMarp() {
  return new Marp({ html: true });
}

// ── Pre-processing ────────────────────────────────────────────────────────────

/**
 * Ensure every `---` slide separator has a blank line before it.
 *
 * markdown-it parses `text\n---` as a setext H2 heading. This means a URL
 * or any text immediately before `---` eats the separator before Marpit's
 * slide-split rule can claim it. Inserting a blank line prevents that.
 *
 * We skip `---` lines that are:
 *  • inside the YAML front matter (first ---…--- block)
 *  • inside a fenced code block (``` or ~~~)
 */
function preprocessMarp(content) {
  const lines = content.split('\n');
  const out   = [];
  let inFrontMatter  = false;
  let frontMatterDone = false;
  let inFence  = false;
  let fenceChar = '';

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // ── YAML front matter (very first ---…--- block) ──────────────────────────
    if (!frontMatterDone) {
      if (i === 0 && /^-{3}\s*$/.test(trimmed)) {
        inFrontMatter = true;
        out.push(line); continue;
      }
      if (inFrontMatter) {
        if (/^-{3}\s*$/.test(trimmed)) {
          inFrontMatter  = false;
          frontMatterDone = true;
        }
        out.push(line); continue;
      }
    }

    // ── Fenced code blocks (``` or ~~~) ───────────────────────────────────────
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence   = true;
        fenceChar = fenceMatch[1];
      } else if (line.startsWith(fenceChar)) {
        inFence   = false;
        fenceChar = '';
      }
    }

    // ── Slide separator guard ─────────────────────────────────────────────────
    if (!inFence && !inFrontMatter && /^-{3}\s*$/.test(trimmed)) {
      // If the last written line is non-blank the separator would be consumed
      // as a setext heading underline — inject a blank line to prevent that.
      if (out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

// ── CSS sanitization ──────────────────────────────────────────────────────────

/**
 * Strip remote @import rules so the CSS works fully offline.
 * MARP themes import web fonts from fonts.bunny.net; those won't load offline.
 */
function sanitizeCss(css) {
  return css.replace(/@import\s+url\([^)]+\)[^;]*;/g, '');
}

/**
 * Simplify MARP CSS selectors for use inside a standalone SVG image.
 *
 * When an SVG is loaded as a Blob URL for canvas capture (PPTX export), there
 * is no ancestor DOM around it — so MARP's scoped selectors like:
 *
 *   div.marpit > svg > foreignObject > section { … }
 *
 * never match because `div.marpit`, `svg`, and `foreignObject` don't exist as
 * ancestors of the CSS context inside the standalone SVG.
 *
 * Stripping the ancestor prefix leaves `section { … }` which matches correctly
 * against the `<section>` elements actually present in the foreignObject HTML.
 *
 * We also strip @page and @media print rules which are meaningless in an
 * SVG image context and may confuse the SVG renderer.
 */
function simplifyMarpCss(css) {
  return sanitizeCss(css)
    // Strip @page rules (not applicable inside standalone SVG)
    .replace(/@page\s*\{[^}]*\}/g, '')
    // Strip @media print blocks — handle one level of nested braces
    // e.g. @media print { selector { prop: val } }
    .replace(/@media\s+print\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
    // "div.marpit > svg[...] > foreignObject > X" → "X"  (most specific first)
    .replace(/div\.marpit\s*>\s*svg(?:\[[^\]]*\])?\s*>\s*foreignObject\s*>\s*/g, '')
    // "div.marpit > svg[...] > X" → "X"
    .replace(/div\.marpit\s*>\s*svg(?:\[[^\]]*\])?\s*>\s*/g, '')
    // "div.marpit > X" → "X"
    .replace(/div\.marpit\s*>\s*/g, '');
}

// ── DOM-based slide parsing ───────────────────────────────────────────────────

/**
 * Parse MARP HTML using DOMParser (avoids regex false-negatives on "</svg>"
 * string literals inside the marp-auto-scaling <script>).
 *
 * Returns:
 *   svgEls     – one SVG DOM element per slide
 *   marpScript – the MARP browser-side script text, or null
 *
 * The browser script defines the `marp-auto-scaling` custom element (which
 * scales oversized code blocks to fit the slide) and the `marp-pre` /
 * `marp-h*` polyfills. cloneNode() does NOT re-execute scripts, so we pull
 * the source here and run it once ourselves after inserting slides.
 */
function parseMarpHtml(html) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, 'text/html');
  return {
    svgEls:     Array.from(doc.querySelectorAll('svg[data-marpit-svg]')),
    marpScript: doc.querySelector('script')?.textContent ?? null,
  };
}

/** Convenience wrapper used by export functions that don't need the script. */
function parseSvgSlides(html) {
  return parseMarpHtml(html).svgEls;
}

/**
 * Execute MARP's browser script exactly once per page load.
 * This registers marp-auto-scaling (and related custom elements) so that
 * <pre is="marp-pre"> elements already in the DOM get upgraded and their
 * content is scaled down to fit inside the slide.
 */
function runMarpScriptOnce(scriptText) {
  if (!scriptText) return;
  if (customElements.get('marp-auto-scaling')) return; // already registered
  try {
    const s = document.createElement('script');
    s.textContent = scriptText;
    document.head.appendChild(s);
    document.head.removeChild(s);
  } catch { /* non-fatal — preview still renders, just without auto-scaling */ }
}

/**
 * Read slide dimensions from an SVG element's viewBox attribute.
 */
function parseDimensions(svgEls) {
  if (!svgEls.length) return { w: DEFAULT_W, h: DEFAULT_H };
  const vb = svgEls[0].getAttribute('viewBox') ?? '';
  const parts = vb.split(/\s+/);
  if (parts.length >= 4) {
    const w = parseFloat(parts[2]);
    const h = parseFloat(parts[3]);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: DEFAULT_W, h: DEFAULT_H };
}

// ── Canvas capture (for PPTX) ─────────────────────────────────────────────────

/**
 * Render a MARP slide SVG element to a PNG data URL via canvas.
 *
 * Key challenges and mitigations:
 *
 * 1. Namespace issue — SVG elements extracted from an HTML-parsed document may
 *    have incorrect namespace declarations after DOM mutation. We serialize
 *    first with XMLSerializer, then inject CSS as a raw string so the style
 *    element gets an explicit `xmlns="…/xhtml"` declaration that the SVG XML
 *    parser will accept.
 *
 * 2. Empty namespace artifacts — XMLSerializer sometimes emits `xmlns:NS1=""`
 *    empty declarations; these are stripped before creating the Blob.
 *
 * 3. Script blocking — Chrome refuses to load SVG images that contain <script>
 *    elements. Any scripts in the clone are removed before serialization.
 *
 * 4. Chrome foreignObject stall — Chrome can silently stall (neither onload
 *    nor onerror fires) when loading SVG images whose foreignObject content it
 *    cannot fully process. A hard 8-second timeout guards against this so the
 *    PPTX export always completes (the caller falls back to a text slide).
 */
async function svgElToDataURL(svgEl, css, w, h) {
  // Clone and set explicit pixel dimensions for canvas rendering
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('width',  String(w));
  clone.setAttribute('height', String(h));

  // Chrome blocks SVG images that contain <script> elements
  for (const s of clone.querySelectorAll('script')) s.remove();

  // Serialize to an XML string — do CSS injection afterwards as a string
  // operation to avoid cross-document namespace issues from DOM mutation.
  let svgStr = new XMLSerializer().serializeToString(clone);

  // Strip empty namespace declarations that XMLSerializer may emit (e.g.
  // xmlns:NS1="" which can confuse strict XML parsers).
  svgStr = svgStr.replace(/\s+xmlns:[a-zA-Z0-9_-]+=""/g, '');

  // Inject theme CSS into every <foreignObject> via string replacement.
  // The style element must carry xmlns="…/xhtml" so the SVG XML parser
  // treats it as an HTML element and cascades it to the <section> children.
  const safeCss = simplifyMarpCss(css);
  svgStr = svgStr.replace(
    /(<foreignObject\b[^>]*>)/g,
    `$1<style xmlns="http://www.w3.org/1999/xhtml">${safeCss}</style>`,
  );

  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  return new Promise((resolve, reject) => {
    // Hard timeout: Chrome can stall indefinitely on SVG images with complex
    // foreignObject content (neither onload nor onerror fires). After 8 s we
    // give up so the caller can use its text-based fallback slide instead.
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error('Slide image timed out'));
    }, 8000);

    const img = new Image();
    img.onload = () => {
      clearTimeout(timer);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error('SVG slide failed to render'));
    };
    img.src = url;
  });
}

// ── Preview renderer ──────────────────────────────────────────────────────────

async function render(content, el) {
  el.innerHTML = '';

  let html, css;
  try {
    ({ html, css } = makeMarp().render(preprocessMarp(content)));
  } catch (e) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'color:#f38ba8;padding:16px;white-space:pre-wrap;font-size:13px;';
    pre.textContent   = `MARP error: ${e.message}`;
    el.appendChild(pre);
    return;
  }

  const { svgEls, marpScript } = parseMarpHtml(html);
  const { w: slideW, h: slideH } = parseDimensions(svgEls);

  // Root container
  const root = document.createElement('div');
  root.style.cssText = `
    padding: 24px 20px;
    background: #1e1e2e;
    min-height: 100%;
    font-family: system-ui, sans-serif;
  `;

  // Slide count chip
  const chip = document.createElement('div');
  chip.style.cssText = `
    color: #585b70;
    font-size: 11px;
    font-family: monospace;
    letter-spacing: .05em;
    text-transform: uppercase;
    margin-bottom: 20px;
  `;
  chip.textContent = `${svgEls.length} slide${svgEls.length !== 1 ? 's' : ''}`;
  root.appendChild(chip);

  // Inject MARP theme CSS once (sanitized — remote @imports stripped).
  const style = document.createElement('style');
  style.textContent = sanitizeCss(css);
  root.appendChild(style);

  // ── Single div.marpit containing ALL slide SVGs as direct children ─────────
  //
  // MARP's CSS uses nth-child selectors on the SVG elements to apply per-slide
  // styles (per-slide backgrounds, class overrides, etc.):
  //
  //   div.marpit > svg[data-marpit-svg]:nth-child(1) > foreignObject > section
  //   div.marpit > svg[data-marpit-svg]:nth-child(2) > foreignObject > section
  //   …
  //
  // If each SVG is wrapped in its own div.marpit, every SVG becomes nth-child(1)
  // and all slide-2+ rules are ignored — causing the "lost padding" bug.
  // Keeping every SVG as a direct child of ONE shared div.marpit preserves the
  // correct nth-child indices so all per-slide theme rules fire correctly.
  //
  // Card styling (border-radius, shadow) is applied directly to the SVG elements.
  // The SVG's viewBox="0 0 W H" plus width:100% / aspect-ratio CSS gives the
  // correct scaled aspect ratio without a separate padding-bottom wrapper.

  const marpitDiv = document.createElement('div');
  marpitDiv.className = 'marpit';
  marpitDiv.style.cssText = 'display:block;';

  svgEls.forEach((svgEl) => {
    const adoptedSvg = document.adoptNode(svgEl.cloneNode(true));
    adoptedSvg.removeAttribute('width');
    adoptedSvg.removeAttribute('height');
    adoptedSvg.style.cssText = `
      display: block;
      width: 100%;
      aspect-ratio: ${slideW} / ${slideH};
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 6px 28px rgba(0,0,0,.55);
      margin-bottom: 28px;
    `;
    marpitDiv.appendChild(adoptedSvg);
  });

  root.appendChild(marpitDiv);

  el.appendChild(root);

  // Activate MARP's custom elements (marp-auto-scaling, marp-pre, etc.) so
  // that oversized content — e.g. code blocks — is scaled down to fit the
  // slide. cloneNode() never re-runs scripts, so we do it manually once.
  runMarpScriptOnce(marpScript);
}

// ── renderToString ────────────────────────────────────────────────────────────

function renderToString(content) {
  const { html, css } = makeMarp().render(preprocessMarp(content));
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<style>${sanitizeCss(css)}</style>
</head>
<body>${html}</body>
</html>`;
}

// ── PDF export ────────────────────────────────────────────────────────────────

async function exportPDF(content) {
  const { html, css } = makeMarp().render(preprocessMarp(content));
  const { marpScript } = parseMarpHtml(html);

  // Use the raw MARP HTML directly — it already has the correct structure:
  //   <div class="marpit">
  //     <svg data-marpit-svg viewBox="0 0 1280 720">…</svg>
  //     …one SVG per slide…
  //   </div>
  //
  // MARP's own CSS already contains:
  //   @page { size: 1280px 720px; margin: 0 }
  //   @media print { div.marpit > svg[data-marpit-svg] { height:100vh; width:100vw } }
  //
  // We add page-break-after rules so each SVG prints on its own page, and
  // include MARP's browser script so marp-auto-scaling registers correctly.

  const printHtml = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Slides</title>
<style>
  html, body {
    margin: 0; padding: 0; background: white;
    /* Ensure slide background colours and images are printed */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  ${sanitizeCss(css)}
  /*
   * Guarantee zero page margins (i.e. no browser-injected URL / date /
   * page-number headers or footers). MARP's CSS already contains an @page
   * rule, but we repeat it here so it wins regardless of cascade order.
   */
  @page { margin: 0; }
  @media print {
    div.marpit > svg[data-marpit-svg] {
      break-after: page;
      page-break-after: always;
    }
    div.marpit > svg[data-marpit-svg]:last-child {
      break-after: auto;
      page-break-after: auto;
    }
  }
</style>
</head>
<body>
${html}
${marpScript ? `<script>${marpScript}<\/script>` : ''}
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) return null;
  win.document.open();
  win.document.write(printHtml);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 800);
  return null;
}

// ── PPTX export ───────────────────────────────────────────────────────────────

async function exportPPTX(content) {
  const { html, css } = makeMarp().render(preprocessMarp(content));
  const svgEls = parseSvgSlides(html);
  const { w: slideW, h: slideH } = parseDimensions(svgEls);

  const pptx = new PptxGenJS();
  pptx.layout = (slideW / slideH) > 1.5 ? 'LAYOUT_WIDE' : 'LAYOUT_4x3';

  for (let i = 0; i < svgEls.length; i++) {
    const slide = pptx.addSlide();
    try {
      const dataURL = await svgElToDataURL(svgEls[i], css, slideW, slideH);
      slide.addImage({ data: dataURL, x: 0, y: 0, w: '100%', h: '100%' });
    } catch {
      // Canvas capture failed (common when the browser blocks foreignObject
      // rendering in SVG images). Fall back to a text placeholder so the
      // PPTX file still downloads and contains readable slide titles.
      const heading = svgEls[i].querySelector('h1, h2, h3');
      const label   = heading?.textContent?.trim() ?? `Slide ${i + 1}`;
      slide.addText(label, {
        x: '10%', y: '35%', w: '80%', h: '30%',
        align: 'center', fontSize: 40, color: '333333',
        bold: true,
      });
    }
  }

  return await pptx.write({ outputType: 'blob' });
}

// ── CodeMirror editor extensions ──────────────────────────────────────────────
//
// The StreamLanguage approach (CM5-compat token-per-character) does not produce
// a Lezer syntax tree, so markdownKeymap commands (insertNewlineContinueMarkup,
// deleteMarkupBackward, …) always return false — list continuation never fires.
//
// Switching to markdown() gives us the full CM6 Lezer tree that markdownKeymap
// requires. MARP-specific highlighting (YAML front matter, slide separators) is
// replicated via a lightweight ViewPlugin that applies Decoration.mark to the
// relevant line ranges.

// ── MARP decoration marks ─────────────────────────────────────────────────────

const marpFmSepMark  = Decoration.mark({ class: 'cm-marp-fm'  }); // front-matter --- (mauve)
const marpYamlKeyMk  = Decoration.mark({ class: 'cm-marp-key' }); // YAML key (red/atom)
const marpYamlValMk  = Decoration.mark({ class: 'cm-marp-val' }); // YAML value (muted)
const marpSlideSepMk = Decoration.mark({ class: 'cm-marp-sep' }); // slide separator (green)

/** Build decorations for the YAML front matter and slide separators. */
function buildMarpDecos(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  let inFrontMatter  = false;
  let frontMatterDone = false;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;

    if (/^-{3}\s*$/.test(text)) {
      if (!frontMatterDone) {
        if (!inFrontMatter && n === 1) {
          // Opening front-matter fence
          inFrontMatter = true;
          builder.add(line.from, line.to, marpFmSepMark);
        } else if (inFrontMatter) {
          // Closing front-matter fence
          inFrontMatter  = false;
          frontMatterDone = true;
          builder.add(line.from, line.to, marpFmSepMark);
        } else {
          builder.add(line.from, line.to, marpSlideSepMk);
        }
      } else {
        builder.add(line.from, line.to, marpSlideSepMk);
      }
      continue;
    }

    if (inFrontMatter) {
      // YAML key:  anything matching /^\w[\w-]*\s*:/ at line start
      const keyMatch = text.match(/^([\w][\w-]*)(\s*:)/);
      if (keyMatch) {
        builder.add(line.from, line.from + keyMatch[1].length, marpYamlKeyMk);
        builder.add(line.from + keyMatch[1].length, line.to,   marpYamlValMk);
      } else {
        builder.add(line.from, line.to, marpYamlValMk);
      }
    }
  }

  return builder.finish();
}

const marpDecoPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildMarpDecos(view); }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildMarpDecos(u.view);
    }
  },
  { decorations: v => v.decorations },
);

// Use !important so these override the markdown() language's own token colours
// for the same ranges (HorizontalRule → dark-grey would otherwise win).
const marpEditorTheme = EditorView.baseTheme({
  '.cm-marp-fm'  : { color: 'var(--hl-keyword) !important' },
  '.cm-marp-key' : { color: 'var(--hl-atom)    !important', fontWeight: 'bold' },
  '.cm-marp-val' : { color: 'var(--hl-meta)    !important' },
  '.cm-marp-sep' : { color: 'var(--hl-string)  !important' },
});

function getEditorExtensions() {
  return [
    cmMarkdown(),                        // Lezer syntax tree → markdownKeymap works
    syntaxHighlighting(catppuccinHighlight),
    keymap.of(markdownKeymap),           // list continuation, Tab indent, smart Backspace
    marpDecoPlugin,                      // front-matter + slide-separator colours
    marpEditorTheme,
  ];
}

// ── Detection ─────────────────────────────────────────────────────────────────

function detect(content) {
  // YAML front matter with MARP-specific directives
  return /^---\r?\n[\s\S]*?\b(?:marp:\s*true|theme:|paginate:|backgroundColor:)/m.test(content);
}

// ── Plugin registration ───────────────────────────────────────────────────────

registerDSL({
  id: 'marp',
  label: 'Mp',
  version: '1.0.0',
  name: 'MARP Slides',
  extensions: ['.marp'],
  editorMode: 'marp',
  detect,
  render,
  renderToString,
  getEditorExtensions,
  exporters: {
    pdf: {
      label: 'PDF',
      mime: 'application/pdf',
      ext: '.pdf',
      async export(content) { return exportPDF(content); },
    },
    pptx: {
      label: 'PPTX',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ext: '.pptx',
      binary: true,
      async export(content) { return exportPPTX(content); },
    },
  },
});
