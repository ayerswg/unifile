import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAlignMarker, alignClass, ALIGN_MARKER_RE } from '../src/core/md-align.js';

test('splitAlignMarker strips a trailing {.align} marker', () => {
  assert.deepEqual(splitAlignMarker('Title {.center}'), { text: 'Title', align: 'center' });
  assert.deepEqual(splitAlignMarker('Title{.right}  '), { text: 'Title', align: 'right' });
  assert.deepEqual(splitAlignMarker('Title {.CENTRE}'), { text: 'Title', align: 'center' });
  assert.deepEqual(splitAlignMarker('Title {.left}'), { text: 'Title', align: 'left' });
  assert.deepEqual(splitAlignMarker('{.center} Title'), { text: '{.center} Title', align: null });
  assert.deepEqual(splitAlignMarker('Title {.bold}'), { text: 'Title {.bold}', align: null });
  assert.deepEqual(splitAlignMarker('line one<br>line two {.center}'), { text: 'line one<br>line two', align: 'center' });
  assert.deepEqual(splitAlignMarker(''), { text: '', align: null });
});

test('alignClass and the regex', () => {
  assert.equal(alignClass('center'), 'md-align-center');
  assert.equal(alignClass(null), '');
  assert.ok(ALIGN_MARKER_RE.test('x {.right}'));
  assert.ok(!ALIGN_MARKER_RE.test('x {.right} y'));
});
