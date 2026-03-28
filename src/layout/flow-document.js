/**
 * Flow → Document layout renderer.
 *
 * Renders content as a paginated print-preview.  Content is first rendered
 * into an off-screen "tape" div (paper width, unconstrained height), measured,
 * and sliced across fixed-size page frames.
 *
 * Performance model
 * ─────────────────
 * Rendering N pages of content naively requires N full clones of the tape —
 * O(N × tape_size) DOM nodes.  For large documents this is prohibitive.
 *
 * Instead we use a two-phase approach:
 *   1. Stub phase  (synchronous, fast): create N lightweight page frames that
 *      hold correct dimensions, headers, footers, and page-number badges, but
 *      no body content.  Yields every STUB_YIELD stubs so the editor stays
 *      responsive.
 *   2. Populate phase (lazy, on-demand): an IntersectionObserver fires when a
 *      stub scrolls into the viewport ± IO_MARGIN_PX.  At that point the tape
 *      is cloned and shifted into the stub's body div.  Once every stub in a
 *      tape group has been populated the tape is removed from the DOM.
 *
 * The stale-while-revalidate pattern keeps the previous render visible during
 * the stub phase.  The container is only updated (atomically) once all stubs
 * are ready.
 *
 * `===` lines are explicit hard page breaks (fence-aware).  Content between
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

// Yield the event loop every N stubs during the stub-creation loop so the
// editor input doesn't stall while paginating large documents.
const STUB_YIELD = 50;

// IntersectionObserver root margin: how far outside the visible scroll area
// we pre-populate stubs.  Two page-heights gives a comfortable scroll buffer.
// (Overridden per-render using the actual cfg.pageH.)
const IO_MARGIN_PAGES = 2;

// Characters to render in the priority batch (first pass, shown to user immediately).
// ~4-5 fountain pages.  The rest of the section renders in the background.
const PRIORITY_CHARS = 15_000;

// ---------------------------------------------------------------------------
// Lazy-load metadata store
// ---------------------------------------------------------------------------

// Maps a page stub element → { tapeGroup, breakStart, bodyH, cfg }
// WeakMap so entries are automatically collected when stubs leave the DOM.
const _stubMeta = new WeakMap();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string}      content
 * @param {HTMLElement} container
 * @param {{ signal?: AbortSignal, cursorPos?: number }} [opts]
 *
 * Incremental rendering strategy
 * ───────────────────────────────
 * Edits can only push layout changes forward in the document.  Pages before
 * the cursor are unchanged, so we keep their stub DOM nodes and skip
 * re-rendering their tape sections entirely.
 *
 * State stored on container:
 *   _ufDocSections  — array of { from, to, stubCount, tapeGroup }
 *                     one entry per explicit section (=== break)
 *   _ufDocObserver  — single IntersectionObserver covering all unpopulated stubs
 */
