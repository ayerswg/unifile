import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpreadsheet, parseRange, formatRange, parseLine, parseMeta, parseFreeze, cellAtOffset, usedExtent,
} from '../src/core/sheet/parse.js';
import { splitTop, unquote, quoteIf, tokenizeArgs } from '../src/core/sheet/lex.js';
import { parseStep, formatStep, generateSequence } from '../src/core/sheet/seq.js';
import {
  parseStyleProps, formatStyleProps, parseCondition, formatCondition, describeCondition, formatValue, parseColor, scaleColor, colorToRgb,
} from '../src/core/sheet/style.js';
import { computeWorkbook, viewRows, viewCols, cellDisplay } from '../src/core/sheet/book.js';
import {
  alignSpreadsheet, serializeModel, toModel, setCell, setCells, clearRange, insertRows, deleteRows, insertCols, deleteCols,
  shiftFormula, shiftRange, sortRows, mergeRange, unmergeRange, setStyle, addRule, removeRule, addScale, setComment, setSequence,
  setWidth, setFreeze, setHidden, setSortView, setFilter, setFilterOn, setHeaderRows, setMeta, addSheet, renameSheet, deleteSheet, rangeHas,
} from '../src/core/sheet/edit.js';
import { renderSheetHtml, renderWorkbookHtml, sheetToCsv, workbookDocument } from '../src/core/sheet/render.js';
import { workbookToXlsx } from '../src/core/sheet/xlsx.js';

const BUDGET = `---
name: Budget
header: 1
freeze: cols 1
decimals: 2
sort: D desc
filter: B > 0
owner: Will
---
# the budget
A1:D1 Item, Qty, Price, Total {bold, bg: #eef}
A2:C2 Apples, 3, 1.20
A3:C3 "Pears, green", 2, 0.80
A4:C4 Plums, , 2.50
D2:D4 =B*C {format: $#,##0.00}
A5:C5 Total {merge}
D5 =SUM(D2:D4)
E1 When
E2:E4 {seq: 2026-01-31, step: 1 month}
D2:D4 {rule: > 3, bold, color: green}
A2:A4 {rule: contains "pe", bg: #fdd}
B2:B4 {scale: #fff #1a8cf5}
B2 {comment: "Market price, October"}
A {width: 18}
3 {hidden}

---
name: Other
---
A1:B1 x, y
A2:B2 1, =Budget!D5*2
`;

// ---------------------------------------------------------------------------
// Lexing, ranges, lines
// ---------------------------------------------------------------------------

test('splitTop respects quotes, parens and (optionally) number-format commas', () => {
  assert.deepEqual(splitTop('a, "b, c", =IF(A,1,2), d').map(s => s.text.trim()), ['a', '"b, c"', '=IF(A,1,2)', 'd']);
  assert.deepEqual(splitTop('format: $#,##0.00, bold', ',', { formats: true }).map(s => s.text.trim()), ['format: $#,##0.00', 'bold']);
  assert.deepEqual(splitTop('format: $#,##0.00, bold', ',').map(s => s.text.trim()), ['format: $#', '##0.00', 'bold']);
  assert.equal(unquote('"a \\"b\\""'), 'a "b"');
  assert.equal(quoteIf('plain'), 'plain');
  assert.equal(quoteIf('a, b'), '"a, b"');
  assert.deepEqual(tokenizeArgs('contains "x y" 3').map(t => t.text), ['contains', 'x y', '3']);
});

test('parseRange / formatRange: cells, ranges, whole columns and rows', () => {
  assert.deepEqual(parseRange('B3'), { r1: 2, c1: 1, r2: 2, c2: 1 });
  assert.deepEqual(parseRange('$B$3:A1'), { r1: 0, c1: 0, r2: 2, c2: 1 });
  assert.deepEqual(parseRange('A'), { r1: 0, c1: 0, r2: Infinity, c2: 0 });
  assert.deepEqual(parseRange('C:D'), { r1: 0, c1: 2, r2: Infinity, c2: 3 });
  assert.deepEqual(parseRange('3'), { r1: 2, c1: 0, r2: 2, c2: Infinity });
  assert.deepEqual(parseRange('3:5'), { r1: 2, c1: 0, r2: 4, c2: Infinity });
  assert.equal(parseRange('A1:C'), null);
  assert.equal(parseRange('bold'), null);
  for (const s of ['B3', 'A1:B3', 'A', 'C:D', '3', '3:5']) assert.equal(formatRange(parseRange(s)), s);
});

test('parseLine: range, values, block; offsets; errors', () => {
  const p = parseLine('A1:D1 Item, "Qty, x", =SUM(A1,B1), 3 {bold, bg: #eef, comment: "a, b"}');
  assert.deepEqual(p.range, { r1: 0, c1: 0, r2: 0, c2: 3 });
  assert.deepEqual(p.values.map(v => v.text), ['Item', 'Qty, x', '=SUM(A1,B1)', '3']);
  assert.equal('A1:D1 Item, "Qty, x", =SUM(A1,B1), 3 {bold, bg: #eef, comment: "a, b"}'.slice(p.values[1].from, p.values[1].to), '"Qty, x"');
  assert.deepEqual(p.block.entries.map(e => [e.key, e.value]), [['bold', null], ['bg', '#eef'], ['comment', 'a, b']]);
  assert.equal(parseLine('A2:A9 {seq: 1}').values, null);
  assert.equal(parseLine('bold A1').range, null);
  assert.ok(parseLine('A1 x {bold').error);
  assert.ok(parseLine('A1 x {bold} y').error);
  assert.deepEqual(parseLine('3 {hidden}').range, { r1: 2, c1: 0, r2: 2, c2: Infinity });
});

test('parseMeta / parseFreeze', () => {
  const m = parseMeta('name: Budget\nheader: 1\nfilter: B > 0 # a comment\nbg: #eef\nbad line\n');
  assert.deepEqual(m.map(e => [e.key, e.value]), [['name', 'Budget'], ['header', '1'], ['filter', 'B > 0'], ['bg', '#eef'], [null, null]]);
  assert.deepEqual(parseFreeze('rows 1, cols 2'), { rows: 1, cols: 2 });
  assert.deepEqual(parseFreeze('2'), { rows: 2, cols: 0 });
  assert.deepEqual(parseFreeze('cols:1'), { rows: 0, cols: 1 });
});

// ---------------------------------------------------------------------------
// Sequences
// ---------------------------------------------------------------------------

