import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midiFileFromTiming, MIDI_PPQ } from '../src/core/midi-file.js';
import { timingFromEvents } from '../src/core/abc-timing.js';
import { engraveModel } from '../build/abc2svg-node.mjs';
import { expandAbc } from '../src/core/abc-shorthand.js';

/** A tiny SMF reader: header + per-track events (delta ticks + bytes), enough to check our writer. */
function readMidi(bytes) {
  const b = bytes; let i = 0;
  const str = (n) => { const s = String.fromCharCode(...b.slice(i, i + n)); i += n; return s; };
  const u32 = () => { const v = (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0; i += 4; return v; };
  const u16 = () => { const v = b[i] << 8 | b[i + 1]; i += 2; return v; };
  const vlq = () => { let v = 0; for (;;) { const c = b[i++]; v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) return v; } };
  assert.equal(str(4), 'MThd'); assert.equal(u32(), 6);
  const format = u16(), ntrks = u16(), ppq = u16();
  const tracks = [];
  for (let t = 0; t < ntrks; t++) {
    assert.equal(str(4), 'MTrk'); const len = u32(); const end = i + len;
    const evs = []; let tick = 0;
    while (i < end) {
      tick += vlq();
      const st = b[i++];
      if (st === 0xff) { const type = b[i++]; const n = vlq(); const data = b.slice(i, i + n); i += n; evs.push({ tick, meta: type, data }); }
      else { const hi = st & 0xf0; const n = (hi === 0xC0 || hi === 0xD0) ? 1 : 2; evs.push({ tick, status: st, d1: b[i], d2: n === 2 ? b[i + 1] : undefined }); i += n; }
    }
    assert.equal(i, end);
    tracks.push(evs);
  }
  return { format, ppq, tracks };
}

const PREFIX = '%%linebreak $\n';
function timingOf(src) {
  const ex = expandAbc(src).text;
  const r = engraveModel(PREFIX + ex);
  return timingFromEvents(r.events, { offset: -PREFIX.length, voices: r.voices, graceStarts: r.graceStarts, syms: r.syms });
}

test('midiFileFromTiming: format 1, a tempo track, one track per voice with program + name, one tick per ms', () => {
  const t = timingOf('X:1\nK:C\nV:1\n%%MIDI program 40\nc2 d2 |\nV:2\nC4 |\n');
  const m = readMidi(midiFileFromTiming(t, { title: 'Two voices' }));
  assert.equal(m.format, 1);
  assert.equal(m.ppq, MIDI_PPQ);
  assert.equal(m.tracks.length, 3);
  // Track 0: title + tempo 500 000 µs/♩ (so a tick is a millisecond) + end.
  assert.deepEqual(m.tracks[0].map(e => e.meta), [0x03, 0x51, 0x2f]);
  assert.deepEqual([...m.tracks[0][1].data], [0x07, 0xa1, 0x20]);
  // Voice 1 (channel 0): name, program 40, then c2 d2 as on/off pairs at ms ticks.
  const v1 = m.tracks[1];
  assert.equal(String.fromCharCode(...v1[0].data), 'Voice 1');
  assert.deepEqual([v1[1].status, v1[1].d1], [0xC0, 40]);
  const notes = v1.filter(e => e.status !== undefined && (e.status & 0xf0) !== 0xC0).map(e => [e.tick, e.status, e.d1, e.d2]);
  assert.deepEqual(notes, [[0, 0x90, 72, 95], [500, 0x80, 72, 0], [500, 0x90, 74, 95], [1000, 0x80, 74, 0]]);
  // Voice 2 (channel 1): C4 — four eighths (no M: → L:1/8), a half note, 1000 ms at ♩ = 120.
  const v2 = m.tracks[2].filter(e => e.status !== undefined && (e.status & 0xf0) !== 0xC0).map(e => [e.tick, e.status, e.d1]);
  assert.deepEqual(v2, [[0, 0x91, 60], [1000, 0x81, 60]]);
});

test('midiFileFromTiming: a note off never lands after the next on of the same tick; channel 9 is skipped; empty timing is a valid file', () => {
  const t = timingOf('X:1\nK:C\nc d e f |\n');
  const m = readMidi(midiFileFromTiming(t));
  const ev = m.tracks[1].filter(e => e.status !== undefined && (e.status & 0xf0) !== 0xC0);
  for (let i = 1; i < ev.length; i++) {
    if (ev[i].tick === ev[i - 1].tick) assert.ok((ev[i - 1].status & 0xf0) === 0x80 || (ev[i].status & 0xf0) !== 0x80, 'off before on');
  }
  // Eleven voices → channels 0..8, 10, 11 (9 reserved for percussion).
  const many = { notes: Array.from({ length: 11 }, (_, vi) => ({ start: vi, end: vi + 1, ms: 0, durMs: 100, midi: 60, voice: String(vi + 1), voiceIndex: vi, instr: 0 })), rests: [], controls: [], totalMs: 100, voices: [] };
  const mm = readMidi(midiFileFromTiming(many));
  const chans = mm.tracks.slice(1).map(tr => tr.find(e => e.status !== undefined).status & 0x0f);
  assert.deepEqual(chans, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
  const empty = readMidi(midiFileFromTiming({ notes: [], rests: [], controls: [], totalMs: 0, voices: [] }));
  assert.equal(empty.tracks.length, 1);
});
