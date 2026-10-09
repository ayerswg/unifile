/**
 * {spreadsheet} — the .xlsx writer (pure, Node-tested).
 *
 * A stored ZIP of OOXML parts (src/core/zip.js).  Everything the DSL holds
 * travels: formulas (with cached values, so Excel / Numbers / Sheets show
 * them at once and recalculate on edit; bare-column refs expanded), merges,
 * number formats, fonts / fills / borders / alignment as real cell styles,
 * conditional formatting rules (cellIs, containsText, top10, colour scales,
 * expressions), column widths, row heights, frozen panes, hidden rows and
 * columns, and cell comments (the legacy VML notes every reader shows).
 */

import { buildZip } from '../zip.js';
import { cellAddress, colLetter } from '../tables/grid.js';
import { isError, isDate, isDateFormat, formulaForExcel } from '../tables/formula.js';
import { formatRange } from './parse.js';
import { colorToRgb, rgbToHex } from './style.js';
import { chartData, CHART_PALETTE, CHART_DEFAULT_SIZE } from './chart.js';

const xml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const argb = (c) => { const rgb = colorToRgb(c); return rgb ? 'FF' + rgbToHex(rgb).slice(1).toUpperCase() : null; };

// ---------------------------------------------------------------------------
// Style table — one xf per distinct resolved style
// ---------------------------------------------------------------------------

