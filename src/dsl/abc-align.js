/**
 * Reflow the music lines of an ABC document so that EVERY MEASURE SITS ON ITS
 * OWN SOURCE LINE — the editor's "align" command for ABC.
 *
 * Why not column padding: the editor now wraps long lines instead of scrolling
 * horizontally, so whitespace grids drift at every wrap point. One measure per
 * line reads as a grid without depending on the viewport width, and line diffs
 * become per-measure diffs.
 *
 * Score line breaks are preserved. ABC treats a source newline as a staff-line
 * break, so a measure that was NOT the last on its original line is emitted
 * with a trailing ` \` — the ABC line-continuation, honoured by both engraving
 * engines (abc2svg joins continued lines; abcjs rewrites `\`+newline in place,
 * keeping char offsets stable). The last measure of an original line ends the
 * staff line exactly as before. Running the formatter twice is a no-op.
 *
 * What counts as a measure line: anything that is not blank, a `%` comment, a
 * `#!` section marker, or an information field (`X:`, `K:`, `V:`, `w:` …), and
 * that carries a barline. A leading barline (`|:` at the start of a line) stays
 * attached to the measure it opens; a trailing pickup with no closing barline
 * becomes its own line. Whitespace inside a measure is normalised (trimmed,
 * inner runs collapsed to one space) so beaming — the presence of a space
 * between two notes — is preserved while the layout is tidy.
 */

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
    measures.forEach((m, k) => {
      const last = k === measures.length - 1;
      out.push(last && !continued ? m : `${m} \\`);
    });
  }

  return out.join('\n');
}
