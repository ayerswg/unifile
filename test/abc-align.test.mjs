import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignAbcVoices, splitMeasures } from '../src/dsl/abc-align.js';

test('splitMeasures: one entry per measure, barline attached to its measure', () => {
  assert.deepEqual(splitMeasures('CDEF GABc | cBAG FEDC | CDEF GABc |'),
    ['CDEF GABc |', 'cBAG FEDC |', 'CDEF GABc |']);
});

test('splitMeasures: a leading barline opens the first measure', () => {
  assert.deepEqual(splitMeasures('|: A B | C D :|'), ['|: A B |', 'C D :|']);
  assert.deepEqual(splitMeasures('[| A B | C D |]'), ['[| A B |', 'C D |]']);
});

test('splitMeasures: trailing pickup without a barline is its own measure', () => {
  assert.deepEqual(splitMeasures('A B | C D | E'), ['A B |', 'C D |', 'E']);
});

test('splitMeasures: inner whitespace is normalised, beaming spaces kept', () => {
  assert.deepEqual(splitMeasures('  AB   cd|  ef gh  |'), ['AB cd |', 'ef gh |']);
});

test('splitMeasures: inline voice field stays with its first measure', () => {
  assert.deepEqual(splitMeasures('[V:1] A B | C D |'), ['[V:1] A B |', 'C D |']);
});

test('alignAbcVoices (flow, the default): one measure per line, no continuations', () => {
  const src = 'X:1\nL:1/8\nK:C\nCDEF GABc | cBAG FEDC | CDEF GABc |\nGABc cBAG | CDEF GABc |\n';
  const want = 'X:1\nL:1/8\nK:C\nCDEF GABc |\ncBAG FEDC |\nCDEF GABc |\nGABc cBAG |\nCDEF GABc |\n';
  assert.equal(alignAbcVoices(src), want);
});

test('alignAbcVoices (%%linebreak <EOL>): staff-line breaks kept via continuation', () => {
  const src = '%%linebreak <EOL>\nX:1\nL:1/8\nK:C\nCDEF GABc | cBAG FEDC | CDEF GABc |\nGABc cBAG | CDEF GABc |\n';
  const want = '%%linebreak <EOL>\nX:1\nL:1/8\nK:C\nCDEF GABc | \\\ncBAG FEDC | \\\nCDEF GABc |\nGABc cBAG | \\\nCDEF GABc |\n';
  assert.equal(alignAbcVoices(src), want);
});

test('alignAbcVoices (flow): a lyric line keeps its music line joined', () => {
  const src = 'X:1\nK:C\nA B | C D |\nw: la la la la\nE F | G A |\n';
  assert.equal(alignAbcVoices(src), 'X:1\nK:C\nA B | \\\nC D |\nw: la la la la\nE F |\nG A |\n');
  assert.equal(alignAbcVoices(alignAbcVoices(src)), alignAbcVoices(src));
});

test('alignAbcVoices: the @id voice prefix stays with its first measure', () => {
  const src = 'X:1\nK:C\n@1 A2 B2 | c2 d2 |\n@2 F2 G2 | A2 B2 |\n';
  assert.equal(alignAbcVoices(src), 'X:1\nK:C\n@1 A2 B2 |\nc2 d2 |\n@2 F2 G2 |\nA2 B2 |\n');
  assert.deepEqual(splitMeasures('@RH A B | C D |'), ['@RH A B |', 'C D |']);
});

test('alignAbcVoices: idempotent', () => {
  const src = 'X:1\nK:C\n|: A B | C D | E F :|\nw: la la\n';
  const once = alignAbcVoices(src);
  assert.equal(alignAbcVoices(once), once);
});

test('alignAbcVoices: a line that already continues keeps continuing', () => {
  const src = 'X:1\nK:C\nA B | C D | \\\nE F |\n';
  assert.equal(alignAbcVoices(src), 'X:1\nK:C\nA B | \\\nC D | \\\nE F |\n');
});

test('alignAbcVoices: fields, comments, lyrics, shebangs and front matter pass through', () => {
  const src = '---\ntitle: T | x\n---\n#!abcjs\nX:1\n% a | comment\nV:1\nK:C\nA B | C D |\nw: do re | mi fa\n';
  assert.equal(alignAbcVoices(src),
    '---\ntitle: T | x\n---\n#!abcjs\nX:1\n% a | comment\nV:1\nK:C\nA B | \\\nC D |\nw: do re | mi fa\n');
  // The same without lyrics: nothing to chain in flow mode.
  assert.equal(alignAbcVoices('X:1\nK:C\nA B | C D |\n'), 'X:1\nK:C\nA B |\nC D |\n');
});

test('alignAbcVoices: a line with a single measure is left alone', () => {
  const src = 'X:1\nK:C\nA B C D |\n';
  assert.equal(alignAbcVoices(src), src);
});
