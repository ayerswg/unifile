/**
 * Dynamics → velocity, for abc2svg's timing (core/abc-timing.js).
 *
 * abc2svg's event rows carry no loudness, and until 2026-10 abcjs's flattener
 * supplied it: a default BEAT STRESS (the first beat of a bar 105, other beats
 * 95, off-beats 85), a fixed level per dynamic mark (`!pp!` … `!ff!`), hairpins
 * (`!crescendo(!` … `!crescendo)!`, `!<(!` … `!<)!`, `!diminuendo(!`,
 * `!>(!`) ramping note by note toward the next mark, and a bump for accents.
 * This module gives every timed note the same, from the source text — the one
 * place {compose} reads markings (abcjs dropped the ones it did not know;
 * abc2svg keeps them in its model but the player rows do not carry them).
 *
 * Pure, Node-tested in test/abc-dynamics.test.mjs. `applyDynamics` mutates the
 * timing's notes (`velocity`, 1–127) and returns the timing.
 */

/** abcjs's table: [first beat, other beats, off-beats] per dynamic mark. */
export const DYNAMIC_LEVELS = {
  pppp: [15, 10, 5], ppp: [30, 20, 10], pp: [45, 35, 20], p: [60, 50, 35], mp: [75, 65, 50],
  mf: [90, 80, 65], f: [105, 95, 80], ff: [120, 110, 95], fff: [127, 125, 110], ffff: [127, 125, 110],
};
/** No mark yet: abcjs's defaults. */
export const DEFAULT_LEVEL = [105, 95, 85];
/** A hairpin with no mark after it moves this far. */
export const HAIRPIN_SPAN = 50;
/** `!accent!`, `!>!`, `L`, `!marcato!`, `!sfz!` … add this to the note. */
export const ACCENT_BUMP = 15;

const ACCENTS = new Set(['accent', '>', 'emphasis', 'marcato', '^', 'sfz', 'sforzando', 'L']);
const OPEN_CRESC = new Set(['crescendo(', '<(']), CLOSE_CRESC = new Set(['crescendo)', '<)']);
const OPEN_DIM = new Set(['diminuendo(', '>(']), CLOSE_DIM = new Set(['diminuendo)', '>)']);

const clamp = (v) => Math.max(1, Math.min(127, Math.round(v)));

/**
 * The marks in the text: `!name!` decorations, plus the `L` shorthand (accent)
 * when it directly precedes a note's token. `at` = where the mark starts.
 */
export function dynamicMarks(source) {
  const marks = [];
  const re = /!([^!\n]+)!/g;
  for (let m; (m = re.exec(source)); ) {
    const name = m[1].trim();
    let kind = null;
    if (name in DYNAMIC_LEVELS) kind = 'level';
    else if (OPEN_CRESC.has(name)) kind = 'cresc(';
    else if (CLOSE_CRESC.has(name)) kind = 'cresc)';
    else if (OPEN_DIM.has(name)) kind = 'dim(';
    else if (CLOSE_DIM.has(name)) kind = 'dim)';
    else if (ACCENTS.has(name)) kind = 'accent';
    if (kind) marks.push({ at: m.index, end: m.index + m[0].length, kind, name });
  }
  return marks;
}

/**
 * Which stress a note gets from its place in the bar: 0 = the first beat,
 * 1 = another beat, 2 = off the beat. `timeWhole` is the note's written time
 * in whole notes (abc2svg's `s.time / BLEN`); compound x/8 meters beat in
 * dotted quarters, as abcjs's `getBeatFraction` has it. No meter → a beat.
 */
export function beatStress(timeWhole, meter) {
  if (timeWhole == null || !meter || !(meter.num > 0 && meter.den > 0)) return 1;
  const barLen = meter.num / meter.den;
  const beat = meter.den === 8 && meter.num % 3 === 0 && meter.num > 3 ? 3 / 8 : 1 / meter.den;
  const pos = ((timeWhole % barLen) + barLen) % barLen;
  const b = pos / beat;
  const eps = 1e-6;
  if (pos < eps || barLen - pos < eps) return 0;
  return Math.abs(b - Math.round(b)) < eps ? 1 : 2;
}

/**
 * Give every note of `timing` a `velocity` from the dynamics in `source`.
 * @param {{ notes: object[] }} timing  core/abc-timing.js timingFromEvents output; notes carry
 *   `start` (content-relative), `voiceIndex`, `grace`, and `timeWhole` when the model was available
 * @param {string} source  the text abc2svg parsed (the EXPANDED content, same offsets as `start`)
 * @param {{ meter?: {num:number, den:number}|null, beatAccents?: boolean }} [opts]
 * @returns the same timing, notes mutated
 */
