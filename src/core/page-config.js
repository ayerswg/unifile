/**
 * Printed-page configuration shared by the {document} app's PDF export
 * (dsl/markdown-print.js) and the paginated `layout: document` preview
 * (layout/flow-document.js).  ONE front matter drives both:
 *
 *   page:          letter | a4 | a5 | legal | <W>x<H>  (px)       default letter
 *   margin:        CSS shorthand, 1–4 values; px (default), in, cm, mm, pt   default 0.75in
 *   font:          serif | sans | mono | <any font-family>
 *   font-size:     e.g. 12px / 11pt                                default 12px
 *   line-height:   e.g. 1.6                                        default 1.6
 *   header:        centre header template     header-left / header-right: sides
 *   footer:        centre footer template     footer-left / footer-right: sides
 *   page-numbers:  on | off | none | top-left … bottom-right  (`on` = bottom-center)
 *                  ON by default: a bare document prints just its page numbers
 *   title-page:    true → the title block gets a page of its own
 *   date:          printed verbatim; `today` (or unset for the {date} token)
 *                  = today's date in the user's locale
 *
 * Templates take {page} {total} {title} {subtitle} {author} {date}.
 * Pure (no DOM) — unit-tested in test/page-config.test.mjs.
 */

/** The default margin on every side — Word/Docs-style round inches, a bit tighter than 1in. */
export const DEFAULT_MARGIN = '0.75in';
/** Page numbers print unless the front matter says `page-numbers: off`. */
export const DEFAULT_PAGE_NUMBERS = 'bottom-center';

/** Page sizes in CSS px at 96 dpi. */
export const PAGE_PX = {
  letter: { w: 816,  h: 1056 },  // 8.5 × 11 in
  a4:     { w: 794,  h: 1123 },  // 210 × 297 mm
  a5:     { w: 559,  h: 794  },  // 148 × 210 mm
  legal:  { w: 816,  h: 1344 },  // 8.5 × 14 in
};

export const PAGE_NUMBER_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

const FONT_STACKS = {
  serif: 'Georgia, "Times New Roman", Times, serif',
  sans:  'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
  mono:  '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
};

/** `12px` / `1in` / `2.5cm` / `10mm` / `11pt` / bare number → CSS px. */
export function lengthToPx(v, fallback = 0) {
  const m = /^\s*(-?\d*\.?\d+)\s*(px|in|cm|mm|pt|)\s*$/i.exec(String(v ?? ''));
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'in': return n * 96;
    case 'cm': return n * 96 / 2.54;
    case 'mm': return n * 96 / 25.4;
    case 'pt': return n * 96 / 72;
    default:   return n;
  }
}

export function parsePagePx(pageStr) {
  const key = String(pageStr ?? 'letter').toLowerCase().trim();
  if (PAGE_PX[key]) return { ...PAGE_PX[key], name: key };
  const m = /^(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/.exec(key);
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]), name: null } : { ...PAGE_PX.letter, name: 'letter' };
}

/** CSS margin shorthand (1–4 values, any supported unit) → px per side. */
export function parseMargins(margin, fallback = DEFAULT_MARGIN) {
  const parts = String(margin ?? '').trim().split(/\s+/).filter(Boolean);
  const p = parts.length ? parts : String(fallback).split(/\s+/);
  let t, r, b, l;
  if (p.length === 1)      [t, r, b, l] = [p[0], p[0], p[0], p[0]];
  else if (p.length === 2) [t, r, b, l] = [p[0], p[1], p[0], p[1]];
  else if (p.length === 3) [t, r, b, l] = [p[0], p[1], p[2], p[1]];
  else                     [t, r, b, l] = p;
  return { top: lengthToPx(t), right: lengthToPx(r), bottom: lengthToPx(b), left: lengthToPx(l) };
}

/**
 * `page-numbers` value → a position or null (off).
 * `on`/`true`/`yes` = bottom-center; `off`/`false`/`no`/`none` = null.
 * Unset → the fallback (the shared default: bottom-center).
 */
export function parsePageNumbers(v, fallback = DEFAULT_PAGE_NUMBERS) {
  if (v == null || v === '') return fallback;
  const s = String(v).toLowerCase().trim();
  if (['on', 'true', 'yes'].includes(s)) return 'bottom-center';
  if (['off', 'false', 'no', 'none'].includes(s)) return null;
  if (PAGE_NUMBER_POSITIONS.includes(s)) return s;
  return fallback;
}

export function fontStack(font) {
  const f = String(font ?? '').trim();
  if (!f) return '';
  return FONT_STACKS[f.toLowerCase()] ?? f;
}

/** `date:` value → printed string. `today` / empty → today's locale date. */
export function resolveDate(v, now = new Date()) {
  const s = String(v ?? '').trim();
  if (!s || s.toLowerCase() === 'today') return now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return s;
}

const TRUE_RE = /^(true|yes|on|1)$/i;

/**
 * @param {Record<string,string>} meta   parsed front matter
 * @param {{ pageNumbers?: string|null, margin?: string }} [defaults]  override the shared defaults
 *        (0.75in margins, bottom-centre page numbers); pass `pageNumbers: null` for none
 */
export function parsePageConfig(meta = {}, defaults = {}) {
  const px      = parsePagePx(meta.page ?? 'letter');
  const margins = parseMargins(meta.margin, defaults.margin ?? DEFAULT_MARGIN);
  const title   = meta.title ?? '';
  return {
    pageName:     px.name,
    pageW:        px.w,
    pageH:        px.h,
    marginTop:    margins.top,
    marginRight:  margins.right,
    marginBottom: margins.bottom,
    marginLeft:   margins.left,
    usableW:      px.w - margins.left - margins.right,
    usableH:      px.h - margins.top  - margins.bottom,
    font:         fontStack(meta.font),
    fontSize:     meta['font-size']   ?? '12px',
    lineHeight:   meta['line-height'] ?? '1.6',
    title,
    subtitle:     meta.subtitle ?? '',
    author:       meta.author ?? '',
    date:         meta.date ?? '',
    header:       { left: meta['header-left'] ?? '', center: meta.header ?? '', right: meta['header-right'] ?? '' },
    footer:       { left: meta['footer-left'] ?? '', center: meta.footer ?? '', right: meta['footer-right'] ?? '' },
    pageNumbers:  parsePageNumbers(meta['page-numbers'], 'pageNumbers' in defaults ? defaults.pageNumbers : DEFAULT_PAGE_NUMBERS),
    titlePage:    TRUE_RE.test(String(meta['title-page'] ?? '')),
  };
}

/** True when any header slot has text. */
export function hasSlots(slots) {
  return !!(slots && (slots.left || slots.center || slots.right));
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Fill a header/footer template.  Escapes the template, then substitutes the
 * tokens (escaped too).  `{total}` with `total == null` becomes a
 * `<span data-uf-total>` the caller back-fills once the page count is known.
 */
export function fillTokens(template, vars = {}) {
  const totalHtml = vars.total == null ? '<span data-uf-total></span>' : escHtml(vars.total);
  return escHtml(template ?? '')
    .replace(/\{page\}/g,     escHtml(vars.page ?? ''))
    .replace(/\{total\}/g,    totalHtml)
    .replace(/\{title\}/g,    escHtml(vars.title ?? ''))
    .replace(/\{subtitle\}/g, escHtml(vars.subtitle ?? ''))
    .replace(/\{author\}/g,   escHtml(vars.author ?? ''))
    .replace(/\{date\}/g,     escHtml(vars.date ?? resolveDate('')));
}
