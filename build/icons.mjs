/**
 * unifile icon system — the `{glyph}` mark (single source of truth for the
 * rasterized app icons).
 *
 * The brand is curly braces in a monospaced font (see src/core/brand.js).  An
 * app icon is literally its mark — `{♪}` for {compose}, `{¶}` for {document} —
 * set in a monospaced face, light on a near-black tile.  No artwork paths:
 * the glyph IS the icon, so the same string that heads the in-app title bar
 * and the site listing is what sits on the home screen.
 *
 * Consumers:
 *   build/gen-icons.mjs   one-off: rasterize PNGs into templates/icons/<abbrev>/
 *   build/build.mjs       stamps per-variant icons into the PWA manifest/shell
 *   build/render-site.mjs sets the marks as text on the site (this module only
 *                         supplies the favicon there)
 */

import { APPS, appMark, appName } from '../src/core/brand.js';

export { APPS, appMark, appName };

// Icon tile palette: neutral near-black + off-white, matching the apps' dark
// chrome (the phosphor-terminal green went with the retired site theme).
export const ICON_BG = '#141416';
export const ICON_FG = '#f2f2f0';

// Monospaced stack for SVG text.  Headless Chromium (gen-icons) resolves this
// to DejaVu Sans Mono, which covers every glyph in APPS; a browser rendering
// the SVG live falls through to its own mono face.
export const ICON_FONT = "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

/**
 * Build the icon as an SVG string: the app's `{glyph}` mark centred on a tile.
 * @param {string} id  variant / DSL id (a key of APPS)
 * @param {object} opts
 *   size     rendered px size (default 96; viewBox is always 0 0 96 96)
 *   fg       text colour (default 'currentColor' — themed by CSS)
 *   bg       tile fill; null/undefined = transparent
 *   pad      inset the mark toward the centre (0–0.5 of the canvas per side)
 *            — used for maskable PWA icons' safe zone
 */
export function iconSvg(id, { size = 96, fg = 'currentColor', bg = null, pad = 0 } = {}) {
  if (!APPS[id]) throw new Error(`unknown app id "${id}"`);
  const mark = appMark(id);
  const scale = 1 - 2 * pad;
  const shift = 96 * pad;
  // Three mono cells ({, glyph, }) at 0.6em advance each ≈ 1.8em wide; 46px
  // fills ~83px of the 96px tile, leaving iOS's squircle mask a safe margin.
  const fontSize = 46;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">`
    + (bg ? `<rect width="96" height="96" fill="${bg}"/>` : '')
    + `<g transform="translate(${shift} ${shift}) scale(${scale})">`
    + `<text x="48" y="48" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="${ICON_FONT.replace(/"/g, '&quot;')}" font-size="${fontSize}" font-weight="500" fill="${fg}"`
    + ` xml:space="preserve">${_escXml(mark)}</text>`
    + `</g></svg>`;
}

/** Site favicon: the bare `{}` on white. */
export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">`
    + `<rect width="96" height="96" fill="#ffffff"/>`
    + `<text x="48" y="50" text-anchor="middle" dominant-baseline="central"`
    + ` font-family="${ICON_FONT.replace(/"/g, '&quot;')}" font-size="62" font-weight="600" fill="#1a1a1a">{}</text>`
    + `</svg>`;
}

function _escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
