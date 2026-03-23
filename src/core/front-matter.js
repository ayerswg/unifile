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
 * Serialize a metadata object to a YAML front matter block.
 * Returns '' if meta has no non-null, non-empty values.
 *
 * @param {Record<string,string>} meta
 * @returns {string}
 */
export function serializeGlobalFrontMatter(meta) {
  const entries = Object.entries(meta).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  return `---\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
}

function _parseSimpleYaml(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = val;
  }
  return result;
}
