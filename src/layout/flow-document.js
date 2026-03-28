/**
 * Flow → Document layout renderer.
 *
 * Renders content as a paginated print-preview. Content is first rendered
 * into an off-screen "tape" div (paper width, unconstrained height), then
 * measured and sliced across fixed-size page frames via CSS `top` offset +
 * `overflow:hidden`. This gives Word-style auto-pagination: content never
 * clips — it simply overflows onto the next physical page.
 *
 * `===` lines are explicit hard page breaks (fence-aware). Content between
 * two `===` breaks is auto-paginated independently.
 *
 * Front matter keys consumed:
 *   page         — a4 | letter | a5 | legal | WxH px  (default: letter)
 *   margin       — CSS shorthand 1–4 values, px only   (default: 72px 80px)
 *   header       — header template: {page}, {total}, {title}, {date}
 *   footer       — footer template: same tokens as header
 *   page-numbers — none | top-left | top-center | top-right |
 *                  bottom-left | bottom-center | bottom-right (default: bottom-center)
 *   font-size    — base font size (default: 12px)
 *   line-height  — (default: 1.6)
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { parseDocSections } from '../core/doc-sections.js';
import { getDSL } from '../dsl/registry.js';
import { attachScaleObserver, detachScaleObserver } from './_scale.js';

// Page sizes in CSS pixels at 96 dpi (1 in = 96 px, 1 mm ≈ 3.7795 px).
const PAGE_PX = {
  letter: { w: 816,  h: 1056 },  // 8.5 × 11 in
  a4:     { w: 794,  h: 1123 },  // 210 × 297 mm
  a5:     { w: 559,  h: 794  },  // 148 × 210 mm
  legal:  { w: 816,  h: 1344 },  // 8.5 × 14 in
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function renderDocument(content, container) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const cfg = _parseConfig(meta);
  const explicitSections = _splitPages(content, bodyFrom);

  container.innerHTML = '';
  container.classList.add('document-mode');

  const doc = document.createElement('div');
  doc.className = 'uf-doc';
  container.appendChild(doc);

  // `dsl:` front matter sets the default DSL; carries forward across === breaks.
  let currentDslId = meta.dsl ?? 'markdown';

  // Physical page counter — increments across explicit AND auto page breaks.
  let globalPageNum = 0;

  for (const section of explicitSections) {
    // ── 1. Render section content into an off-screen measurement tape ──────
    //    The tape has the same usable width as a page content area so that
    //    word-wrap and column widths match the final layout exactly.
    const tape = document.createElement('div');
    // Include `uf-doc-page` so DSL renderers that inspect their DOM context
    // (e.g. fountain's print-mode detection via .closest('.uf-doc-page')) see
    // the correct context.  It also ensures font-family and CSS custom
    // properties match the final page, giving accurate height measurements.
    tape.className = 'uf-doc-tape uf-doc-page';
    tape.style.cssText =
      `position:fixed;left:-${cfg.pageW * 2 + 200}px;top:0;` +
      `width:${cfg.usableW}px;` +
      `font-size:${cfg.fontSize};line-height:${cfg.lineHeight};` +
      `box-sizing:border-box;`;
    document.body.appendChild(tape);

    currentDslId = await _renderPageContent(
      section.text, tape, section.from, currentDslId);

    // Force layout so scrollHeight and getBoundingClientRect are accurate.
    void tape.offsetHeight;
    const breakStarts = _findPageBreaks(tape, cfg.usableH);
    const numPhysical  = breakStarts.length;

    // ── 2. Create one physical page per auto-slice ─────────────────────────
    for (let i = 0; i < numPhysical; i++) {
      globalPageNum++;

      // How many tape-pixels of content live on this page.
      // For non-final pages: exactly the distance to the next break point,
      // which may be LESS than usableH when the break was snapped to a block
      // boundary.  This ensures the body clips at the break point and the
      // pushed block doesn't bleed visibly onto the previous page.
      const bodyH = i < numPhysical - 1
        ? breakStarts[i + 1] - breakStarts[i]
        : Math.min(tape.scrollHeight - breakStarts[i], cfg.usableH);

      const page = document.createElement('div');
      page.className = 'uf-doc-page';
      // Fixed paper dimensions; overflow:hidden clips anything outside the frame.
      page.style.cssText =
        `width:${cfg.pageW}px;height:${cfg.pageH}px;` +
        `overflow:hidden;position:relative;box-sizing:border-box;`;
      page.dataset.docFrom = section.from;
      doc.appendChild(page);

      // Header overlay (sits in the top-margin band, above content area).
      if (cfg.header) {
        const hdr = document.createElement('div');
        hdr.className = 'uf-doc-header';
        hdr.style.cssText =
          `position:absolute;` +
          `top:0;left:${cfg.marginLeft}px;right:${cfg.marginRight}px;` +
          `height:${cfg.marginTop}px;` +
          `display:flex;align-items:flex-end;padding-bottom:6px;`;
        hdr.innerHTML = _fillTokens(cfg.header,
          { page: globalPageNum, total: null, title: meta.title ?? '' });
        page.appendChild(hdr);
      }

      // Content body: absolutely positioned in the usable area.
      // Height = bodyH (≤ usableH) so overflow:hidden clips at the block
      // boundary rather than at the full usableH mark.
      const body = document.createElement('div');
      body.className = 'uf-doc-body';
      body.style.cssText =
        `position:absolute;` +
        `top:${cfg.marginTop}px;left:${cfg.marginLeft}px;` +
        `width:${cfg.usableW}px;height:${bodyH}px;` +
        `overflow:hidden;`;
      page.appendChild(body);

      // Clone the tape and shift it so page `i` shows the correct slice.
      // breakStarts[i] is the tape-relative pixel offset of this page's top,
      // snapped to a block boundary so no element is split mid-line.
      const clone = tape.cloneNode(true);
      // Strip the tape's own classes — the clone lives inside a real .uf-doc-page.
      clone.className = 'uf-doc-content-clone';
      clone.style.cssText =
        `position:relative;top:${-breakStarts[i]}px;width:100%;` +
        `font-size:${cfg.fontSize};line-height:${cfg.lineHeight};`;
      body.appendChild(clone);

      // Footer overlay (sits in the bottom-margin band, below content area).
      if (cfg.footer) {
        const ftr = document.createElement('div');
        ftr.className = 'uf-doc-footer';
        ftr.style.cssText =
          `position:absolute;` +
          `bottom:0;left:${cfg.marginLeft}px;right:${cfg.marginRight}px;` +
          `height:${cfg.marginBottom}px;` +
          `display:flex;align-items:flex-start;padding-top:6px;`;
        ftr.innerHTML = _fillTokens(cfg.footer,
          { page: globalPageNum, total: null, title: meta.title ?? '' });
        page.appendChild(ftr);
      }

      // Page-number badge (absolutely positioned overlay).
      if (cfg.pageNumbers && cfg.pageNumbers !== 'none') {
        page.appendChild(_pageNumEl(globalPageNum, cfg.pageNumbers));
      }
    }

    // Remove the off-screen tape now that all clones have been made.
    document.body.removeChild(tape);
  }

  // ── 3. Back-fill the total page count ─────────────────────────────────────
  //    We didn't know the total until all sections were processed.
  const total = globalPageNum;
  doc.querySelectorAll('[data-uf-total]').forEach(
    el => { el.textContent = String(total); });
  doc.querySelectorAll('[data-uf-pagenum]').forEach(el => {
    el.textContent = `${el.dataset.ufPagenum} / ${total}`;
  });

  // Scale pages to fit the container width (print-preview zoom).
  attachScaleObserver(container, '.uf-doc-page', cfg.pageW);
}

export function teardownDocument(container) {
  detachScaleObserver(container);
  container.classList.remove('document-mode');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function _parseConfig(meta) {
  const px      = _parsePagePx(meta.page ?? 'letter');
  const margin  = meta.margin ?? '72px 80px'; // ~0.75 in × ~0.83 in
  const expanded = _expandMargin(margin);
  const margins  = _parseMarginPx(expanded);
  return {
    pageW:       px.w,
    pageH:       px.h,
    marginTop:   margins.top,
    marginRight: margins.right,
    marginBottom:margins.bottom,
    marginLeft:  margins.left,
    usableW:     px.w - margins.left - margins.right,
    usableH:     px.h - margins.top  - margins.bottom,
    fontSize:    meta['font-size']    ?? '12px',
    lineHeight:  meta['line-height']  ?? '1.6',
    header:      meta.header   ?? null,
    footer:      meta.footer   ?? null,
    pageNumbers: meta['page-numbers'] ?? 'bottom-center',
  };
}

function _parsePagePx(pageStr) {
  const key = String(pageStr ?? 'letter').toLowerCase().trim();
  if (PAGE_PX[key]) return PAGE_PX[key];
  const m = /^(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/.exec(key);
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : PAGE_PX.letter;
}

function _expandMargin(m) {
  const parts = m.trim().split(/\s+/);
  if (parts.length === 1) return `${parts[0]} ${parts[0]} ${parts[0]} ${parts[0]}`;
  if (parts.length === 2) return `${parts[0]} ${parts[1]} ${parts[0]} ${parts[1]}`;
  if (parts.length === 3) return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[1]}`;
  return parts.slice(0, 4).join(' ');
}

/** Parse an already-expanded "top right bottom left" px string into numbers. */
function _parseMarginPx(expanded) {
  const vals = expanded.trim().split(/\s+/).map(v => parseFloat(v) || 0);
  return { top: vals[0], right: vals[1], bottom: vals[2], left: vals[3] };
}

