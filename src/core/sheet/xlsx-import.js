/**
 * {spreadsheet} — importing .xlsx and CSV files (pure, Node-tested).
 *
 *   importXlsx(bytes, { inflateRaw })  → the DSL text of the workbook
 *   importCsv(text, name)              → the DSL text of one sheet
 *
 * What comes across from an .xlsx: every sheet (in order, by name), values
 * (shared / inline strings, numbers, booleans, errors), dates (cells styled
 * with a date format → ISO text), formulas (shared formulas expanded), merged
 * cells, column widths, row heights, hidden rows / columns, frozen panes, the
 * autofilter, cell styles (bold / italic / underline / strike / colour / fill
 * / number format / alignment / wrap, coalesced into rectangles), conditional
 * formats (cellIs, containsText, begins/endsWith, blanks, top10, duplicates,
 * expressions, colour scales, data bars) and cell comments.  Charts, images
 * and everything else are left behind.
 */

import { readZip } from '../zip.js';
import { parseXml, child, children, descendants, textOf } from './xml.js';
import { serializeModel, emptyModel, offsetFormula } from './edit.js';
import { parseRange, colIndex } from './parse.js';
import { parseCondition } from './style.js';
import { tokenizeArgs } from './lex.js';
import { serialToDate, isDateFormat } from '../tables/formula.js';

const dec = new TextDecoder();
const txt = (map, name) => (map.has(name) ? dec.decode(map.get(name)) : null);

// Excel's built-in number formats (the ones that matter here).
const BUILTIN_FORMATS = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd hh:mm',
  37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00', 45: 'mm:ss', 46: 'h:mm:ss', 47: 'mm:ss', 49: '@',
};

