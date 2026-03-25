/**
 * Flow → Slides layout renderer.
 *
 * Renders a document with `layout: slides` in its global front matter as a
 * slide deck preview.  Each slide is delimited by a bare `---` line (not
 * inside a code fence).  Content within a slide can contain embedded DSL
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
 *   ---
 *
 *   ## Data Slide
 *
 *   #!mermaid
 *   pie title Budget
 *     "Dev" : 45
 *     "Design" : 20
 *     "Other" : 35
 *
 *   ---
 *
 * In slides mode `---` is always a slide separator — users wanting a
 * horizontal rule within a slide should use `***` or `___` instead.
 *
 * Front matter keys consumed:
 *   dimensions  — 16:9 | 4:3 | 1:1 | a4 | letter | WxH  (default: 16:9)
 */

import { parseDocSections } from '../core/doc-sections.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { getDSL } from '../dsl/registry.js';
import { attachScaleObserver, detachScaleObserver } from './_scale.js';

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
  container.appendChild(deck);

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

    // Render content asynchronously — may call slow DSLs like mermaid.
    await _renderSlideContent(slide.text, frame, slide.from);
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

// ---------------------------------------------------------------------------
// Slide splitting
// ---------------------------------------------------------------------------

/**
 * Split the document body into individual slide objects with text and source offset.
 *
 * A bare `---` line (optional trailing whitespace, not inside a code fence)
 * acts as the slide separator.  The global front matter block (before
 * `bodyFrom`) is excluded.
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

    if (!inFence && /^---\s*$/.test(line)) {
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
 * @param {string}      slideText  Slide content (trimmed; position 0 = slideFrom)
 * @param {HTMLElement} el         The `.uf-slide-frame` element
 * @param {number}      slideFrom  Absolute document offset of slideText[0]
 */
async function _renderSlideContent(slideText, el, slideFrom) {
  const sections = parseDocSections(slideText);

  if (!sections.length) {
    // No shebangs — render the entire slide as markdown.
    await _renderPart('markdown', slideText, el, slideFrom, slideFrom + slideText.length, slideFrom);
    return;
  }

  // Content before the first shebang → markdown.
  const preambleRaw = slideText.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = slideFrom + (lead >= 0 ? lead : 0);
    await _renderPart('markdown', preamble, el,
      pFrom,
      slideFrom + sections[0].from,
      pFrom);  // contentFrom == docFrom for plain markdown (no shebang)
  }

  // Each shebang section.
  for (let i = 0; i < sections.length; i++) {
    const sec  = sections[i];
    const raw  = slideText.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      // docFrom = shebang line; dslContentFrom = first content char after shebang.
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        slideFrom + sec.from,
        slideFrom + sec.to,
        slideFrom + sec.contentFrom + (lead >= 0 ? lead : 0));
    }
  }
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