/**
 * Fill {page}, {total}, {title}, {date} tokens in a header/footer template.
 * When `vars.total` is null a `<span data-uf-total>` placeholder is emitted
 * so the value can be back-filled once we know the real total page count.
 */
function _fillTokens(template, vars) {
  const totalHtml = vars.total == null
    ? '<span data-uf-total></span>'
    : String(vars.total);
  return _esc(template)
    .replace(/\{page\}/g,  String(vars.page))
    .replace(/\{total\}/g, totalHtml)
    .replace(/\{title\}/g, _esc(vars.title))
    .replace(/\{date\}/g,  new Date().toLocaleDateString());
}

/**
 * Page-number badge element. Uses a `data-uf-pagenum` attribute so the total
 * can be back-filled after all pages are known.
 */
function _pageNumEl(page, position) {
  const el = document.createElement('div');
  const align = position.split('-')[1] ?? 'center';
  el.className = `uf-doc-pagenum uf-doc-pagenum-${align}`;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.ufPagenum = String(page);
  el.textContent = `${page} / …`; // back-filled later
  return el;
}

// ---------------------------------------------------------------------------
// Explicit page-break splitting (===)
// ---------------------------------------------------------------------------

/**
 * Split document body at bare `===` lines (3+ equals, fence-aware).
 * Each segment is an explicit section; within each section content is
 * auto-paginated by the renderer.
 */
