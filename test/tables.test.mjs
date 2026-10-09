import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkbook, parseRowCells, splitRow, parseSeparator, colLetter, colIndex, cellAddress, parseAddress,
  literalValue, alignTables, blankTable, tsvToTable, cellAtOffset,
} from '../src/core/tables/grid.js';
import {
  tokenize, parseFormula, evaluate, evaluateWorkbook, formatNumber, formatWith, formulaForExcel, isError, FUNCTIONS,
} from '../src/core/tables/formula.js';
import {
  renderSheetHtml, renderWorkbookHtml, displayValue, sheetToCsv, workbookToXlsx, sheetDocument, printDocument,
} from '../src/core/tables/render.js';

const BUDGET = `---
title: Budget
decimals: 2
---
# Budget

Notes above the table.

| Item   | Qty | Price | Total       |
|--------|----:|------:|------------:|
| Apples |   3 | $1.20 | =B*C        |
| Pears  |   2 |  0.80 | =B*C        |
| Total ||| =SUM(D2:D3) |
| ^^    ||| =IF(D4>5,"big","small") |

# Other

| x | y |
| 1 | =Budget!D4*2 |
| 2 | ='Budget'!B2 & " apples" |
`;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test('addresses: letters ↔ indexes, A1 parsing', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
  assert.equal(colLetter(26 * 27), 'AAA');
  assert.equal(colIndex('AA'), 26);
  assert.equal(colIndex('z'), 25);
  assert.equal(cellAddress(2, 1), 'B3');
  assert.deepEqual(parseAddress('$B$3'), { r: 2, c: 1 });
  assert.equal(parseAddress('B'), null);
});

// ---------------------------------------------------------------------------
// Rows & spans
// ---------------------------------------------------------------------------

test('splitRow honours \\| escapes and a missing closing pipe', () => {
  assert.deepEqual(splitRow('| a \\| b | c |').map(s => s.raw), [' a \\| b ', ' c ']);
  assert.deepEqual(splitRow('| a | b').map(s => s.raw), [' a ', ' b']);
});

test('parseRowCells: || extends the previous cell, | | is an empty cell', () => {
  const cells = parseRowCells('| a || b | | c |');
  assert.deepEqual(cells.map(c => [c.text, c.col, c.colspan]), [['a', 0, 2], ['b', 2, 1], ['', 3, 1], ['c', 4, 1]]);
  assert.equal(parseRowCells('| a \\| b |')[0].text, 'a | b');
});

test('parseSeparator: alignments; a data row is not a separator', () => {
  assert.deepEqual(parseSeparator('|---|:--|:-:|--:|'), [null, 'left', 'center', 'right']);
  assert.equal(parseSeparator('| 1 | 2 |'), null);
});

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

test('parseWorkbook: sheets named by headings, header rows, merges, prose blocks, front matter skipped', () => {
  const wb = parseWorkbook(BUDGET);
  assert.equal(wb.sheets.length, 2);
  const [b, o] = wb.sheets;
  assert.equal(b.name, 'Budget');
  assert.equal(b.headerRows, 1);
  assert.equal(b.cols, 4);
  assert.equal(b.rows.length, 5);
  assert.deepEqual(b.aligns, [null, 'right', 'right', 'right']);
  // Total spans 3 columns and 2 rows (the ^^ row).
  const total = b.grid[3][0];
  assert.equal(total.text, 'Total');
  assert.equal(total.colspan, 3);
  assert.equal(total.rowspan, 2);
  assert.equal(b.grid[4][1], total);
  assert.equal(b.grid[4][0].merged, false); // the anchor itself
  const merged = b.cells.find(c => c.r === 4 && c.c === 0);
  assert.equal(merged.merged, true);
  assert.equal(merged.text, '');
  // Formula detection.
  assert.equal(b.grid[1][3].formula, 'B*C');
  assert.equal(b.grid[1][0].formula, null);
  // Other: no separator → no header rows.
  assert.equal(o.name, 'Other');
  assert.equal(o.headerRows, 0);
  assert.equal(o.rows.length, 3);
  // Prose blocks around the tables, none from the front matter.
  const prose = wb.blocks.filter(x => x.kind === 'prose').map(x => x.text.trim());
  assert.deepEqual(prose, ['Notes above the table.']);
  // The headings became name blocks, in document order, each bound to its sheet.
  assert.deepEqual(wb.blocks.map(x => x.kind), ['name', 'prose', 'sheet', 'name', 'sheet']);
  assert.equal(wb.blocks[0].sheet, b);
  assert.equal(b.named, true);
  assert.equal(BUDGET.slice(b.nameFrom, b.nameTo), '# Budget');
  // Offsets map back to the source: from/to is the trimmed content, raw* the pipes.
  assert.equal(BUDGET.slice(b.grid[1][3].from, b.grid[1][3].to), '=B*C');
  assert.equal(BUDGET.slice(b.grid[1][0].rawFrom, b.grid[1][0].rawTo), ' Apples ');
  assert.equal(cellAtOffset(wb, b.grid[1][3].from + 1).cell, b.grid[1][3]);
});

