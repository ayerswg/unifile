/**
 * {document} tables — rendering + exports (pure, Node-tested in test/tables.test.mjs).
 *
 *   renderSheetHtml(sheet, values, opts)  the Excel-style grid: a corner, column
 *                                         letters, row numbers, merged cells as
 *                                         colspan/rowspan, every cell tagged
 *                                         with its source range (click-back)
 *   sheetToCsv(sheet, values)             RFC 4180, computed values
 *   workbookToXlsx(wb, values)            a real .xlsx (stored ZIP): formulas
 *                                         with cached values, merges, header bold
 *   sheetDocument(...) / printDocument()  the self-contained HTML / print page
 *
 * Nothing here touches the DOM; the DSL module (src/dsl/markdown-tables.js) mounts the
 * strings and supplies the Markdown inline renderer for cell text.
 */

import { cellAddress, colLetter } from './grid.js';
import { isError, formatNumber, formatWith, formulaForExcel } from './formula.js';
import { buildZip } from '../zip.js';

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Values → text
// ---------------------------------------------------------------------------

/**
 * The text a cell shows.  A literal cell shows what was typed (minus a
 * forcing apostrophe); a formula result is formatted General, or to
 * `decimals` places when it is not an integer and the document asks.
 */
export function displayValue(cell, value, { decimals = null } = {}) {
  if (!cell || cell.merged) return '';
  if (cell.formula == null) {
    const t = cell.text;
    return t.startsWith("'") ? t.slice(1) : t;
  }
  if (isError(value)) return value.code;
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (decimals != null && !Number.isInteger(value)) return formatWith(value, '0.' + '0'.repeat(Math.max(0, decimals)));
    return formatNumber(value);
  }
  return String(value);
}

