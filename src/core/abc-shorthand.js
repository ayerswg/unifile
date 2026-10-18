/**
 * {compose}'s ABC shorthand — two unifile extensions on top of standard ABC,
 * both pure text transforms so the editor, the engravers, the linter and the
 * piano roll agree on them.
 *
 * 1. THE VOICE PREFIX `@id`. In a multi-voice score every music line names
 *    its voice; standard ABC spells that `[V:1]` (five characters, at least).
 *    unifile accepts `@1` / `@S` / `@RH` at the start of a line as the same
 *    thing: `@1 A2 B2 |` IS `[V:1] A2 B2 |`. `@` starts no ABC token (both
 *    engravers ignore the character; it only means something inside a quoted
 *    annotation), so the prefix can never be mistaken for music, and it is
 *    only recognised at the START of a line — mid-line voice switches stay
 *    `[V:id]`. The id is the voice's own (`[A-Za-z0-9_]+`, the token after
 *    `V:`); write a space (or a bar) after it.
 *
 *    `expandVoices` rewrites every `@id` line to `[V:id]` for the engines and
 *    returns the two OFFSET MAPS: the expansion is 3 characters longer per
 *    prefixed line (`[V:` + `]` − `@`), and every char offset the engines
 *    report (abcjs startChar, abc2svg istart) lives in the EXPANDED text while
 *    the editor's live in the source — `toSource` / `toExpanded` convert at
 *    that boundary (abcjs.js `_toDoc` / `_toSec`, the piano roll's edits).
 *
 * 2. LINE FLOW. Standard ABC breaks a staff line at every source newline. In
 *    {compose} the default is the opposite — `%%linebreak $` — so a tune is
 *    written one measure per line (per voice) and the engraver flows the
 *    measures to whatever width it is drawn or printed at; `$` forces a
 *    staff break. A document takes the classic behaviour back with
 *    `%%linebreak <EOL>` (`sourceLineBreaks` reads that opt-out, so the
 *    abcjs fallback renderer and the "one measure per line" formatter follow
 *    the same rule as abc2svg).
 */

/** `@id` at the very start of a line: the id is the voice's own token. */
export const VOICE_PREFIX_RE = /^@([A-Za-z0-9_]+)/;

/** Voice id of a `@id` line, or null when the line carries no prefix. */
export function voicePrefixOf(lineText) {
  const m = VOICE_PREFIX_RE.exec(lineText ?? '');
  return m ? m[1] : null;
}

/** The ABC the engines see for a `@id` line start (`[V:id]`). */
export function expandedPrefix(id) { return `[V:${id}]`; }

// A prefixed line grows by `[V:` + `]` − `@` characters.
const GROW = 3;

/**
 * Expand every `@id` line prefix to `[V:id]`.
 * @param {string} text  ABC source (a whole document or a section)
 * @returns {{ text: string, changed: boolean,
 *             toExpanded: (i: number) => number, toSource: (i: number) => number }}
 *   `toExpanded` maps a source offset into the expanded text, `toSource` the
 *   other way; both are monotone and clamp to the mark they fall inside (a
 *   position inside `[V:` maps to the `@`, the `]` to the id's last char).
 */
export function expandVoices(text) {
  const src = String(text ?? '');
  const marks = [];               // { s: source '@', e: expanded '[', n: id length }
  let out = '', pos = 0, delta = 0;
  for (const line of src.split(/(?<=\n)/)) {
    const m = VOICE_PREFIX_RE.exec(line);
    if (m) {
      marks.push({ s: pos, e: pos + delta, n: m[1].length });
      out += expandedPrefix(m[1]) + line.slice(m[0].length);
      delta += GROW;
    } else {
      out += line;
    }
    pos += line.length;
  }
  if (!marks.length) {
    const id = (i) => i;
    return { text: src, changed: false, toExpanded: id, toSource: id };
  }

  // Index of the last mark whose `key` is < (strict) or <= (inclusive) `i`.
  const lastBefore = (key, i, inclusive) => {
    let lo = 0, hi = marks.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = marks[mid][key];
      if (inclusive ? v <= i : v < i) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };

  return {
    text: out,
    changed: true,
    toExpanded(i) {
      const k = lastBefore('s', i, false);          // marks whose `@` is before i
      if (k < 0) return i;
      const m = marks[k];
      // Inside the id (`@` excluded): shifted by `[V:` − `@` = 2 for this mark.
      if (i <= m.s + m.n) return i + GROW * k + 2;
      return i + GROW * (k + 1);
    },
    toSource(e) {
      const k = lastBefore('e', e, true);           // marks whose `[` is at/before e
      if (k < 0) return e;
      const m = marks[k];
      if (e < m.e + 3) return m.s;                  // inside `[V:` → the `@`
      if (e < m.e + 3 + m.n) return e - GROW * k - 2; // an id character
      return e - GROW * (k + 1);                    // `]` and everything after
    },
  };
}

/**
 * True when the document pins the classic rule "a source newline ends the
 * staff line" — an explicit `%%linebreak` / `I:linebreak` naming `<EOL>`.
 * Everything else flows (the {compose} default, `%%linebreak $`).
 */
export function sourceLineBreaks(text) {
  return /^(?:%%|I:)\s*linebreak\b.*<EOL>/m.test(String(text ?? ''));
}

/** True when the document sets its own `%%linebreak` (so no default is injected). */
export function hasLinebreakDirective(text) {
  return /^%%linebreak\b/m.test(String(text ?? ''));
}

/** The directive the app injects when the document sets none. */
export const DEFAULT_LINEBREAK = '$';
