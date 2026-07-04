/**
 * Line-based diff / patch engine.
 *
 * Patch format (stored per commit):
 *   An array of operations serialised as JSON:
 *     ["=", N]           – N consecutive equal lines (skip)
 *     ["+", "line text"] – insert this line
 *     ["-"]              – delete one line from the source
 *
 * This format is compact, JSON-safe, and trivially re-parseable.
 */

// ---------------------------------------------------------------------------
// Diff (LCS-based, O(m·n) time & space)
// ---------------------------------------------------------------------------

/**
 * Compute the longest common subsequence of two arrays using DP.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number[][]} dp table (a.length+1 × b.length+1)
 */
function lcsDp(a, b) {
  const m = a.length, n = b.length;
  // Use typed arrays for memory efficiency
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp.push(new Uint32Array(n + 1));
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }
  return dp;
}

/**
 * Compute the edit operations between two line arrays.
 * @param {string[]} a – old lines
 * @param {string[]} b – new lines
 * @returns {Array} raw ops: { op: '='|'+'|'-', line?: string }
 */
function editOps(a, b) {
  const dp = lcsDp(a, b);
  const ops = [];
  let i = a.length, j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ op: '=', line: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ op: '+', line: b[j - 1] });
      j--;
    } else {
      ops.unshift({ op: '-' });
      i--;
    }
  }
  return ops;
}

/**
 * Compress a raw ops array into the compact patch array format.
 * Consecutive equal ops are merged into a single ["=", N] entry.
 * @param {Array} ops
 * @returns {Array} patch
 */
function compressPatch(ops) {
  const patch = [];
  let eqCount = 0;

  function flushEq() {
    if (eqCount > 0) {
      patch.push(['=', eqCount]);
      eqCount = 0;
    }
  }

  for (const op of ops) {
    if (op.op === '=') {
      eqCount++;
    } else {
      flushEq();
      if (op.op === '+') patch.push(['+', op.line]);
      else patch.push(['-']);
    }
  }
  flushEq();
  return patch;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a patch from oldText to newText.
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array} patch array (ready to serialise with JSON.stringify)
 */
export function computePatch(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const ops = editOps(a, b);
  return compressPatch(ops);
}

/**
 * Apply a patch to oldText and return the resulting text.
 * @param {string} oldText
 * @param {Array} patch
 * @returns {string}
 */
export function applyPatch(oldText, patch) {
  const lines = oldText === '' ? [] : oldText.split('\n');
  const result = [];
  let idx = 0;

  for (const op of patch) {
    if (op[0] === '=') {
      const count = op[1];
      for (let i = 0; i < count; i++) {
        result.push(lines[idx++] ?? '');
      }
    } else if (op[0] === '+') {
      result.push(op[1]);
    } else if (op[0] === '-') {
      idx++;
    }
  }
  return result.join('\n');
}

/**
 * Side-by-side line diff for read-only display.  Returns aligned rows where
 * runs of deletions/insertions are paired into `change` rows (GitHub style).
 *
 * @param {string} oldText  left side
 * @param {string} newText  right side
 * @returns {Array<{type:'equal'|'add'|'del'|'change', left:string|null, right:string|null, leftNo:number|null, rightNo:number|null}>}
 */
