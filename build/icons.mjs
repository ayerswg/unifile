/**
 * Unifile icon system — the "U border" icons (single source of truth).
 *
 * Design language (from the icon-system exploration sheet, "medium weight"):
 *   • The outer border is a **U** — a rounded square with the TOP side open.
 *   • A monochrome line glyph sits inside; stroke weight is medium.
 *   • Monochrome by design — the same paths render themed on the site
 *     (stroke: currentColor) and rasterized for PWA icons (phosphor green
 *     on near-black, matching the mainframe site theme).
 *
 * Suite naming: every app has a u-codename ("uPub", "uDoc", …).  The mapping
 * to shipping variants lives in ICONS below — change it in ONE place:
 *   upub → uPub · markdown → uDoc · mermaid → uDraw · abcjs → uNote
 *
 * Consumers:
 *   build/gen-icons.mjs   one-off: rasterize PNGs into templates/icons/<abbrev>/
 *   build/build.mjs       stamps per-variant icons into the PWA manifest/shell
 *   build/render-site.mjs inlines the themed SVGs on the site
 */

// Phosphor-terminal palette used for the rasterized PWA icons (must match the
// site theme in docs/assets/css/style.css).
export const ICON_BG = '#0a0f0a';
export const ICON_FG = '#4af626';

// The U border: rounded square, top intentionally open.  ViewBox is 0 0 96 96.
// The arms deliberately stop short of the top edge (y=16, not ~6): iOS renders
// home-screen icons in a square/squircle with tight corner cropping, and
// full-height arms read as touching the mask.  The glyphs stay where they are —
// only the arms were shortened.
const U_BORDER = 'M 10 16 L 10 68 A 20 20 0 0 0 30 88 L 66 88 A 20 20 0 0 0 86 68 L 86 16';

// Glyphs — arrays of path `d` strings, drawn inside the U (roughly x 26–70, y 22–66).
const GLYPHS = {
  // uPub — an open book (publishing / writing).
  pub: [
    'M 48 33 V 62',                                       // spine
    'M 48 33 C 44 27 35 25 29 28 L 29 57 C 35 55 44 56 48 62', // left page
    'M 48 33 C 52 27 61 25 67 28 L 67 57 C 61 55 52 56 48 62', // right page
  ],
  // uDoc — a document page with a folded corner + text lines.
  doc: [
    'M 53 24 H 39 A 5 5 0 0 0 34 29 V 61 A 5 5 0 0 0 39 66 H 57 A 5 5 0 0 0 62 61 V 33 Z', // page
    'M 53 24 V 33 H 62',                                  // fold
    'M 41 45 H 55',                                       // text line 1
    'M 41 53 H 55',                                       // text line 2
    'M 41 59 H 49',                                       // text line 3 (short)
  ],
  // uDraw — an image: sun + mountains (the U itself is the frame).
  draw: [
    'M 27 62 L 42 40 L 51 51 L 57 44 L 68 58',            // mountains
  ],
  // uNote — note lines + a pencil.
  note: [
    'M 27 29 H 55',                                       // line 1
    'M 27 41 H 48',                                       // line 2
    'M 27 53 H 42',                                       // line 3
    'M 62 25 L 69 32 L 53 59 L 44 64 L 46 54 Z',          // pencil
  ],
  // uDraft — a floor plan: room rectangle, interior wall, door swing.
  draft: [
    'M 28 24 H 68 V 64 H 28 Z',                           // the plan
    'M 48 24 V 38',                                       // interior wall (above the door)
    'M 48 49 V 64',                                       // interior wall (below the door)
    'M 48 38 H 59',                                       // door leaf, open 90°
    'M 59 38 A 11 11 0 0 1 48 49',                        // swing arc
  ],
};

// uDraw's sun is a circle, not a path — declared separately per glyph.
const CIRCLES = {
  draw: [{ cx: 58, cy: 32, r: 5 }],
};

/** Per-variant icon identity: DSL id → { codename, glyph, abbrev }.
 *  abbrev mirrors DSL_META in build.mjs (names templates/icons/<abbrev>/). */
export const ICONS = {
  upub:     { codename: 'uPub',   glyph: 'pub',   abbrev: 'upub' },
  markdown: { codename: 'uDoc',   glyph: 'doc',   abbrev: 'md'   },
  mermaid:  { codename: 'uDraw',  glyph: 'draw',  abbrev: 'mer'  },
  abcjs:    { codename: 'uNote',  glyph: 'note',  abbrev: 'abc'  },
  udraft:   { codename: 'uDraft', glyph: 'draft', abbrev: 'dft'  },
};

/**
 * Build the icon as an SVG string.
 * @param {string} glyph    one of GLYPHS keys ('pub' | 'doc' | 'draw' | 'note')
 * @param {object} opts
 *   size     rendered px size (default 96; viewBox is always 0 0 96 96)
 *   fg       stroke color (default 'currentColor' — themed by CSS)
 *   bg       background fill; null/undefined = transparent
 *   pad      inset the artwork by scaling it toward the center (0–0.5 of the
 *            canvas per side) — used for maskable PWA icons' safe zone
 */
export function iconSvg(glyph, { size = 96, fg = 'currentColor', bg = null, pad = 0 } = {}) {
  const paths = GLYPHS[glyph];
  if (!paths) throw new Error(`unknown icon glyph "${glyph}"`);
  const circles = CIRCLES[glyph] || [];
  const scale = 1 - 2 * pad;
  const shift = 96 * pad;
  const stroke = (d, w) => `<path d="${d}" stroke-width="${w}"/>`;
  const art = [
    stroke(U_BORDER, 6.5),
    ...paths.map(d => stroke(d, 5)),
    ...circles.map(c => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" stroke-width="5"/>`),
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">`
    + (bg ? `<rect width="96" height="96" fill="${bg}"/>` : '')
    + `<g transform="translate(${shift} ${shift}) scale(${scale})" fill="none" stroke="${fg}" stroke-linecap="round" stroke-linejoin="round">${art}</g>`
    + `</svg>`;
}
