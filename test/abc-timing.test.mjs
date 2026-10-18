// abc2svg's timing (core/abc-timing.js) against abcjs's — the two engines
// {compose} runs. abc2svg draws the score; these tests pin down that the timed
// events its own player module derives from the SAME parse line up with the
// text, and that both engines agree on what sounds once the source has been
// through expandAbc (the one transform every engine call goes through).
//
// Pure Node: abc2svg loads from its CommonJS export and ToAudio is sliced out
// of play-1.js (build/abc2svg-node.mjs — the same slice the bundle carries).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { engraveModel } from '../build/abc2svg-node.mjs';
import { toAudioSource, MAX_STEPS } from '../build/abc2svg-toaudio.mjs';
import { timingFromEvents, countOnsets } from '../src/core/abc-timing.js';
import { expandAbc } from '../src/core/abc-shorthand.js';

const require = createRequire(import.meta.url);
const abcjs = require('abcjs');

const PREFIX = '%%linebreak $\n';          // what the app injects in front of every engraving

/** abc2svg: engrave the expanded text with the app's prefix → the app's timing table. */
function a2s(src) {
  const ex = expandAbc(src).text;
  const r = engraveModel(PREFIX + ex);
  return { ...r, ex, timing: timingFromEvents(r.events, { offset: -PREFIX.length, voices: r.voices, graceStarts: r.graceStarts }) };
}

/**
 * abcjs: the sounding source positions as the app sees them — `_engineParity`
 * reads `midiPitches[].startChar` off the timing events, which TimingCallbacks
 * copies from the note ELEMENTS after `setUpAudio` (grace notes ride on their
 * principal's element; an ornament keeps its principal; a rest has no pitch).
 */
function abcjsPositions(ex) {
  const tune = abcjs.parseOnly(ex)[0];
  tune.setUpAudio({});
  const starts = new Set();
  for (const line of tune.lines) for (const st of line.staff ?? []) for (const v of st.voices ?? []) {
    for (const el of v) {
      if (el.el_type !== 'note') continue;
      for (const p of el.midiPitches ?? []) if (p?.startChar != null) starts.add(p.startChar);
    }
  }
  return starts;
}

test('timingFromEvents: rows → notes / rests / controls in ms, prefix offset applied, prefix rows dropped', () => {
  const rows = [
    new Float32Array([0, 0, -1, 121, 0, 1, 0]),          // reset control from inside the prefix → dropped
    new Float32Array([20, 0.5, 0, 72, 0.25, 1, 0]),
    new Float32Array([20, 0.5, 0, 76, 0.25, 1, 0]),      // same chord
    new Float32Array([24, 0.75, 0, 0, 0.25, 0, 1]),      // a rest in voice 1
    new Float32Array([26, 1.0, -1, 7, 100, 1, 1]),       // CC7 in voice 1
    new Float32Array([14, 0, 0, 60, 0.5, 1, 1]),
  ];
  const t = timingFromEvents(rows, { offset: -10, voices: ['RH', 'LH'] });
  assert.deepEqual(t.notes.map(n => [n.start, n.ms, n.durMs, n.midi, n.voice]), [[4, 0, 500, 60, 'LH'], [10, 500, 250, 72, 'RH'], [10, 500, 250, 76, 'RH']]);
  assert.deepEqual(t.rests, [{ start: 14, ms: 750, durMs: 250, voice: 'LH', voiceIndex: 1 }]);
  assert.deepEqual(t.controls, [{ start: 16, ms: 1000, ctrl: 7, value: 100, voiceIndex: 1 }]);
  assert.equal(t.totalMs, 1000);
  assert.equal(countOnsets(t), 2);
  assert.deepEqual(t.voices, ['RH', 'LH']);
});

