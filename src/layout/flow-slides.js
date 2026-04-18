/**
 * Flow → Slides layout renderer.
 *
 * Renders a document with `layout: slides` in its global front matter as a
 * slide deck preview.  Each slide is delimited by a bare `===` line (3+ equals,
 * not inside a code fence).  Content within a slide can contain embedded DSL
 * sections via the usual `#!<dslId>` shebang syntax, e.g.:
 *
 *   ---
 *   model: flow
 *   layout: slides
 *   dimensions: 16:9
 *   ---
 *
 *   # Title Slide
 *
 *   Subtitle text
 *
 *   ===
 *
 *   ## Data Slide
 *
 *   #!mermaid
 *   pie title Budget
 *     "Dev" : 45
 *     "Design" : 20
 *     "Other" : 35
 *
 *   ===
 *
 * In slides mode `===` is always a slide separator. `---` inside slide
 * content is passed through to the DSL renderer (markdown treats it as `<hr>`).
 *
 * Front matter keys consumed:
 *   dimensions  — 16:9 | 4:3 | 1:1 | a4 | letter | WxH  (default: 16:9)
 */

import { parseDocSections } from '../core/doc-sections.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { getDSL } from '../dsl/registry.js';
import { attachScaleObserver, detachScaleObserver } from './_scale.js';
import PptxGenJS from 'pptxgenjs';

// Intrinsic design width for all slides — zoom scales this to fit the container.
const SLIDE_INTRINSIC_W = 960;

// Aspect ratios for preset dimension names — used as `aspect-ratio` values.
const ASPECT_RATIO = {
  '16:9':   '16 / 9',
  '4:3':    '4 / 3',
  '1:1':    '1 / 1',
  'a4':     '210 / 297',   // portrait A4
  'letter': '85 / 110',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a slides-layout document into `container`.
 *
 * Clears the container and builds the slide deck.  Each slide is an
 * aspect-ratio box rendered with whatever DSLs appear in its content.
 *
 * @param {string}      content   Full document content (including front matter)
 * @param {HTMLElement} container Target preview element (`.preview-content`)
 */
export async function renderSlides(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const ar     = _aspectRatio(meta.dimensions);
  // `margin:` in front matter overrides the default slide frame padding.
  // Accepts any CSS padding shorthand: "40px", "40px 60px", etc.
  const margin = meta.margin ?? null;   // null → keep CSS default (48px 56px)
  const slides = _splitSlides(content, bodyFrom);

  container.innerHTML = '';
  container.classList.add('slides-mode');

  const deck = document.createElement('div');
  deck.className = 'uf-slide-deck';
  if (meta.theme && meta.theme !== 'default') {
    deck.classList.add(`theme-${_safeClass(meta.theme)}`);
  }
  container.appendChild(deck);

  // `dsl:` front matter sets the default DSL for segments that have no #!shebang.
  // It persists across === breaks so fountain (etc.) doesn't have to repeat #!fountain
  // on every slide.
  let currentDslId = meta.dsl ?? 'markdown';

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const outer = document.createElement('div');
    outer.className  = 'uf-slide';
    // Fixed intrinsic size — zoom (set by ResizeObserver) handles visual scaling.
    outer.style.width       = `${SLIDE_INTRINSIC_W}px`;
    outer.style.aspectRatio = ar;
    outer.setAttribute('aria-label', `Slide ${i + 1} of ${slides.length}`);
    outer.dataset.docFrom = slide.from;

    const frame = document.createElement('div');
    frame.className = 'uf-slide-frame';
    if (margin) frame.style.padding = margin;   // override CSS default when specified
    outer.appendChild(frame);

    const badge = document.createElement('div');
    badge.className   = 'uf-slide-num';
    badge.textContent = `${i + 1} / ${slides.length}`;
    badge.setAttribute('aria-hidden', 'true');
    outer.appendChild(badge);

    deck.appendChild(outer);

    // Render content — currentDslId carries the last-declared DSL across === breaks.
    currentDslId = await _renderSlideContent(slide.text, frame, slide.from, currentDslId);
  }

  // Scale slides to fit the container width (print-preview style — no reflow).
  attachScaleObserver(container, '.uf-slide', SLIDE_INTRINSIC_W);
}