test('sequences: numbers, dates, names, text with a trailing number', () => {
  assert.deepEqual(generateSequence('1', parseStep(null), 3), ['1', '2', '3']);
  assert.deepEqual(generateSequence('10', parseStep('-2.5'), 3), ['10', '7.5', '5']);
  assert.deepEqual(generateSequence('2026-01-31', parseStep('1 month'), 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(generateSequence('2026-12-30', parseStep('7'), 2), ['2026-12-30', '2027-01-06']);
  assert.deepEqual(generateSequence('2024-02-29', parseStep('1 year'), 2), ['2024-02-29', '2025-02-28']);
  assert.deepEqual(generateSequence('Jan', parseStep('1'), 13).slice(11), ['Dec', 'Jan']);
  assert.deepEqual(generateSequence('monday', null, 2), ['monday', 'tuesday']);
  assert.deepEqual(generateSequence('FRI', null, 3), ['FRI', 'SAT', 'SUN']);
  assert.deepEqual(generateSequence('Item 9', null, 2), ['Item 9', 'Item 10']);
  assert.deepEqual(generateSequence('Q01', null, 2), ['Q01', 'Q02']);
  assert.equal(generateSequence('hello', null, 2), null);
  assert.equal(parseStep('2 weeks').unit, 'week');
  assert.equal(formatStep(parseStep('1 month')), '1 month');
  assert.equal(formatStep(parseStep('3 months')), '3 months');
  assert.equal(parseStep('soon'), null);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseSpreadsheet: sheets, front matter, settings, remarks, extent', () => {
  const wb = parseSpreadsheet(BUDGET);
  assert.deepEqual(wb.problems, []);
  assert.equal(wb.sheets.length, 2);
  const [b, o] = wb.sheets;
  assert.equal(b.name, 'Budget');
  assert.equal(b.rows.length, 5);
  assert.equal(b.cols, 5);
  assert.equal(b.headerRows, 1);
  assert.deepEqual(b.freeze, { rows: 0, cols: 1 });
  assert.equal(b.decimals, 2);
  assert.equal(b.filterOn, true);
  assert.equal(b.widths.get(0), 18);
  assert.equal(b.merges.length, 1);
  assert.equal(b.grid[4][2], b.grid[4][0]);
  assert.equal(b.grid[4][0].colspan, 3);
  assert.equal(b.styles.length, 2);
  assert.equal(b.rules.length, 2);
  assert.equal(b.scales.length, 1);
  assert.equal(b.sequences.length, 1);
  assert.deepEqual(b.comments.map(c => [c.r, c.c, c.text]), [[1, 1, 'Market price, October']]);
  assert.deepEqual(b.sorts, [{ col: 3, dir: 'desc' }]);
  assert.equal(b.filters[0].col, 1);
  assert.deepEqual([...b.hidden.rows], [2]);
  assert.deepEqual(b.remarks.map(r => r.text), ['# the budget']);
  assert.deepEqual(b.meta.find(e => e.key === 'owner').value, 'Will');
  assert.equal(b.grid[2][0].text, 'Pears, green');
  assert.equal(b.grid[3][1].text, '');
  assert.equal(b.grid[1][3].formula, 'B*C');
  assert.equal(b.grid[2][4].text, '2026-02-28');
  assert.equal(b.grid[2][4].generated, true);
  assert.equal(o.name, 'Other');
  // Offsets: a cell's text is at its range; a fill's cells share the fill item.
  const d2 = b.grid[1][3];
  assert.equal(BUDGET.slice(d2.from, d2.to), '=B*C');
  assert.equal(b.grid[3][3].from, d2.from);
  assert.equal(cellAtOffset(wb, d2.from + 1).cell, d2);
  assert.equal(BUDGET.slice(b.nameFrom, b.nameTo), 'name: Budget');
});

test('parseSpreadsheet: no front matter = Sheet1; duplicate names; one value fills; open ranges', () => {
  const wb = parseSpreadsheet('A1:B1 a, b\nA2:B2 1, 2\n---\nname: X\n---\nA1 q\n---\nname: X\n---\nA1 r\n');
  assert.deepEqual(wb.sheets.map(s => s.name), ['Sheet1', 'X', 'X 2']);
  const fill = parseSpreadsheet('---\nheader: 1\n---\nA1:C1 h, h, h\nA2:C4 0\nB:B =A*2\n').sheets[0];
  assert.equal(fill.grid[3][2].text, '0');
  assert.equal(fill.grid[0][1].text, 'h');          // the header is never filled by an open column
  assert.equal(fill.grid[1][1].text, '=A*2');
  assert.equal(fill.grid[3][1].text, '=A*2');
  const list = parseSpreadsheet('A:A 1, 2, 3\n').sheets[0];
  assert.equal(list.rows.length, 3);
  assert.equal(list.grid[2][0].text, '3');
});

test('parseSpreadsheet: problems are reported with offsets, parsing continues', () => {
  const wb = parseSpreadsheet('---\nheader: lots\n---\nA1 x {colour: red}\nA {merge}\nA1 {rule: wat, bold}\nA1 {rule: > 1}\nA1:B2 {comment: x}\nA1 {seq: hello}\nA1 {step: 2}\nA {height: 3}\nA1 {hidden}\nbold A1\nA1:A2 1, 2, 3\n');
  const msgs = wb.problems.map(p => p.message);
  for (const re of [/header: expected a number/, /unknown property "colour"/, /merge: a merge needs a bounded range/, /rule: cannot read/, /rule: add the properties/, /comment: expected a cell/, /seq: "hello"/, /step: needs a seq/, /height: applies to rows/, /hidden: applies to whole rows/, /a line starts with a cell/, /3 values for 2 cells/]) {
    assert.ok(msgs.some(m => re.test(m)), String(re));
  }
  assert.equal(wb.sheets[0].grid[0][0].text, '1');
});

// ---------------------------------------------------------------------------
// Styles, conditions, formats
// ---------------------------------------------------------------------------

test('parseStyleProps / formatStyleProps round-trip, resets, validation', () => {
  const { props, problems } = parseStyleProps(['bold', 'italic:off', 'color:Red', 'bg:#EEF', 'size:12', 'font:mono', 'align:center', 'valign:top', 'format:"$#,##0.00"', 'border:top,left', 'wrap']);
  assert.equal(problems.length, 0);
  assert.deepEqual(props, { bold: true, italic: false, color: 'red', bg: '#eef', size: 12, font: 'mono', align: 'center', valign: 'top', format: '$#,##0.00', border: 'top,left', wrap: true });
  assert.equal(formatStyleProps(props), 'bold italic:off wrap color:red bg:#eef size:12 font:mono align:center valign:top format:$#,##0.00 border:top,left');
  assert.deepEqual(parseStyleProps(['color:none', 'format:general', 'border', 'border:none']).props, { color: null, format: null, border: 'none' });
  assert.deepEqual(parseStyleProps(['format:percent', 'format:text']).props, { format: '@' });
  assert.ok(parseStyleProps(['align:middle']).problems[0].includes('align'));
  assert.ok(parseStyleProps(['size:big']).problems[0].includes('size'));
});

test('parseCondition / formatCondition: every kind', () => {
  const c = (s) => parseCondition(tokenizeArgs(s));
  assert.deepEqual(c('> 100'), { kind: 'cmp', op: '>', value: '100' });
  assert.deepEqual(c('>100'), { kind: 'cmp', op: '>', value: '100' });
  assert.deepEqual(c('= "late"'), { kind: 'cmp', op: '=', value: '"late"' });
  assert.deepEqual(c('!= B1*2'), { kind: 'cmp', op: '<>', value: 'B1*2' });
  assert.deepEqual(c('between 10 and 20'), { kind: 'between', a: '10', b: '20' });
  assert.deepEqual(c('contains "x y"'), { kind: 'contains', text: 'x y' });
  assert.deepEqual(c('top 3'), { kind: 'top', n: 3 });
  assert.deepEqual(c('blank'), { kind: 'blank' });
  assert.deepEqual(c('=D>C'), { kind: 'formula', formula: 'D>C' });
  assert.ok(c('wat').error);
  assert.ok(c('between 1 and').error);
  for (const s of ['> 100', 'between 10 and 20', 'contains "x y"', 'top 3', 'blank', '=D>C', 'starts "a"']) assert.equal(formatCondition(c(s)), s);
  assert.equal(describeCondition(c('<> 0')), 'is not equal to 0');
});

test('formatValue: patterns, named formats, text', () => {
  assert.equal(formatValue(1234.567, '#,##0.00'), '1,234.57');
  assert.equal(formatValue(-1234.5, '$#,##0.00'), '-$1,234.50');
  assert.equal(formatValue(0.1234, '0.0%'), '12.3%');
  assert.equal(formatValue(1234.5, '0.00E+00'), '1.23E+03');
  assert.equal(formatValue(5, '#,##0 kg'), '5 kg');
  assert.equal(formatValue(3.14159, null), '3.14159');
  assert.equal(formatValue('text', '0.00'), 'text');
});

test('colours and scales', () => {
  assert.equal(parseColor('#ABC'), '#abc');
  assert.equal(parseColor('Red'), 'red');
  assert.equal(parseColor('#12345'), null);
  assert.deepEqual(colorToRgb('#abc'), [170, 187, 204]);
  const sc = { min: 0, max: 10, rgb: [[0, 0, 0], [255, 255, 255]] };
  assert.equal(scaleColor(0, sc), '#000000');
  assert.equal(scaleColor(5, sc), '#808080');
});

// ---------------------------------------------------------------------------
// Computed workbook: values, resolved styles, view
// ---------------------------------------------------------------------------

test('computeWorkbook: values, formats, rules, scales, generated cells, cross-sheet refs', () => {
  const book = computeWorkbook(BUDGET);
  const b = book.sheets[0];
  assert.equal(book.display(b.grid[1][3]), '$3.60');
  assert.equal(book.display(b.grid[4][3]), '5.20');       // decimals: 2 (no format on D5)
  assert.equal(book.display(b.grid[2][2]), '0.80');       // a literal shows the typed text
  assert.equal(book.display(b.grid[3][4]), '2026-03-31'); // a generated date
  assert.equal(book.display(book.sheets[1].grid[1][1]), '10.4');
  assert.deepEqual(book.styleOf(b.grid[1][3]), { format: '$#,##0.00', bold: true, color: 'green' });
  assert.deepEqual(book.styleOf(b.grid[2][3]), { format: '$#,##0.00' });
  assert.equal(book.styleOf(b.grid[1][0]).bg, undefined);
  assert.equal(book.styleOf(b.grid[2][0]).bg, '#fdd');      // "Pears, green" contains "pe"
  assert.equal(book.styleOf(b.grid[1][1]).bg, '#1a8cf5');   // scale max
  assert.equal(book.styleOf(b.grid[2][1]).bg, '#ffffff');   // scale min
  assert.deepEqual(book.staticStyleOf(b.grid[1][3]), { format: '$#,##0.00' });
  assert.deepEqual(book.styleOf(b.grid[0][0]), { bold: true, bg: '#eef' });
});

test('viewRows / viewCols: header first, filter, sort (blanks last), hidden removed', () => {
  const book = computeWorkbook(BUDGET);
  assert.deepEqual(viewRows(book, book.sheets[0]), [0, 1]);
  const noHide = computeWorkbook(BUDGET.replace('3 {hidden}\n', ''));
  assert.deepEqual(viewRows(noHide, noHide.sheets[0]), [0, 1, 2]);
  const sortOnly = computeWorkbook(BUDGET.replace('3 {hidden}\n', '').replace('filter: B > 0\n', ''));
  assert.deepEqual(viewRows(sortOnly, sortOnly.sheets[0]), [0, 4, 1, 2, 3]);
  const fcond = computeWorkbook('---\nfilter: =B>A\n---\nA1:B1 a, b\nA2:B2 1, 2\nA3:B3 3, 1\n');
  assert.deepEqual(viewRows(fcond, fcond.sheets[0]), [0, 1]);
  const two = computeWorkbook('---\nheader: 1\nfilter: A > 1; B contains "x"\n---\nA1:B1 a, b\nA2:B2 1, x\nA3:B3 3, x\nA4:B4 5, y\n');
  assert.deepEqual(viewRows(two, two.sheets[0]), [0, 2]);
  const hc = computeWorkbook('A1:C1 a, b, c\nB {hidden}\n');
  assert.deepEqual(viewCols(hc.sheets[0]), [0, 2]);
});

test('cellDisplay: literal with a format shows the formatted number; text stays', () => {
  assert.equal(cellDisplay({ text: '1200', formula: null, merged: false }, 1200, { format: '#,##0' }), '1,200');
  assert.equal(cellDisplay({ text: "'=x", formula: null, merged: false }, '=x', {}), '=x');
});

// ---------------------------------------------------------------------------
// Serialization & edits
// ---------------------------------------------------------------------------

test('alignSpreadsheet is canonical and idempotent; extra front matter keys and remarks survive', () => {
  const a = alignSpreadsheet(BUDGET);
  assert.equal(alignSpreadsheet(a), a);
  assert.equal(a, `---
name: Budget
header: 1
freeze: cols 1
decimals: 2
sort: D desc
filter: B > 0
owner: Will
---
# the budget

A1:E1 Item, Qty, Price, Total, When
A2:C2 Apples, 3, 1.20
D2:D4 =B*C {format: $#,##0.00}
A3:C3 "Pears, green", 2, 0.80
A4:C4 Plums, , 2.50
A5:D5 Total, , , =SUM(D2:D4)

E2:E4 {seq: 2026-01-31, step: 1 month}
A5:C5 {merge}
A {width: 18}
3 {hidden}
A1:D1 {bold, bg: #eef}
D2:D4 {rule: > 3, bold, color: green}
A2:A4 {rule: contains "pe", bg: #fdd}
B2:B4 {scale: #fff #1a8cf5}
B2 {comment: "Market price, October"}

---
name: Other
---

A1:B1 x, y
A2:B2 1, =Budget!D5*2
`);
});

test('setCell / setCells / clearRange: grow the sheet; an empty document gets Sheet1', () => {
  let r = setCell('A1:B1 a, b\n', 0, 3, 4, 'x');
  assert.equal(r.text, '---\nname: Sheet1\n---\n\nA1:B1 a, b\nE4 x\n');
  r = setCells(r.text, 0, 0, 0, [['1', '2'], ['=A*B', '']]);
  assert.ok(r.text.includes('\nA1:B1 1, 2\nA2 =A*B\nE4 x\n'));
  r = clearRange(r.text, 0, { r1: 3, c1: 4, r2: 3, c2: 4 });
  assert.ok(!r.text.includes('E4'));
  const first = setCell('', 0, 0, 0, 'hello');
  assert.equal(first.text, '---\nname: Sheet1\n---\n\nA1 hello\n');
  const src = '---\nname: S\n---\nA1 a\n';
  const c = setCell(src, 0, 0, 0, 'zz');
  assert.equal(c.changes[0].from, 0);
  assert.equal(c.changes[0].to, src.length - 1);
  // Three identical formulas down a column become one fill line.
  const f = setCells('A1 h\n', 0, 1, 1, [['=A*2'], ['=A*2'], ['=A*2']]);
  assert.ok(f.text.includes('\nB2:B4 =A*2\n'));
});

test('insertRows / deleteRows shift settings and formulas (other sheets too)', () => {
  const src = '---\nname: A\n---\nA1:B1 x, y\nA2:B2 1, =A*2\nA3:B3 2, =SUM(B2:B3)\nA2:B3 {bold}\nB3 {comment: c}\nB2:B3 {rule: > 1, bold}\nA2:A3 {seq: 1}\n---\nname: B\n---\nA1:B1 =A!B3, =SUM(A!B2:B3)\n';
  const r = insertRows(src, 0, 1, 2);
  const t = r.text;
  assert.ok(t.includes('\nA1:B1 x, y\nA4:B4 1, =A*2\nA5:B5 2, =SUM(B4:B5)\n'));
  assert.ok(t.includes('A4:A5 {seq: 1}'));
  assert.ok(t.includes('A4:B5 {bold}'));
  assert.ok(t.includes('B5 {comment: c}'));
  assert.ok(t.includes('B4:B5 {rule: > 1, bold}'));
  assert.ok(t.includes('A1:B1 =A!B5, =SUM(A!B4:B5)'));
  const d = deleteRows(t, 0, 3, 3);
  assert.ok(d.text.includes('=SUM(B4:B4)'));
  assert.ok(d.text.includes('A4:B4 2, =SUM(B4:B4) {bold}'));   // the style rides on the value line
  assert.ok(d.text.includes('B4 {comment: c}'));
  const d2 = deleteRows(d.text, 0, 3, 3);
  assert.ok(d2.text.includes('=SUM(#REF!)'));
  assert.ok(!d2.text.includes('{bold}'));
});

test('insertCols / deleteCols shift bare-column refs, widths, sorts and filters', () => {
  const src = '---\nsort: B asc\nfilter: B > 0\n---\nA1:C1 a, b, c\nA2:C2 1, 2, =A*B\nB {width: 12}\nB:C {bold}\nC {hidden}\n';
  const r = insertCols(src, 0, 1, 1);
  assert.ok(r.text.includes('=A*C'));
  assert.ok(r.text.includes('C {width: 12}'));
  assert.ok(r.text.includes('sort: C asc'));
  assert.ok(r.text.includes('filter: C > 0'));
  assert.ok(r.text.includes('C:D {bold}'));
  assert.ok(r.text.includes('D {hidden}'));
  const d = deleteCols(r.text, 0, 2, 2);
  assert.ok(d.text.includes('=A*#REF!'));
  assert.ok(!d.text.includes('sort:'));
  assert.ok(d.text.includes('filter: on'));
  assert.ok(d.text.includes('C {bold}'));
});

test('shiftFormula / shiftRange edge cases', () => {
  assert.equal(shiftFormula('SUM(A1:A5)+B3', 'row', 2, 1, 'S', true), 'SUM(A1:A6)+B4');
  assert.equal(shiftFormula('SUM(A1:A5)', 'row', 0, -5, 'S', true), 'SUM(#REF!)');
  assert.equal(shiftFormula('SUM(A1:A5)', 'row', 1, -2, 'S', true), 'SUM(A1:A3)');
  assert.equal(shiftFormula("'Q1 Sales'!B2+Other!B2", 'row', 0, 1, 'Q1 Sales', false), "'Q1 Sales'!B3+Other!B2");
  assert.equal(shiftFormula('SUM(B:B)+C', 'col', 1, 1, 'S', true), 'SUM(C:C)+D');
  assert.equal(shiftFormula('B', 'col', 1, -1, 'S', true), '#REF!');
  assert.deepEqual(shiftRange({ r1: 0, r2: Infinity, c1: 2, c2: 2 }, 'col', 0, 1), { r1: 0, r2: Infinity, c1: 3, c2: 3 });
  assert.equal(shiftRange({ r1: 2, r2: 3, c1: 0, c2: 0 }, 'row', 2, -2), null);
});

test('sortRows: a data sort below the header; comments and row heights ride along', () => {
  const src = '---\nheader: 1\n---\nA1:B1 n, v\nA2:B2 c, 3\nA3:B3 a, 1\nA4:B4 b, =A&"!"\nA3 {comment: cc}\n3 {height: 40}\n';
  const book = computeWorkbook(src);
  const r = sortRows(src, 0, 0, 'asc', book);
  assert.ok(r.text.includes('\nA2:B2 a, 1\nA3:B3 b, =A&"!"\nA4:B4 c, 3\n'));
  assert.ok(r.text.includes('A2 {comment: cc}'));
  assert.ok(r.text.includes('2 {height: 40}'));
  const d = sortRows(src, 0, 1, 'desc', book);
  assert.ok(d.text.includes('\nA2:B2 b, =A&"!"\nA3:B3 c, 3\nA4:B4 a, 1\n'));
});

test('mergeRange / unmergeRange', () => {
  let r = mergeRange('A1:B1 a, b\nA2:B2 c, d\n', 0, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.ok(r.text.endsWith('\nA1 a\n\nA1:B2 {merge}\n'));
  const wb = parseSpreadsheet(r.text);
  assert.equal(wb.sheets[0].grid[1][1], wb.sheets[0].grid[0][0]);
  r = unmergeRange(r.text, 0, { r1: 1, c1: 1, r2: 1, c2: 1 });
  assert.ok(!r.text.includes('merge'));
  assert.equal(mergeRange('A1 a', 0, { r1: 0, c1: 0, r2: 0, c2: 0 }).changes.length, 0);
});

test('setStyle: rides on a value line of the same range, strips inner keys, explicit off', () => {
  let r = setStyle('A1:B1 a, b\n', 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true });
  assert.ok(r.text.includes('\nA1:B1 a, b {bold}\n'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { color: 'red' });
  assert.ok(r.text.includes('\nA1:B1 a, b {bold, color: red}\n'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: false });
  assert.ok(r.text.includes('\nA1 {bold: off}\n'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: false });
  assert.ok(r.text.includes('\nA1:B1 a, b {color: red}\n'));
  assert.ok(!r.text.includes('A1 {'));
  const book = computeWorkbook(r.text);
  assert.equal(rangeHas(book, book.sheets[0], { r1: 0, c1: 0, r2: 0, c2: 1 }, 'color'), true);
  assert.equal(rangeHas(book, book.sheets[0], { r1: 0, c1: 0, r2: 0, c2: 1 }, 'bold'), false);
});

test('rules, scales, comments, sequences, widths, freeze, hidden, views, header, meta', () => {
  let r = addRule('A1:A2 1, 2\n', 0, { r1: 0, c1: 0, r2: 1, c2: 0 }, { kind: 'cmp', op: '>', value: '1' }, { bold: true, bg: '#fdd' });
  assert.ok(r.text.includes('\nA1:A2 {rule: > 1, bold, bg: #fdd}\n'));
  r = addScale(r.text, 0, { r1: 0, c1: 0, r2: 1, c2: 0 }, ['#fff', '#000']);
  assert.ok(r.text.includes('\nA1:A2 {scale: #fff #000}\n'));
  r = removeRule(r.text, 0, 0);
  assert.ok(!r.text.includes('rule:'));
  r = setComment(r.text, 0, 0, 0, 'hello "there"\nsecond line');
  assert.ok(r.text.includes('A1 {comment: "hello \\"there\\" second line"}'));
  assert.equal(parseSpreadsheet(r.text).sheets[0].comments[0].text, 'hello "there" second line');
  r = setComment(r.text, 0, 0, 0, '');
  assert.ok(!r.text.includes('comment'));
  r = setSequence(r.text, 0, { r1: 0, c1: 1, r2: 4, c2: 1 }, '2026-01-01', parseStep('1 week'));
  assert.ok(r.text.includes('B1:B5 {seq: 2026-01-01, step: 1 week}'));
  assert.equal(computeWorkbook(r.text).sheets[0].grid[4][1].text, '2026-01-29');
  r = setSequence(r.text, 0, { r1: 0, c1: 1, r2: 4, c2: 1 }, null);
  assert.ok(!r.text.includes('seq:'));
  r = setWidth(r.text, 0, 0, 2, 14);
  assert.ok(r.text.includes('A:C {width: 14}'));
  r = setWidth(r.text, 0, 1, 1, 0);
  assert.ok(r.text.includes('A {width: 14}\nC {width: 14}'));
  r = setFreeze(r.text, 0, 1, 2);
  assert.ok(r.text.includes('freeze: rows 1, cols 2'));
  r = setHidden(r.text, 0, 'row', 1, 1, true);
  assert.ok(r.text.includes('\n2 {hidden}\n'));
  r = setSortView(r.text, 0, [{ col: 0, dir: 'desc' }]);
  assert.ok(r.text.includes('sort: A desc'));
  r = setFilter(r.text, 0, 0, { kind: 'contains', text: 'x' });
  assert.ok(r.text.includes('filter: A contains "x"'));
  r = setFilter(r.text, 0, 0, null);
  assert.ok(r.text.includes('filter: on'));
  r = setFilterOn(r.text, 0, false);
  assert.ok(!r.text.includes('filter:'));
  r = setHeaderRows(r.text, 0, 1);
  assert.ok(r.text.includes('header: 1'));
  r = setMeta(r.text, 0, 'owner', 'Will');
  assert.ok(r.text.includes('owner: Will\n---'));
});

test('addSheet / renameSheet (refs follow) / deleteSheet', () => {
  let r = addSheet('A1 a\n', 'Q1 Sales');
  assert.equal(r.index, 1);
  assert.equal(r.text, 'A1 a\n\n---\nname: Q1 Sales\n---\n');
  r = setCell(r.text, 1, 0, 0, '=Sheet1!A1');
  r = renameSheet(r.text, 0, 'Costs');
  assert.ok(r.text.startsWith('---\nname: Costs\n---\nA1 a\n'));
  assert.ok(r.text.includes('A1 =Costs!A1'));
  r = renameSheet(r.text, 1, 'Costs');
  assert.equal(r.changes.length, 0);
  r = deleteSheet(r.text, 1);
  assert.equal(r.text, '---\nname: Costs\n---\nA1 a\n');
  assert.equal(deleteSheet(r.text, 0).changes.length, 0);
});

// ---------------------------------------------------------------------------
// Rendering & exports
// ---------------------------------------------------------------------------

test('renderSheetHtml: rulers, filter buttons, spans, inline styles, offsets, view order', () => {
  const book = computeWorkbook(BUDGET);
  const html = renderSheetHtml(book, book.sheets[0]);
  assert.ok(html.includes('<th class="uf-ss-col is-frozen" data-col="0">A'));
  assert.ok(html.includes('data-filter-col="1"'));
  assert.ok(html.includes('data-addr="D2"'));
  assert.ok(html.includes('font-weight:600;color:green'));
  assert.ok(html.includes('$3.60'));
  assert.ok(!html.includes('data-addr="A3"'));
  const all = renderSheetHtml(book, book.sheets[0], { view: false });
  assert.ok(all.includes('colspan="3"'));
  assert.ok(all.includes('has-comment'));
  assert.ok(renderWorkbookHtml(book).includes('<h2 class="uf-ss-name"'));
  assert.ok(workbookDocument(book, { title: 'T' }).startsWith('<!doctype html>'));
});

test('sheetToCsv: displayed values, generated cells, merges blank', () => {
  const book = computeWorkbook(BUDGET);
  assert.equal(sheetToCsv(book, book.sheets[0]), 'Item,Qty,Price,Total,When\r\nApples,3,1.20,$3.60,2026-01-31\r\n"Pears, green",2,0.80,$1.60,2026-02-28\r\nPlums,,2.50,$0.00,2026-03-31\r\nTotal,,,5.20,\r\n');
});

test('workbookToXlsx: a stored ZIP with styles, formulas, merges, cf rules, comments, autofilter', () => {
  const book = computeWorkbook(BUDGET);
  const bytes = workbookToXlsx(book, { title: 'Budget' });
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.includes('xl/comments1.xml'));
  assert.ok(s.includes('<f>B2*C2</f>'));
  assert.ok(s.includes('<mergeCell ref="A5:C5"/>'));
  assert.ok(s.includes('<cfRule type="cellIs"'));
  assert.ok(s.includes('type="containsText"'));
  assert.ok(s.includes('<colorScale>'));
  assert.ok(s.includes('formatCode="$#,##0.00"'));
  assert.ok(s.includes('<pane xSplit="1" ySplit="1"'));
  assert.ok(s.includes('<row r="3" hidden="1">'));
  assert.ok(s.includes('<autoFilter'));
  assert.ok(s.includes('Market price, October'));
  assert.ok(s.includes('<v>46081</v>') && s.includes('formatCode="yyyy-mm-dd"'));   // the generated date: a real date cell
});

test('usedExtent / toModel / serializeModel of a blank sheet', () => {
  const wb = parseSpreadsheet('---\nname: S\n---\nA1 a\n');
  assert.deepEqual(usedExtent(wb.sheets[0]), { rows: 1, cols: 1 });
  assert.equal(serializeModel(toModel(wb.sheets[0])), '---\nname: S\n---\n\nA1 a');
});

// ---------------------------------------------------------------------------
// Dates, data bars, multi-line cells, fill series, charts, import
// ---------------------------------------------------------------------------

import { fillRange, offsetFormula, addBar, removeBar, addChart, updateChart, removeChart } from '../src/core/sheet/edit.js';
import { chartData, renderChartSvg, niceTicks } from '../src/core/sheet/chart.js';
import { importXlsx, importCsv } from '../src/core/sheet/xlsx-import.js';
import { parseXml, textOf } from '../src/core/sheet/xml.js';
import { parseDateText, formatDate, isDateFormat, FUNCTIONS, isDate } from '../src/core/tables/formula.js';
import { inflateRawSync } from 'node:zlib';

test('dates: literals, arithmetic, functions, formats', () => {
  const d = parseDateText('2026-01-31');
  assert.equal(d.serial, 46053);
  assert.equal(String(d), '2026-01-31');
  assert.equal(parseDateText('2026-02-30'), null);
  assert.equal(formatDate(d.serial, 'd mmm yyyy'), '31 Jan 2026');
  assert.equal(formatDate(d.serial + 0.5, 'yyyy-mm-dd hh:mm AM/PM'), '2026-01-31 12:00 PM');
  assert.equal(formatDate(d.serial, 'dddd, mmmm d'), 'Saturday, January 31');
  assert.ok(isDateFormat('dd/mm/yyyy') && !isDateFormat('#,##0.00'));
  const book = computeWorkbook('A1 2026-01-31\nB1 =A1+30\nC1 =B1-A1\nD1 =EDATE(A1, 1)\nE1 =EOMONTH(A1, 1)\nF1 =DATEDIF(A1, "2027-03-15", "ym")\nG1 =TEXT(A1, "mmmm yyyy")\nH1 =YEAR(A1)&"-"&WEEKDAY(A1)\nI1 =MAX(A1, D1)\nJ1 =A1 {format: d mmm yyyy}\nK1 =DAYS("2026-03-01", A1)\n');
  const s = book.sheets[0];
  const show = c => book.display(s.grid[0][c]);
  assert.equal(show(1), '2026-03-02');
  assert.equal(show(2), '30');
  assert.equal(show(3), '2026-02-28');
  assert.equal(show(4), '2026-02-28');
  assert.equal(show(5), '1');
  assert.equal(show(6), 'January 2026');
  assert.equal(show(7), '2026-7');
  assert.equal(show(8), '2026-02-28');
  assert.equal(show(9), '31 Jan 2026');
  assert.equal(show(10), '29');
  assert.equal(book.kindOf(s.grid[0][1]), 'date');
  assert.ok(isDate(FUNCTIONS.TODAY()));
  // Sorting and comparisons treat dates as numbers.
  const v = computeWorkbook('---\nsort: A asc\n---\nA1:A3 2026-03-01, 2025-12-31, 2026-01-15\n');
  assert.deepEqual(viewRows(v, v.sheets[0]), [1, 2, 0]);
  const rule = computeWorkbook('A1 2026-03-01\nA1 {rule: > "2026-01-01", bold}\n');
  assert.equal(rule.styleOf(rule.sheets[0].grid[0][0]).bold, true);
});

test('data bars: resolved length, css, xlsx rule, edit ops', () => {
  const book = computeWorkbook('A1:A4 10, 20, -5, 40\nA1:A4 {bar: #2a78d6}\n');
  const s = book.sheets[0];
  const b4 = book.styleOf(s.grid[3][0]).bar;
  assert.equal(b4.to, 1);
  assert.ok(Math.abs(book.styleOf(s.grid[0][0]).bar.to - (15 / 45)) < 1e-9);
  const b3 = book.styleOf(s.grid[2][0]).bar;
  assert.equal(b3.from, 0);
  assert.ok(renderSheetHtml(book, s).includes('linear-gradient(90deg'));
  const x = Buffer.from(workbookToXlsx(book)).toString('latin1');
  assert.ok(x.includes('<cfRule type="dataBar"'));
  let r = addBar('A1 1\n', 0, { r1: 0, c1: 0, r2: 4, c2: 0 }, '#e34948');
  assert.ok(r.text.includes('A1:A5 {bar: #e34948}'));
  r = removeBar(r.text, 0, 0);
  assert.ok(!r.text.includes('bar:'));
});

test('multi-line cells: \\n in quotes round-trips, renders pre-wrap, exports', () => {
  const src = '---\nname: S\n---\n\nA1:B1 "line one\\nline two", x\n';
  const book = computeWorkbook(src);
  assert.equal(book.sheets[0].grid[0][0].text, 'line one\nline two');
  assert.equal(alignSpreadsheet(src), src);
  assert.ok(renderSheetHtml(book, book.sheets[0]).includes('is-multiline'));
  assert.equal(sheetToCsv(book, book.sheets[0]), '"line one\nline two",x\r\n');
  const r = setCell('A1 a\n', 0, 0, 0, 'p\r\nq');
  assert.ok(r.text.includes('A1 "p\\nq"'));
  assert.ok(Buffer.from(workbookToXlsx(book)).toString('latin1').includes('wrapText="1"'));
});

test('fillRange: linear numbers, dates, text+number, formulas with relative refs, cycling', () => {
  let r = fillRange('A1:B1 1, =A*2\nA2:B2 3, =A*2\n', 0, { r1: 0, c1: 0, r2: 1, c2: 1 }, { r1: 0, c1: 0, r2: 4, c2: 1 });
  assert.ok(r.text.includes('A1:A5 1, 3, 5, 7, 9'));
  assert.ok(r.text.includes('B1:B5 =A*2'));
  r = fillRange('A1 2026-01-31\nB1 Item 1\nC1 =A1+1\nD1 x\n', 0, { r1: 0, c1: 0, r2: 0, c2: 3 }, { r1: 0, c1: 0, r2: 2, c2: 3 });
  assert.ok(r.text.includes('A2:D2 2026-02-01, Item 2, =A2+1, x'));
  assert.ok(r.text.includes('A3:D3 2026-02-02, Item 3, =A3+1, x'));
  // Filling up and to the right; a two-value text cycle.
  r = fillRange('A3:B3 5, =$A$1+A3\n', 0, { r1: 2, c1: 0, r2: 2, c2: 1 }, { r1: 0, c1: 0, r2: 2, c2: 1 });
  assert.ok(r.text.includes('A1:B1 5, =$A$1+A1'));
  r = fillRange('A1:A2 x, y\n', 0, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 });
  assert.ok(r.text.includes('A1:A5 x, y, x, y, x'));
  r = fillRange('A1 10\n', 0, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 0, c2: 3 });
  assert.ok(r.text.includes('A1:D1 10, 10, 10, 10'));
  assert.equal(fillRange('A1 1\n', 0, { r1: 0, c1: 0, r2: 0, c2: 0 }, { r1: 0, c1: 0, r2: 0, c2: 0 }).changes.length, 0);
  assert.equal(offsetFormula('A1+$B$1+SUM(C1:C3)+B+Sheet2!A1+$C2+D$3', 2, 1), 'B3+$B$1+SUM(D3:D5)+B+Sheet2!B3+$C4+E$3');
});