test('abc2svg timing: every note lands on its source token, voices by id, default tempo 120', () => {
  const src = 'X:1\nV:1 clef=treble\nV:2 clef=bass\n@1 cdef |\n@2 abcd |\n%\n@1 gabc |\n@2 defg |\n';
  const { timing, ex, errors } = a2s(src);
  assert.deepEqual(errors, []);
  assert.equal(timing.notes.length, 16);
  for (const n of timing.notes) assert.match(ex[n.start], /[a-g]/, `note at ${n.start} is "${ex[n.start]}"`);
  assert.deepEqual(timing.voices, ['1', '2']);
  assert.deepEqual([...new Set(timing.notes.map(n => n.voice))], ['1', '2']);
  // L:1/8 by default (no M:), Q absent → abc2svg's 120 bpm: an eighth = 250 ms, 8 eighths per voice.
  assert.deepEqual(timing.notes.filter(n => n.voice === '1').map(n => n.ms), [0, 250, 500, 750, 1000, 1250, 1500, 1750]);
  assert.equal(timing.notes[0].durMs, 250);
  assert.equal(timing.totalMs, 2000);
  assert.equal(timing.notes.find(n => ex[n.start] === 'c' && n.voice === '1').midi, 72);
});

test('abc2svg timing: ties join, chords share a start, rests are rests, repeats replay, grace notes sound', () => {
  const ties = a2s('X:1\nK:C\nc2-c2 | (d2 e2) | f4- | f4 |\n').timing;
  assert.equal(ties.notes.length, 4);                                   // c (tied), d, e, f (tied)
  assert.equal(ties.notes[0].durMs, 1000);                              // c2-c2 = a half note at 120
  const chords = a2s('X:1\nK:C\n[CEG]2 [DFA]2 | [ceg]4 |\n').timing;
  assert.equal(chords.notes.length, 9);
  assert.equal(countOnsets(chords), 3);
  const rests = a2s('X:1\nK:C\nc z d z2 | z4 |\n').timing;
  assert.equal(rests.notes.length, 2);
  assert.equal(rests.rests.length, 3);
  assert.equal(rests.totalMs, 2250);                                    // 9 eighths × 250 ms
  const rep = a2s('X:1\nK:C\n|: c d e f :| g4 a4 |]\n').timing;
  assert.equal(rep.notes.length, 10);                                   // cdef twice + g a
  assert.equal(countOnsets(rep), 10);
  assert.equal(new Set(rep.notes.map(n => n.start)).size, 6);          // but six source positions
  const grace = a2s('X:1\nK:C\n{g}a2 {ab}c2 | d4 |\n').timing;
  assert.equal(grace.notes.length, 6);                                  // three principals + three grace notes
  assert.equal(grace.notes.filter(n => n.grace).length, 3);
  assert.equal(countOnsets(grace), 3);
});

test('abc2svg timing: the step guard turns a never-ending repeat into a truncated list, not a hang', () => {
  const r = a2s('X:1\nK:C\n|: c d e f :| g a b c\' |1 d4 :|2 e4 |]\n');
  assert.equal(r.truncated, true);
  assert.ok(r.timing.notes.length > 1000 && r.timing.notes.length <= MAX_STEPS);
  // A well-formed first/second ending is fine.
  const ok = a2s('X:1\nK:C\n|: c d e f |1 g4 :|2 a4 |]\n');
  assert.equal(ok.truncated, false);
  assert.equal(ok.timing.notes.length, 10);
});

test('toAudioSource: the slice is the ToAudio function, with exactly one guarded walk', () => {
  const src = toAudioSource(require('node:fs').readFileSync(require.resolve('abc2svg/play-1.js'), 'utf8'));
  assert.ok(src.startsWith('function ToAudio'));
  assert.equal((src.match(/ToAudio\.truncated=true/g) ?? []).length, 1);
  assert.ok(!/Audio5|Midi5|document\./.test(src));
  assert.throws(() => toAudioSource('nothing here'), /cannot find function ToAudio/);
});

// ── Parity: both engines read the same tune (the check `_engineParity` runs in the app) ──