/**
 * Strip the slides-mode CSS class when leaving slides layout.
 * Called by preview.js when switching away from slides mode.
 * @param {HTMLElement} container
 */
export function teardownSlides(container) {
  detachScaleObserver(container);
  container.classList.remove('slides-mode');
}

/**
 * Trigger a print/PDF export that matches the preview exactly.
 *
 * Resets CSS zoom to 1 on every slide (the preview uses zoom to fit the pane),
 * injects an @page rule that matches the slide's intrinsic dimensions, triggers
 * window.print(), then restores everything via the afterprint event.
 *
 * @param {HTMLElement} container  The `.preview-content` element in slides-mode
 */
export function printSlides(container) {
  const slides = [...container.querySelectorAll('.uf-slide')];
  if (!slides.length) { window.print(); return; }

  // Reset zoom so slides render at their intrinsic size for printing.
  slides.forEach(el => {
    el.dataset.printZoom = el.style.zoom || '';
    el.style.zoom = '1';
  });

  // Read intrinsic dimensions from the first slide after zoom reset.
  const first  = slides[0];
  const slideW = first.offsetWidth  || SLIDE_INTRINSIC_W;
  const slideH = first.offsetHeight || Math.round(SLIDE_INTRINSIC_W * 9 / 16);

  // Inject @page rule so the browser matches the slide canvas exactly.
  let printStyle = document.getElementById('uf-print-page');
  if (!printStyle) {
    printStyle = document.createElement('style');
    printStyle.id = 'uf-print-page';
    document.head.appendChild(printStyle);
  }
  printStyle.textContent = `@page { size: ${slideW}px ${slideH}px; margin: 0; }`;

  window.addEventListener('afterprint', () => {
    printStyle.remove();
    slides.forEach(el => {
      el.style.zoom = el.dataset.printZoom || '';
      delete el.dataset.printZoom;
    });
    // Re-attach scale observer so the preview returns to fit-width display.
    detachScaleObserver(container);
    attachScaleObserver(container, '.uf-slide', SLIDE_INTRINSIC_W);
  }, { once: true });

  window.print();
}

// ---------------------------------------------------------------------------
// Slide splitting
// ---------------------------------------------------------------------------

/**
 * Split the document body into individual slide objects with text and source offset.
 *
 * A bare `===` line (3+ equals, optional trailing whitespace, not inside a
 * code fence) acts as the slide separator.  The global front matter block
 * (before `bodyFrom`) is excluded.
 *
 * @param {string} content   Full document content
 * @param {number} bodyFrom  Offset where body starts (from parseGlobalFrontMatter)
 * @returns {{ text: string, from: number }[]}  Slides with source offsets
 */
