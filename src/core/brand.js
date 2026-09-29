/**
 * unifile brand — the `{…}` signature, single source of truth.
 *
 * Curly braces in a monospaced font ARE the unifile mark.  Every app has two
 * spellings, both set in braces:
 *
 *   name  — the app's name in braces, e.g. `{compose}`   (manifest name,
 *           home-screen label, site listing, About, page titles)
 *   mark  — a single UTF-8 TEXT glyph (never an emoji) that describes it,
 *           in braces, e.g. `{♪}`  (the app icon, the in-app title mark)
 *
 * Keyed by variant / DSL id (the keys of DSL_META in build/build.mjs).  Node
 * imports this too (build/icons.mjs, build/render-site.mjs) — keep it
 * dependency-free plain ESM with no DOM.
 *
 * Glyph choices are deliberately text-presentation code points: ¶ U+00B6,
 * ◇ U+25C7, ♪ U+266A, ✎ U+270E, ⌂ U+2302, ▭ U+25AD — none has an emoji variant, so they
 * render as monochrome text on every platform (iOS included).
 */

export const APPS = {
  markdown: { name: 'document', glyph: '¶', abbrev: 'md',   edits: 'Markdown' },
  mermaid:  { name: 'diagram',  glyph: '◇', abbrev: 'mer',  edits: 'Mermaid' },
  abcjs:    { name: 'compose',  glyph: '♪', abbrev: 'abc',  edits: 'ABC notation' },
  upub:     { name: 'write',    glyph: '✎', abbrev: 'upub', edits: 'Markdown books' },
  udraft:   { name: 'draft',    glyph: '⌂', abbrev: 'dft',  edits: 'floor plans' },
  slides:   { name: 'slides',   glyph: '▭', abbrev: 'sld',  edits: 'Marp slide decks' },
};

/** Wrap anything in the signature braces: brace('compose') → '{compose}'. */
export const brace = (s) => `{${s}}`;

/** '{compose}' — the app's display name. Unknown id → '{unifile}'. */
export function appName(id) {
  return brace(APPS[id]?.name ?? 'unifile');
}

/** '{♪}' — the app's icon mark. Unknown id → '{}'. */
export function appMark(id) {
  return brace(APPS[id]?.glyph ?? '');
}

/** The bare glyph ('♪'), for callers that set their own braces. */
export function appGlyph(id) {
  return APPS[id]?.glyph ?? '';
}