function _splitPages(content, bodyFrom) {
  const body   = content.slice(bodyFrom);
  const lines  = body.split('\n');
  const pages  = [];
  let current  = [];
  let currentFrom = bodyFrom;
  let offset   = bodyFrom;
  let inFence  = false;
  let fenceChar = '';

  for (const line of lines) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line.trimStart());
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar && /^[`~]+\s*$/.test(line.trimStart())) inFence = false;
    }

    if (!inFence && /^={3,}\s*$/.test(line)) {
      const raw = current.join('\n');
      const s   = raw.trim();
      if (s) {
        const lead = raw.search(/\S/);
        pages.push({ text: s, from: currentFrom + (lead >= 0 ? lead : 0) });
      }
      offset += line.length + 1;
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
    pages.push({ text: last, from: currentFrom + (lead >= 0 ? lead : 0) });
  }

  return pages.length ? pages : [{ text: '', from: bodyFrom }];
}

// ---------------------------------------------------------------------------
// Per-section rendering (DSL shebang dispatch)
// ---------------------------------------------------------------------------

/**
 * Render one section's content into `el`, returning the last DSL used.
 * `defaultDslId` carries the active DSL across === page breaks.
 */
async function _renderPageContent(pageText, el, pageFrom, defaultDslId = 'markdown') {
  if (!pageText) return defaultDslId;
  const sections = parseDocSections(pageText);
  let outDslId = defaultDslId;

  if (!sections.length) {
    await _renderPart(defaultDslId, pageText, el, pageFrom, pageFrom + pageText.length, pageFrom);
    return outDslId;
  }

  const preambleRaw = pageText.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = pageFrom + (lead >= 0 ? lead : 0);
    await _renderPart(defaultDslId, preamble, el,
      pFrom, pageFrom + sections[0].from, pFrom);
  }

  for (const sec of sections) {
    const raw  = pageText.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        pageFrom + sec.from,
        pageFrom + sec.to,
        pageFrom + sec.contentFrom + (lead >= 0 ? lead : 0));
    }
    outDslId = sec.dslId;
  }

  return outDslId;
}

async function _renderPart(dslId, text, parentEl, docFrom, docTo, contentFrom) {
  const wrap = document.createElement('div');
  wrap.className = `uf-doc-part uf-dsl-${_safeClass(dslId)}`;
  if (docFrom     != null) wrap.dataset.docFrom        = docFrom;
  if (docTo       != null) wrap.dataset.docTo          = docTo;
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
// Page-break calculation
// ---------------------------------------------------------------------------

/**
 * Find page-start offsets (tape-relative px) that avoid splitting block
 * elements mid-element.  Returns an array of Y offsets, one per physical page:
 * [0, breakAt_1, breakAt_2, ...].
 *
 * Strategy: process block elements top-to-bottom.  If a block straddles a
 * page boundary AND fits entirely on one page, push the break to just before
 * that block so it starts cleanly at the top of the next page.  Blocks taller
 * than a full page are accepted as-is (unavoidable split).
 */
function _findPageBreaks(tape, usableH) {
  // Selectors for paragraph-level content blocks that we try not to split.
  const BLOCK_SEL = [
    // Fountain screenplay elements
    '.fountain-scene-heading', '.fountain-action',
    '.fountain-character',     '.fountain-dialogue',
    '.fountain-parenthetical', '.fountain-transition',
    '.fountain-centered',      '.fountain-lyrics',
    // Markdown / generic HTML blocks
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'pre', 'blockquote', 'table',
  ].join(',');

  const blocks = Array.from(tape.querySelectorAll(BLOCK_SEL));
  if (!blocks.length) {
    // No identifiable blocks — fall back to uniform breaks.
    const n = Math.max(1, Math.ceil(tape.scrollHeight / usableH));
    return Array.from({ length: n }, (_, i) => i * usableH);
  }

  const tapeTop = tape.getBoundingClientRect().top;
  const starts  = [0];
  let pageEnd   = usableH; // bottom edge of the current page, tape-relative px

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    const r    = block.getBoundingClientRect();
    const bTop = r.top    - tapeTop;
    const bBot = r.bottom - tapeTop;

    // Advance page pointer past any pages entirely before this block.
    while (bTop >= pageEnd) {
      starts.push(pageEnd);
      pageEnd += usableH;
    }

    if (bBot <= pageEnd) continue; // block fits on the current page — no action needed

    // Block straddles the current page boundary.
    if (block.offsetHeight < usableH) {
      // It fits on a single page — break just before it so it starts the next page.
      // Widow/orphan prevention: if this is a dialogue (or parenthetical), also
      // drag the immediately-preceding character cue onto the next page so it
      // doesn't sit alone at the bottom of the previous page.
      let breakAt = bTop;
      const cls = block.className;
      if (cls.includes('fountain-dialogue') || cls.includes('fountain-parenthetical')) {
        // Look back up to two blocks for a character cue to bring along.
        for (let back = 1; back <= 2 && idx - back >= 0; back++) {
          const prev = blocks[idx - back];
          const prevCls = prev.className;
          if (prevCls.includes('fountain-character')) {
            const prevTop = prev.getBoundingClientRect().top - tapeTop;
            // Only move back if the character cue is still in the current page range
            // (don't create an empty page).
            const pageStart = starts[starts.length - 1] ?? 0;
            if (prevTop > pageStart) breakAt = prevTop;
            break;
          }
          // A parenthetical between character and dialogue — keep searching back.
          if (!prevCls.includes('fountain-parenthetical')) break;
        }
      }
      starts.push(breakAt);
      pageEnd = breakAt + usableH;
    }
    // else: block is taller than usableH — accept the mid-block split.
  }

  // Add trailing pages to cover any remaining content after the last block.
  const totalH = tape.scrollHeight;
  while ((starts[starts.length - 1] ?? 0) + usableH < totalH - 1) {
    starts.push((starts[starts.length - 1] ?? 0) + usableH);
  }

  return starts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _safeClass(s) { return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