function _splitSlides(content, bodyFrom) {
  const body   = content.slice(bodyFrom);
  const slides = [];
  const lines  = body.split('\n');
  let current  = [];
  let currentFrom = bodyFrom; // absolute offset of the start of current accumulation
  let offset   = bodyFrom;    // tracks absolute offset as we advance through lines
  let inFence  = false;
  let fenceChar = '';

  for (const line of lines) {
    // Track code fences so `---` inside ``` or ~~~ is not treated as a separator.
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence   = true;
        fenceChar = ch;
      } else if (ch === fenceChar && /^[`~]+\s*$/.test(line.trimStart())) {
        inFence = false;
      }
    }

    if (!inFence && /^={3,}\s*$/.test(line)) {
      const raw = current.join('\n');
      const s   = raw.trim();
      if (s) {
        // Point `from` at the first non-whitespace character so that
        // click-back positions land on actual content, not blank lines.
        const lead = raw.search(/\S/);
        slides.push({ text: s, from: currentFrom + (lead >= 0 ? lead : 0) });
      }
      offset += line.length + 1; // +1 for the '\n'
      current = [];
      currentFrom = offset;
    } else {
      current.push(line);
      offset += line.length + 1;
    }
  }

  const lastRaw = current.join('\n');
  const last    = lastRaw.trim();
  if (last) {
    const lead = lastRaw.search(/\S/);
    slides.push({ text: last, from: currentFrom + (lead >= 0 ? lead : 0) });
  }

  return slides.length ? slides : [{ text: '', from: bodyFrom }];
}

// ---------------------------------------------------------------------------
// Per-slide rendering
// ---------------------------------------------------------------------------

/**
 * Render a single slide's content into `el`.
 *
 * Handles embedded `#!dslId` sections: the text before the first shebang
 * is rendered as markdown; each shebang section is rendered by its DSL.
 *
 * @param {string}      slideText  Slide content (positions relative to this string)
 * @param {HTMLElement} el         The `.uf-slide-frame` element
 */
/**
 * Render one slide's content into `el`, returning the last DSL used.
 *
 * `defaultDslId` is the DSL inherited from the previous slide (or from
 * `meta.dsl`).  It is used for any content that has no #!shebang — including
 * the preamble before the first shebang within this slide.  The return value
 * becomes the next slide's `defaultDslId`, so the active DSL carries across
 * === breaks without requiring a repeated #!shebang on every slide.
 *
 * @param {string}      slideText    Slide content (trimmed; position 0 = slideFrom)
 * @param {HTMLElement} el           The `.uf-slide-frame` element
 * @param {number}      slideFrom    Absolute document offset of slideText[0]
 * @param {string}      defaultDslId DSL to use when no shebang is present
 * @returns {string}  The last DSL used in this slide (to carry forward)
 */
async function _renderSlideContent(slideText, el, slideFrom, defaultDslId = 'markdown') {
  const sections = parseDocSections(slideText);
  let outDslId = defaultDslId;

  if (!sections.length) {
    // No shebangs — render the entire slide with the inherited DSL.
    await _renderPart(defaultDslId, slideText, el, slideFrom, slideFrom + slideText.length, slideFrom);
    return outDslId;
  }

  // Content before the first shebang → inherited DSL (not forced to markdown).
  const preambleRaw = slideText.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = slideFrom + (lead >= 0 ? lead : 0);
    await _renderPart(defaultDslId, preamble, el,
      pFrom,
      slideFrom + sections[0].from,
      pFrom);
  }

  // Each shebang section — update outDslId so it carries to the next slide.
  for (let i = 0; i < sections.length; i++) {
    const sec  = sections[i];
    const raw  = slideText.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        slideFrom + sec.from,
        slideFrom + sec.to,
        slideFrom + sec.contentFrom + (lead >= 0 ? lead : 0));
    }
    outDslId = sec.dslId;
  }

  return outDslId;
}

