/**
 * {document} PDF export — a self-paginating print window.
 *
 * The browser's own print headers/footers (page title, URL, date, "1/3") are
 * what made the old export look like a web page.  `@page { margin: 0 }`
 * removes them, so the margins — and everything that lives in them — are
 * ours: the document is rendered once as a measuring "tape" at the usable
 * page width, cut into pages on block boundaries (core/paginate.js, the same
 * finder the `layout: document` preview uses), and each page is a fixed
 * `pageW × pageH` box holding a clipped clone of the tape plus the header /
 * footer slots and the page number from the front matter (core/page-config.js).
 *
 * Window `<title>` = the document title → the browser's suggested PDF name.
 */

import { findPageBreaks } from '../core/paginate.js';
import { fillTokens, hasSlots, resolveDate } from '../core/page-config.js';

/**
 * @param {object} o
 * @param {string} o.bodyHtml   rendered document (title block + body)
 * @param {string} o.css        element styles (headings, tables, images…)
 * @param {object} o.cfg        parsePageConfig() result
 * @param {string} [o.title]    window title (falls back to cfg.title)
 */
export async function openPrintDocument({ bodyHtml, css, cfg, title }) {
  const win = window.open('', '_blank');
  if (!win) throw new Error('The print window was blocked — allow pop-ups for this page and try again.');

  const docTitle = title || cfg.title || 'document';
  win.document.write(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>${esc(docTitle)}</title>
<style>${css}\n${pageCss(cfg)}</style>
</head><body><div id="tape" class="md-doc">${bodyHtml}</div></body></html>`);
  win.document.close();

  const doc  = win.document;
  const tape = doc.getElementById('tape');

  // A title page: the title block alone, pushed down the page, then a break.
  if (cfg.titlePage) {
    const fm = tape.querySelector(':scope > .fm-header');
    if (fm) {
      fm.classList.add('fm-title-page');
      fm.style.marginTop = `${Math.round(cfg.usableH * 0.28)}px`;
      const br = doc.createElement('div');
      br.className = 'page-break';
      fm.after(br);
    }
  }

  // Measure only once fonts and images have settled (a late image reflows).
  try { await doc.fonts?.ready; } catch { /* no Font Loading API */ }
  await Promise.all(Array.from(tape.querySelectorAll('img')).map(img =>
    (img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; }))
      .then(() => img.decode?.().catch(() => {}))));
  void tape.offsetHeight;

  const starts = await findPageBreaks(tape, cfg.usableH);
  const titlePageFirst = cfg.titlePage && !!tape.querySelector(':scope > .fm-title-page');
  const numbered = titlePageFirst ? starts.length - 1 : starts.length;   // {total}
  const dateStr  = resolveDate(cfg.date);

  const pages = doc.createElement('div');
  pages.id = 'pages';
  for (let i = 0; i < starts.length; i++) {
    // The last page's body is only as tall as the page allows; the clone
    // inside is clipped, so the tape's trailing margin never matters here.
    const bodyH = i < starts.length - 1
      ? starts[i + 1] - starts[i]
      : Math.min(tape.scrollHeight - starts[i], cfg.usableH);
    const isTitle = titlePageFirst && i === 0;
    const pageNo  = titlePageFirst ? i : i + 1;

    const pg = doc.createElement('div');
    pg.className = 'pg';

    if (!isTitle) {
      const vars = { page: pageNo, total: numbered, title: cfg.title, subtitle: cfg.subtitle, author: cfg.author, date: dateStr };
      const hdr = bandSlots(cfg.header, cfg.pageNumbers?.startsWith('top') ? cfg.pageNumbers : null, vars);
      const ftr = bandSlots(cfg.footer, cfg.pageNumbers?.startsWith('bottom') ? cfg.pageNumbers : null, vars);
      if (hdr) pg.appendChild(band(doc, 'pg-hdr', hdr));
      if (ftr) pg.appendChild(band(doc, 'pg-ftr', ftr));
    }

    const body = doc.createElement('div');
    body.className = 'pg-body';
    body.style.height = `${bodyH}px`;
    const clone = tape.cloneNode(true);
    clone.removeAttribute('id');
    clone.className = 'md-doc pg-clone';
    clone.style.top = `${-starts[i]}px`;
    body.appendChild(clone);
    pg.appendChild(body);
    pages.appendChild(pg);
  }

  tape.remove();
  doc.body.appendChild(pages);

  win.addEventListener('afterprint', () => setTimeout(() => win.close(), 50), { once: true });
  // Let the clones lay out before the print dialog snapshots the page.
  await new Promise(r => setTimeout(r, 150));
  win.focus();
  win.print();
}

// ---------------------------------------------------------------------------

/**
 * Resolve a band's three slots: the templates, plus the page number merged
 * into its slot (joined with ` · ` when that slot already has text).
 * Returns null when the band is empty.
 */
function bandSlots(slots, pageNumPos, vars) {
  const out = {
    left:   fillTokens(slots.left,   vars),
    center: fillTokens(slots.center, vars),
    right:  fillTokens(slots.right,  vars),
  };
  if (pageNumPos) {
    const slot = pageNumPos.split('-')[1];
    out[slot] = out[slot] ? `${out[slot]} · ${vars.page}` : String(vars.page);
  }
  return hasSlots(out) ? out : null;
}

function band(doc, cls, slots) {
  const el = doc.createElement('div');
  el.className = cls;
  el.innerHTML = `<span class="pg-l">${slots.left}</span><span class="pg-c">${slots.center}</span><span class="pg-r">${slots.right}</span>`;
  return el;
}

/**
 * `@page { size }` is the SAME px size as the `.pg` boxes, so a sheet is
 * exactly one box (a named `a4` is 793.7×1122.5px — half a pixel short of the
 * boxes, and a box that overruns its sheet by any amount can open a blank
 * one).  `margin: 0` is what keeps the browser's own header/footer (URL, date,
 * "1/3") off the page: they are drawn in the page margin, and there is none;
 * the visible margins are the boxes' own.
 */
function pageCss(cfg) {
  return `
@page { size: ${cfg.pageW}px ${cfg.pageH}px; margin: 0; }
html, body { margin: 0; padding: 0; }
body { background: #fff; color: #1a1a2e; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.md-doc { ${cfg.font ? `font-family: ${cfg.font};` : ''} font-size: ${cfg.fontSize}; line-height: ${cfg.lineHeight}; }
.md-doc > :first-child { margin-top: 0; }
/* flow-root: a child's top margin (the title page's push-down) must stay INSIDE
   the tape and the clone alike — collapsing through the tape put the title
   242px lower in the clone than where it was measured (blank first page). */
#tape { display: flow-root; width: ${cfg.usableW}px; padding: 0 ${cfg.marginRight}px 0 ${cfg.marginLeft}px; box-sizing: content-box; }
.pg { position: relative; width: ${cfg.pageW}px; height: ${cfg.pageH}px; overflow: hidden; box-sizing: border-box;
      background: #fff; break-after: page; page-break-after: always; break-inside: avoid; page-break-inside: avoid; }
.pg:last-child { break-after: auto; page-break-after: auto; }
.pg-body { position: absolute; top: ${cfg.marginTop}px; left: ${cfg.marginLeft}px; width: ${cfg.usableW}px; overflow: hidden; }
.pg-clone { display: flow-root; position: relative; width: 100%; }
/* The pages ARE the pagination: no break rule inside a clone (the export
   CSS's .page-break, h2 { break-after: avoid }) may add or move a sheet. */
.pg-clone, .pg-clone * { break-before: auto !important; break-after: auto !important; break-inside: auto !important;
      page-break-before: auto !important; page-break-after: auto !important; page-break-inside: auto !important; }
.pg-hdr, .pg-ftr { position: absolute; left: ${cfg.marginLeft}px; right: ${cfg.marginRight}px; display: flex; align-items: center;
      gap: 1em; font-size: 10px; line-height: 1.3; color: #666; ${cfg.font ? `font-family: ${cfg.font};` : ''} }
.pg-hdr { top: 0; height: ${cfg.marginTop}px; }
.pg-ftr { bottom: 0; height: ${cfg.marginBottom}px; }
.pg-hdr span, .pg-ftr span { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg-l { text-align: left; } .pg-c { text-align: center; } .pg-r { text-align: right; }
.fm-title-page { border-bottom: none; }
.page-break { height: 0; margin: 0; border: 0; } .page-break span { display: none; }
@media screen {
  body { background: #777; padding: 24px 0; }
  .pg { margin: 0 auto 24px; box-shadow: 0 2px 12px rgba(0,0,0,.35); }
}
@media print { .pg { margin: 0; box-shadow: none; } }
`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