/** 'num' | 'text' | 'bool' | 'error' | 'empty' — the value's kind, for styling/alignment. */
export function valueKind(cell, value) {
  if (!cell || cell.merged) return 'empty';
  if (isError(value)) return 'error';
  if (value == null || value === '') return 'empty';
  if (typeof value === 'number') return 'num';
  if (typeof value === 'boolean') return 'bool';
  return 'text';
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * @param {object} sheet    from parseWorkbook
 * @param {Map} values      from evaluateWorkbook
 * @param {object} opts     { inline(text) → html (Markdown inline; default escapes),
 *                            decimals, headings: true (the A/B/C + 1/2/3 rulers),
 *                            docOffsets: true (data-doc-from/to on cells) }
 */
export function renderSheetHtml(sheet, values, opts = {}) {
  const inline = opts.inline ?? escHtml;
  const headings = opts.headings !== false;
  const docOffsets = opts.docOffsets !== false;
  const out = [];
  out.push(`<table class="uf-sheet${headings ? ' has-rulers' : ''}" data-sheet="${escHtml(sheet.name)}">`);
  if (headings) {
    out.push('<thead><tr class="uf-sheet-cols"><th class="uf-sheet-corner"></th>');
    for (let c = 0; c < sheet.cols; c++) out.push(`<th class="uf-sheet-col" data-col="${c}">${colLetter(c)}</th>`);
    out.push('</tr></thead>');
  }
  out.push('<tbody>');
  sheet.rows.forEach((row, r) => {
    const isHeader = r < sheet.headerRows;
    out.push(`<tr class="${isHeader ? 'uf-sheet-header' : ''}"${docOffsets ? ` data-doc-from="${row.from}" data-doc-to="${row.to}"` : ''}>`);
    if (headings) out.push(`<th class="uf-sheet-row" data-row="${r}">${r + 1}</th>`);
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (cell && (cell.r !== r || cell.c !== c)) continue;   // covered by a span
      if (!cell) { out.push(`<td class="uf-cell is-empty" data-addr="${cellAddress(r, c)}"></td>`); continue; }
      const v = values.get(cell);
      const kind = valueKind(cell, v);
      const text = displayValue(cell, v, opts);
      const align = sheet.aligns[c] ?? (kind === 'num' || kind === 'bool' ? 'right' : (kind === 'error' ? 'center' : 'left'));
      const cls = ['uf-cell', `is-${kind}`, cell.formula != null ? 'is-formula' : '', `al-${align}`].filter(Boolean).join(' ');
      const attrs = [
        `class="${cls}"`,
        `data-addr="${cellAddress(r, c)}"`,
        cell.colspan > 1 ? `colspan="${cell.colspan}"` : '',
        cell.rowspan > 1 ? `rowspan="${cell.rowspan}"` : '',
        docOffsets ? `data-doc-from="${cell.from}" data-doc-to="${cell.to}"` : '',
        cell.formula != null ? `title="${escHtml('=' + cell.formula + (isError(v) && v.detail ? ' — ' + v.detail : ''))}"` : '',
      ].filter(Boolean).join(' ');
      const tag = isHeader ? 'th' : 'td';
      const body = cell.formula != null ? escHtml(text) : inline(text);
      out.push(`<${tag} ${attrs}>${body}</${tag}>`);
    }
    out.push('</tr>');
  });
  out.push('</tbody></table>');
  return out.join('');
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvField(s) {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The sheet's computed values as CSV (merged cells are empty where covered). */
export function sheetToCsv(sheet, values, opts = {}) {
  const lines = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const fields = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (!cell || cell.r !== r || cell.c !== c) { fields.push(''); continue; }
      fields.push(csvField(displayValue(cell, values.get(cell), opts)));
    }
    lines.push(fields.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// XLSX — the minimum Excel / Numbers / LibreOffice need
// ---------------------------------------------------------------------------

const xml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sheetXml(sheet, values, decimals) {
  const rows = [];
  const merges = [];
  // Column widths from the text (Excel's unit ≈ one character).
  const widths = new Array(sheet.cols).fill(8);
  for (const cell of sheet.cells) {
    if (cell.colspan !== 1 || cell.merged) continue;
    const t = displayValue(cell, values.get(cell), { decimals });
    widths[cell.c] = Math.max(widths[cell.c], Math.min(60, t.length + 2));
  }
  for (let r = 0; r < sheet.rows.length; r++) {
    const cells = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (!cell || cell.r !== r || cell.c !== c) continue;
      const ref = cellAddress(r, c);
      if (cell.colspan > 1 || cell.rowspan > 1) merges.push(`${ref}:${cellAddress(r + cell.rowspan - 1, c + cell.colspan - 1)}`);
      const v = values.get(cell);
      const style = r < sheet.headerRows ? ' s="1"' : '';
      const f = cell.formula != null ? `<f>${xml(formulaForExcel(cell.formula, r))}</f>` : '';
      if (cell.formula == null && (v == null || v === '')) continue;
      if (isError(v)) cells.push(`<c r="${ref}"${style} t="e">${f}<v>${xml(v.code === '#CIRC!' ? '#REF!' : v.code)}</v></c>`);
      // 15 significant digits: what Excel itself keeps (3*1.2 → 3.6, not 3.5999999999999996).
      else if (typeof v === 'number') cells.push(`<c r="${ref}"${style}>${f}<v>${Number.isFinite(v) ? String(Number(v.toPrecision(15))) : 0}</v></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${style} t="b">${f}<v>${v ? 1 : 0}</v></c>`);
      else if (f) cells.push(`<c r="${ref}"${style} t="str">${f}<v>${xml(v)}</v></c>`);
      else cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
    }
    if (cells.length) rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  }
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    (sheet.cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    `</worksheet>`;
}

/** Excel limits sheet names to 31 chars without []:*?/\ */
function xlsxSheetName(name, used) {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, k = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}

/**
 * The workbook as an .xlsx (a stored ZIP of OOXML parts).  Formulas are
 * written as formulas with their computed values cached, so Excel shows them
 * at once and recalculates on edit; merged cells become real merges; header
 * rows are bold.
 * @returns {Uint8Array}
 */
export function workbookToXlsx(wb, values, { decimals = null, title = '' } = {}) {
  const sheets = wb.sheets.length ? wb.sheets : [{ name: 'Sheet1', rows: [], cols: 0, grid: [], cells: [], headerRows: 0, aligns: [] }];
  const used = new Set();
  const names = sheets.map(s => xlsxSheetName(s.name, used));
  const entries = [];
  entries.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` });
  entries.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>` });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  entries.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>unifile {sheet}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` });
  entries.push({ name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>unifile</Application></Properties>` });
  entries.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<calcPr fullCalcOnLoad="1"/>