const PARITY = {
  'four voices with @id, % separators (the bug report, blank lines in the header)':
    'X:1\nT:Example Song\n\nV:1 clef=treble\nV:2 clef=bass\nV:3 clef=treble\nV:4 clef=bass\n\n@1 cdef |\n@2 abcd |\n@3 abcd |\n@4 a,,b,,c,,d,, |\n%\n@1 abcd |\n@2 bdef |\n%\n@1 abcd |\n@2 bdef |\n',
  'ties and slurs': 'X:1\nK:C\nc2-c2 | (d2 e2) | f4- | f4 |\n',
  'chords': 'X:1\nK:C\n[CEG]2 [DFA]2 | [ceg]4 |\n',
  'grace notes': 'X:1\nK:C\n{g}a2 {ab}c2 | d4 |\n',
  'repeats': 'X:1\nK:C\n|: c d e f :| g4 a4 |]\n',
  'first and second endings': 'X:1\nK:C\n|: c d e f |1 g4 :|2 a4 |]\n',
  'meter, unit length and tempo': 'X:1\nM:3/4\nL:1/8\nQ:1/4=90\nK:G\nGAB cde | fga b2 z2 |\n',
  'tuplets and broken rhythm': 'X:1\nK:C\n(3cde (3fga | b4 | c>d e<f |\n',
  'two V: voices': 'X:1\nK:C\nV:1\nc2 d2 e2 f2 | g4 a4 |\nV:2\nC4 D4 | E8 |\n',
  'ornaments (abcjs plays a trill as many notes, with no source position of their own)': 'X:1\nK:C\n!trill!c4 d4 | ~e2 .f2 g4 |\n',
  'no X: and no K: at all': 'V:1\nV:2\n@1 cdef |\n@2 CDEF |\n',
};

for (const [name, src] of Object.entries(PARITY)) {
  test(`parity: ${name}`, () => {
    const r = a2s(src);
    const drawn = [...new Set(r.timing.notes.filter(n => !n.grace).map(n => n.start))].sort((a, b) => a - b);
    const played = [...abcjsPositions(r.ex)].sort((a, b) => a - b);
    assert.ok(drawn.length > 0, 'abc2svg timed nothing');
    // The same NUMBER of sounding positions (what the app compares)…
    assert.equal(played.length, drawn.length, `abcjs ${played.length} vs abc2svg ${drawn.length}`);
    // …and each abcjs position sits on or shortly before abc2svg's: abcjs's
    // startChar is the start of the whole token (a leading `(`, `!deco!` or
    // space included — the landmine CLAUDE.md records), abc2svg's istart is the
    // note letter itself.
    for (let i = 0; i < drawn.length; i++) {
      assert.ok(played[i] <= drawn[i] && drawn[i] - played[i] <= 12, `note ${i}: abcjs ${played[i]} (${JSON.stringify(r.ex.slice(played[i], played[i] + 4))}) vs abc2svg ${drawn[i]} (${JSON.stringify(r.ex.slice(drawn[i], drawn[i] + 4))})`);
    }
  });
}

test('parity: the header blank lines are what made abcjs read an empty tune', () => {
  const src = PARITY['four voices with @id, % separators (the bug report, blank lines in the header)'];
  // Through expandAbc (the app's path) both engines read 32 notes…
  const r = a2s(src);
  assert.equal(r.timing.notes.length, 32);
  assert.equal(abcjsPositions(r.ex).size, 32);
  assert.deepEqual(r.errors, []);                                       // abc2svg no longer warns either
  // …while the raw text, as the user wrote it, gives abcjs a title and nothing else.
  const raw = src.replace(/^@(\w+) /gm, '[V:$1] ');
  assert.equal(abcjsPositions(raw).size, 0);
  assert.match(engraveModel(PREFIX + raw).errors.join('\n'), /Empty line in tune header/);
});

test('parity: a blank line in the BODY ends the tune for both engines alike', () => {
  const src = 'X:1\nK:C\ncdef |\n\nabcd |\n';
  const r = a2s(src);
  assert.equal(r.timing.notes.length, 4);
  assert.equal(abcjsPositions(r.ex).size, 4);
  assert.deepEqual(expandAbc(src).blanks.map(b => b.where), ['body']);
});