export async function renderDocument(content, container, { signal, cursorPos } = {}) {
  const { meta, bodyFrom } = parseGlobalFrontMatter(content);
  const cfg = _parseConfig(meta);
  const explicitSections = _splitPages(content, bodyFrom);

  // ── Find incremental pivot ──────────────────────────────────────────────
  // The pivot is the earliest position we need to re-render.
  // Everything before it is kept in the DOM untouched.
  //
  // pivotPageNum    — number of existing page stubs to keep (0 = full re-render)
  // pivotSectionIdx — index into explicitSections where re-rendering begins
  // pivotCharFrom   — character offset within the pivot section to start the tape
  //                   (null = render the section from its beginning)

  const prevSections = container._ufDocSections ?? [];
  let pivotSectionIdx = 0;
  let pivotPageNum    = 0;
  let pivotCharFrom   = null;

  if (cursorPos != null && prevSections.length > 0) {
    for (let si = 0; si < prevSections.length && si < explicitSections.length; si++) {
      const prev = prevSections[si];
      const next = explicitSections[si];

      // If a section boundary moved (e.g. a new === was added before this
      // point) the old cached layout is invalid — stop and re-render from here.
      if (Math.abs(prev.from - next.from) > 5) break;

      if (prev.to < cursorPos) {
        // Entire section is before cursor: keep its stubs.
        pivotSectionIdx = si + 1;
        pivotPageNum   += prev.stubCount;
      } else {
        // The cursor is somewhere inside this section.
        // Walk its stubs to find the exact pivot page.
        const secStubs = container.querySelectorAll(
          `.uf-doc-page[data-section-idx="${si}"]`);
        for (const stub of secStubs) {
          const pageTo = parseInt(stub.dataset.pageContentTo, 10);
          if (!isNaN(pageTo) && pageTo < cursorPos) {
            // This entire page is before the cursor — keep it.
            pivotPageNum++;
          } else {
            // The cursor is on this page (or after all pages in this section).
            pivotCharFrom = parseInt(stub.dataset.pageContentFrom, 10) || null;
            break;
          }
        }
        // Re-render from pivotSectionIdx = si, starting at pivotCharFrom.
        break;
      }
    }
  }

  const isFullRender = (pivotPageNum === 0 && pivotCharFrom === null
                        && pivotSectionIdx === 0);

  // ── Disconnect the old IntersectionObserver ─────────────────────────────
  // We will create a fresh one that covers both kept and new stubs.
  container._ufDocObserver?.disconnect();
  container._ufDocObserver = null;

  // ── DOM surgery ─────────────────────────────────────────────────────────
  if (isFullRender) {
    // Release all tapes, wipe DOM.
    for (const sec of prevSections) {
      for (const tg of sec.tapeGroups ?? []) tg.tape?.remove?.();
    }
    detachScaleObserver(container);
    container.innerHTML = '';
    container.classList.add('document-mode');
    container._ufDocSections = null;
  } else {
    // Keep stubs 0..pivotPageNum-1.  Remove the rest, properly decrementing
    // each stub's tapeGroup.remaining so tapes are freed when no longer needed.
    const allStubs = [...container.querySelectorAll('.uf-doc-page')];
    for (let i = pivotPageNum; i < allStubs.length; i++) {
      const stub = allStubs[i];
      const info = _stubMeta.get(stub);
      if (info) {
        _stubMeta.delete(stub);
        info.tapeGroup.remaining--;
        if (info.tapeGroup.remaining === 0) info.tapeGroup.tape.remove();
      }
      stub.remove();
    }
    // Release tapes for any sections that are fully re-rendered (> pivot section).
    for (let si = pivotSectionIdx + 1; si < prevSections.length; si++) {
      for (const tg of prevSections[si].tapeGroups ?? []) {
        if (tg.tape?.isConnected) tg.tape.remove();
      }
    }
  }

  // ── Build new stubs ─────────────────────────────────────────────────────
  // Full render: initially build into a detached div; swap into DOM once the
  // first priority batch is ready.
  // Incremental: already in live DOM — just append.
  const ufDoc = isFullRender
    ? (() => { const d = document.createElement('div'); d.className = 'uf-doc'; return d; })()
    : container.querySelector('.uf-doc');

  let currentDslId  = meta.dsl ?? 'markdown';
  let globalPageNum = pivotPageNum;
  const newSectionRecords = [];
  let domCommitted = !isFullRender; // incremental renders are already live

  for (let si = pivotSectionIdx; si < explicitSections.length; si++) {
    const section = explicitSections[si];
    if (signal?.aborted) { _cleanupNewSections(newSectionRecords); return; }

    const sectionRelativePivot = (si === pivotSectionIdx && pivotCharFrom != null)
      ? Math.max(0, pivotCharFrom - section.from)
      : 0;

    const tapeFrom   = section.from + sectionRelativePivot;
    const sectionEnd = section.from + section.text.length;

    // One record per section; batches accumulate into it.
    const sectionRecord = {
      from:       section.from,
      to:         sectionEnd,
      stubCount:  0,
      tapeGroups: [],
    };

    let batchFrom  = tapeFrom;
    let firstBatch = true;

    while (batchFrom < sectionEnd) {
      if (signal?.aborted) {
        _cleanupNewSections([...newSectionRecords, sectionRecord]);
        return;
      }

      // First batch = priority window (small, fast).
      // Subsequent batches = larger chunks for background rendering.
      const BATCH_LIMIT = firstBatch ? PRIORITY_CHARS : PRIORITY_CHARS * 4;
      const batchEnd  = Math.min(batchFrom + BATCH_LIMIT, sectionEnd);
      const batchText = content.slice(batchFrom, batchEnd);
      const isLastBatch = (batchEnd >= sectionEnd);

      // Build tape for this batch.
      const tape = document.createElement('div');
      tape.className = 'uf-doc-tape uf-doc-page';
      tape.style.cssText =
        `position:fixed;left:-${cfg.pageW * 2 + 200}px;top:0;` +
        `width:${cfg.usableW}px;` +
        `font-size:${cfg.fontSize};line-height:${cfg.lineHeight};` +
        `box-sizing:border-box;`;
      document.body.appendChild(tape);

      currentDslId = await _renderPageContent(batchText, tape, batchFrom, currentDslId, signal);
      if (signal?.aborted) {
        tape.remove();
        _cleanupNewSections([...newSectionRecords, sectionRecord]);
        return;
      }

      void tape.offsetHeight;
      const breakStarts = await _findPageBreaks(tape, cfg.usableH, signal);
      if (signal?.aborted) {
        tape.remove();
        _cleanupNewSections([...newSectionRecords, sectionRecord]);
        return;
      }

      const pageRanges = await _computePageContentRanges(tape, breakStarts, signal);
      if (signal?.aborted) {
        tape.remove();
        _cleanupNewSections([...newSectionRecords, sectionRecord]);
        return;
      }

      // For non-final batches: keep only complete pages (skip the last, possibly
      // partial page — the next batch will pick up from the end of the last
      // complete page).  If no complete pages yet, fall back to keeping all.
      const numToCommit = isLastBatch
        ? breakStarts.length
        : Math.max(breakStarts.length - 1, breakStarts.length > 1 ? breakStarts.length - 1 : 0);
      // Simpler: always skip the last page on non-final batches only if we have >1 page
      const safeNum = (isLastBatch || breakStarts.length <= 1)
        ? breakStarts.length
        : breakStarts.length - 1;

      if (safeNum === 0) {
        // Edge case: the batch produced no layout yet (e.g. a single huge element).
        // Keep the tape and treat as if this is the last batch.
        tape.remove();
        break;
      }

      const tapeGroup = { tape, remaining: safeNum };
      sectionRecord.tapeGroups.push(tapeGroup);

      for (let i = 0; i < safeNum; i++) {
        if (signal?.aborted) {
          _cleanupNewSections([...newSectionRecords, sectionRecord]);
          return;
        }
        globalPageNum++;

        const bodyH = i < safeNum - 1
          ? breakStarts[i + 1] - breakStarts[i]
          : Math.min(tape.scrollHeight - breakStarts[i], cfg.usableH);

        const stub = _createStub(cfg, globalPageNum, section.from, meta.title ?? '',
                                 pageRanges[i].from, pageRanges[i].to);
        stub.dataset.sectionIdx = String(si);
        _stubMeta.set(stub, { tapeGroup, breakStart: breakStarts[i], bodyH, cfg });
        ufDoc.appendChild(stub);
        sectionRecord.stubCount++;

        if (i % STUB_YIELD === STUB_YIELD - 1) {
          await new Promise(r => setTimeout(r, 0));
          if (signal?.aborted) {
            _cleanupNewSections([...newSectionRecords, sectionRecord]);
            return;
          }
        }
      }

      // ── Commit priority pages to DOM as soon as they're ready ───────────
      // For a full render this is the first time content appears in the
      // container; for incremental the stubs are already live.
      if (!domCommitted) {
        container.innerHTML = '';
        container.classList.add('document-mode');
        container.appendChild(ufDoc);
        attachScaleObserver(container, '.uf-doc-page', cfg.pageW);
        domCommitted = true;
      }

      if (isLastBatch) break;

      // Determine where to start the next batch.
      // Begin right after the last complete page's content range ends.
      const lastPageTo = pageRanges[safeNum - 1]?.to;
      batchFrom = (lastPageTo != null && lastPageTo > batchFrom)
        ? lastPageTo + 1
        : batchEnd;

      firstBatch = false;

      // Yield between batches so the editor can process keystrokes.
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) {
        _cleanupNewSections([...newSectionRecords, sectionRecord]);
        return;
      }
    }

    newSectionRecords.push(sectionRecord);
  }

  if (signal?.aborted) { _cleanupNewSections(newSectionRecords); return; }

  // ── Back-fill total page count ──────────────────────────────────────────
  const total = globalPageNum;
  const pageRoot = isFullRender && !domCommitted ? ufDoc : container;
  pageRoot.querySelectorAll('[data-uf-total]').forEach(
    el => { el.textContent = String(total); });
  pageRoot.querySelectorAll('[data-uf-pagenum]').forEach(el => {
    el.textContent = `${el.dataset.ufPagenum} / ${total}`;
  });

  // ── Commit to DOM if nothing was committed yet (e.g. empty document) ───
  if (!domCommitted) {
    container.innerHTML = '';
    container.classList.add('document-mode');
    container.appendChild(ufDoc);
    attachScaleObserver(container, '.uf-doc-page', cfg.pageW);
  }

  // ── Fresh IntersectionObserver covering ALL unpopulated stubs ───────────
  const margin = cfg.pageH * IO_MARGIN_PAGES;
  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      const info = _stubMeta.get(target);
      if (!info) continue;
      _populateStub(target, info);
      _stubMeta.delete(target);
      observer.unobserve(target);
      info.tapeGroup.remaining--;
      if (info.tapeGroup.remaining === 0) info.tapeGroup.tape.remove();
    }
  }, { root: container, rootMargin: `${margin}px 0px` });

  for (const stub of container.querySelectorAll('.uf-doc-page-stub')) {
    observer.observe(stub);
  }

  container._ufDocObserver = observer;

  const keptSections = isFullRender ? [] : (container._ufDocSections ?? []).slice(0, pivotSectionIdx);
  container._ufDocSections = [...keptSections, ...newSectionRecords];
}