/** `yyyy-mm-dd` or `yyyy-mm-dd hh:mm` for an Excel serial. */
function isoOfSerial(serial) {
  const d = serialToDate(serial);
  const p2 = n => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return Number.isInteger(serial) ? date : `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

function argbToCss(rgb) {
  if (!rgb) return null;
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex.toLowerCase() : null;
}

/** styles.xml → { xfs: props[], dxfs: props[] } */
function readStyles(xmlText) {
  if (!xmlText) return { xfs: [], dxfs: [] };
  const root = parseXml(xmlText);
  const numFmts = new Map();
  for (const nf of descendants(child(root, 'numFmts'), 'numFmt')) numFmts.set(+nf.attrs.numFmtId, nf.attrs.formatCode);
  const fmtOf = (id) => (id == null ? null : numFmts.get(id) ?? BUILTIN_FORMATS[id] ?? null);
  const fonts = children(child(root, 'fonts'), 'font').map(f => {
    const p = {};
    if (child(f, 'b')) p.bold = true;
    if (child(f, 'i')) p.italic = true;
    if (child(f, 'u')) p.underline = true;
    if (child(f, 'strike')) p.strike = true;
    const c = argbToCss(child(f, 'color')?.attrs.rgb);
    if (c && c !== '#000000') p.color = c;
    const sz = Number(child(f, 'sz')?.attrs.val);
    if (sz && sz !== 11) p.size = Math.round(sz * 4 / 3);
    return p;
  });
  const fills = children(child(root, 'fills'), 'fill').map(f => {
    const pf = child(f, 'patternFill');
    if (!pf || pf.attrs.patternType === 'none') return null;
    return argbToCss(child(pf, 'fgColor')?.attrs.rgb) ?? null;
  });
  const xfs = children(child(root, 'cellXfs'), 'xf').map(xf => {
    const p = {};
    const font = fonts[+xf.attrs.fontId] ?? {};
    if (xf.attrs.applyFont !== '0') Object.assign(p, font);
    const fill = fills[+xf.attrs.fillId];
    if (fill && xf.attrs.applyFill !== '0') p.bg = fill;
    const fmt = fmtOf(xf.attrs.numFmtId != null ? +xf.attrs.numFmtId : null);
    if (fmt && fmt !== 'General') p.format = fmt;
    const al = child(xf, 'alignment');
    if (al) {
      if (['left', 'center', 'right'].includes(al.attrs.horizontal)) p.align = al.attrs.horizontal;
      if (al.attrs.vertical === 'top' || al.attrs.vertical === 'center' || al.attrs.vertical === 'bottom') p.valign = al.attrs.vertical === 'center' ? 'middle' : al.attrs.vertical;
      if (al.attrs.wrapText === '1') p.wrap = true;
    }
    return p;
  });
  const dxfs = children(child(root, 'dxfs'), 'dxf').map(d => {
    const p = {};
    const f = child(d, 'font');
    if (f) {
      if (child(f, 'b')) p.bold = true;
      if (child(f, 'i')) p.italic = true;
      if (child(f, 'u')) p.underline = true;
      if (child(f, 'strike')) p.strike = true;
      const c = argbToCss(child(f, 'color')?.attrs.rgb);
      if (c) p.color = c;
    }
    const fill = child(d, 'fill');
    const bg = argbToCss(child(child(fill, 'patternFill'), 'bgColor')?.attrs.rgb) ?? argbToCss(child(child(fill, 'patternFill'), 'fgColor')?.attrs.rgb);
    if (bg) p.bg = bg;
    const nf = child(d, 'numFmt');
    if (nf?.attrs.formatCode) p.format = nf.attrs.formatCode;
    return p;
  });
  return { xfs, dxfs };
}

/** A cell's Excel formula text → ours (mostly identical; `TRUE()`/`FALSE()` are kept). */
const formulaText = (f) => f.replace(/\$/g, m => m);

/**
 * Coalesce `{ r, c, key }` cells into rectangles: horizontal runs per row,
 * then vertically identical runs merged.
 */
function rectangles(cells) {
  const byRow = new Map();
  for (const x of cells) { if (!byRow.has(x.r)) byRow.set(x.r, []); byRow.get(x.r).push(x); }
  const runs = [];
  for (const [r, list] of byRow) {
    list.sort((a, b) => a.c - b.c);
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j + 1 < list.length && list[j + 1].c === list[j].c + 1 && list[j + 1].key === list[i].key) j++;
      runs.push({ r1: r, r2: r, c1: list[i].c, c2: list[j].c, key: list[i].key });
      i = j + 1;
    }
  }
  runs.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
  const out = [];
  for (const run of runs) {
    const prev = out.find(o => o.r2 === run.r1 - 1 && o.c1 === run.c1 && o.c2 === run.c2 && o.key === run.key);
    if (prev) prev.r2 = run.r2; else out.push({ ...run });
  }
  return out;
}

/**
 * @param bytes  the .xlsx file
 * @param opts   { inflateRaw(bytes) → Uint8Array|Promise }  (Node: zlib.inflateRawSync; browser: DecompressionStream)
 * @returns {Promise<string>}  the DSL text
 */
export async function importXlsx(bytes, { inflateRaw } = {}) {
  const zip = await readZip(bytes, inflateRaw);
  const wbXml = txt(zip, 'xl/workbook.xml');
  if (!wbXml) throw new Error('not a workbook (no xl/workbook.xml)');
  const wb = parseXml(wbXml);
  const rels = parseXml(txt(zip, 'xl/_rels/workbook.xml.rels') ?? '<Relationships/>');
  const relTarget = new Map(children(rels, 'Relationship').map(r => [r.attrs.Id, r.attrs.Target.replace(/^\/?(xl\/)?/, 'xl/')]));
  const shared = (() => {
    const sst = txt(zip, 'xl/sharedStrings.xml');
    if (!sst) return [];
    return children(parseXml(sst), 'si').map(si => textOf(si));
  })();
  const { xfs, dxfs } = readStyles(txt(zip, 'xl/styles.xml'));
  const sheetsXml = children(child(wb, 'sheets'), 'sheet');
  const models = [];
  for (const sh of sheetsXml) {
    const target = relTarget.get(sh.attrs.id) ?? `xl/worksheets/sheet${models.length + 1}.xml`;
    const xmlText = txt(zip, target);
    if (!xmlText) continue;
    const m = emptyModel(sh.attrs.name || `Sheet${models.length + 1}`);
    readSheet(parseXml(xmlText), m, { shared, xfs, dxfs, zip, target });
    models.push(m);
  }
  if (!models.length) models.push(emptyModel('Sheet1'));
  return models.map(m => serializeModel(m)).join('\n\n') + '\n';
}

function readSheet(ws, m, { shared, xfs, dxfs, zip, target }) {
  const styleCells = [];
  const sharedFormulas = new Map();   // si → { text, r, c }
  // Dimensions first: columns, rows.
  for (const col of descendants(child(ws, 'cols'), 'col')) {
    const a = +col.attrs.min - 1, b = +col.attrs.max - 1;
    if (b - a > 200) continue;
    for (let c = a; c <= b; c++) {
      if (col.attrs.width && col.attrs.customWidth === '1') m.widths.set(c, Math.round(+col.attrs.width));
      if (col.attrs.hidden === '1') m.hiddenCols.add(c);
    }
  }
  for (const row of children(child(ws, 'sheetData'), 'row')) {
    const r = +row.attrs.r - 1;
    if (row.attrs.ht && row.attrs.customHeight === '1') m.heights.set(r, Math.round(+row.attrs.ht * 4 / 3));
    if (row.attrs.hidden === '1') m.hiddenRows.add(r);
    for (const c of children(row, 'c')) {
      const addr = parseRange(c.attrs.r);
      if (!addr) continue;
      const rr = addr.r1, cc = addr.c1;
      const st = c.attrs.s != null ? xfs[+c.attrs.s] : null;
      const f = child(c, 'f');
      const v = child(c, 'v');
      let text = '';
      if (f) {
        let ft = textOf(f);
        if (f.attrs.t === 'shared') {
          if (ft) sharedFormulas.set(f.attrs.si, { text: ft, r: rr, c: cc });
          else { const master = sharedFormulas.get(f.attrs.si); if (master) ft = offsetFormula(master.text, rr - master.r, cc - master.c); }
        }
        if (ft) text = '=' + formulaText(ft);
      }
      if (!text) {
        const t = c.attrs.t;
        if (t === 's') text = shared[+textOf(v)] ?? '';
        else if (t === 'inlineStr') text = textOf(child(c, 'is'));
        else if (t === 'str') text = textOf(v);
        else if (t === 'b') text = textOf(v) === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'e') text = textOf(v);
        else if (v) {
          const n = Number(textOf(v));
          text = st?.format && isDateFormat(st.format) ? isoOfSerial(n) : String(n);
        }
      }
      if (text !== '') {
        while (m.rows.length <= rr) m.rows.push([]);
        m.rows[rr][cc] = text;
      }
      if (st && Object.keys(st).length) {
        const props = { ...st };
        // A date format already shaped the value; ours shows ISO unless a pattern asks otherwise.
        if (props.format && isDateFormat(props.format) && /^(yyyy-mm-dd( hh:mm)?)$/.test(props.format)) delete props.format;
        if (Object.keys(props).length) styleCells.push({ r: rr, c: cc, key: JSON.stringify(props), props });
      }
    }
  }
  const w = Math.max(1, ...m.rows.map(r => r.length));
  for (const row of m.rows) for (let c = 0; c < w; c++) if (row[c] == null) row[c] = '';
  if (!m.rows.length) m.rows.push(['']);
  // Styles → rectangles.
  for (const rect of rectangles(styleCells)) {
    const props = styleCells.find(x => x.key === rect.key).props;
    m.styles.push({ range: { r1: rect.r1, c1: rect.c1, r2: rect.r2, c2: rect.c2 }, props });
  }
  // Merges
  for (const mc of descendants(child(ws, 'mergeCells'), 'mergeCell')) { const R = parseRange(mc.attrs.ref); if (R) m.merges.push(R); }
  // Frozen panes → header rows + freeze cols
  const pane = descendants(child(ws, 'sheetViews'), 'pane')[0];
  if (pane?.attrs.state === 'frozen') {
    const ys = +(pane.attrs.ySplit ?? 0), xs = +(pane.attrs.xSplit ?? 0);
    if (ys) m.headerRows = ys;
    if (xs) m.freeze = { rows: 0, cols: xs };
  }
  if (child(ws, 'autoFilter')) m.filterOn = true;
  // Conditional formatting
  for (const cf of children(ws, 'conditionalFormatting')) {
    const R = parseRange(cf.attrs.sqref.split(' ')[0]);
    if (!R) continue;
    for (const rule of children(cf, 'cfRule')) {
      const props = rule.attrs.dxfId != null ? dxfs[+rule.attrs.dxfId] ?? {} : {};
      const formulas = children(rule, 'formula').map(textOf);
      const type = rule.attrs.type;
      let cond = null;
      const OPS = { equal: '=', notEqual: '<>', lessThan: '<', greaterThan: '>', lessThanOrEqual: '<=', greaterThanOrEqual: '>=' };
      if (type === 'cellIs' && rule.attrs.operator === 'between' && formulas.length >= 2) cond = { kind: 'between', a: formulas[0], b: formulas[1] };
      else if (type === 'cellIs' && OPS[rule.attrs.operator] && formulas[0] != null) cond = parseCondition([OPS[rule.attrs.operator], ...tokenizeArgs(formulas[0]).map(t => t.quoted ? t.text : t.text)]);
      else if (type === 'containsText' && rule.attrs.text != null) cond = { kind: 'contains', text: rule.attrs.text };
      else if (type === 'beginsWith' && rule.attrs.text != null) cond = { kind: 'starts', text: rule.attrs.text };
      else if (type === 'endsWith' && rule.attrs.text != null) cond = { kind: 'ends', text: rule.attrs.text };
      else if (type === 'containsBlanks') cond = { kind: 'blank' };
      else if (type === 'notContainsBlanks') cond = { kind: 'filled' };
      else if (type === 'containsErrors') cond = { kind: 'error' };
      else if (type === 'duplicateValues') cond = { kind: 'duplicate' };
      else if (type === 'uniqueValues') cond = { kind: 'unique' };
      else if (type === 'top10') cond = { kind: rule.attrs.bottom === '1' ? 'bottom' : 'top', n: +(rule.attrs.rank ?? 10) };
      else if (type === 'expression' && formulas[0]) cond = { kind: 'formula', formula: formulas[0] };
      else if (type === 'colorScale') {
        const colors = children(child(rule, 'colorScale'), 'color').map(c => argbToCss(c.attrs.rgb)).filter(Boolean);
        if (colors.length >= 2) m.scales.push({ range: R, colors });
        continue;
      } else if (type === 'dataBar') {
        const color = argbToCss(child(child(rule, 'dataBar'), 'color')?.attrs.rgb) ?? '#1a8cf5';
        m.bars.push({ range: R, color });
        continue;
      }
      if (cond && !cond.error && Object.keys(props).length) m.rules.push({ range: R, cond, props });
    }
  }
  // Comments via the sheet's rels
  const relsPath = target.replace(/worksheets\/(sheet\d+\.xml)$/, 'worksheets/_rels/$1.rels');
  const relsXml = txt(zip, relsPath);
  if (relsXml) {
    const rel = children(parseXml(relsXml), 'Relationship').find(r => /\/comments$/.test(r.attrs.Type));
    if (rel) {
      const path = rel.attrs.Target.startsWith('/') ? rel.attrs.Target.slice(1) : 'xl/' + rel.attrs.Target.replace(/^\.\.\//, '');
      const cx = txt(zip, path);
      if (cx) for (const cm of descendants(parseXml(cx), 'comment')) {
        const R = parseRange(cm.attrs.ref);
        const t = textOf(child(cm, 'text')).replace(/^[^:\n]{0,40}:\s*\n/, '').trim();   // "Author:\n" prefix Excel adds
        if (R && t) m.comments.push({ r: R.r1, c: R.c1, text: t });
      }
    }
  }
}

/** A CSV text → one sheet's DSL text (quotes, embedded commas / newlines honoured; `;` and tab separators detected). */
export function importCsv(text, name = 'Sheet1') {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = src.split('\n')[0] ?? '';
  const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ((firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const m = emptyModel(name);
  const w = Math.max(1, ...rows.map(r => r.length));
  m.rows = rows.length ? rows.map(r => Array.from({ length: w }, (_, i) => (r[i] ?? '').trim())) : [['']];
  return serializeModel(m) + '\n';
}

export { colIndex };