class StyleTable {
  constructor() {
    this.fonts = [`<font><sz val="11"/><name val="Calibri"/></font>`];
    this.fills = [`<fill><patternFill patternType="none"/></fill>`, `<fill><patternFill patternType="gray125"/></fill>`];
    this.borders = [`<border><left/><right/><top/><bottom/><diagonal/></border>`];
    this.numFmts = new Map();   // pattern → id (custom ids start at 164)
    this.xfs = [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`];
    this.xfIndex = new Map([['', 0]]);
    this.dxfs = [];
  }
  _add(list, s) { let i = list.indexOf(s); if (i < 0) { list.push(s); i = list.length - 1; } return i; }
  fontXml(st) {
    const parts = [];
    if (st.bold) parts.push('<b/>');
    if (st.italic) parts.push('<i/>');
    if (st.underline) parts.push('<u/>');
    if (st.strike) parts.push('<strike/>');
    parts.push(`<sz val="${st.size || 11}"/>`);
    const c = st.color && argb(st.color);
    if (c) parts.push(`<color rgb="${c}"/>`);
    parts.push(`<name val="${st.font === 'mono' ? 'Consolas' : st.font === 'serif' ? 'Times New Roman' : 'Calibri'}"/>`);
    return `<font>${parts.join('')}</font>`;
  }
  numFmtId(fmt) {
    if (!fmt || fmt === '@') return fmt === '@' ? 49 : 0;
    const builtin = { '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11 }[fmt];
    if (builtin) return builtin;
    if (!this.numFmts.has(fmt)) this.numFmts.set(fmt, 164 + this.numFmts.size);
    return this.numFmts.get(fmt);
  }
  borderXml(b) {
    if (!b || b === 'none') return this.borders[0];
    const sides = b === 'all' ? ['left', 'right', 'top', 'bottom'] : b.split(',');
    const side = s => (sides.includes(s) ? `<${s} style="thin"><color auto="1"/></${s}>` : `<${s}/>`);
    return `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
  }
  /** The xf index for a resolved style (+ `bold` forced for header rows). */
  xf(st, { bold = false } = {}) {
    const s = { ...st, bold: st.bold || bold };
    const key = JSON.stringify(s);
    if (this.xfIndex.has(key)) return this.xfIndex.get(key);
    const fontId = (s.bold || s.italic || s.underline || s.strike || s.size || s.color || s.font) ? this._add(this.fonts, this.fontXml(s)) : 0;
    const bg = s.bg && argb(s.bg);
    const fillId = bg ? this._add(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = s.border && s.border !== 'none' ? this._add(this.borders, this.borderXml(s.border)) : 0;
    const numFmtId = this.numFmtId(s.format);
    const align = [];
    if (s.align) align.push(`horizontal="${s.align}"`);
    if (s.valign) align.push(`vertical="${s.valign === 'middle' ? 'center' : s.valign}"`);
    if (s.wrap) align.push('wrapText="1"');
    const applies = [fontId ? 'applyFont="1"' : '', fillId ? 'applyFill="1"' : '', borderId ? 'applyBorder="1"' : '', numFmtId ? 'applyNumberFormat="1"' : '', align.length ? 'applyAlignment="1"' : ''].filter(Boolean).join(' ');
    const x = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${applies ? ' ' + applies : ''}>${align.length ? `<alignment ${align.join(' ')}/>` : ''}</xf>`;
    this.xfs.push(x);
    const id = this.xfs.length - 1;
    this.xfIndex.set(key, id);
    return id;
  }
  /** A differential format (conditional formatting). */
  dxf(props) {
    const parts = [];
    if (props.bold || props.italic || props.underline || props.strike || props.color) {
      const f = [];
      if (props.bold) f.push('<b/>'); if (props.italic) f.push('<i/>'); if (props.underline) f.push('<u/>'); if (props.strike) f.push('<strike/>');
      const c = props.color && argb(props.color); if (c) f.push(`<color rgb="${c}"/>`);
      parts.push(`<font>${f.join('')}</font>`);
    }
    if (props.format) parts.push(`<numFmt numFmtId="${this.numFmtId(props.format)}" formatCode="${xml(props.format)}"/>`);
    const bg = props.bg && argb(props.bg);
    if (bg) parts.push(`<fill><patternFill><bgColor rgb="${bg}"/></patternFill></fill>`);
    if (props.border && props.border !== 'none') parts.push(this.borderXml(props.border));
    this.dxfs.push(`<dxf>${parts.join('')}</dxf>`);
    return this.dxfs.length - 1;
  }
  xml() {
    const numFmts = [...this.numFmts].map(([f, id]) => `<numFmt numFmtId="${id}" formatCode="${xml(f)}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmts ? `<numFmts count="${this.numFmts.size}">${numFmts}</numFmts>` : ''}
<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>
<fills count="${this.fills.length}">${this.fills.join('')}</fills>
<borders count="${this.borders.length}">${this.borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="${this.dxfs.length}">${this.dxfs.join('')}</dxfs>
</styleSheet>`;
  }
}

// ---------------------------------------------------------------------------
// Sheet XML
// ---------------------------------------------------------------------------

const OPERATORS = { '=': 'equal', '<>': 'notEqual', '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanOrEqual', '>=': 'greaterThanOrEqual' };

/** A bounded sqref for a (possibly open) range, clipped to the sheet. */
function sqref(R, sheet) {
  const r2 = R.r2 === Infinity ? Math.max(sheet.rows.length - 1, R.r1) : R.r2;
  const c2 = R.c2 === Infinity ? Math.max(sheet.cols - 1, R.c1) : R.c2;
  return formatRange({ r1: R.r1, c1: R.c1, r2, c2 });
}

function cfRulesXml(book, sheet, styles) {
  const out = [];
  let priority = 1;
  const excelExpr = (text, R) => formulaForExcel(text, R.r1);
  sheet.rules.forEach(rule => {
    const ref = sqref(rule.range, sheet);
    const anchor = cellAddress(rule.range.r1, rule.range.c1);
    const dxfId = styles.dxf(rule.props);
    const cond = rule.cond;
    const base = `dxfId="${dxfId}" priority="${priority++}"`;
    let body = null;
    switch (cond.kind) {
      case 'cmp': body = `<cfRule type="cellIs" ${base} operator="${OPERATORS[cond.op]}"><formula>${xml(excelExpr(cond.value, rule.range))}</formula></cfRule>`; break;
      case 'between': body = `<cfRule type="cellIs" ${base} operator="between"><formula>${xml(excelExpr(cond.a, rule.range))}</formula><formula>${xml(excelExpr(cond.b, rule.range))}</formula></cfRule>`; break;
      case 'contains': body = `<cfRule type="containsText" ${base} operator="containsText" text="${xml(cond.text)}"><formula>NOT(ISERROR(SEARCH("${xml(cond.text.replace(/"/g, '""'))}",${anchor})))</formula></cfRule>`; break;
      case 'starts': body = `<cfRule type="beginsWith" ${base} operator="beginsWith" text="${xml(cond.text)}"><formula>LEFT(${anchor},${cond.text.length})="${xml(cond.text.replace(/"/g, '""'))}"</formula></cfRule>`; break;
      case 'ends': body = `<cfRule type="endsWith" ${base} operator="endsWith" text="${xml(cond.text)}"><formula>RIGHT(${anchor},${cond.text.length})="${xml(cond.text.replace(/"/g, '""'))}"</formula></cfRule>`; break;
      case 'blank': body = `<cfRule type="containsBlanks" ${base}><formula>LEN(TRIM(${anchor}))=0</formula></cfRule>`; break;
      case 'filled': body = `<cfRule type="notContainsBlanks" ${base}><formula>LEN(TRIM(${anchor}))&gt;0</formula></cfRule>`; break;
      case 'error': body = `<cfRule type="containsErrors" ${base}><formula>ISERROR(${anchor})</formula></cfRule>`; break;
      case 'duplicate': body = `<cfRule type="duplicateValues" ${base}/>`; break;
      case 'unique': body = `<cfRule type="uniqueValues" ${base}/>`; break;
      case 'top': body = `<cfRule type="top10" ${base} rank="${cond.n}"/>`; break;
      case 'bottom': body = `<cfRule type="top10" ${base} bottom="1" rank="${cond.n}"/>`; break;
      case 'formula': body = `<cfRule type="expression" ${base}><formula>${xml(excelExpr(cond.formula, rule.range))}</formula></cfRule>`; break;
    }
    if (body) out.push(`<conditionalFormatting sqref="${ref}">${body}</conditionalFormatting>`);
  });
  (sheet.bars ?? []).forEach(b => {
    const c = argb(b.color);
    if (!c) return;
    out.push(`<conditionalFormatting sqref="${sqref(b.range, sheet)}"><cfRule type="dataBar" priority="${priority++}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${c}"/></dataBar></cfRule></conditionalFormatting>`);
  });
  sheet.scales.forEach(sc => {
    const cols = sc.colors.map(argb).filter(Boolean);
    if (cols.length < 2) return;
    const cfvo = cols.length >= 3 ? `<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>` : `<cfvo type="min"/><cfvo type="max"/>`;
    const colorsXml = (cols.length >= 3 ? cols.slice(0, 3) : cols.slice(0, 2)).map(c => `<color rgb="${c}"/>`).join('');
    out.push(`<conditionalFormatting sqref="${sqref(sc.range, sheet)}"><cfRule type="colorScale" priority="${priority++}"><colorScale>${cfvo}${colorsXml}</colorScale></cfRule></conditionalFormatting>`);
  });
  return out.join('');
}

function sheetXml(book, sheet, styles, { hasComments, hasDrawing }) {
  const rows = [];
  const merges = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const cells = [];
    for (let c = 0; c < sheet.cols; c++) {
      const cell = sheet.grid[r][c];
      if (!cell || cell.r !== r || cell.c !== c) continue;
      const ref = cellAddress(r, c);
      if (cell.colspan > 1 || cell.rowspan > 1) merges.push(`${ref}:${cellAddress(r + cell.rowspan - 1, c + cell.colspan - 1)}`);
      const v = book.valueOf(cell);
      let st = book.staticStyleOf(cell);   // rules go out as conditional formats, not baked in
      if (isDate(v) && !(st.format && isDateFormat(st.format))) st = { ...st, format: v.hasTime ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd' };
      if (typeof v === 'string' && v.includes('\n') && !st.wrap) st = { ...st, wrap: true };
      const xf = styles.xf(st, { bold: r < sheet.headerRows });
      const s = xf ? ` s="${xf}"` : '';
      const f = cell.formula != null ? `<f>${xml(formulaForExcel(cell.formula, r))}</f>` : '';
      if (cell.formula == null && (v == null || v === '')) { if (xf) cells.push(`<c r="${ref}"${s}/>`); continue; }
      if (isError(v)) cells.push(`<c r="${ref}"${s} t="e">${f}<v>${xml(v.code === '#CIRC!' ? '#REF!' : v.code)}</v></c>`);
      else if (isDate(v)) cells.push(`<c r="${ref}"${s}>${f}<v>${String(Number(v.serial.toPrecision(15)))}</v></c>`);
      else if (typeof v === 'number') cells.push(`<c r="${ref}"${s}>${f}<v>${Number.isFinite(v) ? String(Number(v.toPrecision(15))) : 0}</v></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${s} t="b">${f}<v>${v ? 1 : 0}</v></c>`);
      else if (f) cells.push(`<c r="${ref}"${s} t="str">${f}<v>${xml(v)}</v></c>`);
      else cells.push(`<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`);
    }
    const h = sheet.heights.get(r);
    const hidden = sheet.hidden.rows.has(r);
    const attrs = [`r="${r + 1}"`, h ? `ht="${(h * 0.75).toFixed(2)}" customHeight="1"` : '', hidden ? 'hidden="1"' : ''].filter(Boolean).join(' ');
    if (cells.length || h || hidden) rows.push(`<row ${attrs}>${cells.join('')}</row>`);
  }
  // Column widths: the directive's characters, else from the text.
  const widths = new Array(sheet.cols).fill(sheet.defaultWidth || 8);
  for (const cell of sheet.cells) {
    if (cell.colspan !== 1 || cell.merged) continue;
    widths[cell.c] = Math.max(widths[cell.c], Math.min(60, book.display(cell).length + 2));
  }
  for (const [c, w] of sheet.widths) if (c < sheet.cols) widths[c] = w;
  // customWidth marks the widths the sheet SET (an importer keeps those and
  // drops the text-derived ones).
  const colsXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}"${sheet.widths.has(i) || sheet.defaultWidth ? ' customWidth="1"' : ''}${sheet.hidden.cols.has(i) ? ' hidden="1"' : ''}/>`).join('');