</workbook>` });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` });
  entries.push({ name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>` });
  sheets.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, values, decimals) }));
  return buildZip(entries);
}

// ---------------------------------------------------------------------------
// Standalone HTML / print
// ---------------------------------------------------------------------------

/** The table rules alone — the {document} HTML/PDF exports append these to their own CSS. */
export const TABLE_EXPORT_CSS = `
.uf-sheet-block { margin: 1em 0; overflow-x: auto; }
.uf-sheet { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
.uf-sheet th, .uf-sheet td { border: 1px solid #ddd; padding: .4em .8em; vertical-align: top; }
.uf-sheet th.uf-cell { background: #f5f5f5; }
.uf-sheet .uf-sheet-col, .uf-sheet .uf-sheet-row, .uf-sheet .uf-sheet-corner { background: #f1f1f1; color: #888; font-weight: 500; font-size: .8em; text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace; }
.uf-sheet .uf-sheet-row { text-align: right; }
.uf-sheet .al-right { text-align: right; } .uf-sheet .al-center { text-align: center; } .uf-sheet .al-left { text-align: left; }
.uf-sheet .is-error { color: #b00020; }
.uf-sheet .uf-cell p { margin: 0; }
`;

/** The CSS the standalone sheet exports / print page use. */
export const EXPORT_CSS = `
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; background: #fff; margin: 0; padding: 32px; }
h1, h2 { font-weight: 600; }
h2.uf-sheet-name { font-size: 15px; margin: 28px 0 8px; color: #555; }
.uf-sheet-notes { max-width: 70ch; color: #333; }
${TABLE_EXPORT_CSS}
.uf-sheet { width: auto; font-size: 13px; }
.uf-sheet th, .uf-sheet td { padding: 4px 8px; white-space: pre-wrap; }
@media print { body { padding: 0; } h2.uf-sheet-name { page-break-after: avoid; } .uf-sheet { page-break-inside: auto; } .uf-sheet tr { page-break-inside: avoid; } .uf-sheet-block { page-break-after: always; } .uf-sheet-block:last-child { page-break-after: auto; } }
`;

/**
 * The whole workbook as one HTML fragment: every sheet under its name, the
 * prose blocks between (`prose(text)` → html; default: preformatted).
 */
export function renderWorkbookHtml(wb, values, opts = {}) {
  const prose = opts.prose ?? (t => `<pre class="uf-sheet-notes">${escHtml(t)}</pre>`);
  const off = (from, to) => (opts.docOffsets !== false ? ` data-doc-from="${from}" data-doc-to="${to}"` : '');
  const parts = [];
  const nameOf = (s) => `<h2 class="uf-sheet-name"${off(s.nameFrom, s.nameTo)}>${escHtml(s.name)}</h2>`;
  for (const b of wb.blocks) {
    if (b.kind === 'prose') {
      parts.push(`<div class="uf-sheet-notes"${off(b.from, b.to)}>${prose(b.text)}</div>`);
    } else if (b.kind === 'name') {
      // The heading names the sheet: it is drawn here, in its own place.
      if (opts.names !== false && b.sheet) parts.push(nameOf(b.sheet));
    } else {
      const s = b.sheet;
      parts.push(`<div class="uf-sheet-block" data-sheet-index="${s.index}">` +
        (opts.names !== false && !s.named ? nameOf(s) : '') +
        `<div class="uf-sheet-scroll">${renderSheetHtml(s, values, opts)}</div></div>`);
    }
  }
  return parts.join('\n');
}

/** A self-contained HTML document of the workbook (values, not formulas). */
export function sheetDocument(wb, values, { title = 'Sheet', decimals = null, prose, inline } = {}) {
  const body = renderWorkbookHtml(wb, values, { decimals, prose, inline, docOffsets: false });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title><style>${EXPORT_CSS}</style></head>
<body><h1>${escHtml(title)}</h1>
${body}
</body></html>`;
}

/** The print page: same markup, landscape pages, closes itself after printing. */
export function printDocument(wb, values, opts = {}) {
  const body = renderWorkbookHtml(wb, values, { ...opts, docOffsets: false });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escHtml(opts.title || 'Sheet')}</title>
<style>${EXPORT_CSS}
@page { size: landscape; margin: 0.6in; }
</style></head>
<body>${body}
<script>window.addEventListener('afterprint', () => setTimeout(() => window.close(), 50));</script>
</body></html>`;
}
