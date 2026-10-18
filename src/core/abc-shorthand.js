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
 *
 * 3. HEADER COMPLETION. Standard ABC requires `X:` to open a tune and `K:` to
 *    end its header — abc2svg honours that to the letter and SILENTLY DROPS
 *    every music line it meets before a `K:` (and every field before an
 *    `X:`), while abcjs renders the tune anyway, assuming C major. A sketch
 *    like `V:1 clef=treble` / `@1 cde |` therefore engraved NOTHING in
 *    abc2svg and the app fell back to abcjs — which, drawn as the hidden
 *    timing render, broke a staff line at every source newline (real bug:
 *    "the measures don't flow"). `completeHeader` supplies what is missing —
 *    `X:1` before the first field or music line of a document with no `X:`,
 *    `K:C` (abcjs's own default) before the first music line of a tune whose
 *    header has no `K:` — so both engines see the same, complete tune. It is
 *    an insertion with the same kind of offset maps as the voice prefix;
 *    `expandAbc` composes the two and is what every engine call goes through.
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

// A line abc2svg reads as an information field: a letter (or `+`) and `:`.
const FIELD_RE = /^[A-Za-z+]:/;

/**
 * Supply the tune headers standard ABC requires when the document leaves them
 * out: `X:1` when there is no `X:` line at all (before the first field or
 * music line), and `K:C` before the first music line of every tune whose
 * header has no `K:`. abc2svg drops music before `K:` and fields before `X:`
 * outright (no error — the tune is simply empty); abcjs assumes exactly these
 * values. A leading `---` front matter block, `%` comments and `%%` directives
 * never count as music; a blank line ends a tune (the next `X:` starts one).
 * @param {string} text  ABC source (voice prefixes expanded or not — `@id`
 *   lines are music either way)
 * @returns {{ text: string, changed: boolean, inserted: {at: number, text: string}[],
 *             toExpanded: (i: number) => number, toSource: (i: number) => number }}
 *   `inserted` lists each insertion at its SOURCE offset. The maps are
 *   monotone; a position inside an inserted line maps back to the insertion
 *   point (the line it was inserted before).
 */
export function completeHeader(text) {
  const src = String(text ?? '');
  const inserted = [];
  const lines = src.split(/(?<=\n)/);
  let pos = 0;
  let i = 0;
  // A leading front matter block is not ABC.
  if (/^---[ \t]*\r?\n?$/.test(lines[0] ?? '')) {
    pos += lines[0].length;
    for (i = 1; i < lines.length; i++) {
      pos += lines[i].length;
      if (/^---[ \t]*\r?\n?$/.test(lines[i])) { i++; break; }
    }
  }
  const hasX = lines.slice(i).some((l) => /^X:/.test(l));
  // state: 0 = outside a tune, 1 = in a tune header, 2 = in a tune body
  let state = 0, hasK = false, firstTune = !hasX;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const raw = line.replace(/\r?\n$/, '');
    if (/^\s*$/.test(raw)) {               // blank: ends a tune body
      if (state === 2) state = 0;
    } else if (raw[0] === '%') {           // comment / directive
      // nothing
    } else if (/^X:/.test(raw)) {
      state = 1; hasK = false;
    } else if (FIELD_RE.test(raw)) {       // an information field
      if (firstTune) { inserted.push({ at: pos, text: 'X:1\n' }); firstTune = false; state = 1; hasK = false; }
      if (state === 1 && raw[0] === 'K') { hasK = true; state = 2; }
    } else {                               // music
      if (firstTune) { inserted.push({ at: pos, text: 'X:1\nK:C\n' }); firstTune = false; state = 2; hasK = true; }
      else if (state === 1 && !hasK) { inserted.push({ at: pos, text: 'K:C\n' }); hasK = true; state = 2; }
    }
    pos += line.length;
  }
  if (!inserted.length) {
    const id = (n) => n;
    return { text: src, changed: false, inserted, toExpanded: id, toSource: id };
  }
  let out = '', last = 0, delta = 0;
  const marks = [];                        // { s: source at, e: expanded at, n: inserted length }
  for (const ins of inserted) {
    out += src.slice(last, ins.at) + ins.text;
    marks.push({ s: ins.at, e: ins.at + delta, n: ins.text.length });
    delta += ins.text.length;
    last = ins.at;
  }
  out += src.slice(last);
  return {
    text: out,
    changed: true,
    inserted,
    toExpanded(n) {
      let d = 0;
      for (const m of marks) { if (m.s <= n) d += m.n; else break; }
      return n + d;
    },
    toSource(e) {
      let d = 0;
      for (const m of marks) {
        if (e < m.e) break;
        if (e < m.e + m.n) return m.s;   // inside the inserted line → where it went
        d += m.n;
      }
      return e - d;
    },
  };
}

/**
 * The full source → engine transform: voice prefixes expanded, then the
 * headers completed. Same shape as `expandVoices`; `toExpanded` / `toSource`
 * compose both maps. This is THE boundary abcjs.js uses for every engine call
 * (render, exports, lint, MIDI) so every char offset the engines report maps
 * back to the editor through one function.
 */
export function expandAbc(text) {
  const v = expandVoices(text);
  const h = completeHeader(v.text);
  if (!h.changed) return v;
  return {
    text: h.text,
    changed: true,
    inserted: h.inserted.map((ins) => ({ at: v.toSource(ins.at), text: ins.text })),
    toExpanded: (i) => h.toExpanded(v.toExpanded(i)),
    toSource: (e) => v.toSource(h.toSource(e)),
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
