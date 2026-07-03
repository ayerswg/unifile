/**
 * Align barlines and notes across the music lines of an ABC document by padding
 * with spaces, so multiple voices — and successive lines of one voice — line up
 * vertically in the source text. Each measure "column" is widened to its longest
 * occurrence across the lines being aligned (the longest line drives the width),
 * so the barlines fall on the same columns and the notes read as a grid.
 *
 * Purely additive whitespace: note content, beaming (a space between notes is
 * kept), and barline tokens are preserved — only leading/trailing and repeated
 * inner spaces are normalized, then padding is added. Running it twice is a
 * no-op (idempotent).
 *
 * Music lines are grouped into blocks bounded by blank lines, a `#!` section
 * marker, or a new tune (`X:`) — so voices written as separate `V:` blocks still
 * share one grid and their barlines line up vertically. Within a block, only the
 * measure lines are aligned; interspersed information fields (`V:`, `w:`, `M:` …),
 * comments, and front-matter lines pass through untouched without breaking it.
 * Distinct systems/tunes (separated by a blank line or an `X:`/section boundary)
 * align independently.
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

/** A music line worth aligning: not a field/meta line, and carries a barline. */
function isMeasureLine(line) {
  const t = line.trim();
  if (isFieldOrMeta(t)) return false;
  return t.includes('|');
}

/** Split a music line into cells: segments (even indices) alternating with
 *  barline tokens (odd indices). Segment whitespace is normalized — trimmed and
 *  inner runs collapsed to a single space — which keeps beaming (the presence of
 *  a space between two notes) while making widths comparable across lines. */
function tokenize(line) {
  return line.split(BARLINE_RE).map((cell, i) =>
    (i % 2 === 0) ? cell.trim().replace(/\s+/g, ' ') : cell
  );
}

/** Align one contiguous run of measure lines to a shared column grid. */
function alignGroup(rows) {
  const celled = rows.map(tokenize);
  const cols = Math.max(...celled.map(c => c.length));
  const width = [];
  for (let c = 0; c < cols; c++) {
    width[c] = Math.max(0, ...celled.map(cells => (cells[c] ?? '').length));
  }
  return celled.map(cells => {
    const out = [];
    for (let c = 0; c < cols; c++) out.push((cells[c] ?? '').padEnd(width[c]));
    // One space between cells; drop the padding that spills past the last cell
    // and any leading space from an empty pre-barline segment.
    return out.join(' ').replace(/\s+$/, '').replace(/^\s+/, '');
  });
}

/**
 * Align the music lines of an ABC document. Returns the reformatted text
 * (unchanged when there is nothing to align).
 * @param {string} text
 * @returns {string}
 */
export function alignAbcVoices(text) {
  const lines = text.split('\n');
  const out = lines.slice();          // default: every line unchanged

  // Skip a leading front-matter block (`---` … `---`) verbatim — a YAML value
  // could otherwise look like a measure line (e.g. a `|` block scalar).
  let inFrontMatter = lines[0]?.trim() === '---';

  // Indices of the measure lines in the block currently being accumulated. A
  // block is flushed (aligned together) at every boundary.
  let block = [];
  const flush = () => {
    if (block.length) {
      const aligned = alignGroup(block.map(idx => lines[idx]));
      block.forEach((idx, k) => { out[idx] = aligned[k]; });
    }
    block = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (inFrontMatter) {
      if (i > 0 && lines[i].trim() === '---') inFrontMatter = false;
      continue;
    }
    const t = lines[i].trim();
    // Block boundaries: blank line, a new tune (X:), or a `#!` section marker.
    if (t === '' || t.startsWith('#!') || /^X:/.test(t)) { flush(); continue; }
    if (isMeasureLine(lines[i])) block.push(i);
    // else: field / comment line — passes through, does not break the block.
  }
  flush();

  return out.join('\n');
}
