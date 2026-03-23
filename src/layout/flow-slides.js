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
    outer.style.aspectRatio = ar;
    outer.setAttribute('aria-label', `Slide ${i + 1} of ${slides.length}`);
    outer.dataset.docFrom = slide.from;

    const frame = document.createElement('div');
    frame.className = 'uf-slide-frame';
    outer.appendChild(frame);

    const badge = document.createElement('div');
    badge.className   = 'uf-slide-num';
    badge.textContent = `${i + 1} / ${slides.length}`;
    badge.setAttribute('aria-hidden', 'true');
    outer.appendChild(badge);

    deck.appendChild(outer);

    // Render content asynchronously — may call slow DSLs like mermaid.
    await _renderSlideContent(slide.text, frame);
  }
}

/**
 * Strip the slides-mode CSS class when leaving slides layout.
 * Called by preview.js when switching away from slides mode.
 * @param {HTMLElement} container
 */
export function teardownSlides(container) {
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
      const s = current.join('\n').trim();
      if (s) slides.push({ text: s, from: currentFrom });
      offset += line.length + 1; // +1 for the '\n'
      current = [];
      currentFrom = offset;
    } else {
      current.push(line);
      offset += line.length + 1;
    }
  }

  const last = current.join('\n').trim();
  if (last) slides.push({ text: last, from: currentFrom });

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
async function _renderSlideContent(slideText, el) {
  const sections = parseDocSections(slideText);

  if (!sections.length) {
    // No shebangs — render the entire slide as markdown.
    await _renderPart('markdown', slideText, el);
    return;
  }

  // Content before the first shebang → markdown.
  const preamble = slideText.slice(0, sections[0].from).trim();
  if (preamble) await _renderPart('markdown', preamble, el);

  // Each shebang section.
  for (let i = 0; i < sections.length; i++) {
    const sec  = sections[i];
    const next = sections[i + 1];
    const text = slideText.slice(sec.contentFrom, next ? next.from : slideText.length).trim();
    if (text) await _renderPart(sec.dslId, text, el);
  }
}

async function _renderPart(dslId, text, parentEl) {
  const wrap = document.createElement('div');
  wrap.className = `uf-slide-part uf-dsl-${_safeClass(dslId)}`;
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