export function teardownDocument(container) {
  _releasePrevRender(container);
  detachScaleObserver(container);
  container.classList.remove('document-mode');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Disconnect IO + remove all tapes (full teardown or full re-render). */
function _releasePrevRender(container) {
  container._ufDocObserver?.disconnect();
  container._ufDocObserver = null;
  const sections = container._ufDocSections ?? [];
  for (const sec of sections) {
    for (const tg of sec.tapeGroups ?? []) tg.tape?.remove?.();
  }
  container._ufDocSections = null;
}

/** Remove tapes for a subset of new section records (called on abort). */
function _cleanupNewSections(records) {
  for (const rec of records) {
    for (const tg of rec.tapeGroups ?? []) tg.tape?.remove?.();
  }
}

/** Remove every tape from the document (safety cleanup). */
function _removeTapes(tapes) {
  for (const t of tapes) if (t?.isConnected) t.remove();
}

// ---------------------------------------------------------------------------
// Stub creation
// ---------------------------------------------------------------------------

/**
 * Create a lightweight page frame with correct dimensions, header, footer, and
 * page-number badge.  Body content is intentionally omitted — it will be added
 * lazily by the IntersectionObserver once the stub scrolls into view.
 *
 * @param {number|null} contentFrom  First character offset of this page's content
 * @param {number|null} contentTo    Last character offset  of this page's content
 */
function _createStub(cfg, pageNum, docFrom, title, contentFrom, contentTo) {
  const page = document.createElement('div');
  page.className = 'uf-doc-page uf-doc-page-stub';
  page.style.cssText =
    `width:${cfg.pageW}px;height:${cfg.pageH}px;` +
    `overflow:hidden;position:relative;box-sizing:border-box;`;
  page.dataset.docFrom = docFrom;
  if (contentFrom != null) page.dataset.pageContentFrom = contentFrom;
  if (contentTo   != null) page.dataset.pageContentTo   = contentTo;

  if (cfg.header) {
    const hdr = document.createElement('div');
    hdr.className = 'uf-doc-header';
    hdr.style.cssText =
      `position:absolute;` +
      `top:0;left:${cfg.marginLeft}px;right:${cfg.marginRight}px;` +
      `height:${cfg.marginTop}px;` +
      `display:flex;align-items:flex-end;padding-bottom:6px;`;
    hdr.innerHTML = _fillTokens(cfg.header, { page: pageNum, total: null, title });
    page.appendChild(hdr);
  }

  if (cfg.footer) {
    const ftr = document.createElement('div');
    ftr.className = 'uf-doc-footer';
    ftr.style.cssText =
      `position:absolute;` +
      `bottom:0;left:${cfg.marginLeft}px;right:${cfg.marginRight}px;` +
      `height:${cfg.marginBottom}px;` +
      `display:flex;align-items:flex-start;padding-top:6px;`;
    ftr.innerHTML = _fillTokens(cfg.footer, { page: pageNum, total: null, title });
    page.appendChild(ftr);
  }

  if (cfg.pageNumbers && cfg.pageNumbers !== 'none') {
    page.appendChild(_pageNumEl(pageNum, cfg.pageNumbers));
  }

  return page;
}

/**
 * Populate a stub's body when it enters the viewport.
 * Clones the relevant tape slice into the stub and promotes it from stub to
 * a fully rendered page.
 */
function _populateStub(page, { tapeGroup, breakStart, bodyH, cfg }) {
  page.classList.remove('uf-doc-page-stub');

  const body = document.createElement('div');
  body.className = 'uf-doc-body';
  body.style.cssText =
    `position:absolute;` +
    `top:${cfg.marginTop}px;left:${cfg.marginLeft}px;` +
    `width:${cfg.usableW}px;height:${bodyH}px;` +
    `overflow:hidden;`;

  const clone = tapeGroup.tape.cloneNode(true);
  clone.className = 'uf-doc-content-clone';
  clone.style.cssText =
    `position:relative;top:${-breakStart}px;width:100%;` +
    `font-size:${cfg.fontSize};line-height:${cfg.lineHeight};`;
  body.appendChild(clone);

  // Insert body before the first absolute overlay (header is first child).
  page.insertBefore(body, page.firstChild);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function _parseConfig(meta) {
  const px      = _parsePagePx(meta.page ?? 'letter');
  const margin  = meta.margin ?? '72px 80px';
  const expanded = _expandMargin(margin);
  const margins  = _parseMarginPx(expanded);
  return {
    pageW:        px.w,
    pageH:        px.h,
    marginTop:    margins.top,
    marginRight:  margins.right,
    marginBottom: margins.bottom,
    marginLeft:   margins.left,
    usableW:      px.w - margins.left - margins.right,
    usableH:      px.h - margins.top  - margins.bottom,
    fontSize:     meta['font-size']    ?? '12px',
    lineHeight:   meta['line-height']  ?? '1.6',
    header:       meta.header   ?? null,
    footer:       meta.footer   ?? null,
    pageNumbers:  meta['page-numbers'] ?? 'bottom-center',
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

function _parseMarginPx(expanded) {
  const vals = expanded.trim().split(/\s+/).map(v => parseFloat(v) || 0);
  return { top: vals[0], right: vals[1], bottom: vals[2], left: vals[3] };
}

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

function _pageNumEl(page, position) {
  const el = document.createElement('div');
  const align = position.split('-')[1] ?? 'center';
  el.className = `uf-doc-pagenum uf-doc-pagenum-${align}`;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.ufPagenum = String(page);
  el.textContent = `${page} / …`;
  return el;
}

// ---------------------------------------------------------------------------
// Explicit page-break splitting (===)
// ---------------------------------------------------------------------------

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

async function _renderPageContent(pageText, el, pageFrom, defaultDslId = 'markdown', signal) {
  if (!pageText) return defaultDslId;
  const sections = parseDocSections(pageText);
  let outDslId = defaultDslId;

  if (!sections.length) {
    await _renderPart(defaultDslId, pageText, el, pageFrom, pageFrom + pageText.length, pageFrom, signal);
    return outDslId;
  }

  const preambleRaw = pageText.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = pageFrom + (lead >= 0 ? lead : 0);
    await _renderPart(defaultDslId, preamble, el,
      pFrom, pageFrom + sections[0].from, pFrom, signal);
  }

  for (const sec of sections) {
    if (signal?.aborted) return outDslId;
    const raw  = pageText.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        pageFrom + sec.from,
        pageFrom + sec.to,
        pageFrom + sec.contentFrom + (lead >= 0 ? lead : 0),
        signal);
    }
    outDslId = sec.dslId;
  }

  return outDslId;
}

async function _renderPart(dslId, text, parentEl, docFrom, docTo, contentFrom, signal) {
  const wrap = document.createElement('div');
  wrap.className = `uf-doc-part uf-dsl-${_safeClass(dslId)}`;
  if (docFrom     != null) wrap.dataset.docFrom        = docFrom;
  if (docTo       != null) wrap.dataset.docTo          = docTo;
  if (contentFrom != null) wrap.dataset.dslContentFrom = contentFrom;
  parentEl.appendChild(wrap);
  try {
    const dsl = getDSL(dslId);
    await dsl.render(text, wrap, { signal });
  } catch (err) {
    if (signal?.aborted) return;
    wrap.innerHTML = `<pre class="error">${_esc(dslId)} error: ${_esc(err.message)}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Page-break calculation
// ---------------------------------------------------------------------------

/**
 * Find page-start offsets (tape-relative px) that avoid splitting block
 * elements mid-line.  Returns [0, breakAt_1, breakAt_2, ...].
 *
 * Strategy: process block elements top-to-bottom.  If a block straddles a
 * page boundary AND fits on one page, snap the break to just before that
 * block.  Blocks taller than a full page are accepted as-is.
 *
 * Widow/orphan prevention: when snapping before a dialogue or parenthetical,
 * also drag the immediately-preceding character cue onto the next page.
 */
async function _findPageBreaks(tape, usableH, signal) {
  const BLOCK_SEL = [
    '.fountain-scene-heading', '.fountain-action',
    '.fountain-character',     '.fountain-dialogue',
    '.fountain-parenthetical', '.fountain-transition',
    '.fountain-centered',      '.fountain-lyrics',
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'pre', 'blockquote', 'table',
  ].join(',');

  const blocks = Array.from(tape.querySelectorAll(BLOCK_SEL));
  if (!blocks.length) {
    const n = Math.max(1, Math.ceil(tape.scrollHeight / usableH));
    return Array.from({ length: n }, (_, i) => i * usableH);
  }

  const tapeTop = tape.getBoundingClientRect().top;
  const starts  = [0];
  let pageEnd   = usableH;

  for (let idx = 0; idx < blocks.length; idx++) {
    // Yield every 500 blocks to keep the editor responsive.
    if (idx % 500 === 499) {
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) return starts;
    }

    const block = blocks[idx];
    const r    = block.getBoundingClientRect();
    const bTop = r.top    - tapeTop;
    const bBot = r.bottom - tapeTop;

    while (bTop >= pageEnd) {
      starts.push(pageEnd);
      pageEnd += usableH;
    }

    if (bBot <= pageEnd) continue;

    if (block.offsetHeight < usableH) {
      let breakAt = bTop;
      const cls = block.className;
      if (cls.includes('fountain-dialogue') || cls.includes('fountain-parenthetical')) {
        for (let back = 1; back <= 2 && idx - back >= 0; back++) {
          const prev = blocks[idx - back];
          const prevCls = prev.className;
          if (prevCls.includes('fountain-character')) {
            const prevTop = prev.getBoundingClientRect().top - tapeTop;
            const pageStart = starts[starts.length - 1] ?? 0;
            if (prevTop > pageStart) breakAt = prevTop;
            break;
          }
          if (!prevCls.includes('fountain-parenthetical')) break;
        }
      }
      starts.push(breakAt);
      pageEnd = breakAt + usableH;
    }
  }

  const totalH = tape.scrollHeight;
  while ((starts[starts.length - 1] ?? 0) + usableH < totalH - 1) {
    starts.push((starts[starts.length - 1] ?? 0) + usableH);
  }

  return starts;
}

// ---------------------------------------------------------------------------
// Page content range mapping
// ---------------------------------------------------------------------------

/**
 * For each page (identified by its breakStart), find the character-offset
 * range of the fountain/markdown elements that land on that page.
 *
 * Uses the data-doc-from / data-doc-to attributes emitted by DSL renderers so
 * the mapping works for any DSL, not just Fountain.
 *
 * Returns an array parallel to breakStarts where each entry is { from, to }.
 * Used to store data-page-content-from / data-page-content-to on stubs so
 * the preview can scroll-sync to editor cursor position.
 */
async function _computePageContentRanges(tape, breakStarts, signal) {
  const n      = breakStarts.length;
  const ranges = Array.from({ length: n }, () => ({ from: null, to: null }));
  const tapeTop = tape.getBoundingClientRect().top;

  const blocks = Array.from(tape.querySelectorAll('[data-doc-from]'));
  for (let bi = 0; bi < blocks.length; bi++) {
    if (bi % 500 === 499) {
      await new Promise(r => setTimeout(r, 0));
      if (signal?.aborted) return ranges;
    }

    const block = blocks[bi];
    const bTop    = block.getBoundingClientRect().top - tapeTop;
    const docFrom = parseInt(block.dataset.docFrom, 10);
    const docTo   = parseInt(block.dataset.docTo ?? block.dataset.docFrom, 10);
    if (isNaN(docFrom)) continue;

    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (breakStarts[mid] <= bTop) lo = mid; else hi = mid - 1;
    }
    const pi = lo;

    if (ranges[pi].from === null || docFrom < ranges[pi].from) ranges[pi].from = docFrom;
    if (ranges[pi].to   === null || docTo   > ranges[pi].to)   ranges[pi].to   = docTo;
  }

  let lastFrom = 0;
  for (let i = 0; i < n; i++) {
    if (ranges[i].from === null) ranges[i].from = lastFrom;
    if (ranges[i].to   === null) ranges[i].to   = ranges[i].from;
    lastFrom = ranges[i].from;
  }

  return ranges;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _safeClass(s) { return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