  const frozenRows = Math.max(sheet.headerRows, sheet.freeze.rows), frozenCols = sheet.freeze.cols;
  const pane = frozenRows || frozenCols
    ? `<pane${frozenCols ? ` xSplit="${frozenCols}"` : ''}${frozenRows ? ` ySplit="${frozenRows}"` : ''} topLeftCell="${cellAddress(frozenRows, frozenCols)}" activePane="bottomRight" state="frozen"/>`
    : '';
  const autoFilter = (sheet.filterOn || sheet.filters.length || sheet.sorts.length) && sheet.rows.length > 1 && sheet.cols
    ? `<autoFilter ref="${cellAddress(Math.max(0, sheet.headerRows - 1), 0)}:${cellAddress(sheet.rows.length - 1, sheet.cols - 1)}"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    (sheet.cols ? `<cols>${colsXml}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    autoFilter +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    cfRulesXml(book, sheet, styles) +
    (hasDrawing ? `<drawing r:id="rId3"/>` : '') +
    (hasComments ? `<legacyDrawing r:id="rId1"/>` : '') +
    `</worksheet>`;
}

// ---------------------------------------------------------------------------
// Comments (legacy VML notes)
// ---------------------------------------------------------------------------

function commentsXml(sheet) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>unifile</author></authors><commentList>` +
    sheet.comments.map(c => `<comment ref="${cellAddress(c.r, c.c)}" authorId="0"><text><r><t xml:space="preserve">${xml(c.text)}</t></r></text></comment>`).join('') +
    `</commentList></comments>`;
}

function vmlXml(sheet) {
  const shapes = sheet.comments.map((c, i) => `<v:shape id="_x0000_s${1025 + i}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:${(c.r * 15)}pt;width:120pt;height:60pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${c.c + 1}, 15, ${c.r}, 2, ${c.c + 3}, 15, ${c.r + 3}, 2</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${c.r}</x:Row><x:Column>${c.c}</x:Column></x:ClientData></v:shape>`).join('');
  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
}