test('parseWorkbook: unnamed tables are Sheet<n>; duplicate names get a suffix; fences are skipped; a heading with no table is prose', () => {
  const wb = parseWorkbook('| a |\n| 1 |\n\ntext\n\n| b |\n| 2 |\n\n# Same\n| c |\n\n# Same\n| d |\n\n# Just prose\n\n```\n| not | a | sheet |\n```\n');
  assert.deepEqual(wb.sheets.map(s => s.name), ['Sheet1', 'Sheet2', 'Same', 'Same 2']);
  assert.equal(wb.sheets[0].named, false);
  assert.match(wb.blocks[wb.blocks.length - 1].text, /# Just prose/);
});

test('parseWorkbook: a lone |---| line under a header is the separator, a later one is data', () => {
  const wb = parseWorkbook('| h |\n|---|\n| 1 |\n|---|\n');
  assert.equal(wb.sheets[0].headerRows, 1);
  assert.equal(wb.sheets[0].rows.length, 3);
  assert.equal(wb.sheets[0].rows[2].cells[0].text, '---');
});

test('literalValue: numbers in their written forms, booleans, forced text', () => {
  assert.equal(literalValue('1,200'), 1200);
  assert.equal(literalValue('$3.50'), 3.5);
  assert.equal(literalValue('12%'), 0.12);
  assert.equal(literalValue('(5)'), -5);
  assert.equal(literalValue('-2.5'), -2.5);
  assert.equal(literalValue('TRUE'), true);
  assert.equal(literalValue("'0123"), '0123');
  assert.equal(literalValue(''), null);
  assert.equal(literalValue('A1'), 'A1');
  assert.equal(literalValue('1.2.3'), '1.2.3');
});

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

test('tokenize: refs, ranges, sheets, bare columns, strings, operators', () => {
  const t = tokenize(`SUM(A1:B2) + Budget!C3 - 'Q1 Sales'!D4:D & "x""y" * B:B / b`).map(x => [x.type, x.value]);
  assert.deepEqual(t[0], ['name', 'SUM']);
  assert.deepEqual(t[2], ['ref', { sheet: null, a: 'A1', b: 'B2' }]);
  assert.deepEqual(t[5], ['ref', { sheet: 'Budget', a: 'C3', b: null }]);
  assert.deepEqual(t[7], ['ref', { sheet: 'Q1 Sales', a: 'D4', b: 'D' }]);
  assert.deepEqual(t[9], ['str', 'x"y']);
  assert.deepEqual(t[11], ['ref', { sheet: null, a: 'B', b: 'B' }]);
  assert.deepEqual(t[13], ['ref', { sheet: null, a: 'b', b: null }]);
  assert.throws(() => tokenize('"open'), /#VALUE!/);
});

function ev(src, cells = {}, row = 0) {
  const sheet = { name: 'S', rows: [], grid: [] };
  const ctx = {
    sheet, row, col: 0,
    sheetByName: n => (n.toLowerCase() === 's' ? sheet : null),
    valueAt: (s, r, c) => cells[cellAddress(r, c)] ?? null,
  };
  return evaluate(parseFormula(src), ctx);
}

test('evaluate: precedence, unary, percent, concat, comparison', () => {
  assert.equal(ev('1+2*3'), 7);
  assert.equal(ev('(1+2)*3'), 9);
  assert.equal(ev('2^3^2'), 64);          // left-assoc like Excel
  assert.equal(ev('-2^2'), 4);            // Excel: unary minus binds tighter than ^
  assert.equal(ev('50%'), 0.5);
  assert.equal(ev('"a" & 1 & TRUE'), 'a1TRUE');
  assert.equal(ev('1 = 1'), true);
  assert.equal(ev('"a" <> "A"'), false);  // case-insensitive text
  assert.equal(ev('2 >= 3'), false);
  assert.equal(ev('"b" > 10'), true);     // text ranks above numbers
});

test('evaluate: refs — this-row columns, ranges, empty cells, text numbers', () => {
  const cells = { A1: 'x', B1: 2, A2: 3, B2: '4', C2: null };
  assert.equal(ev('A2+B2', cells, 1), 7);
  assert.equal(ev('A+B', cells, 1), 7);     // bare column = this row
  assert.throws(() => ev('A+B', cells, 0), /#VALUE!/);  // "x" is not a number
  assert.equal(ev('C2+1', cells, 1), 1);   // empty → 0
  assert.equal(ev('SUM(A1:B2)', cells), 5);  // text (even "4") is skipped in a range, as Excel does
  assert.equal(ev('COUNT(A1:B2)', cells), 2);
  assert.equal(ev('COUNTA(A1:C2)', cells), 4);
  assert.equal(ev('AVERAGE(A2:B2)', cells), 3);
  assert.equal(ev('MAX(A1:B2)', cells), 3);
  assert.equal(ev('S!B1', cells), 2);
  assert.throws(() => ev('Nope!A1', cells), /#REF!/);
});

test('evaluate: errors — #DIV/0!, #NAME?, #VALUE!, #NUM!, #N/A; IF branches are lazy; IFERROR', () => {
  assert.throws(() => ev('1/0'), /#DIV\/0!/);
  assert.throws(() => ev('FOO(1)'), /#NAME\?/);
  assert.throws(() => ev('1+'), /#VALUE!/);
  assert.throws(() => ev('SQRT(-1)'), /#NUM!/);
  assert.throws(() => ev('VLOOKUP("z", A1:B2, 2, FALSE)', { A1: 'a', B1: 1 }), /#N\/A/);
  assert.equal(ev('IF(TRUE, 1, 1/0)'), 1);
  assert.equal(ev('IFERROR(1/0, "n/a")'), 'n/a');
  assert.equal(ev('IF(1>2, "y")'), false);
});

test('functions: the common set behaves like Excel', () => {
  assert.equal(ev('ROUND(2.345, 2)'), 2.35);
  assert.equal(ev('ROUND(-2.5)'), -2);
  assert.equal(ev('ROUNDUP(2.001, 2)'), 2.01);
  assert.equal(ev('ROUNDDOWN(-2.999, 2)'), -2.99);
  assert.equal(ev('INT(-1.5)'), -2);
  assert.equal(ev('MOD(-7, 3)'), 2);
  assert.equal(ev('CEILING(7, 5)'), 10);
  assert.equal(ev('FLOOR(7, 5)'), 5);
  assert.equal(ev('ABS(-3)'), 3);
  assert.equal(ev('POWER(2, 10)'), 1024);
  assert.equal(ev('LEN("abc")'), 3);
  assert.equal(ev('UPPER("ab")'), 'AB');
  assert.equal(ev('PROPER("hello world")'), 'Hello World');
  assert.equal(ev('TRIM("  a   b ")'), 'a b');
  assert.equal(ev('LEFT("hello", 2)'), 'he');
  assert.equal(ev('RIGHT("hello", 2)'), 'lo');
  assert.equal(ev('MID("hello", 2, 3)'), 'ell');
  assert.equal(ev('FIND("l", "hello")'), 3);
  assert.equal(ev('SUBSTITUTE("a-b-c", "-", "+")'), 'a+b+c');
  assert.equal(ev('CONCAT("a", 1, "b")'), 'a1b');
  assert.equal(ev('TEXTJOIN(", ", TRUE, "a", "", "b")'), 'a, b');
  assert.equal(ev('TEXT(1234.5, "#,##0.00")'), '1,234.50');
  assert.equal(ev('TEXT(0.256, "0.0%")'), '25.6%');
  assert.equal(ev('AND(TRUE, 1)'), true);
  assert.equal(ev('OR(FALSE, 0)'), false);
  assert.equal(ev('NOT(0)'), true);
  assert.equal(ev('MEDIAN(1, 5, 3, 4)'), 3.5);
  assert.equal(ev('LARGE(A1:A3, 2)', { A1: 3, A2: 9, A3: 5 }), 5);
  assert.equal(ev('SMALL(A1:A3, 1)', { A1: 3, A2: 9, A3: 5 }), 3);
  assert.equal(ev('PI()').toFixed(4), '3.1416');
});

test('functions: SUMIF / COUNTIF / AVERAGEIF criteria, VLOOKUP, INDEX, MATCH, ROW/COLUMN', () => {
  const cells = { A1: 'apple', B1: 10, A2: 'pear', B2: 20, A3: 'apricot', B3: 30 };
  assert.equal(ev('SUMIF(A1:A3, "apple", B1:B3)', cells), 10);
  assert.equal(ev('SUMIF(A1:A3, "ap*", B1:B3)', cells), 40);
  assert.equal(ev('SUMIF(B1:B3, ">15")', cells), 50);
  assert.equal(ev('COUNTIF(B1:B3, "<>20")', cells), 2);
  assert.equal(ev('COUNTIF(A1:A3, "pear")', cells), 1);
  assert.equal(ev('AVERAGEIF(B1:B3, ">=20")', cells), 25);
  assert.equal(ev('VLOOKUP("pear", A1:B3, 2, FALSE)', cells), 20);
  assert.equal(ev('VLOOKUP(25, B1:B3, 1, TRUE)', cells), 20);
  assert.equal(ev('INDEX(A1:B3, 3, 1)', cells), 'apricot');
  assert.equal(ev('INDEX(B1:B3, 2)', cells), 20);
  assert.equal(ev('MATCH("pear", A1:A3, 0)', cells), 2);
  assert.equal(ev('MATCH(25, B1:B3, 1)', cells), 2);
  assert.equal(ev('ROW()', cells, 4), 5);
  assert.equal(ev('ROW(B7)', cells), 7);
  assert.equal(ev('COLUMN(C1)', cells), 3);
  assert.equal(ev('ROWS(A1:B3)', cells), 3);
  assert.equal(ev('SUMPRODUCT(B1:B3, B1:B3)', cells), 1400);
  assert.ok(typeof FUNCTIONS.SUM === 'function');
});

test('evaluateWorkbook: the budget computes, across sheets, with merges and formatting', () => {
  const wb = parseWorkbook(BUDGET);
  const { values, errors } = evaluateWorkbook(wb);
  assert.equal(errors.length, 0);
  const [b, o] = wb.sheets;
  const v = (s, r, c) => values.get(s.grid[r][c]);
  assert.equal(Math.round(v(b, 1, 3) * 100) / 100, 3.6);
  assert.equal(Math.round(v(b, 2, 3) * 100) / 100, 1.6);
  assert.equal(Math.round(v(b, 3, 3) * 100) / 100, 5.2);
  assert.equal(v(b, 4, 3), 'big');
  assert.equal(Math.round(v(o, 1, 1) * 100) / 100, 10.4);
  assert.equal(v(o, 2, 1), '3 apples');
  // Display: literals as typed, formula results General or to `decimals`.
  assert.equal(displayValue(b.grid[2][2], v(b, 2, 2)), '0.80');
  assert.equal(displayValue(b.grid[1][3], v(b, 1, 3)), '3.6');
  assert.equal(displayValue(b.grid[1][3], v(b, 1, 3), { decimals: 2 }), '3.60');
  assert.equal(displayValue(b.grid[3][3], v(b, 3, 3), { decimals: 2 }), '5.20');
});

test('evaluateWorkbook: errors are collected per cell; a cycle is #CIRC!, not a hang', () => {
  const wb = parseWorkbook('| =B1 | =A1 |\n| =1/0 | =NOPE() |\n| =SUM(A:A) | 1 |\n');
  const { values, errors } = evaluateWorkbook(wb);
  const s = wb.sheets[0];
  assert.equal(values.get(s.grid[0][0]).code, '#CIRC!');
  assert.equal(values.get(s.grid[0][1]).code, '#CIRC!');
  assert.equal(values.get(s.grid[1][0]).code, '#DIV/0!');
  assert.equal(values.get(s.grid[1][1]).code, '#NAME?');
  // A range containing an error propagates it.
  assert.ok(isError(values.get(s.grid[2][0])));
  assert.ok(errors.length >= 4);
  assert.ok(errors.every(e => e.cell && e.sheet === s));
});

test('formatNumber / formatWith: General trims noise; formats cover the basics', () => {
  assert.equal(formatNumber(3 * 1.2), '3.6');
  assert.equal(formatNumber(1 / 3), '0.3333333333');
  assert.equal(formatNumber(1e21), '1e+21');
  assert.equal(formatNumber(-0.5), '-0.5');
  assert.equal(formatWith(-12, '$#,##0'), '-$12');
  assert.equal(formatWith(0.5, '0%'), '50%');
  assert.equal(formatWith(2, '0.000'), '2.000');
  assert.equal(formatWith('x', '0.00'), 'x');
});

test('formulaForExcel: bare columns gain the row, AVG → AVERAGE, sheet names quoted as needed', () => {
  assert.equal(formulaForExcel('B*C+SUM(a:a)', 4), 'B5*C5+SUM(A:A)');
  assert.equal(formulaForExcel('AVG(B2:B4)', 0), 'AVERAGE(B2:B4)');
  assert.equal(formulaForExcel("'Q1 Sales'!A1 + Budget!b2", 0), "'Q1 Sales'!A1 + Budget!B2");
  assert.equal(formulaForExcel('IF(B>1,"x","y")', 2), 'IF(B3>1,"x","y")');
});

// ---------------------------------------------------------------------------
// Alignment / helpers
// ---------------------------------------------------------------------------

test('alignTables: pads columns, numbers right, keeps spans and ^^, idempotent, leaves prose', () => {
  const src = 'intro\n\n| Item | Qty |\n|---|--:|\n| Apples | 3 |\n| Total || \n| ^^ | 12 |\n\nafter';
  const out = alignTables(src);
  assert.equal(out, 'intro\n\n| Item   | Qty |\n|--------|----:|\n| Apples |   3 |\n| Total       ||\n| ^^     |  12 |\n\nafter');
  // Every row of the table is the same width.
  const widths = new Set(out.split('\n').filter(l => l.startsWith('|')).map(l => l.length));
  assert.equal(widths.size, 1);
  assert.equal(alignTables(out), out);
  // Text column with only numbers (no alignment given) pads on the left.
  assert.equal(alignTables('| a |\n| 10 |\n| 200 |'), '| a   |\n|  10 |\n| 200 |');
  // Structure is unchanged.
  const a = parseWorkbook(src).sheets[0], b = parseWorkbook(out).sheets[0];
  assert.deepEqual(a.cells.map(c => [c.text, c.colspan, c.rowspan]), b.cells.map(c => [c.text, c.colspan, c.rowspan]));
});

test('blankTable and tsvToTable', () => {
  assert.equal(blankTable(1, 2), '| A     | B     |\n|-------|-------|\n|       |       |');
  assert.equal(tsvToTable('a\tb\n1\t2'), '| a   | b   |\n|-----|-----|\n|   1 |   2 |');
  assert.equal(tsvToTable('no tabs'), null);
  assert.equal(tsvToTable('x|y\t2'), '| x\\|y | 2   |');
});

// ---------------------------------------------------------------------------
// Render & exports
// ---------------------------------------------------------------------------

test('renderSheetHtml: rulers, header cells, spans, values, click-back offsets', () => {
  const wb = parseWorkbook(BUDGET);
  const { values } = evaluateWorkbook(wb);
  const html = renderSheetHtml(wb.sheets[0], values, { decimals: 2 });
  assert.match(html, /<th class="uf-sheet-col" data-col="3">D<\/th>/);
  assert.match(html, /<th class="uf-sheet-row" data-row="4">5<\/th>/);
  assert.match(html, /<th class="uf-cell is-text al-left" data-addr="A1" data-doc-from="\d+" data-doc-to="\d+">Item<\/th>/);
  assert.match(html, /data-addr="A4" colspan="3" rowspan="2"/);
  assert.match(html, /is-formula al-right" data-addr="D2"[^>]*title="=B\*C">3\.60</);
  assert.match(html, /data-addr="D5"[^>]*>big</);
  // The merged ^^ row has no cell for A5–C5.
  assert.doesNotMatch(html, /data-addr="A5"/);
  // Inline renderer is pluggable.
  const inl = renderSheetHtml(parseWorkbook('| **b** |').sheets[0], new Map(), { inline: t => `<i>${t}</i>` });
  assert.match(inl, /<i>\*\*b\*\*<\/i>/);
});

test('renderWorkbookHtml / sheetDocument / printDocument: blocks in order, names, prose', () => {
  const wb = parseWorkbook(BUDGET);
  const { values } = evaluateWorkbook(wb);
  const html = renderWorkbookHtml(wb, values, { prose: t => `<p>${t.trim()}</p>` });
  assert.ok(html.indexOf('Notes above') < html.indexOf('data-sheet="Budget"'));
  // The sheet's name is drawn where its heading was: before the notes.
  assert.match(html, /<h2 class="uf-sheet-name" data-doc-from="\d+" data-doc-to="\d+">Budget<\/h2>/);
  assert.ok(html.indexOf('>Budget</h2>') < html.indexOf('Notes above'));
  assert.equal((html.match(/uf-sheet-name/g) || []).length, 2);
  assert.match(html, /data-sheet="Other"/);
  const doc = sheetDocument(wb, values, { title: 'My <book>' });
  assert.match(doc, /<title>My &lt;book&gt;<\/title>/);
  assert.doesNotMatch(doc, /data-doc-from/);
  assert.match(printDocument(wb, values, { title: 'P' }), /afterprint/);
});

test('sheetToCsv: RFC 4180 quoting, computed values, merges leave empties', () => {
  const wb = parseWorkbook('| a | b |\n| x,"y" | =1+1 |\n| m || \n');
  const { values } = evaluateWorkbook(wb);
  assert.equal(sheetToCsv(wb.sheets[0], values), 'a,b\r\n"x,""y""",2\r\nm,\r\n');
});

function readZip(bytes) {
  // Minimal stored-ZIP reader: walk local headers.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const td = new TextDecoder();
  const files = {};
  let off = 0;
  while (off + 30 <= bytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const nameLen = dv.getUint16(off + 26, true), extraLen = dv.getUint16(off + 28, true), size = dv.getUint32(off + 18, true);
    const name = td.decode(bytes.subarray(off + 30, off + 30 + nameLen));
    files[name] = td.decode(bytes.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + size));
    off += 30 + nameLen + extraLen + size;
  }
  return files;
}

test('workbookToXlsx: parts present, formulas with cached values, merges, header style, sheet names', () => {
  const wb = parseWorkbook(BUDGET + '\n# Bad/Name:With*Chars that is far too long for Excel\n| z |\n');
  const { values } = evaluateWorkbook(wb);
  const files = readZip(workbookToXlsx(wb, values, { title: 'T' }));
  assert.ok(files['[Content_Types].xml']);
  assert.ok(files['xl/workbook.xml']);
  assert.ok(files['xl/styles.xml']);
  assert.match(files['xl/workbook.xml'], /<sheet name="Budget" sheetId="1" r:id="rId1"\/>/);
  assert.match(files['xl/workbook.xml'], /name="Bad Name With Chars that is far"/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Item<\/t><\/is><\/c>/);
  assert.match(s1, /<c r="D2"><f>B2\*C2<\/f><v>3\.6[0-9]*<\/v><\/c>/);
  assert.match(s1, /<c r="D4"><f>SUM\(D2:D3\)<\/f>/);
  assert.match(s1, /<c r="D5" t="str"><f>IF\(D4&gt;5,&quot;big&quot;,&quot;small&quot;\)<\/f><v>big<\/v><\/c>/);
  assert.match(s1, /<mergeCell ref="A4:C5"\/>/);
  // Price "$1.20" is stored as the number 1.2.
  assert.match(s1, /<c r="C2"><v>1\.2<\/v><\/c>/);
  const s2 = files['xl/worksheets/sheet2.xml'];
  assert.match(s2, /<f>Budget!D4\*2<\/f>/);
  // Error cells.
  const bad = parseWorkbook('| =1/0 |');
  const r = evaluateWorkbook(bad);
  assert.match(readZip(workbookToXlsx(bad, r.values))['xl/worksheets/sheet1.xml'], /t="e"><f>1\/0<\/f><v>#DIV\/0!<\/v>/);
});
