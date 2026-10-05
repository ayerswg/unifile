/**
 * Mermaid front matter forwarding — pure, Node-tested (test/mermaid-front-matter.test.mjs).
 *
 * Mermaid reads its OWN YAML front matter: `config:` (look: handDrawn,
 * layout: elk | dagre, theme, flowchart.curve, …) and `displayMode:` (gantt
 * `compact`).  Since mermaid 11 that block is the only way to pick the look or
 * the layout engine of a diagram.  In unifile the leading `---` block is the
 * DOCUMENT's front matter (title, model, layout, …) and is stripped before a
 * section's body reaches its DSL — so the {diagram} app forwards the mermaid
 * keys out of it as a mermaid front matter block in front of the diagram text.
 * The RAW YAML lines are forwarded (not a re-serialisation of unifile's parsed
 * map, whose values are all strings) so mermaid's real YAML parser sees
 * numbers, booleans and nesting exactly as on mermaid.live.
 *
 * `title:` is deliberately NOT forwarded: it is the document title (the top
 * bar / layout heading) and mermaid would draw it into every diagram.
 */

import { getFrontMatterRange } from './front-matter.js';

/** Top-level front-matter keys mermaid understands (besides `title`). */
export const MERMAID_FRONT_MATTER_KEYS = ['config', 'displayMode'];

const FORWARDED = new Set(MERMAID_FRONT_MATTER_KEYS);

/**
 * The lines of `innerYaml` (the text between the `---` fences) that belong to
 * a mermaid key: the `key:` line itself plus its indented continuation lines.
 * Blank lines are dropped; YAML comments inside a forwarded block are kept.
 *
 * @param {string} innerYaml
 * @returns {string[]}
 */
export function mermaidFrontMatterLines(innerYaml) {
  const out = [];
  let taking = false;
  for (const raw of String(innerYaml ?? '').split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*)\s*:/.exec(raw);
    if (top) taking = FORWARDED.has(top[1]);
    else if (/^\S/.test(raw) && !raw.startsWith('#')) taking = false;   // some other top-level construct
    if (taking && raw.trim() !== '') out.push(raw);
  }
  return out;
}

/**
 * Turn diagram text into what mermaid should parse.
 *
 * `text` is either a bare diagram body (the live preview — the layout has
 * already stripped the document's front matter, whose inner YAML arrives as
 * `docFrontMatterYaml`), or a full document / section that still carries its
 * own leading `---` block (exports receive the whole document): that block is
 * stripped and its mermaid keys forwarded the same way, so what you see is
 * what you export.
 *
 * @param {string} text
 * @param {string|null} [docFrontMatterYaml]  Inner YAML of the document's front
 *   matter, used only when `text` has no leading block of its own.
 * @returns {{ source: string, body: string, prefixLines: number }}
 *   `source` = what mermaid parses; `body` = the diagram text without any front
 *   matter (its char offsets are the editor's); `prefixLines` = how many lines
 *   `source` has in front of `body` (for mapping parser line numbers back).
 */
export function prepareMermaidSource(text, docFrontMatterYaml = null) {
  const str = String(text ?? '');
  const region = getFrontMatterRange(str);
  const body = region ? str.slice(region.bodyFrom) : str;
  const inner = region ? region.innerText : docFrontMatterYaml;
  const lines = inner ? mermaidFrontMatterLines(inner) : [];
  if (!lines.length) return { source: body, body, prefixLines: 0 };
  return {
    source: `---\n${lines.join('\n')}\n---\n${body}`,
    body,
    prefixLines: lines.length + 2,
  };
}
