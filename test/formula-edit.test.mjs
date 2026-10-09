import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanFormula, operandSlotAt, completionAt, signatureAt, acceptCompletion, insertRef, refText, formulaRefs,
} from '../src/core/sheet/formula-edit.js';
import { FN_PARAMS, functionSignature, FN_DETAIL } from '../src/core/tables/formula-help.js';
import { FUNCTION_NAMES } from '../src/core/tables/formula.js';

test('every function has a signature and a description', () => {
  for (const n of FUNCTION_NAMES) {
    assert.ok(FN_PARAMS[n], `${n} has no signature`);
    assert.ok(FN_DETAIL[n], `${n} has no description`);
  }
  assert.equal(functionSignature('sum'), 'SUM(number1, [number2], …)');
  assert.equal(functionSignature('PI'), 'PI()');
  assert.equal(functionSignature('NOPE'), 'NOPE(…)');
});

test('scanFormula: strings and the open-call stack', () => {
  assert.deepEqual(scanFormula('=SUM(A1, "x,(y"', 16), { inString: false, stack: [{ name: 'SUM', nameFrom: 1, open: 4, arg: 1 }] });
  assert.equal(scanFormula('=SUM("ab', 7).inString, true);
  assert.equal(scanFormula('=SUM("a""b', 9).inString, true);          // "" is an escaped quote, still inside
  assert.deepEqual(scanFormula('=IF(1,(2+', 9).stack.map(f => [f.name, f.arg]), [['IF', 1], [null, 0]]);
  assert.deepEqual(scanFormula('=IF(1,(2)+3,', 12).stack.map(f => [f.name, f.arg]), [['IF', 2]]);
});

test('operandSlotAt: where a pointed reference goes', () => {
  assert.deepEqual(operandSlotAt('=', 1), { from: 1, to: 1 });
  assert.deepEqual(operandSlotAt('=SUM(', 5), { from: 5, to: 5 });
  assert.deepEqual(operandSlotAt('=SUM(A1, ', 9), { from: 9, to: 9 });
  assert.deepEqual(operandSlotAt('=A1+', 4), { from: 4, to: 4 });
  assert.deepEqual(operandSlotAt('=A1:', 4), { from: 4, to: 4 });
  assert.equal(operandSlotAt('=A1', 3), null);                          // a typed reference: a click commits
  assert.equal(operandSlotAt('=SUM(A1)', 8), null);
  assert.equal(operandSlotAt('=12', 3), null);
  assert.equal(operandSlotAt('12', 2), null);                            // not a formula
  assert.equal(operandSlotAt('=', 0), null);                             // caret before the =
  assert.equal(operandSlotAt('=SUM("a', 7), null);                       // inside a string
  // A reference just pointed stays the slot while the caret sits at its end…
  assert.deepEqual(operandSlotAt('=SUM(A1', 7, { pointed: { from: 5, to: 7 } }), { from: 5, to: 7 });
  // …but not once the caret moved.
  assert.equal(operandSlotAt('=SUM(A1', 6, { pointed: { from: 5, to: 7 } }), null);
  // A selected run of the formula is replaced.
  assert.deepEqual(operandSlotAt('=SUM(A1:B2)', 5, { selEnd: 10 }), { from: 5, to: 10 });
});