async function _renderPart(dslId, text, parentEl, docFrom, docTo, contentFrom) {
  const wrap = document.createElement('div');
  wrap.className = `uf-slide-part uf-dsl-${_safeClass(dslId)}`;
  // docFrom/docTo bracket the whole section including the shebang line.
  if (docFrom != null) wrap.dataset.docFrom = docFrom;
  if (docTo   != null) wrap.dataset.docTo   = docTo;
  // dslContentFrom is the absolute offset of the first character of the *content*
  // (after the shebang line and any leading whitespace).  DSL renderers that
  // annotate fine-grained elements (fountain, mermaid, abcjs) use this as their
  // base offset so click-back lands on the specific element, not just the block.
  if (contentFrom != null) wrap.dataset.dslContentFrom = contentFrom;
  parentEl.appendChild(wrap);

  try {
    const dsl = getDSL(dslId);
    await dsl.render(text, wrap);
  } catch (err) {
    wrap.innerHTML = `<pre class="error">${_esc(dslId)} error: ${_esc(err.message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _aspectRatio(dim) {
  if (!dim) return ASPECT_RATIO['16:9'];
  if (ASPECT_RATIO[dim]) return ASPECT_RATIO[dim];
  // Custom WxH or W:H
  const m = /^(\d+)[x×:](\d+)$/i.exec(String(dim).trim());
  return m ? `${m[1]} / ${m[2]}` : ASPECT_RATIO['16:9'];
}

function _safeClass(s) {
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// PPTX export
// ---------------------------------------------------------------------------

/**
 * Export the rendered slide deck (already in the DOM) as a .pptx file.
 *
 * Uses PptxGenJS with DOM-based content extraction so the output contains
 * editable text rather than rasterised images.  SVG diagrams (mermaid, abcjs,
 * etc.) are captured to PNG via canvas and embedded as images.
 *
 * @param {HTMLElement} container  The `.preview-content` element in slides-mode
 * @returns {Promise<Blob>}
 */
export async function exportSlidesPptx(container) {
  const slideEls = [...container.querySelectorAll('.uf-slide')];
  if (!slideEls.length) throw new Error('No slides to export');

  // Read the slide aspect ratio from the first rendered slide.
  // Temporarily reset zoom so we get intrinsic pixel dimensions.
  const first     = slideEls[0];
  const savedZoom = first.style.zoom;
  first.style.zoom = '1';
  const slideW = first.offsetWidth  || SLIDE_INTRINSIC_W;
  const slideH = first.offsetHeight || Math.round(SLIDE_INTRINSIC_W * 9 / 16);
  first.style.zoom = savedZoom;

  const isWide = (slideW / slideH) > 1.4;
  const pptx   = new PptxGenJS();
  pptx.layout  = isWide ? 'LAYOUT_WIDE' : 'LAYOUT_4x3';

  // PptxGenJS LAYOUT_WIDE = 13.33 × 7.5 in, LAYOUT_4x3 = 10 × 7.5 in
  const SW = isWide ? 13.33 : 10;   // slide width  (inches)
  const SH = 7.5;                    // slide height (inches)

  for (const slideEl of slideEls) {
    const pptxSlide = pptx.addSlide();

    // Slide background colour (read from computed style).
    const bg = _computedColorHex(slideEl, 'backgroundColor') ?? 'FFFFFF';
    pptxSlide.background = { color: bg };

    const frame = slideEl.querySelector('.uf-slide-frame');
    if (frame) await _buildPptxSlide(pptxSlide, frame, SW, SH);
  }

  return pptx.write({ outputType: 'blob' });
}

/**
 * Populate a single PptxGenJS slide from the rendered HTML frame element.
 */
async function _buildPptxSlide(pptxSlide, frame, SW, SH) {
  const MX = SW * 0.05;  // left/right margin (inches)
  const MY = SH * 0.06;  // top/bottom margin (inches)
  const CW = SW - MX * 2; // content width

  // Heading: the first h1 or h2 inside the first markdown part.
  const heading = frame.querySelector('.uf-slide-part.uf-dsl-markdown h1, .uf-slide-part.uf-dsl-markdown h2');
  let curY = MY;

  if (heading) {
    const big   = heading.tagName === 'H1';
    const hH    = big ? 1.3 : 1.0;
    const color = _computedColorHex(heading) ?? '1e1e2e';
    pptxSlide.addText(heading.textContent.trim(), {
      x: MX, y: curY, w: CW, h: hH,
      fontSize: big ? 36 : 28, bold: true, color,
      valign: 'top', wrap: true,
    });
    curY += hH + 0.15;
  }

  // Body text runs (paragraphs, bullets, sub-headings) — excluding the main heading.
  const bodyRuns = _extractBodyRuns(frame, heading);

  // Diagrams (non-markdown DSL parts) and inline data-URL images.
  const diagrams  = [...frame.querySelectorAll('.uf-slide-part:not(.uf-dsl-markdown) svg')];
  const mdImages  = [...frame.querySelectorAll('.uf-slide-part.uf-dsl-markdown img[src^="data:"]')];
  const hasVisual = diagrams.length > 0 || mdImages.length > 0;

  const remainH = SH - curY - MY;

  if (hasVisual && bodyRuns.length) {
    // Text above, visuals below.
    const textH = remainH * 0.40;
    const imgY  = curY + textH + 0.1;
    const imgH  = SH - imgY - MY;
    pptxSlide.addText(bodyRuns, { x: MX, y: curY, w: CW, h: textH, valign: 'top', wrap: true });
    await _addVisuals(pptxSlide, diagrams, mdImages, MX, imgY, CW, imgH);
  } else if (hasVisual) {
    await _addVisuals(pptxSlide, diagrams, mdImages, MX, curY, CW, remainH);
  } else if (bodyRuns.length) {
    pptxSlide.addText(bodyRuns, { x: MX, y: curY, w: CW, h: remainH, valign: 'top', wrap: true });
  }
}

/** Extract body text runs from the markdown parts of a slide frame. */
function _extractBodyRuns(frame, heading) {
  const runs = [];
  const parts = frame.querySelectorAll('.uf-slide-part.uf-dsl-markdown');

  for (const part of parts) {
    for (const child of part.children) {
      const tag = child.tagName?.toLowerCase();
      if (!tag || child === heading) continue;

      if (tag === 'h1' || tag === 'h2') {
        const color = _computedColorHex(child) ?? '1e1e2e';
        runs.push({ text: child.textContent.trim(), options: { fontSize: tag === 'h1' ? 32 : 26, bold: true, color, paraSpaceBefore: 8 } });
      } else if (tag === 'h3') {
        runs.push({ text: child.textContent.trim(), options: { fontSize: 22, bold: true, color: '1e1e2e', paraSpaceBefore: 6 } });
      } else if (tag === 'h4') {
        runs.push({ text: child.textContent.trim(), options: { fontSize: 20, bold: true, color: '1e1e2e', paraSpaceBefore: 4 } });
      } else if (tag === 'p') {
        const img = child.querySelector('img');
        if (!img) {
          const text = child.textContent.trim();
          if (text) runs.push({ text, options: { fontSize: 18, color: '2d2d44', paraSpaceBefore: 4 } });
        }
      } else if (tag === 'ul' || tag === 'ol') {
        for (const li of child.querySelectorAll('li')) {
          const text = li.textContent.trim();
          if (text) runs.push({ text, options: { fontSize: 18, color: '2d2d44', bullet: { type: 'bullet' }, paraSpaceBefore: 2 } });
        }
      }
    }
  }
  return runs;
}

/** Place SVG diagrams and data-URL images into a PPTX slide region. */
async function _addVisuals(pptxSlide, diagrams, mdImages, x, y, w, h) {
  const visuals = [
    ...await Promise.all(diagrams.map(async svg => {
      try { return { dataURL: await _svgToDataURL(svg) }; } catch { return null; }
    })),
    ...mdImages.map(img => ({ dataURL: img.src })),
  ].filter(Boolean);

  if (!visuals.length) return;

  const iW = w / visuals.length;
  for (let i = 0; i < visuals.length; i++) {
    pptxSlide.addImage({
      data:    visuals[i].dataURL,
      x:       x + i * iW,
      y,
      w:       iW * 0.96,
      h,
      sizing:  { type: 'contain', w: iW * 0.96, h },
    });
  }
}

/**
 * Serialise an SVG element to a PNG data URL via an offscreen canvas.
 * Works for pure-SVG diagrams (mermaid, abcjs) that don't contain foreignObject.
 */
async function _svgToDataURL(svgEl) {
  const clone = svgEl.cloneNode(true);
  const bbox  = svgEl.getBoundingClientRect();
  const w     = Math.round(bbox.width)  || 400;
  const h     = Math.round(bbox.height) || 300;

  clone.setAttribute('width',  String(w));
  clone.setAttribute('height', String(h));
  for (const s of clone.querySelectorAll('script')) s.remove();

  let svgStr = new XMLSerializer().serializeToString(clone);
  svgStr = svgStr.replace(/\s+xmlns:[a-zA-Z0-9_-]+=""/g, '');

  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url  = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout')), 5000);
      img.onload  = () => { clearTimeout(t); resolve(); };
      img.onerror = () => { clearTimeout(t); reject(new Error('Load error')); };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Read a computed CSS color as a 6-char hex string (no #).  Returns null on failure. */
function _computedColorHex(el, prop = 'color') {
  try {
    const css = window.getComputedStyle(el)[prop];
    const m   = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return null;
    return [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
