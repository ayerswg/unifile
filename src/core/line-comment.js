/**
 * Line-comment toggling (Mod-/) — the one implementation every editor shares.
 *
 * Pure: works on an array of line strings + an inclusive line range and returns
 * EDITS in the original coordinates (`{ line, col, remove, insert }`), so the
 * CodeMirror shell turns them into a change set (and lets CM map the selection)
 * while the custom uPub/uDraft editor applies them with `applyEdits` and moves
 * its caret with `mapOffset`.  Semantics follow CodeMirror / VS Code:
 *
 *   line comments  — if any non-blank selected line is NOT commented, comment
 *                    every non-blank line (`token + ' '` at the block's minimum
 *                    indentation); else strip the token (+ one space) from each.
 *                    Blank lines are left alone, unless the selection is that
 *                    one blank line.  A `directive` regex names lines that START
 *                    with the token but are not comments (ABC `%%MIDI`, mermaid
 *                    `%%{init}%%`): they count as uncommented, and commenting
 *                    them prefixes `% ` / `%% ` so the toggle round-trips.
 *   block comments — a language with no line comment (Markdown `<!-- -->`,
 *                    Fountain's boneyard) wraps the selected lines in ONE block:
 *                    `open + ' '` before the first non-blank line, `' ' + close`
 *                    after the last; selected lines already wrapped are unwrapped.
 *
 * The leading `---` front matter is YAML in every app, so `commentSpecFor`
 * answers `#` for a range inside it whatever the document's DSL.
 *
 * @typedef {{ line?: string, directive?: RegExp, block?: { open: string, close: string } }} CommentSpec
 * @typedef {{ line: number, col: number, remove: number, insert: string }} LineEdit
 */

/** The front matter's comment: YAML. */
export const YAML_COMMENT = Object.freeze({ line: '#' });

/**
 * Index of the closing `---` of a leading front-matter block, or -1.  Same rule
 * as core/front-matter.js FM_RE and the uPub/uDraft classifiers: line 0 is
 * exactly `---` and a later line is exactly `---`.
 * @param {string[]} lines
 */
export function frontMatterEnd(lines) {
  if (!lines.length || lines[0].replace(/\r$/, '') !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') return i;
  }
  return -1;
}

/**
 * The spec to toggle lines a..b with: YAML's `#` when the whole range lies in
 * the leading front matter, else the DSL's own.
 * @param {string[]} lines
 * @param {number} a
 * @param {number} b
 * @param {CommentSpec|null|undefined} dslSpec
 * @returns {CommentSpec|null}
 */
export function commentSpecFor(lines, a, b, dslSpec) {
  const fm = frontMatterEnd(lines);
  if (fm > 0 && b <= fm) return YAML_COMMENT;
  return dslSpec ?? null;
}

const indentOf = (text) => /^[ \t]*/.exec(text)[0].length;

/**
 * Compute the edits that toggle comments on lines a..b (inclusive).
 * @param {string[]} lines
 * @param {number} a
 * @param {number} b
 * @param {CommentSpec|null|undefined} spec
 * @returns {{ edits: LineEdit[], commented: boolean } | null}  null = nothing to do
 */
export function toggleCommentEdits(lines, a, b, spec) {
  if (!spec || !lines.length) return null;
  a = Math.max(0, Math.min(a, lines.length - 1));
  b = Math.max(a, Math.min(b, lines.length - 1));
  if (spec.line) return _lineEdits(lines, a, b, spec.line, spec.directive);
  if (spec.block?.open && spec.block?.close) return _blockEdits(lines, a, b, spec.block);
  return null;
}