// ---------------------------------------------------------------------------
// Charts (DrawingML)
// ---------------------------------------------------------------------------

const EMU_PX = 9525;

/** The drawing part: one two-cell anchor per chart. */
function drawingXml(sheet, chartIds) {
  const anchors = sheet.charts.map((ch, i) => {
    const at = ch.at ?? { r: ch.range.r1, c: Math.min(ch.range.c2, sheet.cols - 1) + 2 };
    const w = ch.size?.w ?? CHART_DEFAULT_SIZE.w, h = ch.size?.h ?? CHART_DEFAULT_SIZE.h;
    // Approximate the extent in cells: 64px columns, 20px rows (Excel repositions on open).
    const cols = Math.max(1, Math.round(w / 64)), rows = Math.max(1, Math.round(h / 20));
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${at.c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.r}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>${at.c + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.r + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU_PX}" cy="${h * EMU_PX}"/></xdr:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${chartIds[i]}"/></a:graphicData></a:graphic>` +
      `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

/** One chart part. Series point at the sheet's cells; cached values ride along for readers that want them. */
function chartXml(book, sheet, sheetName, ch) {
  const data = chartData(book, sheet, ch);
  const q = `'${sheetName.replace(/'/g, "''")}'`;
  const R = ch.range;
  const hasHeader = data.series.length && data.series[0].name !== 'Series 1';
  const byRows = ch.series === 'rows';
  const oneCol = (byRows ? R.r2 - R.r1 : R.c2 - R.c1) === 0;
  const r1 = R.r1 + (hasHeader && !byRows ? 1 : 0), c1 = R.c1 + (hasHeader && byRows ? 1 : 0);
  const abs = (r, c) => `$${colLetter(c)}$${r + 1}`;
  const catRef = byRows ? `${q}!${abs(R.r1, c1)}:${abs(R.r1, R.c2)}` : `${q}!${abs(r1, R.c1)}:${abs(R.r2, R.c1)}`;
  const valRef = (i) => {
    const k = (oneCol ? 0 : 1) + i;
    return byRows ? `${q}!${abs(R.r1 + k, c1)}:${abs(R.r1 + k, R.c2)}` : `${q}!${abs(r1, R.c1 + k)}:${abs(R.r2, R.c1 + k)}`;
  };
  const nameRef = (i) => { const k = (oneCol ? 0 : 1) + i; return byRows ? `${q}!${abs(R.r1 + k, R.c1)}` : `${q}!${abs(R.r1, R.c1 + k)}`; };
  const strCache = (vals) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xml(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
  const numCache = (vals) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
  const ser = (s, i) => {
    const color = argb(CHART_PALETTE[i % 8]).slice(2);
    const fill = ch.type === 'line' || ch.type === 'scatter' ? `<c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
    const tx = hasHeader ? `<c:tx><c:strRef><c:f>${xml(nameRef(i))}</c:f>${strCache([s.name])}</c:strRef></c:tx>` : `<c:tx><c:v>${xml(s.name)}</c:v></c:tx>`;
    const cat = oneCol ? '' : (ch.type === 'scatter' ? `<c:xVal><c:numRef><c:f>${xml(catRef)}</c:f>${numCache(data.xs ?? [])}</c:numRef></c:xVal>` : `<c:cat><c:strRef><c:f>${xml(catRef)}</c:f>${strCache(data.categories)}</c:strRef></c:cat>`);
    const val = ch.type === 'scatter' ? `<c:yVal><c:numRef><c:f>${xml(valRef(i))}</c:f>${numCache(s.values)}</c:numRef></c:yVal>` : `<c:val><c:numRef><c:f>${xml(valRef(i))}</c:f>${numCache(s.values)}</c:numRef></c:val>`;
    const marker = ch.type === 'line' ? `<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>` : ch.type === 'scatter' ? `<c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>` : '';
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${fill}${marker}${cat}${val}${ch.type === 'line' || ch.type === 'scatter' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
  };
  const series = data.series.slice(0, 8).map(ser).join('');
  const axes = `<c:axId val="10"/><c:axId val="20"/>`;
  let plot;
  switch (ch.type) {
    case 'bar': case 'column': plot = `<c:barChart><c:barDir val="${ch.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="60"/>${axes}</c:barChart>`; break;
    case 'line': plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axes}</c:lineChart>`; break;
    case 'area': plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axes}</c:areaChart>`; break;
    case 'scatter': plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series.replace(/<a:ln w="19050">/g, '<a:ln w="19050"><a:noFill/></a:ln><a:ln w="19050">')}${axes}</c:scatterChart>`; break;
    default: plot = `<c:pieChart><c:varyColors val="1"/>${data.series.slice(0, 1).map(ser).join('')}<c:firstSliceAng val="0"/></c:pieChart>`;
  }
  const axisXml = ch.type === 'pie' ? '' :
    (ch.type === 'scatter'
      ? `<c:valAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/></c:valAx>`
      : `<c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${ch.type === 'bar' ? 'l' : 'b'}"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`) +
    `<c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${ch.type === 'bar' ? 'b' : 'l'}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/></c:valAx>`;
  const title = ch.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="1300" b="1"/><a:t>${xml(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : `<c:autoTitleDeleted val="1"/>`;
  const legend = ch.legend !== false && (data.series.length >= 2 || ch.type === 'pie') ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axisXml}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/** Excel limits sheet names to 31 chars without []:*?/\ */
function xlsxSheetName(name, used) {
  const base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base, k = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${k++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}

/** @returns {Uint8Array} the .xlsx bytes */
export function workbookToXlsx(book, { title = '' } = {}) {
  const sheets = book.sheets.length ? book.sheets : [];
  const used = new Set();
  const names = sheets.map(s => xlsxSheetName(s.name, used));
  const styles = new StyleTable();
  const entries = [];
  let chartNo = 0;
  const sheetParts = sheets.map((s, i) => {
    const charts = (s.charts ?? []).map(() => ++chartNo);
    return { xml: sheetXml(book, s, styles, { hasComments: s.comments.length > 0, hasDrawing: charts.length > 0 }), comments: s.comments.length > 0, charts, i };
  });

  entries.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${sheetParts.map(p => `<Override PartName="/xl/worksheets/sheet${p.i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` + (p.comments ? `\n<Override PartName="/xl/comments${p.i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>` : '') + (p.charts.length ? `\n<Override PartName="/xl/drawings/drawing${p.i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` + p.charts.map(n => `\n<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('') : '')).join('\n')}
</Types>` });
  entries.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>` });
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  entries.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>unifile {spreadsheet}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` });
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
  for (const p of sheetParts) {
    entries.push({ name: `xl/worksheets/sheet${p.i + 1}.xml`, data: p.xml });
    const s = sheets[p.i];
    const rels = [];
    if (p.comments) {
      rels.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing${p.i + 1}.vml"/>`);
      rels.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${p.i + 1}.xml"/>`);
      entries.push({ name: `xl/comments${p.i + 1}.xml`, data: commentsXml(s) });
      entries.push({ name: `xl/drawings/vmlDrawing${p.i + 1}.vml`, data: vmlXml(s) });
    }
    if (p.charts.length) {
      rels.push(`<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${p.i + 1}.xml"/>`);
      entries.push({ name: `xl/drawings/drawing${p.i + 1}.xml`, data: drawingXml(s, p.charts.map((_, k) => k + 1)) });
      entries.push({ name: `xl/drawings/_rels/drawing${p.i + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${p.charts.map((n, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/>`).join('\n')}
</Relationships>` });
      p.charts.forEach((n, k) => entries.push({ name: `xl/charts/chart${n}.xml`, data: chartXml(book, s, names[p.i], s.charts[k]) }));
    }
    if (rels.length) {
      entries.push({ name: `xl/worksheets/_rels/sheet${p.i + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>` });
    }
  }
  // styles.xml last: the sheets register their xfs / dxfs while rendering.
  entries.push({ name: 'xl/styles.xml', data: styles.xml() });
  return buildZip(entries);
}

export { colLetter };
