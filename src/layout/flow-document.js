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

// Page dimensions in mm → aspect ratio for CSS
const PAGE_SIZES = {
  a4:     { w: 210, h: 297 },
  letter: { w: 216, h: 279 },
  a5:     { w: 148, h: 210 },
  legal:  { w: 216, h: 356 },
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
    page.style.cssText = `
      width: min(${cfg.pageW}mm, 100%);
      padding: ${cfg.margin};
      font-size: ${cfg.fontSize};
      line-height: ${cfg.lineHeight};
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

    // Page number (if position is top-*)
    if (cfg.pageNumbers && cfg.pageNumbers.startsWith('top')) {
      page.appendChild(_pageNumEl(i + 1, pages.length, cfg.pageNumbers));
    }

    // Content area
    const body = document.createElement('div');
    body.className = 'uf-doc-body';
    page.appendChild(body);

    await _renderPageContent(pages[i].text, body);

    // Page number (if position is bottom-*)
    if (cfg.pageNumbers && cfg.pageNumbers.startsWith('bottom')) {
      page.appendChild(_pageNumEl(i + 1, pages.length, cfg.pageNumbers));
    }

    // Footer
    if (cfg.footer) {
      const ftr = document.createElement('div');
      ftr.className = 'uf-doc-footer';
      ftr.innerHTML = _fillTokens(cfg.footer, { page: i + 1, total: pages.length, title: meta.title ?? '' });
      page.appendChild(ftr);
    }
  }
}

export function teardownDocument(container) {
  container.classList.remove('document-mode');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function _parseConfig(meta) {
  const size = _parsePageSize(meta.page ?? 'a4');
  const margin = meta.margin ?? '20mm 25mm';
  return {
    pageW:      size.w,
    pageH:      size.h,
    margin:     _expandMargin(margin),
    fontSize:   meta['font-size']   ?? '11pt',
    lineHeight: meta['line-height'] ?? '1.6',
    header:     meta.header  ?? null,
    footer:     meta.footer  ?? null,
    pageNumbers: meta['page-numbers'] ?? 'bottom-center',
  };
}

function _parsePageSize(pageStr) {
  if (PAGE_SIZES[pageStr]) return PAGE_SIZES[pageStr];
  const m = /^(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/.exec(pageStr.trim());
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : PAGE_SIZES.a4;
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
  const align = position.split('-')[1] ?? 'center';
  el.className = `uf-doc-pagenum uf-doc-pagenum-${align}`;
  el.textContent = `${page} / ${total}`;
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
      const s = current.join('\n').trim();
      if (s) pages.push({ text: s, from: currentFrom });
      offset += line.length + 1;
      current = [];
      currentFrom = offset;
    } else {
      current.push(line);
      offset += line.length + 1;
    }
  }

  const last = current.join('\n').trim();
  if (last) pages.push({ text: last, from: currentFrom });

  return pages.length ? pages : [{ text: '', from: bodyFrom }];
}

// ---------------------------------------------------------------------------
// Per-page rendering (same shebang dispatch as slides)
// ---------------------------------------------------------------------------

async function _renderPageContent(pageText, el) {
  if (!pageText) return;
  const sections = parseDocSections(pageText);

  if (!sections.length) {
    await _renderPart('markdown', pageText, el);
    return;
  }

  const preamble = pageText.slice(0, sections[0].from).trim();
  if (preamble) await _renderPart('markdown', preamble, el);

  for (let i = 0; i < sections.length; i++) {
    const sec  = sections[i];
    const next = sections[i + 1];
    const text = pageText.slice(sec.contentFrom, next ? next.from : pageText.length).trim();
    if (text) await _renderPart(sec.dslId, text, el);
  }
}

async function _renderPart(dslId, text, parentEl) {
  const wrap = document.createElement('div');
  wrap.className = `uf-doc-part uf-dsl-${_safeClass(dslId)}`;
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
