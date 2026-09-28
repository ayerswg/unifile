/**
 * {slides} DSL plugin — Marp-style slide decks (bare Marpit).
 *
 * The whole document is ONE deck (`wholeDocument: true`): preview.js hands the
 * full source to `render()` instead of splitting it into `===` sections, and
 * the deck engine (src/core/slides/deck.js, pure + Node-tested) does the
 * Markdown → inline-SVG work.  This module is the DOM half:
 *
 *   • render()   — mounts the engraved slides in the preview, tags each
 *                  `<svg>` with its source range (click → source, cursor →
 *                  scroll), and starts the WebKit foreignObject polyfill once.
 *   • editor     — GFM Markdown highlighting + the Marp keymap, front-matter
 *                  autocomplete/lint (theme, paginate, size, …), and the
 *                  IMAGE ASSETS surface: paste / drop an image file → it is
 *                  stored in `data.assets` (base64, OUTSIDE the text) and a
 *                  `![name](name.png)` line is inserted; a line that is just
 *                  such a reference gets a thumbnail block widget under it, so
 *                  the editor never shows base64 (that was the {document}
 *                  app's approach) and the deck text stays diff-friendly.
 *                  Large rasters are downscaled to MAX_EDGE px on the long
 *                  side before storing (a phone photo is ~4 MB; a 1280×720
 *                  slide never needs more than 2× that).
 *   • exports    — PDF (a print window, one slide per page at the deck's own
 *                  @page size) and HTML (one self-contained file: stacked
 *                  slides, click / F to present, arrow keys, prints too).
 *
 * Assets are document-level, NOT versioned: an image an old commit references
 * but no longer exists renders as a broken image.  Unreferenced assets are
 * pruned when the data object is built for a save (app.js), where the
 * serialized history counts as a reference.
 */

