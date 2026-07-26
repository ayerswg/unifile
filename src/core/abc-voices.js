/**
 * ABC voice helpers — shared by the editor gutter (which voice a line belongs to)
 * and the abcjs DSL (mute/solo playback + highlight filtering).
 *
 * A voice is identified by the token after `V:` on a voice field line
 * (`V:1`, `V:Soprano`, `V:2 clef=bass name="Cello"` → "1" / "Soprano" / "2").
 * The same voice id can appear on many lines (each system repeats `V:1`, `V:2…`
 * in interleaved scores); mute/solo key off the id so they apply song-wide.
 */

// A `V:` field line: optional indent, `V:`, then the voice id token. `%` starts
// an ABC comment, so it terminates the token.
const VOICE_LINE_RE = /^\s*V:\s*([^\s%]+)/;

// An inline voice field in the music body: `[V:PR1]`, `[V: 2]`, `[V:1 name="x"]`.
// Interleaved scores commonly prefix each music line with one instead of using
// standalone `V:` lines, and a mid-line one switches the voice mid-line.
const INLINE_VOICE_RE = /\[V:\s*([^\s\]%]+)[^\]]*\]/g;

/** Voice id of a `V:` field line, or null when the line isn't one. */
export function voiceIdOfLine(lineText) {
  const m = VOICE_LINE_RE.exec(lineText ?? '');
  if (!m) return null;
  // Strip surrounding quotes if the id was quoted (rare).
  return m[1].replace(/^"|"$/g, '');
}

/**
 * Build a voice map over an ABC source string.
 * @param {string} source
 * @returns {{ order: string[], at: (char:number)=>(string|null) }}
 *   `order` = distinct voice ids in first-appearance order (matches abcjs's
 *   score-order voice indexing, used for the synth `voicesOff` option).
 *   `at(char)` = the voice active at a character offset (the id of the nearest
 *   preceding `V:` line), or null before any voice is declared.
 */
export function buildVoiceMap(source) {
  const boundaries = []; // { from, voiceId } in increasing `from`
  const order = [];
  const note = (from, voiceId) => {
    boundaries.push({ from, voiceId });
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
      let v = null;
      for (const b of boundaries) {
        if (b.from <= char) v = b.voiceId;
        else break;
      }
      return v;
    },
  };
}