test('charts: data from the sheet, svg forms, edit ops, xlsx parts', () => {
  const src = '---\nheader: 1\n---\nA1:C1 Month, North, South\nA2:A4 Jan, Feb, Mar\nB2:B4 1, 2, 3\nC2:C4 4, 5, 6\nA1:C4 {chart: column, title: "T", at: E2, size: 400x240}\nB1:B4 {chart: pie}\nA1:C4 {chart: scatter, series: rows, legend: off}\n';
  const book = computeWorkbook(src);
  const s = book.sheets[0];
  assert.equal(s.charts.length, 3);
  assert.deepEqual(s.charts[0].at, { r: 1, c: 4 });
  const d = chartData(book, s, s.charts[0]);
  assert.deepEqual(d.categories, ['Jan', 'Feb', 'Mar']);
  assert.deepEqual(d.series.map(x => x.name), ['North', 'South']);
  assert.deepEqual(d.series[1].values, [4, 5, 6]);
  const byRows = chartData(book, s, s.charts[2]);
  assert.deepEqual(byRows.series.map(x => x.name), ['Jan', 'Feb', 'Mar']);
  for (const type of ['column', 'bar', 'line', 'area', 'pie', 'scatter']) {
    const svg = renderChartSvg(d, { type, title: 'x', width: 300, height: 200 });
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), type);
    assert.ok(svg.includes('#2a78d6'), type);
  }
  assert.ok(renderChartSvg(d, { type: 'column' }).includes('<rect x="48"'));      // legend for 2 series
  assert.ok(!renderChartSvg({ categories: ['a'], series: [{ name: 's', values: [1] }], xs: null }, { type: 'column' }).includes('<rect x="48"'));
  assert.ok(renderChartSvg({ categories: [], series: [], xs: null }, {}).includes('No data'));
  assert.deepEqual(niceTicks(0, 23).ticks, [0, 5, 10, 15, 20, 25]);
  assert.equal(alignSpreadsheet(src), alignSpreadsheet(alignSpreadsheet(src)));
  assert.ok(alignSpreadsheet(src).includes('A1:C4 {chart: column, title: T, at: E2, size: 400x240}'));
  assert.ok(alignSpreadsheet(src).includes('A1:C4 {chart: scatter, series: rows, legend: off}'));
  assert.ok(renderWorkbookHtml(book).includes('uf-ss-chartfig'));
  const x = Buffer.from(workbookToXlsx(book)).toString('latin1');
  assert.ok(x.includes('xl/charts/chart1.xml') && x.includes('xl/charts/chart3.xml') && x.includes('xl/drawings/drawing1.xml'));
  assert.ok(x.includes('<c:barChart>') && x.includes('<c:pieChart>') && x.includes('<c:scatterChart>'));
  assert.ok(x.includes("<c:f>'Sheet1'!$B$2:$B$4</c:f>"));
  assert.ok(x.includes('<drawing r:id="rId3"/>'));
  let r = addChart('A1:B2 1, 2, 3, 4\n', 0, { range: { r1: 0, c1: 0, r2: 1, c2: 1 }, type: 'line', title: 'L' });
  assert.ok(r.text.includes('A1:B2 {chart: line, title: L}'));
  r = updateChart(r.text, 0, 0, { at: { r: 3, c: 3 } });
  assert.ok(r.text.includes('at: D4'));
  r = insertRows(r.text, 0, 0, 1);
  assert.ok(r.text.includes('A2:B3 {chart: line, title: L, at: D5}'));
  r = removeChart(r.text, 0, 0);
  assert.ok(!r.text.includes('chart:'));
});

