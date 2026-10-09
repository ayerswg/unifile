/**
 * {spreadsheet} — static rendering + text exports (pure, Node-tested).
 *
 *   renderSheetHtml(book, sheet, opts)   one sheet as an HTML table: rulers,
 *                                        merges, resolved styles inline,
 *                                        `data-addr` + `data-doc-from/to` per
 *                                        cell (the quine's static preview, the
 *                                        HTML export, the print page)
 *   renderWorkbookHtml(book, opts)       every sheet under its name
 *   sheetToCsv(book, sheet)              RFC 4180, displayed values
 *   workbookDocument / printDocument     self-contained pages
 *
 * The LIVE grid (src/ui/sheet-grid.js) draws its own table — same classes,
 * same cell attributes — so these two stay visually aligned through app.css.
 */

import { colLetter } from '../tables/grid.js';
import { viewRows, viewCols } from './book.js';
import { styleToCss } from './style.js';

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Column width in px from the `width` directive (characters) — 8px a character, like Excel's default unit. */
export const CHAR_PX = 8;
export const DEFAULT_COL_PX = 96;
export const DEFAULT_ROW_PX = 26;
export const colPx = (sheet, c) => sheet.widths.has(c) ? Math.round(sheet.widths.get(c) * CHAR_PX + 12) : DEFAULT_COL_PX;

/**
 * @param {object} opts  { rulers: true, docOffsets: true, view: true (apply sort/filter/hidden),
 *                         extraRows: 0, extraCols: 0 (blank rows/cols past the data, the live grid's room to grow) }
 */
export function renderSheetHtml(book, sheet, opts = {}) {
  const rulers = opts.rulers !== false;
  const docOffsets = opts.docOffsets !== false;
  const totalCols = sheet.cols + (opts.extraCols ?? 0);
  const colsShown = opts.view === false ? Array.from({ length: totalCols }, (_, i) => i) : viewCols(sheet, totalCols);
  const rowsData = opts.view === false ? sheet.rows.map((_, r) => r) : viewRows(book, sheet);
  const rowsShown = rowsData.concat(Array.from({ length: opts.extraRows ?? 0 }, (_, i) => sheet.rows.length + i));
  const out = [];
  out.push(`<table class="uf-ss-grid${rulers ? ' has-rulers' : ''}" data-sheet="${escHtml(sheet.name)}" data-sheet-index="${sheet.index}">`);
  out.push('<colgroup>' + (rulers ? '<col class="uf-ss-rulercol">' : '') + colsShown.map(c => `<col style="width:${colPx(sheet, c)}px">`).join('') + '</colgroup>');
  if (rulers) {
    out.push('<thead><tr class="uf-ss-cols"><th class="uf-ss-corner" data-corner="1"></th>');
    for (const c of colsShown) out.push(`<th class="uf-ss-col${c < sheet.freeze.cols ? ' is-frozen' : ''}" data-col="${c}">${colLetter(c)}<span class="uf-ss-colgrip" data-grip-col="${c}"></span></th>`);
    out.push('</tr></thead>');
  }
  out.push('<tbody>');
  const shownSet = new Set(rowsShown);
  for (const r of rowsShown) {
    const row = sheet.rows[r];
    const isHeader = r < sheet.headerRows;
    const h = sheet.heights.get(r);
    const attrs = [`class="${isHeader ? 'uf-ss-header' : ''}${r < sheet.freeze.rows || isHeader ? ' is-frozen' : ''}"`, `data-row="${r}"`, h ? `style="height:${h}px"` : '', row && docOffsets ? `data-doc-from="${row.from}" data-doc-to="${row.to}"` : ''].filter(Boolean).join(' ');
    out.push(`<tr ${attrs}>`);
    if (rulers) out.push(`<th class="uf-ss-row" data-row="${r}">${r + 1}<span class="uf-ss-rowgrip" data-grip-row="${r}"></span></th>`);
    for (const c of colsShown) {
      const cell = sheet.grid[r]?.[c] ?? null;
      if (cell && (cell.r !== r || cell.c !== c)) {
        // Covered by a span.  A span whose anchor row is filtered out still
        // needs its cells, else the row would be short — draw blanks then.
        if (shownSet.has(cell.r) && !sheet.hidden.cols.has(cell.c)) continue;
      }
      if (!cell || cell.r !== r || cell.c !== c) { out.push(`<td class="uf-ss-cell is-empty" data-addr="${colLetter(c)}${r + 1}" data-r="${r}" data-c="${c}"></td>`); continue; }
      out.push(cellHtml(book, sheet, cell, { isHeader, docOffsets, shownSet }));
    }
    out.push('</tr>');
  }
  out.push('</tbody></table>');
  return out.join('');
}

