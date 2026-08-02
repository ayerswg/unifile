/**
 * ABC pitch + duration text helpers for the piano roll's source write-back.
 *
 * Everything here works on the section-relative ABC source string (the same
 * string abcjs parsed, so char offsets line up with noteTimings startChars).
 *
 * The tricky part is ABC accidental semantics: an explicit accidental applies
 * to that note AND to every later note of the same letter+octave in the same
 * measure.  Editing one note's pitch can therefore silently change later
 * notes.  midiToAbcPitch always writes an explicit accidental when the target
 * pitch differs from the bare-letter reading at that point, and
 * accidentalRepairs() pins down any later same-letter notes in the measure
 * whose sounding pitch (known from the timing table) would otherwise change.
 */

// ---------------------------------------------------------------------------
// Key signatures
// ---------------------------------------------------------------------------

// Sharp/flat orders for building letter→alteration maps from a count.
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

// Circle-of-fifths index per major tonic (sharps positive, flats negative).
const MAJOR_FIFTHS = {
  'C': 0, 'G': 1, 'D': 2, 'A': 3, 'E': 4, 'B': 5, 'F#': 6, 'C#': 7,
  'F': -1, 'Bb': -2, 'Eb': -3, 'Ab': -4, 'Db': -5, 'Gb': -6, 'Cb': -7,
};

// Mode offsets in fifths relative to the major (ionian) tonic.
const MODE_FIFTHS = {
  '': 0, 'maj': 0, 'major': 0, 'ion': 0, 'ionian': 0,
  'm': -3, 'min': -3, 'minor': -3, 'aeo': -3, 'aeolian': -3,
  'dor': -2, 'dorian': -2, 'phr': -4, 'phrygian': -4,
  'lyd': 1, 'lydian': 1, 'mix': -1, 'mixolydian': -1,
  'loc': -5, 'locrian': -5,
};

/**
 * Parse the `K:` field of an ABC source into a key signature.
 * @returns {{ alter: Record<string, number>, preferFlats: boolean }}
 *   alter maps each letter A–G to -1/0/+1; preferFlats guides chromatic
 *   spelling (flat keys spell black keys as flats).
 */
