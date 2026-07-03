/**
 * Front-matter schema engine.
 *
 * Each DSL owns a *complete* declarative schema describing the front-matter it
 * understands (see `dsl.frontMatterSchema`).  This module turns any such schema
 * into two editor features, so a DSL only writes data, never logic:
 *
 *   • schemaCompletions() — key / enum-value autocomplete inside the FM block
 *   • schemaLint()        — unknown-key / bad-enum / bad-number / duplicate-key
 *                            diagnostics
 *
 * Both share one structural pass (`parseFmEntries`) over the raw region so the
 * completion path and the lint path can never disagree about the YAML shape.
 *
 * ── Schema descriptor ──────────────────────────────────────────────────────
 * A schema is a plain object mapping key → node.  A node is one of:
 *
 *   { type: 'string',  doc }
 *   { type: 'number',  doc }
 *   { type: 'enum',    values: string[], doc }
 *   { type: 'map',     doc,
 *       children:    { key: node, … }   // fixed, known sub-keys
 *       | freeform:  true,              // user-invented keys (e.g. midi.map)
 *       valueSchema: { key: node, … } } // schema applied to each freeform value
 *
 * `freeform` and `children` are mutually exclusive.  A freeform map may still
 * carry a `valueSchema` (each user key descends into that shape — e.g.
 * `midi.voices.<n>` → { channel, volume, pan, … }).
 */

// ---------------------------------------------------------------------------
// Schema navigation
// ---------------------------------------------------------------------------

/** Wrap the root schema object as a map node so traversal is uniform. */
function rootNode(schema) {
  return { type: 'map', children: schema || {} };
}

/**
 * The node reached by descending one key from a map node, or null if the key is
 * not valid there.  Freeform maps accept any key: they descend into valueSchema
 * (as a map) when present, else into a permissive 'any' node.
 */
function childOf(node, key) {
  if (!node) return null;
  if (node.children && Object.prototype.hasOwnProperty.call(node.children, key)) {
    return node.children[key];
  }
  if (node.type === 'map' && node.freeform) {
    return node.valueSchema ? { type: 'map', children: node.valueSchema } : { type: 'any' };
  }
  return null;
}

