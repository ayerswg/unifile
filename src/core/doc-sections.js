/**
 * Document section parser for the #! shebang DSL declaration syntax.
 *
 * A document may contain zero or more shebang lines:
 *
 *   #!markdown@1.0.0
 *   # This section uses Markdown
 *
 *   #!mermaid@1.0.0
 *   graph TD
 *     A --> B
 *
 *   #!abcjs@1.0.0+tablature
 *   X:1
 *   T:My Tune
 *   K:G
 *
 * Rules:
 *   - If NO shebang lines are present the whole document belongs to the
 *     default DSL (state.data.dslType).  100% backwards compatible.
 *   - Content BEFORE the first #! line is an implicit section using the
 *     default DSL.
 *   - Shebang lines are EXCLUDED from the content passed to DSL render().
 *   - Version and extensions are stored but not enforced here.
 *
 * Shebang line format (must start at column 0):
 *   #!<dslId>[@<version>][+<ext1>[+<ext2>...]]
 *
 * Examples:
 *   #!markdown@1.0.0
 *   #!abcjs@1.0.0+tablature
 *   #!mermaid
 */

const SHEBANG_RE = /^#!([\w-]+)(?:@([\w.]+))?((?:\+[\w-]+)*)[ \t]*$/;

/**
 * Parse a document string into sections.
 *
 * @param {string} content  Full document text
 * @returns {Array<{
 *   dslId:       string,
 *   version:     string|null,
 *   extensions:  string[],
 *   shebangLine: number,     // 0-based line index of the #! line
 *   from:        number,     // char offset of the #! line start
 *   to:          number,     // char offset of section end (exclusive)
 *   contentFrom: number      // char offset of content start (line after #!)
 * }>}
 *
 * Returns an empty array when the document has no shebang lines.
 */
export function parseDocSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let pos = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // +1 for the \n separator (last line may have no trailing newline — clamp below)
    const lineEnd = Math.min(pos + line.length + 1, content.length);

    const m = SHEBANG_RE.exec(line);
    if (m) {
      // Close the previous section at the start of this shebang line
      if (sections.length > 0) {
        sections[sections.length - 1].to = pos;
      }

      const extensions = m[3] ? m[3].slice(1).split('+').filter(Boolean) : [];

      sections.push({
        dslId:       m[1],
        version:     m[2] ?? null,
        extensions,
        shebangLine: i,
        from:        pos,
        to:          content.length, // overridden when the next section starts
        contentFrom: lineEnd          // content starts on the line after #!
      });
    }

    // Advance: for all lines except the very last that has no trailing \n,
    // add line.length + 1; otherwise clamp to content.length.
    pos = Math.min(pos + line.length + 1, content.length);
  }

  return sections;
}

/**
 * Find the section that contains the given cursor position.
 *
 * @param {ReturnType<typeof parseDocSections>} sections
 * @param {number} pos  Cursor character offset
 * @returns {object|null}  The containing section, or null if no sections
 */
export function activeSectionAt(sections, pos) {
  if (sections.length === 0) return null;
  // Walk backwards: return the last section whose 'from' <= pos
  for (let i = sections.length - 1; i >= 0; i--) {
    if (pos >= sections[i].from) return sections[i];
  }
  return sections[0];
}

/**
 * Extract the renderable content of a section (everything after the #! line).
 *
 * @param {{ contentFrom: number, to: number }} section
 * @param {string} fullContent
 * @returns {string}
 */
export function sectionContent(section, fullContent) {
  return fullContent.slice(section.contentFrom, section.to);
}