import { markdown as cmMarkdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { keymap, EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { linter } from '@codemirror/lint';
import { observe as observeMarpitSvg } from '@marp-team/marpit-svg-polyfill';
import { registerDSL } from './registry.js';
import { state } from '../ui/state.js';
import { getFrontMatterRange } from '../core/front-matter.js';
import { schemaCompletions, schemaLint } from '../core/fm-schema.js';
import {
  renderDeck, deckDocument, deckPrintDocument, THEME_NAMES,
  assetNameFor, uniqueAssetName, parseDataUri, assetDataUri,
} from '../core/slides/deck.js';

/** Long-side cap for stored raster images (px). */
export const MAX_EDGE = 2560;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let _polyfilled = false;

async function render(content, el) {
  el.innerHTML = '';
  if (!content || !content.trim()) {
    el.innerHTML = '<p class="preview-empty">Write Markdown — <code>---</code> on its own line starts a new slide.</p>';
    return;
  }

  const { html, css, slides } = renderDeck(content, { assets: state.data?.assets });

  const wrap = document.createElement('div');
  wrap.className = 'uf-deck';
  const style = document.createElement('style');
  style.textContent = css;
  wrap.appendChild(style);
  wrap.insertAdjacentHTML('beforeend', html);

  // Source ranges on every slide: `data-doc-from/to` drive preview.js's
  // click-back (click a slide → cursor to its source), `data-page-content-*`
  // its cursor → slide scroll sync.
  const svgs = wrap.querySelectorAll('div.marpit > svg[data-marpit-svg]');
  svgs.forEach((svg, i) => {
    const r = slides[i];
    if (r) {
      svg.dataset.docFrom = r.from;
      svg.dataset.docTo = r.to;
      svg.dataset.pageContentFrom = r.from;
      svg.dataset.pageContentTo = r.to;
    }
    svg.dataset.slide = i + 1;
    // Belt and braces for the width:100%/height:auto scaling — browsers derive
    // the ratio from the viewBox, but an explicit aspect-ratio never hurts.
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) svg.style.aspectRatio = `${vb[2]} / ${vb[3]}`;
  });

  el.appendChild(wrap);

  // WebKit mis-scales `<foreignObject>` content inside a scaled svg; Marpit's
  // polyfill fixes the sections up by CSS transform.  It self-detects Safari
  // (no-op elsewhere) and watches the document, so start it once.
  if (!_polyfilled) {
    _polyfilled = true;
    try { observeMarpitSvg(); } catch { /* non-fatal */ }
  }
}

/** Static HTML for the quine's embedded preview. */
function renderToString(content) {
  const { html, css } = renderDeck(content || '', { assets: state.data?.assets });
  return `<div class="uf-deck"><style>${css}</style>${html}</div>`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function _docTitle() {
  return state.data?.title || 'Slides';
}

async function exportHTML(content) {
  const deck = renderDeck(content, { assets: state.data?.assets });
  return new Blob([deckDocument({ ...deck, title: _docTitle() })], { type: 'text/html' });
}

/** PDF = the browser's print dialog on a window holding one slide per page. */
async function exportPDF(content) {
  const deck = renderDeck(content, { assets: state.data?.assets });
  const win = window.open('', '_blank');
  if (!win) return null;   // pop-up blocked
  win.document.open();
  // The window title is the browser's suggested PDF filename.
  win.document.write(deckPrintDocument({ ...deck, title: _docTitle() }));
  win.document.close();
  // Let the SVGs lay out before the dialog opens (onload is unreliable here).
  setTimeout(() => { win.focus(); win.print(); }, 400);
  return null;
}

// ---------------------------------------------------------------------------
// Image assets — paste / drop / pick → data.assets + a reference line
// ---------------------------------------------------------------------------

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(String(e.target.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * The stored `{ type, data }` for an image file: SVG / GIF verbatim; rasters
 * larger than MAX_EDGE on the long side are downscaled through a canvas,
 * keeping PNG as PNG (transparency) and everything else as JPEG.
 */
async function encodeImage(file) {
  const uri = await readAsDataUrl(file);
  const parsed = parseDataUri(uri);
  if (!parsed) return null;
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return parsed;
  try {
    const img = await loadImage(uri);
    const w = img.naturalWidth, h = img.naturalHeight;
    const max = Math.max(w, h);
    if (!max || max <= MAX_EDGE) return parsed;
    const k = MAX_EDGE / max;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return parseDataUri(c.toDataURL(type, 0.88)) || parsed;
  } catch {
    return parsed;
  }
}

/**
 * Store image files as document assets and insert one `![alt](name)` block
 * per image at `at` (an absolute offset; undefined = the editor's cursor).
 * Identical content already stored is reused under its existing name.
 */
export async function addImageFiles(files, { at } = {}) {
  const imgs = Array.from(files || []).filter(f => /^image\//.test(f.type));
  if (!imgs.length) return [];
  const assets = { ...(state.data?.assets || {}) };
  const names = [];
  for (const f of imgs) {
    const enc = await encodeImage(f);
    if (!enc) continue;
    let name = Object.keys(assets).find(n => assets[n].type === enc.type && assets[n].data === enc.data);
    if (!name) {
      name = uniqueAssetName(assetNameFor(f.name, enc.type), assets);
      assets[name] = enc;
    }
    names.push(name);
  }
  if (!names.length) return [];

  // Order matters: the assets land in state first (the widget reads them as
  // the reference line arrives), the reference is inserted (so the save that
  // follows sees it referenced and keeps it), THEN the save is requested.
  state.update({ data: { ...state.data, assets } });
  const text = names.map(n => `![${n.replace(/\.[a-z0-9]+$/i, '')}](${n})`).join('\n\n');
  state.emit('editor-insert-block', { text, at });
  state.emit('assets-change', { assets });
  return names;
}

/** Open the OS file picker (the photo library on phones) and insert the picks. */
export function pickImages() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    addImageFiles(input.files);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

const imageDropPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items.filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return false;
    event.preventDefault();
    addImageFiles(files, { at: view.state.selection.main.head });
    return true;
  },
  drop(event, view) {
    const files = Array.from(event.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    addImageFiles(files, { at: pos ?? undefined });
    return true;
  },
});

// ---------------------------------------------------------------------------
// Editor — image thumbnails under reference lines
// ---------------------------------------------------------------------------

// A line that is nothing but an image reference.  Group 1 = alt, 2 = target.
const IMG_LINE_RE = /^\s*!\[([^\]]*)\]\(\s*([^)\s"']+)(?:\s+"[^"]*")?\s*\)\s*$/;

/** True when the target is a bare asset name (no scheme, no path). */
function isAssetName(target) {
  return !/[:/\\]/.test(target) && !target.startsWith('#');
}

class ImageWidget extends WidgetType {
  constructor(name, uri) { super(); this.name = name; this.uri = uri; }
  eq(other) { return other.name === this.name && other.uri === this.uri; }
  get estimatedHeight() { return this.uri ? 120 : 24; }
  ignoreEvent() { return true; }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'cm-slide-img' + (this.uri ? '' : ' missing');
    if (this.uri) {
      const img = document.createElement('img');
      img.src = this.uri;
      img.alt = this.name;
      img.draggable = false;
      box.appendChild(img);
    } else {
      box.textContent = `no image named ${this.name} — drop or paste one here`;
    }
    return box;
  }
}

const refreshImagesEffect = StateEffect.define();

function buildImageDecos(editorState) {
  const builder = new RangeSetBuilder();
  const assets = state.data?.assets || {};
  const doc = editorState.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.length > 400 || line.text.indexOf('![') === -1) continue;
    const m = IMG_LINE_RE.exec(line.text);
    if (!m || !isAssetName(m[2])) continue;
    const asset = Object.prototype.hasOwnProperty.call(assets, m[2]) ? assets[m[2]] : null;
    builder.add(line.to, line.to, Decoration.widget({
      widget: new ImageWidget(m[2], asset ? assetDataUri(asset) : ''),
      block: true, side: 1,
    }));
  }
  return builder.finish();
}

