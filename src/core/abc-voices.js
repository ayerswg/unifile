/**
 * ABC voice helpers — shared by the editor (which voice a line belongs to: the
 * colour bar, the M/S marks, the Mute / Solo menu) and the abcjs DSL (mute/solo
 * playback + highlight filtering, the piano roll's per-voice data).
 *
 * A voice is identified by the token after `V:` on a voice field line
 * (`V:1`, `V:Soprano`, `V:2 clef=bass name="Cello"` → "1" / "Soprano" / "2").
 * The same voice id can appear on many lines (each system repeats `V:1`, `V:2…`
 * in interleaved scores); mute/solo key off the id so they apply song-wide.
 *
 * Three spellings switch the voice (core/abc-shorthand.js has the third):
 *   V:id …         a standalone field line
 *   [V:id] …       the inline field — anywhere in a music line
 *   @id …          unifile's line-start shorthand for `[V:id]`
 */
import { VOICE_PREFIX_RE } from './abc-shorthand.js';

// A `V:` field line: optional indent, `V:`, then the voice id token. `%` starts
// an ABC comment, so it terminates the token.
const VOICE_LINE_RE = /^\s*V:\s*([^\s%]+)/;

// An inline voice field in the music body: `[V:PR1]`, `[V: 2]`, `[V:1 name="x"]`.
// Interleaved scores commonly prefix each music line with one instead of using
// standalone `V:` lines, and a mid-line one switches the voice mid-line.
const INLINE_VOICE_RE = /\[V:\s*([^\s\]%]+)[^\]]*\]/g;

/** Voice id of a `V:` field line or a `@id` shorthand line, or null otherwise. */
export function voiceIdOfLine(lineText) {
  const t = lineText ?? '';
  const m = VOICE_LINE_RE.exec(t);
  if (m) return m[1].replace(/^"|"$/g, '');   // strip quotes if the id was quoted (rare)
  const p = VOICE_PREFIX_RE.exec(t);
  return p ? p[1] : null;
}

/**
 * The voice tag at the start of a line — the token that names its voice —
 * as `{ from, to, id }` offsets within the line, or null. Covers `V:id`,
 * `[V:id]` (leading) and `@id`. The editor colours that token in the voice's
 * colour.
 */
export function voiceTagOfLine(lineText) {
  const t = lineText ?? '';
  let m;
  if ((m = /^\s*V:\s*[^\s%]+/.exec(t)))        return { from: m.index, to: m[0].length, id: voiceIdOfLine(t) };
  if ((m = VOICE_PREFIX_RE.exec(t)))           return { from: 0, to: m[0].length, id: m[1] };
  if ((m = /^\s*\[V:\s*([^\s\]%]+)[^\]]*\]/.exec(t))) return { from: m.index, to: m[0].length, id: m[1].replace(/^"|"$/g, '') };
  return null;
}

/**
 * Build a voice map over an ABC source string.
 * @param {string} source
 * @returns {{ order: string[], at: (char:number)=>(string|null) }}
 *   `order` = distinct voice ids in first-appearance order (matches abcjs's
 *   score-order voice indexing, used for the synth `voicesOff` option and the
 *   voice colours).
 *   `at(char)` = the voice active at a character offset (the id of the nearest
 *   preceding `V:` line / `[V:]` field / `@id` prefix), or null before any
 *   voice is declared.
 */
export function buildVoiceMap(source) {
  const starts = [];   // boundary char offsets, increasing
  const ids = [];      // voice id per boundary
  const order = [];
  const note = (from, voiceId) => {
    starts.push(from); ids.push(voiceId);
    if (!order.includes(voiceId)) order.push(voiceId);
  };
  let pos = 0;
  for (const raw of String(source ?? '').split(/(?<=\n)/)) {
    const id = voiceIdOfLine(raw);
    if (id != null) {
      note(pos, id);
    } else {
      INLINE_VOICE_RE.lastIndex = 0;
      let m;
      while ((m = INLINE_VOICE_RE.exec(raw)) !== null) {
        note(pos + m.index, m[1].replace(/^"|"$/g, ''));
      }
    }
    pos += raw.length;
  }
  return {
    order,
    at(char) {
      // Binary search: the last boundary at or before `char`.
      let lo = 0, hi = starts.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= char) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best < 0 ? null : ids[best];
    },
  };
}
