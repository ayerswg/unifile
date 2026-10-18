/**
 * Block alignment marker for the {document} app — `{.center}` / `{.right}` /
 * `{.left}` at the end of a heading or paragraph line:
 *
 *     # Annual report {.center}
 *     Signed, the committee {.right}
 *
 * Pure helpers shared by the preview/HTML/PDF renderer (marked) and the DOCX
 * exporter; unit-tested in test/md-align.test.mjs.
 */

/** Trailing marker: optional whitespace, `{.align}`, optional whitespace, end. */
export const ALIGN_MARKER_RE = /\s*\{\.(center|centre|right|left)\}\s*$/i;

/**
 * Split a trailing alignment marker off a string.
 * @returns {{ text: string, align: 'center'|'right'|'left'|null }}
 */
export function splitAlignMarker(text) {
  const s = String(text ?? '');
  const m = ALIGN_MARKER_RE.exec(s);
  if (!m) return { text: s, align: null };
  const align = m[1].toLowerCase() === 'centre' ? 'center' : m[1].toLowerCase();
  return { text: s.slice(0, m.index), align };
}

/** CSS class for an alignment (null → ''). */
export function alignClass(align) {
  return align ? `md-align-${align}` : '';
}
