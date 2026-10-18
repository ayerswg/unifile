/**
 * Reflow the music lines of an ABC document so that EVERY MEASURE SITS ON ITS
 * OWN SOURCE LINE — the editor's "align" command for ABC.
 *
 * Why not column padding: the editor now wraps long lines instead of scrolling
 * horizontally, so whitespace grids drift at every wrap point. One measure per
 * line reads as a grid without depending on the viewport width, and line diffs
 * become per-measure diffs.
 *
 * Line flow (core/abc-shorthand.js): by default a {compose} document FLOWS —
 * a source newline never ends a staff line (`%%linebreak $`), so the
 * measures simply go one per line, nothing else. A line that already ends in
 * the ` \` continuation keeps it on every measure it is split into, and so
 * does a line a `w:` lyric line follows: ABC binds lyrics to the source line
 * above them, and ` \` joins lines, so the whole original line stays one
 * lyric line. Only when the document pins `%%linebreak <EOL>` (every source
 * line is a staff line) is every non-last measure given ` \`, which keeps the
 * score's line breaks exactly as they were (both engines honour the
 * continuation; abcjs rewrites `\`+newline in place, keeping char offsets
 * stable). Running the formatter twice is a no-op either way.
 *
 * A `@id` voice prefix (the unifile shorthand for `[V:id]`) stays with the
 * first measure of its line, like an inline field does.
 *
 * What counts as a measure line: anything that is not blank, a `%` comment, a
 * `#!` section marker, or an information field (`X:`, `K:`, `V:`, `w:` …), and
 * that carries a barline. A leading barline (`|:` at the start of a line) stays
 * attached to the measure it opens; a trailing pickup with no closing barline
 * becomes its own line. Whitespace inside a measure is normalised (trimmed,
 * inner runs collapsed to one space) so beaming — the presence of a space
 * between two notes — is preserved while the layout is tidy.
 */

import { sourceLineBreaks } from '../core/abc-shorthand.js';

// Barline tokens: | || |: :| |] [| :|: — a run of | with optional leading/
// trailing : and an optional trailing ]. Split keeps these as their own cells.
const BARLINE_RE = /(\[\||:*\|+\]?:*)/;

/** True for lines that are NOT music: blank, comment, section marker, or an ABC
 *  information field (a single letter followed by `:` at the line start). */
function isFieldOrMeta(trimmed) {
  return !trimmed
    || trimmed.startsWith('%')        // ABC comment
    || trimmed.startsWith('#!')       // unifile section shebang
    || /^[A-Za-z]:/.test(trimmed);    // information field: X: M: L: K: V: w: …
}

/** A music line worth reflowing: not a field/meta line, and carries a barline. */
function isMeasureLine(line) {
  const t = line.trim();
  if (isFieldOrMeta(t)) return false;
  return t.includes('|');
}

/**
 * Split one music line (continuation marker already stripped) into measures.
 * Each measure = the notes before a barline plus that barline; a barline with
 * nothing before it (a line-opening `|:` or `[|`) is carried as the prefix of
 * the next measure. Notes after the last barline form a trailing measure.
 * @param {string} line
 * @returns {string[]}
 */
export function splitMeasures(line) {
  const cells = line.split(BARLINE_RE);
  const out = [];
  let cur = '';                       // the measure being assembled
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (i % 2 === 0) {                // note segment
      const seg = cell.trim().replace(/\s+/g, ' ');
      if (seg) cur = cur ? `${cur} ${seg}` : seg;
    } else {                          // barline
      const hadNotes = /[^\s|:\[\]]/.test(cur);
      cur = cur ? `${cur} ${cell}` : cell;
      if (hadNotes) { out.push(cur); cur = ''; }
    }
  }
  if (cur) {
    // Trailing notes (a pickup without a closing barline) — or a dangling
    // barline run with no notes at all — form the last measure.
    out.push(cur);
  }
  return out;
}

/**
 * Put every measure of the ABC document on its own line, keeping the score's
 * staff-line breaks via ` \` continuations. Returns the reformatted text
 * (unchanged when there is nothing to reflow).
 * @param {string} text
 * @returns {string}
 */
export function alignAbcVoices(text) {
  const lines = text.split('\n');
  const out = [];
  // Only a document that pins source line breaks needs every split measure
  // chained back into its staff line.
  const keepBreaks = sourceLineBreaks(text);

  // Skip a leading front-matter block (`---` … `---`) verbatim — a YAML value
  // could otherwise look like a measure line (e.g. a `|` block scalar).
  let inFrontMatter = lines[0]?.trim() === '---';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontMatter) {
      if (i > 0 && line.trim() === '---') inFrontMatter = false;
      out.push(line);
      continue;
    }
    if (!isMeasureLine(line)) { out.push(line); continue; }

    // A line already ending in the continuation marker joins the next source
    // line into the same staff line; remember that so the reflow keeps it.
    const contMatch = /\\\s*$/.exec(line);
    const continued = !!contMatch;
    const body = continued ? line.slice(0, contMatch.index) : line;

    const measures = splitMeasures(body);
    if (!measures.length) { out.push(line); continue; }
    // In flow mode the inner measures are chained only when the original line
    // is part of a joined group: it continues, or a lyric line binds to it.
    const lyricsFollow = /^\s*[wW]:/.test(lines[i + 1] ?? '');
    const chainInner = keepBreaks || continued || lyricsFollow;
    measures.forEach((m, k) => {
      const last = k === measures.length - 1;
      const cont = last ? continued : chainInner;
      out.push(cont ? `${m} \\` : m);
    });
  }

  return out.join('\n');
}