test('completionAt: function names at an operand position', () => {
  assert.equal(completionAt('=', 1), null);
  const c = completionAt('=su', 3);
  assert.equal(c.from, 1); assert.equal(c.to, 3); assert.equal(c.query, 'SU');
  assert.deepEqual(c.options.map(o => o.name), ['SUBSTITUTE', 'SUM', 'SUMIF', 'SUMPRODUCT']);
  assert.equal(c.options[1].detail, 'add numbers');
  assert.equal(c.options[1].signature, 'SUM(number1, [number2], …)');
  // Prefix matches first, then names containing the letters.
  assert.deepEqual(completionAt('=ROUN', 5).options.map(o => o.name), ['ROUND', 'ROUNDDOWN', 'ROUNDUP']);
  assert.deepEqual(completionAt('=OUN', 4).options.map(o => o.name), ['COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'ROUND', 'ROUNDDOWN', 'ROUNDUP']);
  // Inside an argument, after an operator, after a comma.
  assert.equal(completionAt('=SUM(A1, av', 11).options[0].name, 'AVERAGE');
  assert.equal(completionAt('=A1+ma', 6).options[0].name, 'MATCH');
  // Not for references, not mid-literal, not in strings, not after an operand.
  assert.equal(completionAt('=A1', 3), null);
  assert.equal(completionAt('=$A$1', 5), null);
  assert.equal(completionAt('=SUM(A1 su', 10), null);
  assert.equal(completionAt('="su', 4), null);
  assert.equal(completionAt('=1su', 4), null);
  assert.equal(completionAt('=zzz', 4), null);
  assert.equal(completionAt('sum', 3), null);
  // The caret mid-word still completes the word before it.
  assert.deepEqual(completionAt('=SUM(A1)', 3), { ...completionAt('=SUM(A1)', 3), from: 1, to: 3 });
});

test('acceptCompletion replaces the word with NAME(', () => {
  const c = completionAt('=su+1', 3);
  assert.deepEqual(acceptCompletion('=su+1', c, 'SUM'), { text: '=SUM(+1', caret: 5 });
});

test('signatureAt: the innermost call and the current argument', () => {
  assert.equal(signatureAt('=A1+1', 5), null);
  assert.deepEqual(signatureAt('=SUM(', 5), { name: 'SUM', argIndex: 0, params: ['number1', '[number2]', '…'], current: 0, signature: 'SUM(number1, [number2], …)' });
  assert.equal(signatureAt('=SUM(A1,B1,', 11).current, 2);                     // variadic: the … stays marked
  assert.equal(signatureAt('=SUM(A1,B1,C1,D1,', 17).current, 2);
  assert.equal(signatureAt('=IF(A1>2, SUM(B1,', 17).name, 'SUM');
  assert.equal(signatureAt('=IF(A1>2, SUM(B1),', 18).name, 'IF');
  assert.equal(signatureAt('=IF(A1>2, SUM(B1),', 18).current, 2);
  assert.equal(signatureAt('=IF(1,2,3,', 10).current, -1);                     // past the last argument
  assert.equal(signatureAt('=SUM((A1+', 9).name, 'SUM');                       // a grouping paren inside
  assert.equal(signatureAt('=SUM(A1)', 8), null);                              // closed
  assert.equal(signatureAt('=FOO(', 5).params, null);
  assert.equal(signatureAt('=FOO(', 5).signature, 'FOO(…)');
});

test('insertRef and refText', () => {
  assert.deepEqual(insertRef('=SUM(', { from: 5, to: 5 }, 'A1'), { text: '=SUM(A1', slot: { from: 5, to: 7 } });
  assert.deepEqual(insertRef('=SUM(A1)', { from: 5, to: 7 }, 'B2:C3'), { text: '=SUM(B2:C3)', slot: { from: 5, to: 10 } });
  assert.equal(refText({ r1: 2, c1: 1, r2: 2, c2: 1 }), 'B3');
  assert.equal(refText({ r1: 1, c1: 1, r2: 3, c2: 3 }), 'B2:D4');
  assert.equal(refText({ r1: 0, c1: 1, r2: Infinity, c2: 1 }), 'B:B');
  assert.equal(refText({ r1: 0, c1: 1, r2: Infinity, c2: 3 }), 'B:D');
  assert.equal(refText({ r1: 2, c1: 0, r2: 2, c2: Infinity }), '3:3');
  assert.equal(refText({ r1: 2, c1: 0, r2: 4, c2: Infinity }), '3:5');
});

test('formulaRefs: every reference, keyed for colours', () => {
  const refs = formulaRefs('=SUM(A1:B2)+Budget!D4+\'Q1 Sales\'!A1+B*C+3:5+$A$1+LOG10(2)+"A1"+B:D+TRUE+PI()');
  assert.deepEqual(refs.map(r => [r.text, r.kind]), [
    ['A1:B2', 'range'], ['Budget!D4', 'sheet'], ["'Q1 Sales'!A1", 'sheet'], ['B', 'col'], ['C', 'col'], ['3:5', 'range'], ['$A$1', 'range'], ['B:D', 'range'],
  ]);
  assert.deepEqual(refs[0].R, { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.deepEqual(refs[3].R, { c: 1 });
  assert.deepEqual(refs[5].R, { r1: 2, c1: 0, r2: 4, c2: Infinity });
  assert.deepEqual(refs[6], { from: 44, to: 48, text: '$A$1', key: 'A1', kind: 'range', R: { r1: 0, c1: 0, r2: 0, c2: 0 } });
  assert.deepEqual(refs[7].R, { r1: 0, c1: 1, r2: Infinity, c2: 3 });
  assert.deepEqual(formulaRefs('=1.5+2e3'), []);
  assert.deepEqual(formulaRefs('A1'), []);
  assert.deepEqual(formulaRefs('=a1:b2').map(r => r.key), ['A1:B2']);      // lower case counts, normalised key
});