export function applyDynamics(timing, source, { meter = null, beatAccents = true } = {}) {
  const notes = timing?.notes ?? [];
  if (!notes.length) return timing;
  const text = String(source ?? '');
  const marks = dynamicMarks(text);

  // Distinct principal tokens per voice, in source order (a chord is one token;
  // a repeat replays a token — the velocity belongs to the token).
  const voices = new Map();   // voiceIndex → [{ start, timeWhole }]
  for (const n of notes) {
    if (n.grace) continue;
    let list = voices.get(n.voiceIndex);
    if (!list) { list = []; voices.set(n.voiceIndex, list); }
    if (!list.length || list[list.length - 1].start !== n.start) {
      if (!list.some(t => t.start === n.start)) list.push({ start: n.start, timeWhole: n.timeWhole });
    }
  }
  for (const list of voices.values()) list.sort((a, b) => a.start - b.start);

  // A mark belongs to the first token at or after it in the text (its own
  // voice's: a voice's music is contiguous in the source around the mark).
  const allTokens = [...voices.values()].flat().sort((a, b) => a.start - b.start);
  const marksAt = new Map();   // token start → marks
  let ti = 0;
  for (const mk of marks.sort((a, b) => a.at - b.at)) {
    while (ti < allTokens.length && allTokens[ti].start < mk.at) ti++;
    // The mark may sit INSIDE a chord / after accidentals: a token whose range
    // reaches past the mark owns it. Otherwise the next token.
    let owner = allTokens[ti];
    if (ti > 0) {
      const prev = allTokens[ti - 1];
      const prevEnd = notes.find(n => n.start === prev.start)?.end ?? prev.start + 1;
      if (mk.at < prevEnd) owner = prev;
    }
    if (!owner) continue;
    let list = marksAt.get(owner.start);
    if (!list) { list = []; marksAt.set(owner.start, list); }
    list.push(mk);
  }

  // The `L` shorthand: the char before the token (past its accidentals).
  const shorthandAccent = (start) => {
    let i = start;
    while (i > 0 && /[\^_=]/.test(text[i - 1])) i--;
    return text[i - 1] === 'L';
  };

  // Walk each voice: a sticky level, hairpins ramping toward the next mark.
  const velocityOf = new Map();   // token start → velocity
  const graceLevel = new Map();   // token start → the level in force (for grace notes before it)
  for (const tokens of voices.values()) {
    let level = DEFAULT_LEVEL.slice();
    let ramp = null;              // { per: number, left: number }
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const here = marksAt.get(tok.start) ?? [];
      let accent = shorthandAccent(tok.start);
      for (const mk of here) {
        if (mk.kind === 'level') { level = DYNAMIC_LEVELS[mk.name].slice(); ramp = null; }
        else if (mk.kind === 'accent') accent = true;
        else if (mk.kind === 'cresc(' || mk.kind === 'dim(') {
          const closeKind = mk.kind === 'cresc(' ? 'cresc)' : 'dim)';
          // Tokens until the matching close (the close's own token included).
          let n = 0, j = i, closed = false;
          for (; j < tokens.length; j++) {
            n++;
            if ((marksAt.get(tokens[j].start) ?? []).some(x => x.kind === closeKind && (j > i || x.at > mk.at))) { closed = true; break; }
          }
          if (!closed) n = Math.max(1, tokens.length - i);
          // The target: the first level mark after the close, else ± the span.
          let target = null;
          for (let k = j + 1; k < tokens.length && target == null; k++) {
            const lv = (marksAt.get(tokens[k].start) ?? []).find(x => x.kind === 'level');
            if (lv) target = DYNAMIC_LEVELS[lv.name][0];
          }
          if (target == null) target = mk.kind === 'cresc(' ? Math.min(127, level[0] + HAIRPIN_SPAN) : Math.max(15, level[0] - HAIRPIN_SPAN);
          ramp = { per: (target - level[0]) / Math.max(1, n), left: n };
        }
        // a close mark on its own: the ramp ends on this token (handled by `left`)
      }
      if (ramp) {
        level = level.map(v => Math.max(1, Math.min(127, v + ramp.per)));
        if (--ramp.left <= 0) ramp = null;
      }
      graceLevel.set(tok.start, level[2]);
      const stress = beatAccents ? beatStress(tok.timeWhole, meter) : 1;
      let vel = level[stress];
      if (accent) vel += ACCENT_BUMP;
      velocityOf.set(tok.start, clamp(vel));
    }
  }

  // Write back: every row of a token (chord pitches, repeat passes) shares it;
  // a grace note takes the soft level in force at the token it decorates.
  const principalStarts = allTokens.map(t => t.start);
  for (const n of notes) {
    if (!n.grace) { n.velocity = velocityOf.get(n.start) ?? 95; continue; }
    let next = principalStarts.find(s => s > n.start);
    n.velocity = clamp((next != null ? graceLevel.get(next) : DEFAULT_LEVEL[2]) ?? 85);
  }
  return timing;
}