test('row windowing: spacer rows carry the hidden heights; frozen rows always render', () => {
  const lines = ['---', 'header: 1', '---', 'A1 h'];
  for (let i = 2; i <= 300; i++) lines.push(`A${i} ${i}`);
  const book = computeWorkbook(lines.join('\n'));
  const html = renderSheetHtml(book, book.sheets[0], { window: { from: 100, to: 120 }, rowHeight: 26 });
  assert.ok(html.includes('data-addr="A1"'));
  assert.ok(!html.includes('data-addr="A50"'));
  assert.ok(html.includes('data-addr="A110"'));
  assert.ok(html.includes('<tr class="is-spacer" style="height:' + (99 * 26) + 'px">'));
  assert.ok(html.includes('<tr class="is-spacer" style="height:' + (180 * 26) + 'px">'));
});

test('xml: a tiny OOXML reader', () => {
  const root = parseXml('<?xml version="1.0"?><a:root xmlns:a="x"><b k="1 &amp; 2"/><c>hi <d>there</d></c><!-- c --></a:root>');
  assert.equal(root.name, 'root');
  assert.equal(root.children[0].attrs.k, '1 & 2');
  assert.equal(textOf(root.children[1]), 'hi there');
});

test('importXlsx round-trips our own export (stored + deflated); importCsv', async () => {
  const src = `---
name: Sales
header: 1
freeze: cols 1
filter: on
---
A1:D1 Month, North, South, Note {bold, bg: #eeeeff}
A2:E2 Jan, 12, 8, "two\\nlines", =B2+C2
A3:E3 Feb, 18, 11, 2026-02-28, =B3+C3
A4:E4 Mar, 9, 14, , =B4+C4

A {width: 14}
4 {hidden}
E2:E4 {format: #,##0.00}
B2:C4 {rule: > 10, bold, color: #008000}
E2:E4 {scale: #ffffff #1a8cf5}
B2:B4 {bar: #2a78d6}
B3 {comment: big month}
`;
  const book = computeWorkbook(src);
  const bytes = workbookToXlsx(book);
  const back = await importXlsx(bytes, { inflateRaw: inflateRawSync });
  for (const line of ['name: Sales', 'header: 1', 'freeze: cols 1', 'filter: on', 'A1:D1 Month, North, South, Note {bold, bg: #eeeeff}', 'A2:E2 Jan, 12, 8, "two\\nlines", =B2+C2', 'A3:E3 Feb, 18, 11, 2026-02-28, =B3+C3', 'A {width: 14}', '4 {hidden}', 'E2:E4 {format: #,##0.00}', 'B2:C4 {rule: > 10, bold, color: #008000}', 'E2:E4 {scale: #ffffff #1a8cf5}', 'B2:B4 {bar: #2a78d6}', 'B3 {comment: big month}']) {
    assert.ok(back.includes(line), line);
  }
  // Deflated entries go through the inflater.
  const { deflateRawSync } = await import('node:zlib');
  const { readZip } = await import('../src/core/zip.js');
  const stored = await readZip(bytes);
  assert.ok(stored.has('xl/workbook.xml'));
  const inflated = await readZip(bytes, inflateRawSync);
  assert.equal(inflated.size, stored.size);
  void deflateRawSync;
  const csv = importCsv('a,b,"c, d"\r\n1,2,"x\ny"\r\n', 'Data');
  assert.equal(csv, '---\nname: Data\n---\n\nA1:C1 a, b, "c, d"\nA2:C2 1, 2, "x\\ny"\n');
  assert.ok(importCsv('a;b\n1;2\n').includes('A1:B1 a, b'));
  assert.ok(importCsv('a\tb\n1\t2\n').includes('A2:B2 1, 2'));
});

