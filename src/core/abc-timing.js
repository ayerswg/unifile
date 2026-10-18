/**
 * abc2svg's timing, in the app's terms.
 *
 * abc2svg draws the score; its player module (play-1.js) turns the very same
 * parsed tune — the time-sequenced symbol list `get_abcmodel` hands out — into
 * timed events: `ToAudio().add(tsfirst, voice_tb)` walks repeats, ties, grace
 * notes, tempo changes and `%%MIDI` program/control lines and emits one
 * `Float32Array` row per event:
 *
 *     [ istart, seconds, instr, midi, durationSeconds, volume, voiceIndex ]
 *
 *   note     instr ≥ 0, volume > 0  (a chord is one row per pitch, same istart)
 *   rest     instr = 0, midi = 0, volume = 0
 *   control  instr < 0: midi = the controller number (121 = reset), duration = value
 *
 * `istart` is the symbol's offset in the text abc2svg parsed — the same offset
 * the engraving's annotation rects carry — so a timed note and its drawn glyphs
 * are keyed alike, with no second parser to disagree. This module is pure (no
 * abc2svg import: it only reads the rows), Node-tested in test/abc-timing.test.mjs.
 */

/**
 * @typedef {object} TimedNote
 * @property {number} start   offset of the note's source token (content-relative)
 * @property {number} ms      onset, ms from the start of the tune
 * @property {number} durMs   sounding length, ms (ties already joined)
 * @property {number} midi    MIDI pitch (may carry a fraction for microtones)
 * @property {string} voice   the voice id as declared (`V:id`), '' when unnamed
 * @property {number} voiceIndex  score-order voice index
 * @property {number} instr   General MIDI program (bank << 7 | program)
 */

/**
 * Convert ToAudio's rows into notes / rests / controls with ms times.
 * @param {ArrayLike<number>[]} events  ToAudio's rows
 * @param {{ offset?: number, voices?: string[], graceStarts?: Set<number> }} [opts]
 *   `offset` is ADDED to every istart (pass −prefix.length when the parsed text
 *   carried an injected directive prefix; rows that then land before 0 — events
 *   from inside the prefix — are dropped); `voices` = voice ids by score index;
 *   `graceStarts` = the istarts (BEFORE the offset) of grace notes
 *   (`graceStartsOf`) — their rows become notes flagged `grace: true`.
 * @returns {{ notes: TimedNote[], rests: {start:number, ms:number, durMs:number, voice:string, voiceIndex:number}[],
 *             controls: {start:number, ms:number, ctrl:number, value:number, voiceIndex:number}[],
 *             totalMs: number, voices: string[] }}
 */
export function timingFromEvents(events, { offset = 0, voices = [], graceStarts = null } = {}) {
  const notes = [], rests = [], controls = [];
  let end = 0;
  for (const e of events ?? []) {
    if (!e || e.length < 7) continue;
    const istart = Math.round(e[0]);
    const start = istart + offset;
    if (start < 0) continue;
    const ms = Math.round(e[1] * 1000);
    const instr = e[2];
    const voiceIndex = e[6] | 0;
    const voice = voices[voiceIndex] != null ? String(voices[voiceIndex]) : '';
    if (instr < 0) {
      controls.push({ start, ms, ctrl: e[3] | 0, value: e[4], voiceIndex });
      continue;
    }
    const durMs = Math.max(0, Math.round(e[4] * 1000));
    if (e[5] > 0) {
      const note = { start, ms, durMs, midi: e[3], voice, voiceIndex, instr: instr | 0 };
      if (graceStarts?.has(istart)) note.grace = true;
      notes.push(note);
    } else {
      rests.push({ start, ms, durMs, voice, voiceIndex });
    }
    if (ms + durMs > end) end = ms + durMs;
  }
  const byTime = (a, b) => a.ms - b.ms || a.voiceIndex - b.voiceIndex || a.start - b.start || a.midi - b.midi;
  notes.sort(byTime);
  rests.sort((a, b) => a.ms - b.ms || a.voiceIndex - b.voiceIndex || a.start - b.start);
  controls.sort((a, b) => a.ms - b.ms || a.voiceIndex - b.voiceIndex);
  return { notes, rests, controls, totalMs: end, voices: voices.map(String) };
}

/** Distinct principal-note onsets (one per chord, per pass of a repeat; grace notes excluded). */
export function countOnsets(timing) {
  const seen = new Set();
  for (const n of timing.notes) if (!n.grace) seen.add(n.start + ':' + n.ms);
  return seen.size;
}

/**
 * The istarts of every grace note in a tune's time-sequenced model — abc2svg
 * keeps grace notes as the `extra` chain of a GRACE symbol, and ToAudio emits
 * each one as a row of its own (so they sound), while abcjs folds them into
 * their principal note. Walk the model BEFORE ToAudio (which relinks it).
 * @param {object|null} tsfirst  the first symbol of the model (`user.get_abcmodel`)
 * @param {object} C  `abc2svg.C` (the symbol type constants)
 * @returns {Set<number>}
 */
export function graceStartsOf(tsfirst, C) {
  const out = new Set();
  for (let s = tsfirst; s; s = s.ts_next) {
    if (s.type !== C.GRACE) continue;
    for (let g = s.extra; g; g = g.next) if (g.type === C.NOTE && g.istart != null) out.add(g.istart);
  }
  return out;
}
