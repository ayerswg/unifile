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