test('renderSheetHtml: minRows / minCols pad the extent up to a floor, never below it', () => {
  const small = computeWorkbook('---\nname: S\n---\nA1:B2 1, 2, 3, 4');
  const html = renderSheetHtml(small, small.sheets[0], { minRows: 50, minCols: 5 });
  assert.equal((html.match(/<th class="uf-ss-col/g) || []).length, 5, 'five columns for a 2-column sheet');
  assert.equal((html.match(/<tr [^>]*data-row=/g) || []).length, 50, 'fifty rows for a 2-row sheet');
  assert.ok(html.includes('data-addr="E50"'));
  // A formula out in column I at row 60 sets the extent past the floor.
  const wide = computeWorkbook('---\nname: S\n---\nA1 1\nI60 =A1*2');
  const h2 = renderSheetHtml(wide, wide.sheets[0], { minRows: 50, minCols: 5 });
  assert.equal((h2.match(/<th class="uf-ss-col/g) || []).length, 9, 'through column I');
  assert.equal((h2.match(/<tr [^>]*data-row=/g) || []).length, 60, 'through row 60');
  assert.ok(!h2.includes('data-addr="J1"'));
  // The static render (no floor) stays the bare extent.
  const bare = renderSheetHtml(small, small.sheets[0]);
  assert.equal((bare.match(/<th class="uf-ss-col/g) || []).length, 2);
  assert.equal((bare.match(/<tr [^>]*data-row=/g) || []).length, 2);
});

test('mergeRange over blank cells past the extent writes the merge and grows the extent', () => {
  const text = '---\nname: S\n---\nA1 x';
  const res = mergeRange(text, 0, { r1: 3, c1: 1, r2: 4, c2: 2 }, computeWorkbook(text));
  assert.ok(res.changes.length, 'a change');
  assert.ok(res.text.includes('B4:C5 {merge}'), res.text);
  const book = computeWorkbook(res.text);
  assert.equal(book.sheets[0].cols, 3);
  assert.equal(book.sheets[0].rows.length, 5);
  assert.equal(book.sheets[0].grid[3][1].colspan, 2);
});

test('an insert past the data, or a no-op merge, is no edit (a hand-written file is left as written)', () => {
  const text = '---\nname: S\n---\nA1:B2 1, 2, 3, 4';
  assert.equal(insertCols(text, 0, 5, 1).changes.length, 0);
  assert.equal(insertRows(text, 0, 10, 2).changes.length, 0);
  assert.equal(insertCols(text, 0, 1, 1).changes.length, 1, 'inside the data it is a real insert');
  const merged = '---\nname: S\n---\nA1:B1 a, b\nA1:B1 {merge}';
  assert.equal(mergeRange(merged, 0, { r1: 0, c1: 0, r2: 0, c2: 1 }).changes.length, 0);
});