export function lineDiff(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const dp = lcsDp(a, b);

  // Backtrack to raw ops, keeping BOTH sides' text.
  const ops = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { ops.unshift({ op: '=', left: a[i - 1], right: b[j - 1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { ops.unshift({ op: '+', right: b[j - 1] }); j--; }
    else { ops.unshift({ op: '-', left: a[i - 1] }); i--; }
  }

  // Pair consecutive deletions + insertions into change rows.
  const rows = [];
  let ln = 1, rn = 1;
  for (let k = 0; k < ops.length; ) {
    if (ops[k].op === '=') {
      rows.push({ type: 'equal', left: ops[k].left, right: ops[k].right, leftNo: ln++, rightNo: rn++ });
      k++; continue;
    }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].op === '-') dels.push(ops[k++].left);
    while (k < ops.length && ops[k].op === '+') adds.push(ops[k++].right);
    const max = Math.max(dels.length, adds.length);
    for (let x = 0; x < max; x++) {
      const l = x < dels.length ? dels[x] : null;
      const r = x < adds.length ? adds[x] : null;
      if (l != null && r != null) rows.push({ type: 'change', left: l, right: r, leftNo: ln++, rightNo: rn++ });
      else if (l != null)         rows.push({ type: 'del', left: l, right: null, leftNo: ln++, rightNo: null });
      else                        rows.push({ type: 'add', left: null, right: r, leftNo: null, rightNo: rn++ });
    }
  }
  return rows;
}

/**
 * Produce a human-readable unified-diff-like string for display.
 * @param {string} oldText
 * @param {string} newText
 * @param {string} [oldLabel='a']
 * @param {string} [newLabel='b']
 * @returns {string}
 */
export function unifiedDiff(oldText, newText, oldLabel = 'a', newLabel = 'b') {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const ops = editOps(a, b);

  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const op of ops) {
    if (op.op === '=') lines.push(' ' + op.line);
    else if (op.op === '+') lines.push('+' + op.line);
    else lines.push('-' + (/* we lost the original line */ ''));
  }
  return lines.join('\n');
}

/**
 * Line-level three-way merge (diff3), producing merged text with git-style
 * conflict markers where both sides changed the same region differently.
 *
 * Each side is diffed against the base independently into "change regions"
 * (`diffRegions`) aligned to base line indices.  Walking the base:
 *   • a region on only one side  → apply that side (adjacent independent edits
 *     on different lines both land cleanly — no false conflict)
 *   • overlapping regions from both sides, resolving to the same text → take it
 *   • overlapping regions that differ                → conflict block
 *
 * The merge is a squash (no second parent recorded); the caller commits the
 * result as a normal commit.
 *
 * @param {string} oursText   the target ("ours") content
 * @param {string} baseText   common-ancestor content ('' if no shared history)
 * @param {string} theirsText the source ("theirs") content being merged in
 * @param {{oursLabel?:string, theirsLabel?:string}} [labels]
 * @returns {{ content: string, conflicts: number }}
 */
export function diff3Merge(oursText, baseText, theirsText, labels = {}) {
  const oursLabel = labels.oursLabel ?? 'ours';
  const theirsLabel = labels.theirsLabel ?? 'theirs';

  const O = baseText === '' ? [] : baseText.split('\n');
  const ra = diffRegions(O, oursText === '' ? [] : oursText.split('\n'));
  const rb = diffRegions(O, theirsText === '' ? [] : theirsText.split('\n'));

  const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

  const out = [];
  let conflicts = 0;
  let i = 0, ia = 0, ib = 0;

  while (i <= O.length) {
    const aActive = ia < ra.length && ra[ia].start <= i && (ra[ia].end > i || ra[ia].start === i);
    const bActive = ib < rb.length && rb[ib].start <= i && (rb[ib].end > i || rb[ib].start === i);

    if (!aActive && !bActive) {
      if (i < O.length) out.push(O[i]);
      i++;
      continue;
    }

    // Expand a combined block over any regions (both sides) that touch/overlap.
    let end = i, sideA = false, sideB = false;
    const aParts = [], bParts = [];
    // Merge in a region only when it begins at `i` (the seed) or truly overlaps
    // the running span (start < end).  Regions that merely *touch* at a boundary
    // (e.g. base[3,4) on one side and [4,5) on the other) are independent edits
    // on different lines and must NOT be combined into a conflict.
    let progress = true;
    while (progress) {
      progress = false;
      if (ia < ra.length && (ra[ia].start <= i || ra[ia].start < end)) { end = Math.max(end, ra[ia].end); aParts.push(ra[ia++]); sideA = true; progress = true; }
      if (ib < rb.length && (rb[ib].start <= i || rb[ib].start < end)) { end = Math.max(end, rb[ib].end); bParts.push(rb[ib++]); sideB = true; progress = true; }
    }

    const aLines = _applySideRegions(O, aParts, i, end);
    const bLines = _applySideRegions(O, bParts, i, end);

    if (!sideA)             out.push(...bLines);          // only theirs changed
    else if (!sideB)        out.push(...aLines);          // only ours changed
    else if (eq(aLines, bLines)) out.push(...aLines);     // same change both sides
    else {
      conflicts++;
      out.push(`<<<<<<< ${oursLabel}`, ...aLines, '=======', ...bLines, `>>>>>>> ${theirsLabel}`);
    }
    i = end;
  }

  return { content: out.join('\n'), conflicts };
}

