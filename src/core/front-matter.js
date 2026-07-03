/**
 * Global front matter parser.
 *
 * The global front matter MUST appear at the very start of the document,
 * before any #! shebang lines. It defines document-level metadata:
 *
 *   ---
 *   model: flow
 *   model2: grid
 *   title: My Document
 *   ---
 *
 * Keys used by the host app:
 *   model  — primary model ID (flow | grid | spatial | timeline | graph)
 *   model2 — optional secondary model ID
 *   title  — document title (topbar; also rendered by the Markdown DSL)
 *
 * Additional keys are preserved when round-tripping through
 * serializeGlobalFrontMatter but are otherwise ignored by the host.
 */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Parse global front matter from document content.
 *
 * @param {string} content
 * @returns {{ meta: Record<string,string>, bodyFrom: number }}
 *   meta     — parsed YAML key/value pairs (string values only)
 *   bodyFrom — char offset where the document body starts (0 if no front matter)
 */
export function parseGlobalFrontMatter(content) {
  const m = FM_RE.exec(content);
  if (!m) return { meta: {}, bodyFrom: 0 };
  return { meta: _parseSimpleYaml(m[1]), bodyFrom: m[0].length };
}

/**
 * Locate the front-matter region with real character offsets into `content`.
 * Unlike parseGlobalFrontMatter (which only returns the parsed map + bodyFrom),
 * this exposes the inner YAML text and where it starts, so editor features
 * (completion / lint) can map positions between the region and the document.
 *
 * @param {string} content
 * @returns {{ innerFrom: number, innerText: string, bodyFrom: number } | null}
 *   null when the document has no leading front-matter block.
 */
export function getFrontMatterRange(content) {
  const m = FM_RE.exec(content);
  if (!m) return null;
  const lead = m[0].match(/^---\r?\n/)[0].length;   // opening fence + newline
  return { innerFrom: lead, innerText: m[1], bodyFrom: m[0].length };
}

/**
 * Serialize a metadata object to a YAML front matter block.
 * Returns '' if meta has no non-null, non-empty values.
 *
 * Round-trips nested maps (e.g. `midi.keyswitches`) as indented blocks so that
 * editing one key (model/title) never destroys an unrelated nested section.
 *
 * @param {Record<string, any>} meta
 * @returns {string}
 */
export function serializeGlobalFrontMatter(meta) {
  const body = _emitYaml(meta, 0);
  if (!body.trim()) return '';
  return `---\n${body}\n---\n`;
}

function _emitYaml(obj, level) {
  const pad = '  '.repeat(level);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = _emitYaml(v, level + 1);
      if (inner.trim()) out.push(`${pad}${k}:\n${inner}`);
    } else {
      out.push(`${pad}${k}: ${v}`);
    }
  }
  return out.join('\n');
}

/**
 * Minimal YAML-subset parser supporting top-level scalars (back-compat with
 * `model`/`title`) plus indentation-based nested maps and inline flow maps
 * (`{ cc: 32, value: 6 }`).  Scalar values stay strings; consumers coerce.
 */
function _parseSimpleYaml(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.trimStart().startsWith('#'));
  const indentOf = l => l.length - l.trimStart().length;
  let i = 0;

  function block(level) {
    const obj = {};
    while (i < lines.length) {
      const ind = indentOf(lines[i]);
      if (ind < level) break;
      if (ind > level) { i++; continue; }      // stray deeper line — skip defensively
      const t = lines[i].trim();
      const c = t.indexOf(':');
      if (c < 0) { i++; continue; }
      const key = t.slice(0, c).trim();
      // Strip a trailing inline comment.  A `#` only starts a comment when
      // preceded by whitespace, so note names like `C#3` / `F#-1` are preserved.
      const val = t.slice(c + 1).replace(/\s+#.*$/, '').trim();
      i++;
      if (!key) continue;
      if (val === '') {
        // Nested block iff the next line is indented deeper; else empty scalar.
        if (i < lines.length && indentOf(lines[i]) > level) obj[key] = block(indentOf(lines[i]));
        else obj[key] = '';
      } else {
        obj[key] = _parseScalar(val);
      }
    }
    return obj;
  }
  return block(0);
}

/** Parse a scalar or an inline flow map `{ a: 1, b: 2 }` → object of strings. */
function _parseScalar(val) {
  if (val.startsWith('{') && val.endsWith('}')) {
    const o = {};
    for (const pair of val.slice(1, -1).split(',')) {
      const c = pair.indexOf(':');
      if (c < 0) continue;
      const k = pair.slice(0, c).trim();
      if (k) o[k] = pair.slice(c + 1).trim().replace(/^["']|["']$/g, '');
    }
    return o;
  }
  return val.replace(/^["']|["']$/g, '');
}
