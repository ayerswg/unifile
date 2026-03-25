/**
 * Flow → Document layout renderer.
 *
 * Renders content as a paginated document. Content flows naturally through pages;
 * `---` on its own line creates an explicit page break. The preview shows white
 * page-sized boxes stacked vertically, styled for portrait reading.
 *
 * Unlike slides, overflow DOES flow visually in the preview (the page box grows
 * to fit content). PDF/print export via `@media print` and `break-after: page`
 * handles true pagination.
 *
 * Front matter keys consumed:
 *   page        — page size: a4 | letter | a5 | custom WxH (default: a4)
 *   margin      — margin: 20mm or 20mm 25mm (v h) or all four sides
 *   header      — header template: text, supports {page}, {title}, {date}
 *   footer      — footer template: same tokens as header
 *   page-numbers — none | top-left | top-center | top-right |
 *                  bottom-left | bottom-center | bottom-right (default: bottom-center)
 *   font-size   — base font size (default: 11pt)
 *   line-height — default: 1.6
 */

import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { parseDocSections } from '../core/doc-sections.js';
import { getDSL } from '../dsl/registry.js';
import { attachScaleObserver, detachScaleObserver } from './_scale.js';

// Page sizes in CSS pixels at 96dpi (1in = 96px, 1mm ≈ 3.7795px).
// These are the intrinsic "paper" dimensions — zoom scales them to fit preview.
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
  const pages = _splitPages(content, bodyFrom);

  container.innerHTML = '';
  container.classList.add('document-mode');

  const doc = document.createElement('div');
  doc.className = 'uf-doc';
  container.appendChild(doc);

  for (let i = 0; i < pages.length; i++) {
    const page = document.createElement('div');
    page.className = 'uf-doc-page';
    // Fixed intrinsic dimensions — CSS zoom (set by ResizeObserver) handles scaling.
    page.style.cssText = `
      width: ${cfg.pageW}px;
      height: ${cfg.pageH}px;
      padding: ${cfg.margin};
      font-size: ${cfg.fontSize};
      line-height: ${cfg.lineHeight};
      box-sizing: border-box;
      overflow: hidden;
    `;
    page.dataset.docFrom = pages[i].from;
    doc.appendChild(page);

    // Header
    if (cfg.header) {
      const hdr = document.createElement('div');
      hdr.className = 'uf-doc-header';
      hdr.innerHTML = _fillTokens(cfg.header, { page: i + 1, total: pages.length, title: meta.title ?? '' });
      page.appendChild(hdr);
    }

    // Content area
    const body = document.createElement('div');
    body.className = 'uf-doc-body';
    page.appendChild(body);

    await _renderPageContent(pages[i].text, body, pages[i].from);

    // Footer
    if (cfg.footer) {
      const ftr = document.createElement('div');
      ftr.className = 'uf-doc-footer';
      ftr.innerHTML = _fillTokens(cfg.footer, { page: i + 1, total: pages.length, title: meta.title ?? '' });
      page.appendChild(ftr);
    }

    // Page number badge — absolutely-positioned overlay like slide badge.
    if (cfg.pageNumbers && cfg.pageNumbers !== 'none') {
      page.appendChild(_pageNumEl(i + 1, pages.length, cfg.pageNumbers));
    }
  }

  // Scale pages to fit the container width (print-preview — no reflow).
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
  const px     = _parsePagePx(meta.page ?? 'letter');
  const margin = meta.margin ?? '72px 80px'; // ~0.75in × ~0.83in margins
  return {
    pageW:       px.w,
    pageH:       px.h,
    margin:      _expandMargin(margin),
    fontSize:    meta['font-size']   ?? '12px',
    lineHeight:  meta['line-height'] ?? '1.6',
    header:      meta.header  ?? null,
    footer:      meta.footer  ?? null,
    pageNumbers: meta['page-numbers'] ?? 'bottom-center',
  };
}

function _parsePagePx(pageStr) {
  const key = String(pageStr ?? 'letter').toLowerCase().trim();
  if (PAGE_PX[key]) return PAGE_PX[key];
  // Custom WxH in px — e.g. "800x1000"
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

function _fillTokens(template, vars) {
  return _esc(template)
    .replace(/\{page\}/g,  String(vars.page))
    .replace(/\{total\}/g, String(vars.total))
    .replace(/\{title\}/g, _esc(vars.title))
    .replace(/\{date\}/g,  new Date().toLocaleDateString());
}

function _pageNumEl(page, total, position) {
  const el = document.createElement('div');
  // Derive horizontal alignment from position string (bottom-center, top-right, etc.)
  const align = position.split('-')[1] ?? 'center';
  el.className = `uf-doc-pagenum uf-doc-pagenum-${align}`;
  el.textContent = `${page} / ${total}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// ---------------------------------------------------------------------------
// Page splitting
// ---------------------------------------------------------------------------

/**
 * Split document body at bare `---` lines. Each segment is one page.
 * Content flows freely within a page (no overflow isolation).
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

    if (!inFence && /^---\s*$/.test(line)) {
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
// Per-page rendering (same shebang dispatch as slides)
// ---------------------------------------------------------------------------

async function _renderPageContent(pageText, el, pageFrom) {
  if (!pageText) return;
  const sections = parseDocSections(pageText);

  if (!sections.length) {
    await _renderPart('markdown', pageText, el, pageFrom, pageFrom + pageText.length, pageFrom);
    return;
  }

  const preambleRaw = pageText.slice(0, sections[0].from);
  const preamble    = preambleRaw.trim();
  if (preamble) {
    const lead = preambleRaw.search(/\S/);
    const pFrom = pageFrom + (lead >= 0 ? lead : 0);
    await _renderPart('markdown', preamble, el,
      pFrom,
      pageFrom + sections[0].from,
      pFrom);
  }

  for (let i = 0; i < sections.length; i++) {
    const sec  = sections[i];
    const raw  = pageText.slice(sec.contentFrom, sec.to);
    const text = raw.trim();
    if (text) {
      const lead = raw.search(/\S/);
      await _renderPart(sec.dslId, text, el,
        pageFrom + sec.from,
        pageFrom + sec.to,
        pageFrom + sec.contentFrom + (lead >= 0 ? lead : 0));
    }
  }
}

async function _renderPart(dslId, text, parentEl, docFrom, docTo, contentFrom) {
  const wrap = document.createElement('div');
  wrap.className = `uf-doc-part uf-dsl-${_safeClass(dslId)}`;
  if (docFrom    != null) wrap.dataset.docFrom        = docFrom;
  if (docTo      != null) wrap.dataset.docTo          = docTo;
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

function _safeClass(s) { return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function _esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