/** Resolve the node at an absolute key path (array of keys). null if invalid. */
function resolveNode(schema, path) {
  let node = rootNode(schema);
  for (const key of path) {
    node = childOf(node, key);
    if (!node) return null;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Structural parse of the front-matter region
// ---------------------------------------------------------------------------

/**
 * Parse the inner YAML text into positioned entries with resolved key paths.
 * Offsets are relative to `innerText`; callers add the region's base offset.
 *
 * @param {string} innerText  the YAML between the `---` fences
 * @returns {{ path: string[], key: string, value: string, indent: number,
 *             keyFrom: number, keyTo: number, valFrom: number, valTo: number }[]}
 */
export function parseFmEntries(innerText) {
  const entries = [];
  const stack = [];          // enclosing blocks: { indent, key }
  let pos = 0;

  for (const raw of innerText.split(/(?<=\n)/)) {
    const lineStart = pos;
    pos += raw.length;
    const line = raw.replace(/\r?\n$/, '');
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;   // blank / comment line

    const indent = line.length - trimmed.length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;                             // not a key line
    const key = trimmed.slice(0, colon).trim();
    if (!key) continue;

    // Value = text after the colon, minus an inline comment.  A `#` only starts
    // a comment when preceded by whitespace (so note names like `C#3` survive).
    const rawVal = trimmed.slice(colon + 1);
    const value = rawVal.replace(/\s+#.*$/, '').trim();

    const keyFrom = lineStart + indent;
    const valOffset = colon + 1 + (rawVal.length - rawVal.trimStart().length);
    const valFrom = lineStart + indent + valOffset;

    entries.push({
      path: stack.map(s => s.key),
      key,
      value,
      indent,
      keyFrom,
      keyTo: keyFrom + key.length,
      valFrom,
      valTo: valFrom + value.length,
    });

    // A key with no scalar value opens a nested block for deeper-indented lines.
    if (value === '') stack.push({ indent, key });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Compute front-matter completions at a document position.
 *
 * @param {object} schema        the DSL's frontMatterSchema
 * @param {object} region        { innerFrom, innerText } from getFrontMatterRange
 * @param {number} pos           absolute cursor offset in the document
 * @param {boolean} explicit     true when the user forced completion (Ctrl-Space)
 * @returns {{ from: number, options: object[] } | null}  null = not applicable
 */
export function schemaCompletions(schema, region, pos, explicit) {
  const base = region.innerFrom;
  const posIn = pos - base;
  const text = region.innerText;
  if (posIn < 0 || posIn > text.length) return null;

  // Split the region into the current (partial) line and everything before it.
  const lineStart = text.lastIndexOf('\n', posIn - 1) + 1;
  const before = text.slice(0, lineStart);
  const lineToCursor = text.slice(lineStart, posIn);

  const trimmed = lineToCursor.trimStart();
  const indent = lineToCursor.length - trimmed.length;
  const colon = trimmed.indexOf(':');

  // Resolve the enclosing block by replaying entries on the preceding lines.
  const priorEntries = parseFmEntries(before);
  const stack = [];
  for (const e of priorEntries) {
    while (stack.length && stack[stack.length - 1].indent >= e.indent) stack.pop();
    if (e.value === '') stack.push({ indent: e.indent, key: e.key });
  }
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  const parentPath = stack.map(s => s.key);
  const parentNode = resolveNode(schema, parentPath);
  if (!parentNode) return null;

  // ── Value position: after the colon → offer enum values. ──────────────────
  if (colon >= 0) {
    const key = trimmed.slice(0, colon).trim();
    const node = childOf(parentNode, key);
    if (!node || node.type !== 'enum') return null;
    const valPart = trimmed.slice(colon + 1);
    const typed = valPart.trimStart();
    const from = base + lineStart + indent + colon + 1 + (valPart.length - typed.length);
    return {
      from,
      options: node.values.map(v => ({ label: v, type: 'enum', info: node.doc })),
    };
  }

  // ── Key position: offer child keys of the enclosing map. ──────────────────
  if (parentNode.type !== 'map' || !parentNode.children) return null;
  const present = new Set(
    parseFmEntries(text)
      .filter(e => e.path.length === parentPath.length &&
                   e.path.every((k, i) => k === parentPath[i]))
      .map(e => e.key)
  );
  const from = base + lineStart + indent;
  const options = Object.entries(parentNode.children)
    .filter(([k]) => !present.has(k) || k === trimmed)   // hide keys already set
    .map(([k, node]) => ({
      label: k,
      type: node.type === 'map' ? 'namespace' : 'property',
      detail: node.type === 'enum' ? node.values.join(' | ')
            : node.type === 'map'  ? '' : node.type,
      info: node.doc,
      apply: node.type === 'map' ? `${k}:` : `${k}: `,
    }));
  if (!options.length) return null;
  return { from, options };
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * Validate the front-matter region against the schema.
 *
 * @param {object} schema   the DSL's frontMatterSchema
 * @param {object} region   { innerFrom, innerText } from getFrontMatterRange
 * @returns {{ from, to, severity, message }[]}  positions are absolute (doc)
 */
export function schemaLint(schema, region) {
  const base = region.innerFrom;
  const entries = parseFmEntries(region.innerText);
  const diags = [];
  const seen = new Set();

  for (const e of entries) {
    const parentNode = resolveNode(schema, e.path);
    // Parent path itself is invalid (unknown ancestor) — it will already be
    // flagged at the ancestor line, so don't pile on here.
    if (!parentNode) continue;

    // Duplicate key at the same path.
    const sig = e.path.join(' ') + ' ' + e.key;
    if (seen.has(sig)) {
      diags.push({
        from: base + e.keyFrom, to: base + e.keyTo, severity: 'warning',
        message: `Duplicate key "${e.key}" — the later value wins.`,
      });
    }
    seen.add(sig);

    const node = childOf(parentNode, e.key);

    // Unknown key (only meaningful for fixed-children maps; freeform accepts any).
    if (!node) {
      if (parentNode.type === 'map' && parentNode.children) {
        const suggestion = closestKey(e.key, Object.keys(parentNode.children));
        diags.push({
          from: base + e.keyFrom, to: base + e.keyTo, severity: 'warning',
          message: `Unknown key "${e.key}".` + (suggestion ? ` Did you mean "${suggestion}"?` : ''),
        });
      }
      continue;
    }

    // Value checks (skip empty — an empty value opens a nested block).
    if (e.value === '' || e.value.startsWith('{')) continue;
    if (node.type === 'enum' && !node.values.includes(e.value)) {
      diags.push({
        from: base + e.valFrom, to: base + e.valTo, severity: 'error',
        message: `"${e.value}" is not valid for ${e.key}. Expected: ${node.values.join(', ')}.`,
      });
    } else if (node.type === 'number' && Number.isNaN(Number(e.value))) {
      diags.push({
        from: base + e.valFrom, to: base + e.valTo, severity: 'warning',
        message: `${e.key} should be a number, got "${e.value}".`,
      });
    }
  }
  return diags;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Nearest candidate within edit-distance 2 (for "did you mean" hints). */
function closestKey(word, candidates) {
  let best = null, bestD = 3;
  for (const c of candidates) {
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}
