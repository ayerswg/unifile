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
  let pos = 0;
  for (const raw of String(source ?? '').split(/(?<=\n)/)) {
    const id = voiceIdOfLine(raw);
    if (id != null) {
      boundaries.push({ from: pos, voiceId: id });
      if (!order.includes(id)) order.push(id);
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