function cellHtml(book, sheet, cell, { isHeader, docOffsets, shownSet }) {
  const r = cell.r, c = cell.c;
  const v = book.valueOf(cell);
  const kind = book.kindOf(cell);
  const text = book.display(cell);
  const st = book.styleOf(cell);
  const align = st.align ?? sheet.aligns[c] ?? (kind === 'num' || kind === 'bool' ? 'right' : (kind === 'error' ? 'center' : 'left'));
  const cls = ['uf-ss-cell', `is-${kind}`, cell.formula != null ? 'is-formula' : '', `al-${align}`, isHeader ? 'is-header' : ''].filter(Boolean).join(' ');
  // A span's rows/cols that are hidden shrink the span.
  let rowspan = 0, colspan = 0;
  for (let k = 0; k < cell.rowspan; k++) if (shownSet.has(r + k)) rowspan++;
  for (let k = 0; k < cell.colspan; k++) if (!sheet.hidden.cols.has(c + k)) colspan++;
  const css = styleToCss(st, { bold: isHeader });
  const comment = sheet.comments.find(x => x.r === r && x.c === c);
  const attrs = [
    `class="${cls}${comment ? ' has-comment' : ''}"`,
    `data-addr="${colLetter(c)}${r + 1}"`, `data-r="${r}"`, `data-c="${c}"`,
    colspan > 1 ? `colspan="${colspan}"` : '', rowspan > 1 ? `rowspan="${rowspan}"` : '',
    docOffsets && !cell.synthetic ? `data-doc-from="${cell.from}" data-doc-to="${cell.to}"` : '',
    css ? `style="${escHtml(css)}"` : '',
    cell.formula != null ? `title="${escHtml('=' + cell.formula + (v?.detail ? ' — ' + v.detail : ''))}"` : (comment ? `title="${escHtml(comment.text)}"` : ''),
  ].filter(Boolean).join(' ');
  return `<td ${attrs}>${escHtml(text)}</td>`;
}

/** Every sheet, each under its name (the HTML export, the quine preview). */
export function renderWorkbookHtml(book, opts = {}) {
  const parts = [];
  for (const s of book.sheets) {
    parts.push(`<section class="uf-ss-sheet" data-sheet-index="${s.index}">` +
      `<h2 class="uf-ss-name"${opts.docOffsets !== false ? ` data-doc-from="${s.nameFrom}" data-doc-to="${s.nameTo}"` : ''}>${escHtml(s.name)}</h2>` +
      `<div class="uf-ss-scroll">${renderSheetHtml(book, s, opts)}</div>` +
      (s.notes.length ? `<div class="uf-ss-notes">${s.notes.map(n => `<p>${escHtml(n.text)}</p>`).join('')}</div>` : '') +
      `</section>`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const csvField = s => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

/** The sheet's shown values as CSV, in text order (no view sort / filter). */
export function sheetToCsv(book, sheet) {
  const lines = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const fields = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (!cell || cell.r !== r || cell.c !== c) { fields.push(''); continue; }
      fields.push(csvField(book.display(cell)));
    }
    lines.push(fields.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Standalone HTML / print
// ---------------------------------------------------------------------------

export const EXPORT_CSS = `
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fff; margin: 0; padding: 32px; }
h1 { font-weight: 600; font-size: 22px; }
h2.uf-ss-name { font-size: 15px; margin: 28px 0 8px; color: #555; font-weight: 600; }
.uf-ss-scroll { overflow-x: auto; }
.uf-ss-grid { border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 13px; font-variant-numeric: tabular-nums; }
.uf-ss-grid th, .uf-ss-grid td { border-right: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 3px 6px; vertical-align: top; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.uf-ss-grid .uf-ss-corner, .uf-ss-grid .uf-ss-col, .uf-ss-grid .uf-ss-row { background: #f1f1f1; color: #888; font-weight: 500; font-size: 11px; text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace; }
.uf-ss-grid .uf-ss-row { text-align: right; }
.uf-ss-grid col.uf-ss-rulercol { width: 40px; }
.uf-ss-grid .al-right { text-align: right; } .uf-ss-grid .al-center { text-align: center; } .uf-ss-grid .al-left { text-align: left; }
.uf-ss-grid .is-error { color: #b00020; }
.uf-ss-grid tr.uf-ss-header td { font-weight: 600; background: #fafafa; }
.uf-ss-grid .uf-ss-colgrip, .uf-ss-grid .uf-ss-rowgrip { display: none; }
.uf-ss-notes { max-width: 70ch; color: #333; font-size: 14px; }
@media print { body { padding: 0; } h2.uf-ss-name { page-break-after: avoid; } .uf-ss-grid tr { page-break-inside: avoid; } .uf-ss-sheet { page-break-after: always; } .uf-ss-sheet:last-child { page-break-after: auto; } }
`;

/** A self-contained HTML document of the workbook (values and formatting, not formulas). */
export function workbookDocument(book, { title = 'Spreadsheet' } = {}) {
  const body = renderWorkbookHtml(book, { docOffsets: false });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title><style>${EXPORT_CSS}</style></head>
<body><h1>${escHtml(title)}</h1>
${body}
</body></html>`;
}

/** The print page: landscape, closes itself after printing. */
export function printDocument(book, { title = 'Spreadsheet' } = {}) {
  const body = renderWorkbookHtml(book, { docOffsets: false });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>${EXPORT_CSS}
@page { size: landscape; margin: 0.6in; }
</style></head>
<body>${body}
<script>window.addEventListener('afterprint', () => setTimeout(() => window.close(), 50));</script>
</body></html>`;
}
