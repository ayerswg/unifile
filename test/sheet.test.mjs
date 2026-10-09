import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpreadsheet, parseRange, formatRange, tokenizeArgs, quoteArg, cellAtOffset, usedExtent,
} from '../src/core/sheet/parse.js';
import {
  parseStyleProps, formatStyleProps, parseCondition, formatCondition, describeCondition, formatValue, parseColor, scaleColor, colorToRgb,
} from '../src/core/sheet/style.js';
import { computeWorkbook, viewRows, viewCols, cellDisplay } from '../src/core/sheet/book.js';
import {
  alignSpreadsheet, serializeModel, toModel, setCell, setCells, clearRange, insertRows, deleteRows, insertCols, deleteCols,
  shiftFormula, shiftRange, sortRows, mergeRange, unmergeRange, setStyle, addRule, removeRule, addScale, setComment,
  setWidth, setFreeze, setHidden, setSortView, setFilter, addSheet, renameSheet, deleteSheet, rangeHas,
} from '../src/core/sheet/edit.js';
import { renderSheetHtml, renderWorkbookHtml, sheetToCsv, workbookDocument } from '../src/core/sheet/render.js';
import { workbookToXlsx } from '../src/core/sheet/xlsx.js';

const BUDGET = `---
title: Budget
decimals: 2
---
# Budget

| Item   | Qty | Price | Total       |
|--------|----:|-------|-------------|
| Apples |   3 |  1.20 | =B*C        |
| Pears  |   2 |  0.80 | =B*C        |
| Plums  |     |  2.50 | =B*C        |
| Total  |     |       | =SUM(D2:D4) |

width A 18
merge A5:C5
style A1:D1 bold bg:#eef
style D format:$#,##0.00
if D2:D4 > 3 then bold color:green
if A2:A4 contains "pe" then bg:#fdd
scale B2:B4 #fff #1a8cf5
comment B2 "Market price, October"
sort D desc
filter B > 0
hide 3

Figures in USD.

# Other

| x | y            |
| 1 | =Budget!D5*2 |
`;

// ---------------------------------------------------------------------------
// Ranges & args
// ---------------------------------------------------------------------------

test('parseRange / formatRange: cells, ranges, whole columns and rows', () => {
  assert.deepEqual(parseRange('B3'), { r1: 2, c1: 1, r2: 2, c2: 1 });
  assert.deepEqual(parseRange('$B$3:A1'), { r1: 0, c1: 0, r2: 2, c2: 1 });
  assert.deepEqual(parseRange('A'), { r1: 0, c1: 0, r2: Infinity, c2: 0 });
  assert.deepEqual(parseRange('C:D'), { r1: 0, c1: 2, r2: Infinity, c2: 3 });
  assert.deepEqual(parseRange('3'), { r1: 2, c1: 0, r2: 2, c2: Infinity });
  assert.deepEqual(parseRange('3:5'), { r1: 2, c1: 0, r2: 4, c2: Infinity });
  assert.equal(parseRange('A1:C'), null);
  assert.equal(parseRange('bold'), null);
  assert.equal(parseRange(''), null);
  for (const s of ['B3', 'A1:B3', 'A', 'C:D', '3', '3:5']) assert.equal(formatRange(parseRange(s)), s);
});

