import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDynamics, dynamicMarks, beatStress, DYNAMIC_LEVELS, DEFAULT_LEVEL, ACCENT_BUMP } from '../src/core/abc-dynamics.js';
import { timingFromEvents } from '../src/core/abc-timing.js';
import { engraveModel } from '../build/abc2svg-node.mjs';
import { expandAbc } from '../src/core/abc-shorthand.js';

const PREFIX = '%%linebreak $\n';
/** abc2svg's timing for `src`, with dynamics applied — exactly the app's path. */
function timed(src) {
  const ex = expandAbc(src).text;
  const r = engraveModel(PREFIX + ex);
  const timing = timingFromEvents(r.events, { offset: -PREFIX.length, voices: r.voices, graceStarts: r.graceStarts, syms: r.syms });
  applyDynamics(timing, ex, { meter: r.meter });
  return { ex, timing, byLetter: (ch, nth = 0) => timing.notes.filter(n => ex[n.start] === ch)[nth] };
}

test('dynamicMarks: levels, hairpins (both spellings), accents; anything else ignored', () => {
  const marks = dynamicMarks('!p! c !crescendo(! d !<)! e !>(! f !diminuendo)! !accent! g !trill! !sfz! a');
  assert.deepEqual(marks.map(m => m.kind), ['level', 'cresc(', 'cresc)', 'dim(', 'dim)', 'accent', 'accent']);
  assert.equal(marks[0].at, 0);
});

test('beatStress: first beat / beat / off-beat, compound meters, no meter', () => {
  const m44 = { num: 4, den: 4 };
  assert.equal(beatStress(0, m44), 0);
  assert.equal(beatStress(0.25, m44), 1);
  assert.equal(beatStress(0.125, m44), 2);
  assert.equal(beatStress(1.0, m44), 0);                                 // bar 2, beat 1
  assert.equal(beatStress(0.75, { num: 3, den: 4 }), 0);                 // 3/4: the bar is 3 quarters
  assert.equal(beatStress(3 / 8, { num: 6, den: 8 }), 1);                // 6/8 beats in dotted quarters
  assert.equal(beatStress(1 / 8, { num: 6, den: 8 }), 2);
  assert.equal(beatStress(0, null), 1);
  assert.equal(beatStress(undefined, m44), 1);
});

test('no marks: abcjs\'s default beat stress — 105 on the first beat, 95 on beats, 85 off the beat', () => {
  const { timing, byLetter } = timed('X:1\nM:4/4\nL:1/8\nK:C\nc d e f g a b c\' | C4 D4 |\n');
  assert.equal(byLetter('c').velocity, DEFAULT_LEVEL[0]);               // beat 1
  assert.equal(byLetter('d').velocity, DEFAULT_LEVEL[2]);               // off the beat
  assert.equal(byLetter('e').velocity, DEFAULT_LEVEL[1]);               // beat 2
  assert.equal(byLetter('C').velocity, DEFAULT_LEVEL[0]);               // bar 2, beat 1
  assert.equal(byLetter('D').velocity, DEFAULT_LEVEL[1]);
  assert.ok(timing.notes.every(n => n.velocity >= 1 && n.velocity <= 127));
});

test('a dynamic mark is sticky from its note on, per voice', () => {
  const { byLetter } = timed('X:1\nM:4/4\nL:1/4\nK:C\nV:1\n!pp! c d e f | !ff! g a b c\' |\nV:2\nC D E F | G A B C |\n');
  assert.equal(byLetter('c').velocity, DYNAMIC_LEVELS.pp[0]);
  assert.equal(byLetter('d').velocity, DYNAMIC_LEVELS.pp[1]);
  assert.equal(byLetter('g').velocity, DYNAMIC_LEVELS.ff[0]);           // bar 2, beat 1
  assert.equal(byLetter('a').velocity, DYNAMIC_LEVELS.ff[1]);
  // Voice 2 never saw a mark: defaults.
  assert.equal(byLetter('C').velocity, DEFAULT_LEVEL[0]);
  assert.equal(byLetter('E').velocity, DEFAULT_LEVEL[1]);
});

test('a hairpin ramps note by note toward the next mark; without one it moves by the span', () => {
  const { byLetter } = timed('X:1\nM:4/4\nL:1/4\nK:C\n!p! !crescendo(! c d e !crescendo)! f | !f! g a b c\' |\n');
  const vs = ['c', 'd', 'e', 'f'].map(ch => byLetter(ch).velocity);
  assert.ok(vs[0] < vs[1] && vs[1] < vs[2] && vs[2] < vs[3], `rises: ${vs}`);
  assert.equal(byLetter('g').velocity, DYNAMIC_LEVELS.f[0]);           // the target, reached and held
  assert.ok(Math.abs(vs[3] - DYNAMIC_LEVELS.f[1]) <= 12, `f lands near the target's beat level: ${vs[3]}`);
  // Diminuendo with no mark after: down by the span, floor 15.
  const dim = timed('X:1\nM:4/4\nL:1/4\nK:C\n!diminuendo(! c d e !diminuendo)! f |\n');
  const ds = ['c', 'd', 'e', 'f'].map(ch => dim.byLetter(ch).velocity);
  assert.ok(ds[0] > ds[1] && ds[1] > ds[2] && ds[2] > ds[3], `falls: ${ds}`);
});

test('accents bump one note: !accent!, !>!, the L shorthand, !sfz!', () => {
  const { byLetter } = timed('X:1\nM:4/4\nL:1/4\nK:C\n!accent! c !>! d Le f |\n');
  assert.equal(byLetter('c').velocity, DEFAULT_LEVEL[0] + ACCENT_BUMP);
  assert.equal(byLetter('d').velocity, DEFAULT_LEVEL[1] + ACCENT_BUMP);
  assert.equal(byLetter('e').velocity, DEFAULT_LEVEL[1] + ACCENT_BUMP);
  assert.equal(byLetter('f').velocity, DEFAULT_LEVEL[1]);
});

test('chords share one velocity; repeats replay the same velocity; grace notes take the soft level in force', () => {
  const { timing, byLetter, ex } = timed('X:1\nM:4/4\nL:1/4\nK:C\n|: !f! [ceg] {a}b c d :|\n');
  const chord = timing.notes.filter(n => ex[n.start] === '[');
  assert.equal(chord.length, 6);                                        // 3 pitches × 2 passes
  assert.ok(chord.every(n => n.velocity === chord[0].velocity));
  const bs = timing.notes.filter(n => ex[n.start] === 'b').map(n => n.velocity);
  assert.equal(bs.length, 2); assert.equal(bs[0], bs[1]);
  const grace = timing.notes.find(n => n.grace);
  assert.equal(grace.velocity, DYNAMIC_LEVELS.f[2]);
  assert.equal(byLetter('c', 0).velocity, DYNAMIC_LEVELS.f[1]);
});