function _lineEdits(lines, a, b, token, directive) {
  const rows = [];
  let minIndent = Infinity;
  for (let i = a; i <= b; i++) {
    const text = lines[i];
    const indent = indentOf(text);
    const empty = indent === text.length;
    const rest = text.slice(indent);
    const commented = rest.startsWith(token) && !(directive && directive.test(rest)) ? indent : -1;
    if (!empty && indent < minIndent) minIndent = indent;
    rows.push({ i, indent, empty, commented });
  }
  const single = rows.length === 1;
  if (rows.some(r => r.commented < 0 && (!r.empty || single))) {
    const edits = rows
      .filter(r => single || !r.empty)
      .map(r => ({ line: r.i, col: r.empty ? r.indent : minIndent, remove: 0, insert: token + ' ' }));
    return { edits, commented: true };
  }
  if (rows.some(r => r.commented >= 0)) {
    const edits = rows
      .filter(r => r.commented >= 0)
      .map(r => {
        let n = token.length;
        if (lines[r.i][r.commented + n] === ' ') n++;
        return { line: r.i, col: r.commented, remove: n, insert: '' };
      });
    return { edits, commented: false };
  }
  return null;
}

function _blockEdits(lines, a, b, { open, close }) {
  let f = a, l = b;
  while (f < l && !lines[f].trim()) f++;
  while (l > f && !lines[l].trim()) l--;
  const first = lines[f];
  const last = lines[l];
  const fi = indentOf(first);
  const rest = first.slice(fi);
  const lastBody = last.replace(/\s+$/, '');
  const closeAt = lastBody.length - close.length;
  const wrapped = rest.startsWith(open) && lastBody.endsWith(close)
    && (f !== l || closeAt >= fi + open.length);
  if (wrapped) {
    let openEnd = fi + open.length;
    if (first[openEnd] === ' ') openEnd++;
    let closeStart = closeAt;
    if (closeStart > 0 && last[closeStart - 1] === ' ') closeStart--;
    if (f === l) closeStart = Math.max(closeStart, openEnd);
    const edits = [{ line: f, col: fi, remove: openEnd - fi, insert: '' }];
    edits.push({ line: l, col: closeStart, remove: lastBody.length - closeStart, insert: '' });
    return { edits, commented: false };
  }
  return {
    edits: [
      { line: f, col: fi, remove: 0, insert: open + ' ' },
      { line: l, col: last.length, remove: 0, insert: ' ' + close },
    ],
    commented: true,
  };
}

/**
 * Apply edits (original coordinates, non-overlapping) to a copy of `lines`.
 * @param {string[]} lines
 * @param {LineEdit[]} edits
 * @returns {string[]}
 */
export function applyEdits(lines, edits) {
  const out = lines.slice();
  const sorted = edits.slice().sort((x, y) => x.line - y.line || x.col - y.col);
  // Right to left within a line so earlier columns stay valid.
  for (let k = sorted.length - 1; k >= 0; k--) {
    const e = sorted[k];
    const text = out[e.line];
    out[e.line] = text.slice(0, e.col) + e.insert + text.slice(e.col + e.remove);
  }
  return out;
}

/**
 * Where a document offset lands after `edits` (CodeMirror's `assoc: 1` rule:
 * an insertion AT the offset moves it after the inserted text, an offset inside
 * a removed span lands on the removal point).
 * @param {string[]} lines   the ORIGINAL lines
 * @param {LineEdit[]} edits
 * @param {number} offset
 * @returns {number}
 */
export function mapOffset(lines, edits, offset) {
  // Locate the offset in the original lines.
  let lineIdx = 0, lineStart = 0;
  while (lineIdx < lines.length - 1 && lineStart + lines[lineIdx].length < offset) {
    lineStart += lines[lineIdx].length + 1;
    lineIdx++;
  }
  const col = Math.max(0, Math.min(offset - lineStart, lines[lineIdx].length));
  let delta = 0;      // from edits on earlier lines
  let shift = 0;      // from edits on this line wholly before the offset
  let inside = null;  // the edit whose removed span holds the offset
  const onLine = edits.filter(e => e.line === lineIdx).sort((x, y) => x.col - y.col);
  for (const e of edits) if (e.line < lineIdx) delta += e.insert.length - e.remove;
  for (const e of onLine) {
    if (e.col + e.remove <= col) { shift += e.insert.length - e.remove; continue; }
    if (e.col <= col) inside = e;
    break;
  }
  const newCol = inside ? inside.col + shift : col + shift;
  return lineStart + delta + newCol;
}