export function parseKeySig(source) {
  const alter = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0 };
  const m = /^K:\s*([A-G])([b#]?)\s*([A-Za-z]*)/m.exec(source ?? '');
  let fifths = 0;
  if (m) {
    const tonic = m[1] + (m[2] === '#' ? '#' : m[2] === 'b' ? 'b' : '');
    const mode = m[3].toLowerCase();
    const base = MAJOR_FIFTHS[tonic];
    if (base !== undefined) fifths = base + (MODE_FIFTHS[mode.slice(0, 3)] ?? MODE_FIFTHS[mode] ?? 0);
  }
  fifths = Math.max(-7, Math.min(7, fifths));
  if (fifths > 0) for (let i = 0; i < fifths; i++) alter[SHARP_ORDER[i]] = 1;
  if (fifths < 0) for (let i = 0; i < -fifths; i++) alter[FLAT_ORDER[i]] = -1;
  return { alter, preferFlats: fifths < 0 };
}

// ---------------------------------------------------------------------------
// Unit note length (L:)
// ---------------------------------------------------------------------------

/** The unit note length as a fraction of a whole note (e.g. 0.125 for L:1/8). */
export function parseUnitLen(source) {
  const m = /^L:\s*(\d+)\s*\/\s*(\d+)/m.exec(source ?? '');
  if (m) {
    const v = parseInt(m[1], 10) / parseInt(m[2], 10);
    if (v > 0 && isFinite(v)) return v;
  }
  // ABC default: meter value < 0.75 → 1/16, else 1/8 (absent M: → 1/8).
  const mm = /^M:\s*(\d+)\s*\/\s*(\d+)/m.exec(source ?? '');
  if (mm) {
    const mv = parseInt(mm[1], 10) / parseInt(mm[2], 10);
    if (mv > 0 && mv < 0.75) return 1 / 16;
  }
  return 1 / 8;
}

// ---------------------------------------------------------------------------
// Pitch tokens
// ---------------------------------------------------------------------------

// One pitch inside the music body: optional accidentals, letter, octave marks.
const PITCH_RE = /([_^=]{1,2})?([A-Ga-g])([,']*)/g;

// Natural (no key sig) MIDI value of a bare letter+octave-marks token.
// Uppercase C = middle C octave (C = 60 … B = 71); lowercase = one up;
// each `'` +12, each `,` -12.
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function naturalMidi(letter, octMarks = '') {
  const upper = letter.toUpperCase();
  let midi = 60 + LETTER_PC[upper];
  if (letter !== upper) midi += 12;
  for (const ch of octMarks) midi += ch === "'" ? 12 : -12;
  return midi;
}

function accValue(accText) {
  if (!accText) return null;             // no explicit accidental
  if (accText === '=') return 0;
  let v = 0;
  for (const ch of accText) v += ch === '^' ? 1 : -1;
  return v;
}

function accText(value) {
  if (value === 0) return '=';
  if (value > 0) return '^'.repeat(Math.min(2, value));
  return '_'.repeat(Math.min(2, -value));
}

/**
 * Spell a MIDI pitch as an ABC pitch token relative to a key signature.
 * Always writes an explicit accidental when the bare letter (under the key
 * signature) would not sound the target pitch — measure-propagation-proof.
 * @returns {{ text: string, letter: string, octMarks: string }}
 */
export function midiToAbcPitch(midi, keysig) {
  const pc = ((midi % 12) + 12) % 12;
  const preferFlats = keysig?.preferFlats ?? false;
  // Candidate spellings for the pitch class: [letter pc, alteration].
  const NATURALS = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };
  let letter, alterNeeded;
  if (NATURALS[pc] !== undefined) {
    letter = NATURALS[pc];
    alterNeeded = 0;
  } else if (preferFlats) {
    letter = NATURALS[pc + 1];         // e.g. pc 10 → B flat
    alterNeeded = -1;
  } else {
    letter = NATURALS[pc - 1];         // e.g. pc 10 → A sharp
    alterNeeded = 1;
  }
  // Octave: choose case + marks so naturalMidi(letter…) + alterNeeded === midi.
  const target = midi - alterNeeded;
  let tok = letter, base = naturalMidi(letter, '');
  if (target >= base + 12) { tok = letter.toLowerCase(); base += 12; }
  let marks = '';
  while (base + 12 <= target) { marks += "'"; base += 12; }
  while (base > target) { marks += ','; base -= 12; }
  const keyAlter = keysig?.alter?.[letter] ?? 0;
  // Explicit accidental unless the key signature alone already sounds it.
  // (Even then, an earlier in-measure accidental could interfere — callers pass
  // forceAccidental via spellWithContext when the measure context demands it.)
  const acc = alterNeeded === keyAlter ? '' : accText(alterNeeded);
  return { text: acc + tok + marks, letter, octMarks: marks, caseTok: tok, alterNeeded };
}

// ---------------------------------------------------------------------------
// Measure context
// ---------------------------------------------------------------------------

/** [from, to) char span of the measure containing `pos`: bounded by barlines
 *  (| variants) and line boundaries.  Line-scoped, so interleaved `V:`-per-line
 *  scores resolve to the right voice's measure. */
export function measureSpan(source, pos) {
  const lineFrom = source.lastIndexOf('\n', pos - 1) + 1;
  let lineTo = source.indexOf('\n', pos);
  if (lineTo === -1) lineTo = source.length;
  let from = lineFrom;
  for (let i = pos - 1; i >= lineFrom; i--) {
    if (source[i] === '|') { from = i + 1; break; }
  }
  let to = lineTo;
  for (let i = pos; i < lineTo; i++) {
    if (source[i] === '|') { to = i; break; }
  }
  return { from, to };
}

/** All pitch tokens in [from, to) with their offsets, skipping `!…!`
 *  decorations, `"…"` chord symbols, `[V:…]` fields and `%` comments (whose
 *  letters would otherwise read as pitches). */
export function pitchTokensIn(source, from, to) {
  const out = [];
  let i = from;
  while (i < to) {
    const ch = source[i];
    if (ch === '%') break;                                    // comment → line over
    if (ch === '!') { const e = source.indexOf('!', i + 1); i = e === -1 ? to : e + 1; continue; }
    if (ch === '"') { const e = source.indexOf('"', i + 1); i = e === -1 ? to : e + 1; continue; }
    if (ch === '[' && source[i + 1] && /[A-Za-z]/.test(source[i + 1]) && source[i + 2] === ':') {
      const e = source.indexOf(']', i + 1); i = e === -1 ? to : e + 1; continue;  // [V:…] etc.
    }
    PITCH_RE.lastIndex = i;
    const m = PITCH_RE.exec(source);
    if (!m || m.index >= to) break;
    if (m.index > i) { i = Math.max(i + 1, m.index); continue; }
    out.push({ from: m.index, to: m.index + m[0].length, acc: m[1] ?? '', letter: m[2], octMarks: m[3] ?? '' });
    i = m.index + m[0].length;
  }
  return out;
}

/**
 * Whether a bare (accidental-less) token for `letter`+`octMarks` at `pos`
 * would inherit an explicit accidental from earlier in its measure.
 */
export function hasEarlierAccidental(source, pos, letter, octMarks) {
  const { from } = measureSpan(source, pos);
  // Propagation is by sounding letter+octave, so naturalMidi equality (which
  // folds case + octave marks together) is the whole test.
  return pitchTokensIn(source, from, pos).some(t =>
    t.acc && t.letter.toUpperCase() === letter.toUpperCase() &&
    naturalMidi(t.letter, t.octMarks) === naturalMidi(letter, octMarks));
}

/**
 * Compute repair edits for later notes in the measure after replacing the
 * pitch at [editFrom, editTo).  Any later accidental-less token whose letter+
 * octave matches the OLD or NEW spelling gets an explicit accidental pinning
 * its original sounding pitch (taken from `soundingMidiAt(token)`, backed by
 * the timing table — null when unknown, which skips the repair).
 * @returns {Array<{from:number,to:number,insert:string}>} in original coords
 */
export function accidentalRepairs(source, editFrom, editTo, spellings, keysig, soundingMidiAt) {
  const { to: measureTo } = measureSpan(source, editFrom);
  const later = pitchTokensIn(source, editTo, measureTo).filter(t => !t.acc);
  const edits = [];
  for (const t of later) {
    const matches = spellings.some(s =>
      s && t.letter.toUpperCase() === s.letter.toUpperCase() &&
      naturalMidi(t.letter, t.octMarks) === naturalMidi(s.caseTok ?? s.letter, s.octMarks ?? ''));
    if (!matches) continue;
    const orig = soundingMidiAt(t);
    if (orig == null) continue;
    const diff = orig - naturalMidi(t.letter, t.octMarks);
    if (diff < -2 || diff > 2) continue;
    edits.push({ from: t.from, to: t.from, insert: accText(diff) });
  }
  return edits;
}

/**
 * The inverse of accidentalRepairs: after an edit removes or changes a pitch
 * token, later explicit accidentals in the measure may become REDUNDANT (they
 * now just restate the key signature / context) — e.g. add `=B` in K:F, the
 * repair pins a later B as `_B`, then deleting the `=B` leaves `_B` saying
 * nothing the key signature doesn't.  Strip those.
 *
 * The safety argument: every roll edit preserves each untouched note's
 * sounding pitch, and in ABC the accidental state a note leaves behind always
 * equals its own sounding alteration (explicit or inherited).  So the
 * post-edit context can be modelled purely from SOUNDING pitches (the timing
 * table), sidestepping the repair/cleanup interaction: walk the measure, track
 * each pitch-key's last sounding alteration, and strip an explicit accidental
 * only when (a) the sounding is known, (b) it matches the accidental, and
 * (c) the modelled context already produces it.
 *
 * @param inserted  {key: naturalMidi, alter: semitones}|null — the pitch the
 *   edit itself leaves at [editFrom, editTo) (null for a deletion).
 * @returns {Array<{from:number,to:number,insert:string}>} in original coords
 */
export function accidentalCleanups(source, editFrom, editTo, inserted, keysig, soundingMidiAt) {
  const { from: mFrom, to: mTo } = measureSpan(source, editFrom);
  const state = new Map();   // naturalMidi pitch key → last sounding alteration
  const keyAlter = (letter) => keysig?.alter?.[letter.toUpperCase()] ?? 0;

  const soundingAlter = (t, key) => {
    const snd = soundingMidiAt(t);
    return snd != null ? snd - key : null;
  };
  const walk = (t, key, sndAlter, effective) => {
    // The state a token leaves = its sounding; fall back to its explicit
    // accidental, else the unchanged context.
    state.set(key, sndAlter ?? (t.acc ? accValue(t.acc) : effective));
  };

  for (const t of pitchTokensIn(source, mFrom, Math.max(mFrom, Math.min(editFrom, mTo)))) {
    const key = naturalMidi(t.letter, t.octMarks);
    const effective = state.has(key) ? state.get(key) : keyAlter(t.letter);
    walk(t, key, soundingAlter(t, key), effective);
  }
  if (inserted && inserted.alter != null) state.set(inserted.key, inserted.alter);

  const changes = [];
  for (const t of pitchTokensIn(source, Math.max(editTo, mFrom), mTo)) {
    const key = naturalMidi(t.letter, t.octMarks);
    const effective = state.has(key) ? state.get(key) : keyAlter(t.letter);
    const sndAlter = soundingAlter(t, key);
    if (t.acc && sndAlter != null && accValue(t.acc) === sndAlter && sndAlter === effective) {
      changes.push({ from: t.from, to: t.from + t.acc.length, insert: '' });
    }
    walk(t, key, sndAlter, effective);
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Duration suffixes
// ---------------------------------------------------------------------------

// A length suffix right after a pitch/chord/rest: "2", "3/2", "/2", "//", "".
const LEN_RE = /^(\d+)?(\/+)?(\d+)?/;

/** Parse a length suffix (at `pos`) → { value: multiplier of the unit, to }. */
export function parseLenSuffix(source, pos) {
  const m = LEN_RE.exec(source.slice(pos, pos + 8));
  if (!m || (!m[1] && !m[2] && !m[3])) return { value: 1, from: pos, to: pos };
  let num = m[1] ? parseInt(m[1], 10) : 1;
  let den = 1;
  if (m[2]) den = m[3] ? parseInt(m[3], 10) * Math.pow(2, m[2].length - 1)
                       : Math.pow(2, m[2].length);
  else if (m[3]) den = parseInt(m[3], 10); // shouldn't happen without '/'
  return { value: num / den, from: pos, to: pos + m[0].length };
}

/** Serialize a unit multiplier as an ABC length suffix ("" | "2" | "3/2" | "/2" …). */
export function lenSuffix(mult) {
  // Quantize to a musically sensible fraction (denominator ≤ 16).
  let best = { num: 1, den: 1, err: Math.abs(mult - 1) };
  for (const den of [1, 2, 4, 8, 16, 3, 6, 12]) {
    const num = Math.max(1, Math.round(mult * den));
    const err = Math.abs(mult - num / den);
    if (err < best.err - 1e-9) best = { num, den, err };
  }
  // Reduce.
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const g = gcd(best.num, best.den);
  const num = best.num / g, den = best.den / g;
  if (den === 1) return num === 1 ? '' : String(num);
  if (num === 1 && den === 2) return '/';
  if (num === 1) return '/' + den;
  return num + '/' + den;
}