// Block widgets must come from a StateField (a ViewPlugin may not add them).
const imageWidgetField = StateField.define({
  create(s) { return buildImageDecos(s); },
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some(e => e.is(refreshImagesEffect))) return buildImageDecos(tr.state);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// Assets change without a doc change (a later paste that dedupes onto an
// existing name, a data-file load) → rebuild the thumbnails.
const assetsWatcher = ViewPlugin.fromClass(class {
  constructor(view) {
    this._off = state.on('assets-change', () => view.dispatch({ effects: refreshImagesEffect.of(null) }));
  }
  destroy() { this._off?.(); }
});

// ---------------------------------------------------------------------------
// Editor — front matter schema (Marpit global directives)
// ---------------------------------------------------------------------------

const slidesFrontMatterSchema = {
  title:           { type: 'string', doc: 'Document title (the top bar).' },
  theme:           { type: 'enum', values: THEME_NAMES, doc: 'Slide theme: `default`, `gaia` or `uncover`.' },
  paginate:        { type: 'enum', values: ['true', 'false'], doc: 'Show the slide number on every slide.' },
  size:            { type: 'enum', values: ['16:9', '4:3'], doc: 'Slide canvas: 1280×720 (16:9) or 960×720 (4:3).' },
  headingDivider:  { type: 'number', doc: 'Start a new slide at every heading of this level (or lower), e.g. `2` = every `#`/`##`.' },
  header:          { type: 'string', doc: 'Text drawn at the top of every slide (Markdown allowed).' },
  footer:          { type: 'string', doc: 'Text drawn at the bottom of every slide (Markdown allowed).' },
  class:           { type: 'string', doc: 'CSS class for every slide, e.g. `lead` or `invert` (theme dependent).' },
  backgroundColor: { type: 'string', doc: 'Background colour for every slide.' },
  backgroundImage: { type: 'string', doc: 'Background image for every slide (CSS `url(…)`).' },
  color:           { type: 'string', doc: 'Text colour for every slide.' },
  style:           { type: 'string', doc: 'Extra CSS for the deck (Marp tweak style).' },
  lang:            { type: 'string', doc: 'Language of the deck (the `lang` attribute).' },
  marp:            { type: 'enum', values: ['true'], doc: 'Accepted for Marp compatibility — has no effect here.' },
};

function slidesComplete(context) {
  try {
    const doc = context.state.doc.toString();
    const region = getFrontMatterRange(doc);
    if (region && context.pos <= region.bodyFrom) {
      return schemaCompletions(slidesFrontMatterSchema, region, context.pos, context.explicit);
    }
  } catch { /* ignore */ }
  return null;
}

function slidesLint(view) {
  const doc = view.state.doc.toString();
  const region = getFrontMatterRange(doc);
  if (!region) return [];
  const docLen = doc.length;
  return schemaLint(slidesFrontMatterSchema, region)
    .map(d => ({ ...d, from: Math.max(0, Math.min(d.from, docLen)), to: Math.max(0, Math.min(d.to, docLen)) }))
    .filter(d => d.from <= d.to);
}

function getEditorExtensions() {
  const md = cmMarkdown({ base: markdownLanguage });
  return [
    md,
    md.language.data.of({ autocomplete: slidesComplete }),
    keymap.of(markdownKeymap),
    linter(slidesLint, { delay: 500 }),
    imageWidgetField,
    assetsWatcher,
    imageDropPaste,
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const slidesDSL = {
  id: 'slides',
  label: 'Sl',
  version: '1.0.0',
  name: 'Slides',
  extensions: ['.md'],
  editorMode: 'markdown',

  // The full document is the deck — preview.js bypasses the section/layout
  // machinery and calls render() with everything.
  wholeDocument: true,

  render,
  renderToString,
  print: exportPDF,
  getEditorExtensions,

  // Surfaced by the desktop ⋯ menu and the phone action bubble (editor view).
  actions: [
    { id: 'image', label: 'Insert image…', glyph: '▢', run: () => pickImages() },
  ],

  exporters: {
    pdf:  { label: 'PDF',  mime: 'application/pdf', ext: '.pdf',  export: exportPDF },
    html: { label: 'HTML', mime: 'text/html',       ext: '.html', export: exportHTML },
  },

  detect(content) {
    return /^---\n[\s\S]*?\b(marp|theme|paginate)\s*:/m.test(content) || /^\n?---\s*$/m.test(content);
  },
};

registerDSL(slidesDSL);
export default slidesDSL;
