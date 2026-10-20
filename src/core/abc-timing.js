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
 * are keyed alike, with no second parser to disagree.
 *
 * Three views of one tune come out of here, all pure (no abc2svg import — the
 * functions only read the rows and the model's plain fields), Node-tested in
 * test/abc-timing.test.mjs:
 *   • `timingFromEvents`  — notes / rests / controls with ms times (+ the written
 *     length, the text extent and the tempo from `modelInfo`);
 *   • `momentsFromTiming` — the table abcjs.js's transport, cursor, highlight,
 *     seek, audition, piano roll and Web MIDI paths read (abcjs's noteTimings
 *     shape, so every consumer kept working when the source engine changed);
 * The sampler plays `timing.notes` directly — the piano (core/abc-sampler.js)
 * reads `ms`, `durMs`, `midi`, `velocity` (core/abc-dynamics.js) and `start`.
 */

/**
 * @typedef {object} TimedNote
 * @property {number} start   offset of the note's source token (content-relative)
 * @property {number} end     end of that token (content-relative; `start + 1` when unknown)
 * @property {number} ms      onset, ms from the start of the tune
 * @property {number} durMs   sounding length, ms (ties already joined)
 * @property {number} durWhole  the sounding length in whole notes
 * @property {number} msPerWhole  the tempo in force at the note (ms per whole note)
 * @property {number} midi    MIDI pitch (may carry a fraction for microtones)
 * @property {string} voice   the voice id as declared (`V:id`), '' when unnamed
 * @property {number} voiceIndex  score-order voice index
 * @property {number} instr   General MIDI program (bank << 7 | program)
 * @property {boolean} [grace]  a grace note (abcjs folds these into their principal)
 */

const DEFAULT_MS_PER_WHOLE = 2000;   // abc2svg's default: ♩ = 120 → a whole note is 2 s

/**
 * What the time-sequenced model says about each symbol, read BEFORE ToAudio
 * runs (it relinks grace-note timing in place): the text extent, the written
 * length, the tempo in force, which istarts are grace notes, and the meter.
 * Mirrors ToAudio's own tempo rule (`play_factor`), so the ms per whole note
 * attached here is exactly what its seconds were computed with.
 * @param {object|null} tsfirst  the first symbol (`user.get_abcmodel`)
 * @param {object} C  `abc2svg.C` (symbol type constants + BLEN)
 * @param {object[]} [voice_tb]  the voices (`user.get_abcmodel`'s second argument):
 *   the tune's meter is the first voice's `meter.a_meter` (meter changes stay out —
 *   consumers want ONE meter fraction per tune, as abcjs reports it)
 * @returns {{ syms: Map<number, {end:number, dur:number, msPerWhole:number, rest:boolean}>,
 *             graceStarts: Set<number>, meter: {num:number, den:number}|null, blen: number }}
 */
export function modelInfo(tsfirst, C, voice_tb = null) {
  const syms = new Map();
  const graceStarts = new Set();
  let meter = null;
  const BLEN = C.BLEN || 1536;
  const am = voice_tb?.[0]?.meter?.a_meter;
  if (Array.isArray(am) && am.length) {
    const top = String(am[0].top ?? ''), bot = String(am[0].bot ?? '');
    if (/^\d+$/.test(top)) meter = { num: parseInt(top, 10) || 4, den: /^\d+$/.test(bot) ? parseInt(bot, 10) || 4 : 4 };
    else if (top === 'C' || top === 'C|') meter = top === 'C' ? { num: 4, den: 4 } : { num: 2, den: 2 };
  }
  let playFactor = BLEN / 4 * 120 / 60;              // BLEN units per second at ♩ = 120
  const put = (s, rest) => {
    if (s.istart == null) return;
    syms.set(s.istart, {
      end: s.iend != null && s.iend > s.istart ? s.iend : s.istart + 1,
      dur: s.dur ?? 0,
      msPerWhole: 1000 * BLEN / playFactor,
      timeWhole: (s.time ?? 0) / BLEN,      // the WRITTEN position (repeats share it) — the beat stress reads it
      rest,
    });
  };
  for (let s = tsfirst; s; s = s.ts_next) {
    if (s.tempo && Array.isArray(s.tempo_notes) && s.tempo_notes.length) {
      let d = 0;
      for (const n of s.tempo_notes) d += n;
      if (d > 0 && s.tempo > 0) playFactor = d * s.tempo / 60;
    }
    switch (s.type) {
      case C.NOTE: put(s, false); break;
      case C.REST: put(s, true); break;
      case C.GRACE:
        for (let g = s.extra; g; g = g.next) {
          if (g.type !== C.NOTE || g.istart == null) continue;
          graceStarts.add(g.istart);
          put(g, false);
        }
        break;
      default: break;
    }
  }
  return { syms, graceStarts, meter, blen: BLEN };
}

/** The istarts of every grace note (see modelInfo). */
export function graceStartsOf(tsfirst, C) {
  return modelInfo(tsfirst, C).graceStarts;
}

/**
 * Convert ToAudio's rows into notes / rests / controls with ms times.
 * @param {ArrayLike<number>[]} events  ToAudio's rows
 * @param {{ offset?: number, voices?: string[], graceStarts?: Set<number>,
 *           syms?: Map<number, {end:number, dur:number, msPerWhole:number}>, blen?: number }} [opts]
 *   `offset` is ADDED to every istart (pass −prefix.length when the parsed text
 *   carried an injected directive prefix; rows that then land before 0 — events
 *   from inside the prefix — are dropped); `voices` = voice ids by score index;
 *   `graceStarts` / `syms` come from `modelInfo` (istarts BEFORE the offset).
 * @returns {{ notes: TimedNote[],
 *             rests: {start:number, end:number, ms:number, durMs:number, msPerWhole:number, voice:string, voiceIndex:number}[],
 *             controls: {start:number, ms:number, ctrl:number, value:number, voiceIndex:number}[],
 *             totalMs: number, voices: string[] }}
 */
export function timingFromEvents(events, { offset = 0, voices = [], graceStarts = null, syms = null } = {}) {
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
    const sym = syms?.get(istart);
    const tokenEnd = sym ? sym.end + offset : start + 1;
    const msPerWhole = sym?.msPerWhole || DEFAULT_MS_PER_WHOLE;
    if (e[5] > 0) {
      const note = {
        start, end: tokenEnd, ms, durMs,
        durWhole: durMs / msPerWhole, msPerWhole,
        timeWhole: sym?.timeWhole,            // written position, whole notes (core/abc-dynamics.js beat stress)
        midi: e[3], voice, voiceIndex, instr: instr | 0,
      };
      if (graceStarts?.has(istart)) note.grace = true;
      notes.push(note);
    } else {
      rests.push({ start, end: tokenEnd, ms, durMs, msPerWhole, voice, voiceIndex });
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
 * The timing as abcjs's `TimingCallbacks.noteTimings` would have reported it —
 * one MOMENT per distinct onset, carrying every voice's entry that starts right
 * then — which is the table abcjs.js's transport, cursor, green highlight,
 * seek, audition, piano roll, Web MIDI and oscillator paths were written
 * against. Keeping that shape is what let the source engine change under them
 * untouched (2026-10, the one-parser work); the duplicate fields (`startChar` +
 * `startCharArray`, `left: 0`…) are abcjs's conventions, not ours.
 *
 * Principal notes and rests only: grace notes ride on their principal in
 * abcjs's table too (they still SOUND — the sampler plays `timing.notes`).
 * `millisecondsPerMeasure` = ms per whole × the meter fraction, which is how
 * every consumer converts a `duration` in whole notes back to ms.
 * @param {ReturnType<typeof timingFromEvents>} timing
 * @param {{ meterSize?: number }} [opts]  num/den of the meter (1 when unknown)
 * @returns {object[]}  sorted by `milliseconds`
 */
export function momentsFromTiming(timing, { meterSize = 1 } = {}) {
  const byMs = new Map();   // ms → moment under construction
  const moment = (ms, msPerWhole) => {
    let m = byMs.get(ms);
    if (!m) {
      m = { type: 'event', milliseconds: ms, millisecondsPerMeasure: msPerWhole * (meterSize || 1),
            left: 0, top: 0, width: 0, height: 0, line: 0,
            startCharArray: [], endCharArray: [], elements: [], midiPitches: [], _entries: new Map() };
      byMs.set(ms, m);
    }
    return m;
  };
  const entry = (m, start, end) => {
    if (!m._entries.has(start)) {
      m._entries.set(start, true);
      m.startCharArray.push(start);
      m.endCharArray.push(end);
      m.elements.push([]);
    }
  };
  for (const n of timing.notes) {
    if (n.grace) continue;
    const m = moment(n.ms, n.msPerWhole);
    entry(m, n.start, n.end);
    m.midiPitches.push({
      pitch: n.midi, startChar: n.start, endChar: n.end,
      duration: n.durWhole, volume: n.velocity ?? 95, instrument: n.instr & 0x7f,
    });
  }
  for (const r of timing.rests) {
    entry(moment(r.ms, r.msPerWhole), r.start, r.end);
  }
  const out = [...byMs.values()].sort((a, b) => a.milliseconds - b.milliseconds);
  for (const m of out) {
    delete m._entries;
    // abcjs lists a moment's entries in source order; so do we.
    const order = m.startCharArray.map((s, i) => i).sort((i, j) => m.startCharArray[i] - m.startCharArray[j]);
    m.startCharArray = order.map(i => m.startCharArray[i]);
    m.endCharArray   = order.map(i => m.endCharArray[i]);
    m.elements       = order.map(i => m.elements[i]);
    m.midiPitches.sort((a, b) => a.startChar - b.startChar || a.pitch - b.pitch);
    // abcjs's single-entry fields, read by a few consumers.
    m.startChar = m.startCharArray[0];
    m.endChar   = m.endCharArray[0];
  }
  return out;
}


/**
 * One of abc2svg's `user.errmsg(text, line, col)` calls as a diagnostic the
 * editor can place. abc2svg's `text` is `fname:LINE:COL Error: message` (its
 * LINE/COL are 1-based renderings of `line`/`col`, which are 0-based; `col` is
 * −1 when it has no column — then `line` is the line AFTER the problem, as in
 * "Empty line in tune header" and "No end of tuplet", so the diagnostic goes
 * to the end of the line before). `prefixLines` = lines the caller injected in
 * front of the user's text (`%%linebreak $` …), subtracted so `line` indexes
 * the user's text; a diagnostic inside the prefix is dropped (null).
 * @param {{ msg: string, l: number, c: number }} e
 * @param {number} [prefixLines]
 * @returns {{ line: number, col: number|null, severity: 'error'|'warning', message: string }|null}
 */
export function parseErrmsg({ msg, l, c }, prefixLines = 0) {
  const text = String(msg ?? '');
  const m = /^[^:\s]*:\d+:-?\d+\s+(Error|Warning|Fatal)?:?\s*([\s\S]*)$/.exec(text);
  const label = m?.[1] ?? 'Error';
  const message = (m ? m[2] : text).trim();
  let line = Number.isFinite(l) ? l : 0;
  let col = Number.isFinite(c) && c >= 0 ? c : null;
  if (col == null && line > 0) line -= 1;        // "the line after" → the line itself
  line -= prefixLines;
  if (line < 0) return null;
  const ignored = /\bignored\b/i.test(message);
  const severity = label === 'Warning' || ignored ? 'warning' : 'error';
  return { line, col, severity, message };
}
