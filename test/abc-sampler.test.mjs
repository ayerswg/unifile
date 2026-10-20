import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteName, nearestSample, scheduleWindow } from '../src/core/abc-sampler.js';

test('noteName: MIDI numbers → the soundfont\'s key names (flats, octave from C-1)', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'Db4');
  assert.equal(noteName(70), 'Bb4');
  assert.equal(noteName(21), 'A0');
  assert.equal(noteName(108), 'C8');
  assert.equal(noteName(59.6), 'C4');                                   // rounds
});

test('nearestSample: the key itself, else the nearest held key with the rate that re-pitches it', () => {
  const has = (n) => ['C4', 'E4'].includes(n);
  assert.deepEqual(nearestSample(60, has), { name: 'C4', rate: 1 });
  const d = nearestSample(62, has);                                     // D4: C4 and E4 are both 2 away; the lower wins
  assert.equal(d.name, 'C4');
  assert.ok(Math.abs(d.rate - Math.pow(2, 2 / 12)) < 1e-9);
  const dsharp = nearestSample(63, has);
  assert.equal(dsharp.name, 'E4');
  assert.ok(Math.abs(dsharp.rate - Math.pow(2, -1 / 12)) < 1e-9);
  // A quarter-tone rides on the rate.
  const q = nearestSample(60.5, has);
  assert.equal(q.name, 'C4');
  assert.ok(Math.abs(q.rate - Math.pow(2, 0.5 / 12)) < 1e-9);
  assert.equal(nearestSample(100, has), null);                          // more than an octave from anything
});

test('scheduleWindow: notes up to the horizon, skipping finished / muted / past-the-stop ones; a note across the start plays from its offset', () => {
  const notes = [
    { ms: 0, durMs: 1000, midi: 60, start: 0 },
    { ms: 500, durMs: 200, midi: 62, start: 3 },
    { ms: 800, durMs: 100, midi: 64, start: 6 },
    { ms: 1500, durMs: 500, midi: 65, start: 9 },
    { ms: 3000, durMs: 500, midi: 67, start: 12 },
  ];
  // Seek into the middle: the first note is already sounding, the second over.
  const w = scheduleWindow(notes, 0, { fromMs: 750, horizonMs: 2000 });
  assert.deepEqual(w.items.map(i => [i.note.midi, i.atMs, i.offsetMs, i.durMs]),
                   [[60, 750, 750, 250], [64, 800, 0, 100], [65, 1500, 0, 500]]);
  assert.equal(w.next, 4);                                              // the 3000 ms note waits for a later pass
  // The next pass continues from `next`.
  const w2 = scheduleWindow(notes, w.next, { fromMs: 750, horizonMs: 4000 });
  assert.deepEqual(w2.items.map(i => i.note.midi), [67]);
  assert.equal(w2.next, 5);
  // A range stop keeps notes at/after it out; muting by position too.
  const r = scheduleWindow(notes, 0, { fromMs: 0, horizonMs: 5000, stopMs: 1500, isMuted: (s) => s === 3 });
  assert.deepEqual(r.items.map(i => i.note.midi), [60, 64]);
  // Zero-length notes never schedule.
  assert.equal(scheduleWindow([{ ms: 0, durMs: 0, midi: 60, start: 0 }], 0, { fromMs: 0, horizonMs: 100 }).items.length, 0);
});