/**
 * Diff `other` against `base` as a list of change regions aligned to base line
 * indices: each `{ start, end, lines }` means base[start,end) is replaced by
 * `lines`.  A pure insertion is a zero-width region (start === end).  Regions
 * are ordered by `start` and don't overlap.
 * @param {string[]} base
 * @param {string[]} other
 * @returns {Array<{start:number,end:number,lines:string[]}>}
 */
function diffRegions(base, other) {
  const rows = lineDiff(base.join('\n'), other.join('\n'));
  // lineDiff splits '' into [] — guard the degenerate single-empty-line case.
  const regions = [];
  let bi = 0, cur = null;
  for (const r of rows) {
    if (r.type === 'equal') {
      if (cur) { regions.push(cur); cur = null; }
      bi++;
    } else {
      if (!cur) cur = { start: bi, end: bi, lines: [] };
      if (r.left  != null) { cur.end = bi + 1; bi++; }   // consumes a base line
      if (r.right != null) cur.lines.push(r.right);      // contributes an other line
    }
  }
  if (cur) regions.push(cur);
  return regions;
}

/** Reconstruct one side's text over base[start,end), substituting its regions. */
function _applySideRegions(base, parts, start, end) {
  const res = [];
  let p = start;
  for (const r of parts) {
    for (let k = p; k < r.start; k++) res.push(base[k]);
    res.push(...r.lines);
    p = r.end;
  }
  for (let k = p; k < end; k++) res.push(base[k]);
  return res;
}

/**
 * Compute blame information: for each line in currentText, which commit
 * last changed it.
 *
 * @param {string[]} commitChain  – ordered array of commit objects (oldest first),
 *                                   each having .hash and .patch (or .fullContent)
 * @returns {Array<{ line: string, commitHash: string }>}
 */
export function computeBlame(commitChain) {
  if (commitChain.length === 0) return [];

  let content = commitChain[0].fullContent ?? '';
  // blame[i] = hash of the commit that introduced line i
  let blame = content.split('\n').map(() => commitChain[0].hash);

  for (let ci = 1; ci < commitChain.length; ci++) {
    const commit = commitChain[ci];
    const patch = commit.patch;
    if (!patch) continue;

    const oldLines = content === '' ? [] : content.split('\n');
    const newLines = [];
    const newBlame = [];
    let idx = 0;

    for (const op of patch) {
      if (op[0] === '=') {
        for (let i = 0; i < op[1]; i++) {
          newLines.push(oldLines[idx]);
          newBlame.push(blame[idx]);
          idx++;
        }
      } else if (op[0] === '+') {
        newLines.push(op[1]);
        newBlame.push(commit.hash);
      } else if (op[0] === '-') {
        idx++;
      }
    }

    content = newLines.join('\n');
    blame = newBlame;
  }

  const finalLines = content === '' ? [] : content.split('\n');
  return finalLines.map((line, i) => ({ line, commitHash: blame[i] ?? null }));
}