test('tokenizeArgs: quotes, escapes, key:"value with spaces"', () => {
  const t = tokenizeArgs('B3 "Market price, \\"Oct\\"" format:"$#,##0 kg" bold');
  assert.deepEqual(t.map(x => x.text), ['B3', 'Market price, "Oct"', 'format:$#,##0 kg', 'bold']);
  assert.equal(t[1].quoted, true);
  assert.equal(quoteArg('plain'), 'plain');
  assert.equal(quoteArg('two words'), '"two words"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseSpreadsheet: sheets, header rows, directives, notes, inline spans', () => {
  const wb = parseSpreadsheet(BUDGET);
  assert.equal(wb.problems.length, 0);
  assert.equal(wb.sheets.length, 2);
  const [b, o] = wb.sheets;
  assert.equal(b.name, 'Budget');
  assert.equal(b.rows.length, 5);
  assert.equal(b.cols, 4);
  assert.equal(b.headerRows, 1);
  assert.deepEqual(b.aligns, [null, 'right', null, null]);
  assert.equal(b.widths.get(0), 18);
  assert.equal(b.merges.length, 1);
  assert.equal(b.grid[4][2], b.grid[4][0]);          // A5:C5 merged → anchor covers C5
  assert.equal(b.grid[4][0].colspan, 3);
  assert.equal(b.styles.length, 2);
  assert.equal(b.rules.length, 2);
  assert.equal(b.scales.length, 1);
  assert.deepEqual(b.comments[0], { r: 1, c: 1, text: 'Market price, October', from: b.comments[0].from, to: b.comments[0].to });
  assert.deepEqual(b.sorts, [{ col: 3, dir: 'desc' }]);
  assert.equal(b.filters[0].col, 1);
  assert.deepEqual([...b.hidden.rows], [2]);
  assert.deepEqual(b.notes.map(n => n.text), ['Figures in USD.']);
  assert.equal(o.name, 'Other');
  assert.equal(o.headerRows, 0);
  // Offsets are absolute: the cell text is at its range.
  const d2 = b.grid[1][3];
  assert.equal(BUDGET.slice(d2.from, d2.to), '=B*C');
  assert.equal(cellAtOffset(wb, d2.from + 1).cell, d2);
});

test('parseSpreadsheet: no heading = Sheet1; duplicate names get a suffix; `||`/`^^` spans', () => {
  const wb = parseSpreadsheet('| a | b |\n| 1 | 2 |\n# X\n| q |\n# X\n| r |\n');
  assert.deepEqual(wb.sheets.map(s => s.name), ['Sheet1', 'X', 'X 2']);
  assert.equal(wb.sheets[0].named, false);
  const sp = parseSpreadsheet('| a || c |\n| ^^ | x | y |\n').sheets[0];
  assert.equal(sp.grid[0][0].colspan, 2);
  assert.equal(sp.grid[0][0].rowspan, 2);
  assert.equal(sp.grid[1][0], sp.grid[0][0]);
  assert.equal(sp.grid[0][2].text, 'c');
});

test('parseSpreadsheet: problems are reported with offsets, parsing continues', () => {
  const wb = parseSpreadsheet('| a |\nstyle ZZZ9 bold\nmerge A\nif A1 > then bold\nif A1 nonsense then bold\nwidth A lots\ncomment A1:B2 "x"\nstyle A1 colour:red\n');
  const msgs = wb.problems.map(p => p.message);
  assert.ok(msgs.some(m => /merge: a merge needs a bounded range/.test(m)));
  assert.ok(msgs.some(m => /if: missing value|if: "": /.test(m)) || msgs.some(m => /^if:/.test(m)));
  assert.ok(msgs.some(m => /width: expected a number/.test(m)));
  assert.ok(msgs.some(m => /comment: expected a single cell/.test(m)));
  assert.ok(msgs.some(m => /unknown property "colour"/.test(m)));
  assert.equal(wb.sheets[0].rows.length, 1);
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
  assert.equal(formatStyleProps({ format: '#,##0 kg' }), 'format:"#,##0 kg"');
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
  assert.ok(c('> ').error);
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
  assert.equal(formatValue(true, '0'), 'TRUE');
});

test('colours and scales', () => {
  assert.equal(parseColor('#ABC'), '#abc');
  assert.equal(parseColor('Red'), 'red');
  assert.equal(parseColor('#12345'), null);
  assert.deepEqual(colorToRgb('#abc'), [170, 187, 204]);
  const sc = { min: 0, max: 10, rgb: [[0, 0, 0], [255, 255, 255]] };
  assert.equal(scaleColor(0, sc), '#000000');
  assert.equal(scaleColor(10, sc), '#ffffff');
  assert.equal(scaleColor(5, sc), '#808080');
});

// ---------------------------------------------------------------------------
// Computed workbook: values, resolved styles, view
// ---------------------------------------------------------------------------

test('computeWorkbook: values, display with formats, resolved styles incl. rules and scales', () => {
  const book = computeWorkbook(BUDGET);
  const b = book.sheets[0];
  assert.equal(book.display(b.grid[1][3]), '$3.60');
  assert.equal(book.display(b.grid[4][3]), '$5.20');
  assert.equal(book.display(b.grid[2][2]), '0.80');            // literal shows typed text
  assert.equal(book.sheets[1].cells[3].formula, 'Budget!D5*2');
  assert.equal(book.display(book.sheets[1].grid[1][1]), '10.40');  // decimals: 2 on a formula result
  const d2 = book.styleOf(b.grid[1][3]);
  assert.deepEqual(d2, { format: '$#,##0.00', bold: true, color: 'green' });   // rule fired (3.6 > 3)
  const d3 = book.styleOf(b.grid[2][3]);
  assert.deepEqual(d3, { format: '$#,##0.00' });                              // 1.6 — not
  assert.equal(book.styleOf(b.grid[1][0]).bg, undefined);    // "Apples" has no "pe"
  assert.equal(book.styleOf(b.grid[2][0]).bg, '#fdd');       // "Pears" contains "pe"
  assert.equal(book.styleOf(b.grid[3][0]).bg, undefined);    // "Plums"
  assert.equal(book.styleOf(b.grid[1][1]).bg, '#1a8cf5');    // scale max
  assert.equal(book.styleOf(b.grid[2][1]).bg, '#ffffff');    // scale min
  assert.deepEqual(book.staticStyleOf(b.grid[1][3]), { format: '$#,##0.00' });
  assert.deepEqual(book.styleOf(b.grid[0][0]), { bold: true, bg: '#eef' });
});

test('viewRows: header first, filter, sort (blanks last), hidden rows removed; viewCols hides columns', () => {
  const book = computeWorkbook(BUDGET);
  const b = book.sheets[0];
  // filter B > 0 drops Plums (blank qty) and Total; sort D desc: Apples (3.6) before Pears (1.6); row 3 (Pears) hidden.
  assert.deepEqual(viewRows(book, b), [0, 1]);
  const noHide = computeWorkbook(BUDGET.replace('hide 3\n', ''));
  assert.deepEqual(viewRows(noHide, noHide.sheets[0]), [0, 1, 2]);
  const sortOnly = computeWorkbook(BUDGET.replace('hide 3\n', '').replace('filter B > 0\n', ''));
  assert.deepEqual(viewRows(sortOnly, sortOnly.sheets[0]), [0, 4, 1, 2, 3]);   // 5.2, 3.6, 1.6, 0 (Plums =B*C → 0)
  const fcond = computeWorkbook('| a | b |\n| 1 | 2 |\n| 3 | 1 |\nfilter =B>A\n');
  assert.deepEqual(viewRows(fcond, fcond.sheets[0]), [0, 1]);   // no header: "b">"a" and 2>1 pass, 1>3 fails
  const fcond2 = computeWorkbook('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 1 |\nfilter =B>A\n');
  assert.deepEqual(viewRows(fcond2, fcond2.sheets[0]), [0, 1]);
  const hc = computeWorkbook('| a | b | c |\nhide B\n');
  assert.deepEqual(viewCols(hc.sheets[0]), [0, 2]);
});

test('cellDisplay: literal with a format shows the formatted number; text stays', () => {
  const cell = { text: '1200', formula: null, merged: false };
  assert.equal(cellDisplay(cell, 1200, { format: '#,##0' }), '1,200');
  assert.equal(cellDisplay({ text: "'=x", formula: null, merged: false }, '=x', {}), '=x');
  assert.equal(cellDisplay({ text: 'abc', formula: null, merged: false }, 'abc', { format: '0.00' }), 'abc');
});

// ---------------------------------------------------------------------------
// Serialization & edits
// ---------------------------------------------------------------------------

test('alignSpreadsheet is canonical and idempotent; front matter and notes survive', () => {
  const a = alignSpreadsheet(BUDGET);
  assert.equal(alignSpreadsheet(a), a);
  assert.ok(a.startsWith('---\ntitle: Budget\ndecimals: 2\n---\n# Budget\n\n| Item   | Qty | Price | Total       |\n|--------|----:|-------|-------------|'));
  assert.ok(a.includes('\nwidth A 18\nmerge A5:C5\nstyle A1:D1 bold bg:#eef\nstyle D format:$#,##0.00\nif D2:D4 > 3 then bold color:green\n'));
  assert.ok(a.includes('\nscale B2:B4 #fff #1a8cf5\ncomment B2 "Market price, October"\nsort D desc\nfilter B > 0\nhide 3\n\nFigures in USD.\n\n# Other\n'));
});

test('setCell / setCells / clearRange: grow the sheet, keep everything else', () => {
  let r = setCell('| a | b |\n', 0, 3, 4, 'x');
  assert.equal(r.text, '| a   | b   |     |     |     |\n|     |     |     |     |     |\n|     |     |     |     |     |\n|     |     |     |     | x   |\n');
  r = setCells(r.text, 0, 0, 0, [['1', '2'], ['=A*B', '']]);
  assert.ok(r.text.startsWith('| 1    | 2   |     |     |     |\n| =A*B |'));
  r = clearRange(r.text, 0, { r1: 3, c1: 4, r2: 3, c2: 4 });
  assert.equal(r.text.split('\n').length, 3);   // trailing empty rows and columns trimmed
  // An empty document: the first edit creates Sheet1.
  const first = setCell('', 0, 0, 0, 'hello');
  assert.equal(first.text, '# Sheet1\n\n| hello |\n');
  assert.equal(first.changes.length, 1);
  // Changes are in original coordinates.
  const src = '# S\n\n| a |\n';
  const c = setCell(src, 0, 0, 0, 'zz');
  assert.equal(c.changes[0].from, 0);
  assert.equal(c.changes[0].to, src.length - 1);
});

test('insertRows / deleteRows shift directives and formulas (other sheets too)', () => {
  const src = '# A\n\n| x | y |\n| 1 | =A*2 |\n| 2 | =SUM(B2:B3) |\n\nstyle A2:B3 bold\ncomment B3 "c"\nif B2:B3 > 1 then bold\n\n# B\n\n| =A!B3 | =SUM(A!B2:B3) |\n';
  const r = insertRows(src, 0, 1, 2);
  const t = r.text;
  assert.ok(t.includes('| x   | y           |\n|     |             |\n|     |             |\n|   1 | =A*2        |\n|   2 | =SUM(B4:B5) |'));
  assert.ok(t.includes('style A4:B5 bold'));
  assert.ok(t.includes('comment B5 c'));
  assert.ok(t.includes('if B4:B5 > 1 then bold'));
  assert.ok(t.includes('| =A!B5 | =SUM(A!B4:B5) |'));
  const d = deleteRows(t, 0, 3, 3);   // delete row 4 (the "1" row)
  assert.ok(d.text.includes('=SUM(B4:B4)'));
  assert.ok(d.text.includes('style A4:B4 bold'));
  assert.ok(!d.text.includes('comment B5'));   // comment B5 moved to B4
  assert.ok(d.text.includes('comment B4 c'));
  const d2 = deleteRows(d.text, 0, 3, 3);       // delete the last data row: the range is gone
  assert.ok(d2.text.includes('=SUM(#REF!)'));
  assert.ok(!d2.text.includes('style A4'));
});

test('insertCols / deleteCols shift bare-column refs, widths, sorts and filters', () => {
  const src = '| a | b | c |\n| 1 | 2 | =A*B |\n\nwidth B 12\nsort B asc\nfilter B > 0\nstyle B:C bold\nhide C\n';
  const r = insertCols(src, 0, 1, 1);
  assert.ok(r.text.includes('| =A*C |'));
  assert.ok(r.text.includes('width C 12'));
  assert.ok(r.text.includes('sort C asc'));
  assert.ok(r.text.includes('filter C > 0'));
  assert.ok(r.text.includes('style C:D bold'));
  assert.ok(r.text.includes('hide D'));
  const d = deleteCols(r.text, 0, 2, 2);   // delete the (moved) B column
  assert.ok(d.text.includes('=A*#REF!'));
  assert.ok(!d.text.includes('sort '));
  assert.ok(!d.text.includes('filter '));
  assert.ok(d.text.includes('style C bold'));
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
  const src = '| n | v |\n|---|---|\n| c | 3 |\n| a | 1 |\n| b | =A&"!" |\n\ncomment A3 "cc"\nheight 3 40\n';
  const book = computeWorkbook(src);
  const r = sortRows(src, 0, 0, 'asc', book);
  assert.ok(r.text.includes('| a   |      1 |\n| b   | =A&"!" |\n| c   |      3 |'));
  assert.ok(r.text.includes('comment A2 cc'));    // the comment was on "a" (row 3) → row 2
  assert.ok(r.text.includes('height 2 40'));
  const d = sortRows(src, 0, 1, 'desc', book);
  assert.ok(d.text.includes('| b   | =A&"!" |\n| c   |      3 |\n| a   |      1 |'));   // "b!" is text → before numbers in desc
  assert.ok(d.text.includes('comment A4 cc'));
});

test('mergeRange / unmergeRange', () => {
  let r = mergeRange('| a | b |\n| c | d |\n', 0, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.equal(r.text, '| a   |     |\n|     |     |\n\nmerge A1:B2\n');
  const wb = parseSpreadsheet(r.text);
  assert.equal(wb.sheets[0].grid[1][1], wb.sheets[0].grid[0][0]);
  r = unmergeRange(r.text, 0, { r1: 1, c1: 1, r2: 1, c2: 1 });
  assert.ok(!r.text.includes('merge'));
  assert.equal(mergeRange('| a |', 0, { r1: 0, c1: 0, r2: 0, c2: 0 }).changes.length, 0);
});

test('setStyle: merges into same-range lines, strips keys from inner lines, explicit off against wider lines', () => {
  let r = setStyle('| a | b |\n', 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true });
  assert.ok(r.text.trimEnd().endsWith('style A1:B1 bold'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { color: 'red' });
  assert.ok(r.text.trimEnd().endsWith('style A1:B1 bold color:red'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: false });
  assert.ok(r.text.trimEnd().endsWith('style A1:B1 bold color:red\nstyle A1 bold:off'));
  r = setStyle(r.text, 0, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: false });
  assert.ok(r.text.trimEnd().endsWith('style A1:B1 color:red'));   // inner A1 line emptied + dropped, bold stripped
  const book = computeWorkbook(r.text);
  assert.equal(rangeHas(book, book.sheets[0], { r1: 0, c1: 0, r2: 0, c2: 1 }, 'color'), true);
  assert.equal(rangeHas(book, book.sheets[0], { r1: 0, c1: 0, r2: 0, c2: 1 }, 'bold'), false);
});

test('rules, scales, comments, widths, freeze, hidden, view sort / filter', () => {
  let r = addRule('| 1 |\n| 2 |\n', 0, { r1: 0, c1: 0, r2: 1, c2: 0 }, { kind: 'cmp', op: '>', value: '1' }, { bold: true, bg: '#fdd' });
  assert.ok(r.text.trimEnd().endsWith('if A1:A2 > 1 then bold bg:#fdd'));
  r = addScale(r.text, 0, { r1: 0, c1: 0, r2: 1, c2: 0 }, ['#fff', '#000']);
  assert.ok(r.text.trimEnd().endsWith('if A1:A2 > 1 then bold bg:#fdd\nscale A1:A2 #fff #000'));
  r = removeRule(r.text, 0, 0);
  assert.ok(!r.text.includes('if '));
  r = setComment(r.text, 0, 0, 0, 'hello "there"\nsecond line');
  assert.ok(r.text.includes('comment A1 "hello \\"there\\" second line"'));
  assert.equal(parseSpreadsheet(r.text).sheets[0].comments[0].text, 'hello "there" second line');
  r = setComment(r.text, 0, 0, 0, '');
  assert.ok(!r.text.includes('comment'));
  r = setWidth(r.text, 0, 0, 2, 14);
  assert.ok(r.text.includes('width A:C 14'));
  r = setWidth(r.text, 0, 1, 1, 0);
  assert.ok(r.text.includes('width A 14\nwidth C 14'));
  r = setFreeze(r.text, 0, 1, 2);
  assert.ok(r.text.includes('freeze rows:1 cols:2'));
  r = setHidden(r.text, 0, 'row', 1, 1, true);
  assert.ok(r.text.includes('hide 2'));
  r = setSortView(r.text, 0, [{ col: 0, dir: 'desc' }]);
  assert.ok(r.text.includes('sort A desc'));
  r = setFilter(r.text, 0, 0, { kind: 'contains', text: 'x' });
  assert.ok(r.text.includes('filter A contains "x"'));
  r = setFilter(r.text, 0, 0, null);
  assert.ok(!r.text.includes('filter'));
});

test('addSheet / renameSheet (refs follow) / deleteSheet', () => {
  let r = addSheet('| a |\n', 'Q1 Sales');
  assert.equal(r.index, 1);
  assert.equal(r.text, '# Sheet1\n\n| a |\n\n# Q1 Sales\n\n|     |\n');
  r = setCell(r.text, 1, 0, 0, '=Sheet1!A1');
  r = renameSheet(r.text, 0, 'Costs');
  assert.ok(r.text.startsWith('# Costs\n'));
  assert.ok(r.text.includes("| =Costs!A1 |"));
  r = renameSheet(r.text, 1, 'Costs');   // a duplicate name is refused
  assert.equal(r.changes.length, 0);
  r = deleteSheet(r.text, 1);
  assert.equal(r.text, '# Costs\n\n| a |\n');
  assert.equal(deleteSheet(r.text, 0).changes.length, 0);   // the last sheet stays
});

// ---------------------------------------------------------------------------
// Rendering & exports
// ---------------------------------------------------------------------------

test('renderSheetHtml: rulers, spans, inline styles, offsets, view order', () => {
  const book = computeWorkbook(BUDGET);
  const html = renderSheetHtml(book, book.sheets[0]);
  assert.ok(html.includes('<th class="uf-ss-col" data-col="0">A'));
  const frozen = computeWorkbook(BUDGET.replace('width A 18', 'width A 18\nfreeze cols:1'));
  assert.ok(renderSheetHtml(frozen, frozen.sheets[0]).includes('<th class="uf-ss-col is-frozen" data-col="0">A'));
  assert.ok(html.includes('data-addr="D2"'));
  assert.ok(html.includes('font-weight:600;color:green'));
  assert.ok(html.includes('$3.60'));
  assert.ok(!html.includes('data-addr="A3"'));   // hidden row 3 / filtered rows are not drawn
  const all = renderSheetHtml(book, book.sheets[0], { view: false });
  assert.ok(all.includes('colspan="3"'));
  assert.ok(all.includes('has-comment'));
  assert.ok(renderWorkbookHtml(book).includes('<h2 class="uf-ss-name"'));
  assert.ok(workbookDocument(book, { title: 'T' }).startsWith('<!doctype html>'));
});

test('sheetToCsv: displayed values, merges blank', () => {
  const book = computeWorkbook(BUDGET);
  assert.equal(sheetToCsv(book, book.sheets[0]), 'Item,Qty,Price,Total\r\nApples,3,1.20,$3.60\r\nPears,2,0.80,$1.60\r\nPlums,,2.50,$0.00\r\nTotal,,,$5.20\r\n');
});

test('workbookToXlsx: a stored ZIP with styles, formulas, merges, cf rules, comments', () => {
  const book = computeWorkbook(BUDGET);
  const bytes = workbookToXlsx(book, { title: 'Budget' });
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.includes('xl/worksheets/sheet1.xml'));
  assert.ok(s.includes('xl/comments1.xml'));
  assert.ok(s.includes('<f>B2*C2</f>'));
  assert.ok(s.includes('<mergeCell ref="A5:C5"/>'));
  assert.ok(s.includes('<cfRule type="cellIs"'));
  assert.ok(s.includes('type="containsText"'));
  assert.ok(s.includes('<colorScale>'));
  assert.ok(s.includes('formatCode="$#,##0.00"'));
  assert.ok(s.includes('<pane ySplit="1"'));
  assert.ok(s.includes('<row r="3" hidden="1">'));
  assert.ok(s.includes('Market price, October'));
  // Rules are not baked into the static cell style: D2's font is not bold/green.
  assert.ok(!s.includes('<color rgb="FF008000"/>') || s.indexOf('<color rgb="FF008000"/>') > s.indexOf('<dxfs'));
});

test('usedExtent / toModel / serializeModel', () => {
  const wb = parseSpreadsheet('| a |  |\n|   |  |\n');
  assert.deepEqual(usedExtent(wb.sheets[0]), { rows: 1, cols: 1 });
  const m = toModel(wb.sheets[0]);
  assert.equal(serializeModel(m), '| a   |');
});
