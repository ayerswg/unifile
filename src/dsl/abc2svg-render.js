// abc2svg engraving engine — the app's default score renderer.
//
// Dual-engine architecture: abc2svg (Jean-François Moine's JS successor to
// abcm2ps) does the ENGRAVING — visibly better beams/slurs/spacing than abcjs —
// while abcjs still parses the same source for everything audible: synth,
// Web-MIDI, keyswitches, note timing (see abcjs.js, which renders abcjs into a
// hidden container to keep TimingCallbacks alive).
//
// Escape hatch (no rebuild): localStorage.setItem('uf_engraver','abcjs') falls
// back to the abcjs renderer; remove the key to return to abc2svg.
//
// Interactivity is built on abc2svg's own annotation mechanism (the same one
// its official editor uses, see node_modules/abc2svg/edit-1.js): a
// `user.anno_stop` callback fires per engraved symbol with its source char
// range + staff box, and we emit an invisible <rect class="abcr _<istart>_">
// over each one via abc.out_svg/out_sxsy (which handle staff-coordinate
// scaling). Those rects then drive, via CSS classes:
//   click → source   (rect click → istart/iend → 'dsl-select')
//   .uf-hl           editor-selection / clicked-note highlight — on the
//                    symbol's OWN glyphs (heads, stem, flags, dots, accidentals,
//                    ledger lines; the beam too once every note under it is lit)
//   .uf-play         playback "now sounding" highlight (same glyph targets)
//   .uf-range        selected playback range band
//   .uf-muted        muted-voice dim on a mixed staff (bg-tinted overlay);
//                    fully muted staves get a full-width .uf-staff-veil band
// The playback cursor bar is an absolutely-positioned div moved between rects.
//
// abc2svg is a <script>-tag library (populates a global); the esbuild
// `abc2svgExportPlugin` (build.mjs) appends an `export default` for bundling.
import abc2svg from 'abc2svg/abc2svg-1.js';
// String-tablature module (%%strtab): self-registers into abc2svg.modules and
// hooks every new Abc instance (pass-through when no %%strtab directive).
import 'abc2svg/strtab-1.js';
import { DEFAULT_LINEBREAK } from '../core/abc-shorthand.js';

/** abc2svg's own page width when none is injected (A4 at 96 dpi, px). */
const DEFAULT_PAGE_WIDTH = 794;

/** True when abc2svg is the active engraver (default; 'abcjs' opts out). */
export function useAbc2svg() {
  try { return localStorage.getItem('uf_engraver') !== 'abcjs'; } catch { return true; }
}

// abc2svg frontends define these hooks; the core calls them. No-ops keep it
// fully offline (no %%abc-include fetches, no dynamic module loads).
abc2svg.abc_end = abc2svg.abc_end || function () {};
abc2svg.loadjs  = abc2svg.loadjs  || function (_fn, relay) { if (relay) relay(); };

// Symbol types excluded from INTERACTIVE annotation rects (they span other
// symbols' geometry and would swallow their clicks/highlights — same
// exclusions as abc2svg's own editor). They still get a non-interactive
// `abcd` geometry rect so the muted-staff veil can cover them (a muted
// voice's slur arcs above the band otherwise stayed crisp).
const SKIP_ANNO = new Set(['beam', 'slur', 'tuplet']);

/** Source offsets of every symbol under the beam starting at `s1` — the voice
 *  chain from the `beam_st` symbol to the `beam_end` one (grace-note beams
 *  chain the same way). */
function beamMembers(s1) {
  const out = [];
  for (let n = s1, guard = 0; n && guard < 512; n = n.next, guard++) {
    if (n.istart != null) out.push(n.istart);
    if (n.beam_end) break;
  }
  return out;
}

/**
 * Core engraving pass. Returns { chunks, errors, annos } where `chunks` are the
 * raw SVG strings abc2svg emitted (one per staff system) and `annos` records
 * each annotated symbol { start, end, voice } in emission order (1:1 with the
 * `rect.abcr` elements when `annotate` is on).
 */
function engrave(content, { annotate = false, preserveSheet = false } = {}) {
  const chunks = [], errors = [], annos = [];
  let abc = null;
  // Every Abc instance's first style insertion WIPES the shared document
  // stylesheet (abc2svg.sheet) and refills it with its own class names. An
  // export engraves with %%fullsvg, whose class names are suffixed (f0x…) —
  // so without restoring, an export leaves the sheet holding only f0x rules
  // while the live in-app svg still references f0/f1: every notehead/clef in
  // the APP turned to tofu right after using print/SVG export (real bug).
  const sheet = preserveSheet ? abc2svg.sheet : null;
  const savedRules = sheet ? [...sheet.cssRules].map(r => r.cssText) : null;
  const user = {
    read_file: () => '',                       // %%abc-include: offline, unsupported
    errmsg: (msg) => errors.push(String(msg)),
    img_out: (s) => chunks.push(s),
  };
  if (annotate) {
    // NOTE: do NOT try to wrap each symbol's output in a <g> via anno_start/
    // anno_stop — abc2svg buffers SVG per staff and interleaves symbol output,
    // so the open/close tags mis-nest and one group swallows its neighbours.
    // Rect overlays (its own editor's pattern) + geometric glyph mapping
    // (below, in renderAbc2svg) are the reliable route.
    user.anno_stop = (type, start, stop, x, y, w, h, s) => {
      const deco = SKIP_ANNO.has(type);
      const anno = { start, end: stop, voice: s?.p_v?.id ?? null, staff: s?.st ?? null, type, deco };
      // A beam is annotated with its FIRST note's range only; remember every
      // symbol under it so the highlight can light the beam once all are lit.
      if (type === 'beam') anno.members = beamMembers(s);
      annos.push(anno);
      // The abc2svg editor's exact pattern: out_sxsy/sh map staff coords → SVG.
      abc.out_svg(`<rect class="${deco ? 'abcd' : 'abcr'} _${start}_" x="`);
      abc.out_sxsy(x, '" y="', y);
      abc.out_svg(`" width="${w.toFixed(2)}" height="${abc.sh(h).toFixed(2)}"/>\n`);
    };
  }
  try {
    abc = new abc2svg.Abc(user);
    abc.tosvg('unifile', content);
    abc2svg.abc_end();
  } catch (e) {
    errors.push(e && e.message ? e.message : String(e));
  } finally {
    if (savedRules && abc2svg.sheet === sheet) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) sheet.deleteRule(i);
      for (const t of savedRules) {
        try { sheet.insertRule(t, sheet.cssRules.length); } catch { /* rule not re-insertable */ }
      }
    }
  }
  return { chunks, errors, annos };
}

/**
 * abc2svg batches a whole line of music glyphs into ONE <text> element with
 * per-character x/y coordinate lists (SMuFL codepoints: clefs, noteheads,
 * rests…). Individual notes therefore aren't addressable elements. Split each
 * such text into per-character <tspan>s carrying their own x/y — rendering is
 * identical, but every glyph becomes an element the highlight mapping can
 * colour. Texts with a font class (f0…, titles/labels) or a single position
 * are left alone.
 */
const _SVG_NS = 'http://www.w3.org/2000/svg';
function explodeGlyphTexts(el) {
  el.querySelectorAll('svg text').forEach((t) => {
    if (t.getAttribute('class') || t.firstElementChild) return;
    const xs = (t.getAttribute('x') || '').split(',');
    if (xs.length < 2) return;
    const ys = (t.getAttribute('y') || '').split(',');
    const chars = [...t.textContent];
    if (chars.length !== xs.length) return;   // unexpected shape — don't touch
    t.textContent = '';
    t.removeAttribute('x');
    t.removeAttribute('y');
    chars.forEach((ch, i) => {
      const ts = document.createElementNS(_SVG_NS, 'tspan');
      ts.setAttribute('x', xs[i]);
      ts.setAttribute('y', ys[i] ?? ys[ys.length - 1]);
      ts.textContent = ch;
      t.appendChild(ts);
    });
  });
}

/**
 * abc2svg also batches STEMS (one `<path class="sW" d="Mx yv-21Mx yv-19…">`
 * per flush), bar lines (`bW`, same shape) and LEDGER LINES (one `<path
 * class="stroke" d="Mx y m-6 0h12 m120 0h12…">` per staff row). Split each
 * into one <path> per subpath, in absolute coordinates, same attributes —
 * rendering is identical, but a single stem or ledger line becomes an element
 * the highlight can colour. Paths using anything beyond M/m/H/h/V/v/L/l are
 * left untouched.
 */
function explodeBatchedPaths(el) {
  el.querySelectorAll('svg path.sW, svg path.bW, svg path.stroke').forEach((p) => {
    const segs = splitSubpaths(p.getAttribute('d') || '');
    if (!segs || !segs.length) return;
    if (segs.length === 1) { p.setAttribute('d', segs[0]); return; }
    for (const d of segs) {
      const q = p.cloneNode(false);
      q.setAttribute('d', d);
      p.parentNode.insertBefore(q, p);
    }
    p.remove();
  });
}

/** 'M96.1 92.0v18.7M114.6 89.0v19.6' → ['M96.1 92V110.7', 'M114.6 89V108.6'].
 *  Subpaths that only move (no drawing) are dropped; null when the path has
 *  commands other than M/m/H/h/V/v/L/l. */
function splitSubpaths(d) {
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)/g;
  const r = (v) => String(Math.round(v * 100) / 100);
  const out = [];
  let cmd = null, x = 0, y = 0, cur = null, drew = false, nums = [], m;
  const flush = () => { if (cur && drew) out.push(cur); cur = null; drew = false; };
  while ((m = re.exec(d))) {
    if (m[1]) {
      cmd = m[1];
      nums = [];
      if (!'MmHhVvLl'.includes(cmd)) return null;
      continue;
    }
    if (!cmd) return null;
    nums.push(parseFloat(m[2]));
    switch (cmd) {
      case 'M': case 'm':
        if (nums.length === 2) {
          x = cmd === 'm' ? x + nums[0] : nums[0];
          y = cmd === 'm' ? y + nums[1] : nums[1];
          flush();
          cur = `M${r(x)} ${r(y)}`;
          cmd = cmd === 'm' ? 'l' : 'L';     // further pairs are implicit linetos
          nums = [];
        }
        break;
      case 'L': case 'l':
        if (nums.length === 2) {
          x = cmd === 'l' ? x + nums[0] : nums[0];
          y = cmd === 'l' ? y + nums[1] : nums[1];
          cur += `L${r(x)} ${r(y)}`; drew = true; nums = [];
        }
        break;
      case 'H': case 'h':
        x = cmd === 'h' ? x + nums[0] : nums[0];
        cur += `H${r(x)}`; drew = true; nums = [];
        break;
      case 'V': case 'v':
        y = cmd === 'v' ? y + nums[0] : nums[0];
        cur += `V${r(y)}`; drew = true; nums = [];
        break;
    }
  }
  flush();
  return out;
}

// ── Glyph → symbol mapping, from the SVG's own coordinates (no layout) ─────
//
// Every glyph abc2svg draws for a symbol — notehead tspans, the stem segment,
// flags/dots/accidentals (glyphs too), ledger lines — carries its position in
// the same user space the annotation rect was emitted in (both go through
// abc2svg's sx/sy, or share the same `<g transform>` when a voice is scaled).
// So a glyph belongs to the smallest annotation box containing its anchor
// point, computed from ATTRIBUTES: no getBoundingClientRect, which is 0×0 in a
// hidden pane (the phone's render pane while the editor shows — where the
// lazy screen-space map of 2026-09 never latched and every highlight fell
// back to the rect tint) and unreliable for tspans on WebKit.

const mulM = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const applyM = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** An SVG `transform` attribute → affine matrix [a b c d e f]. */
function parseTransform(str) {
  let m = IDENTITY;
  const re = /(translate|scale|rotate|matrix)\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n = null;
    switch (t[1]) {
      case 'translate': n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale':     n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = (v[0] || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        n = [cos, sin, -sin, cos, 0, 0];
        if (v.length > 2) n = mulM(mulM([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      }
      case 'matrix':    n = v.length === 6 ? v : null; break;
    }
    if (n) m = mulM(m, n);
  }
  return m;
}

/** Matrix from `el`'s user space to its <svg> root (ancestor <g transform>s). */
function rootMatrix(el, memo) {
  if (!el || el.tagName === 'svg') return IDENTITY;
  let m = memo.get(el);
  if (!m) {
    m = rootMatrix(el.parentElement, memo);
    const tr = el.getAttribute('transform');
    if (tr) m = mulM(m, parseTransform(tr));
    memo.set(el, m);
  }
  return m;
}

const numAttr = (el, a) => parseFloat(el.getAttribute(a));

/** The anchor point (in the element's own user space) identifying which
 *  symbol a drawn glyph belongs to; null for elements that are not a symbol's
 *  glyph (staff lines, titles/lyrics, slur arcs, beams — handled apart). */
function glyphAnchor(g) {
  switch (g.tagName) {
    case 'tspan':
      // A glyph's origin is its left edge (noteheads: vertically centred).
      return [numAttr(g, 'x') + 1, numAttr(g, 'y')];
    case 'text': {
      if (g.getAttribute('class') || g.firstElementChild) return null;   // font text / exploded container
      const tr = g.getAttribute('transform');
      if (tr) {                                      // scaled glyph: translate(X,Y) scale(…)
        const m = /translate\(\s*([-\d.]+)[\s,]+([-\d.]+)/.exec(tr);
        return m ? [+m[1], +m[2]] : null;
      }
      const x = g.getAttribute('x'), y = g.getAttribute('y');
      if (x == null || y == null || x.includes(',')) return null;
      return [+x + 1, +y];
    }
    case 'use': {
      const href = g.getAttribute('href') || g.getAttribute('xlink:href') || '';
      if (/^#st/.test(href)) return null;           // the staff-lines def
      return [numAttr(g, 'x'), numAttr(g, 'y')];
    }
    case 'path': {
      const cls = g.getAttribute('class') || '';
      const d = g.getAttribute('d') || '';
      let m;
      if ((cls === 'sW' || cls === 'bW') && (m = /^M([-\d.]+) ([-\d.]+)V([-\d.]+)$/.exec(d))) {
        return [+m[1], (+m[2] + +m[3]) / 2];         // stem / bar: its midpoint
      }
      if (cls === 'stroke' && (m = /^M([-\d.]+) ([-\d.]+)H([-\d.]+)$/.exec(d))) {
        return [(+m[1] + +m[3]) / 2, +m[2]];         // ledger line: its midpoint
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Assign every drawn glyph to its symbol (`sym.glyphs`), per system svg, and
 * every beam's polygon paths to its beam record (`beam.glyphs`: the unclassed
 * paths abc2svg emits right before the beam's annotation rect — draw_beams
 * opens and closes the annotation around its own output).
 */
function buildGlyphMap(el, syms, decoSyms) {
  const PAD = 1.5, CELL = 64;
  const bySvg = new Map();
  for (const s of syms) {
    const svg = s.el.ownerSVGElement;
    if (!svg) continue;
    let list = bySvg.get(svg);
    if (!list) bySvg.set(svg, list = []);
    list.push(s);
  }
  for (const [svg, list] of bySvg) {
    const memo = new Map();
    // Annotation boxes in root coordinates, bucketed by x for the lookup.
    const buckets = new Map();
    for (const s of list) {
      const r = s.el;
      const x = numAttr(r, 'x'), y = numAttr(r, 'y'), w = numAttr(r, 'width'), h = numAttr(r, 'height');
      if (![x, y, w, h].every(isFinite)) continue;
      const m = rootMatrix(r.parentElement, memo);
      const pts = [applyM(m, x, y), applyM(m, x + w, y), applyM(m, x, y + h), applyM(m, x + w, y + h)];
      const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
      const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
      const box = { s, x0, x1, y0, y1, area: (x1 - x0) * (y1 - y0) };
      for (let c = Math.floor((x0 - PAD) / CELL); c <= Math.floor((x1 + PAD) / CELL); c++) {
        let b = buckets.get(c);
        if (!b) buckets.set(c, b = []);
        b.push(box);
      }
    }
    svg.querySelectorAll('tspan, text, use, path').forEach((g) => {
      if (g.classList.contains('abcr') || g.classList.contains('abcd')) return;
      const a = glyphAnchor(g);
      if (!a) return;
      const parent = g.tagName === 'tspan' ? g.parentElement.parentElement : g.parentElement;
      const [px, py] = applyM(rootMatrix(parent, memo), a[0], a[1]);
      let best = null;
      for (const box of buckets.get(Math.floor(px / CELL)) ?? []) {
        if (px < box.x0 - PAD || px > box.x1 + PAD || py < box.y0 - PAD || py > box.y1 + PAD) continue;
        if (!best || box.area < best.area) best = box;
      }
      if (best) (best.s.glyphs ??= []).push(g);
    });
  }
  for (const d of decoSyms) {
    if (d.type !== 'beam') continue;
    const paths = [];
    for (let n = d.el.previousElementSibling; n; n = n.previousElementSibling) {
      if (n.tagName !== 'path' || n.getAttribute('class')) break;
      if (!/^m[-\d. ]+l/i.test(n.getAttribute('d') || '')) break;
      paths.push(n);
    }
    if (paths.length) d.glyphs = paths;
  }
}

/**
 * Make abc2svg's fixed-size <svg>s scale to their container (parity with
 * abcjs's responsive:'resize'): give each a viewBox, drop the fixed size.
 */
function makeResponsive(el) {
  el.querySelectorAll('svg').forEach((svg) => {
    const w = parseFloat(svg.getAttribute('width'));
    const h = parseFloat(svg.getAttribute('height'));
    if (w && h && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.width = '100%';
    svg.style.height = 'auto';
    svg.style.maxWidth = `${w}px`;   // don't upscale past engraved size
    svg.style.display = 'block';
  });
}

/**
 * Engrave `content` into `el` and wire interactivity. Returns a "score" object
 * (or null if abc2svg produced nothing — caller falls back to abcjs's render):
 *   highlightRange(from, to)  — selection highlight ('uf-hl'), from===to clears
 *   setPlaying(pairs|null)    — playback highlight ('uf-play')
 *   setRange(pairs|null)      — playback-range band ('uf-range')
 *   setVoiceFade(isMuted)     — dim voices where isMuted(voiceId) ('uf-muted')
 *   cursorAt(pairs|null)      — position the playback cursor bar
 * `pairs` are section-relative [{from, to}] char ranges (abcjs noteTimings
 * startChar/endChar space — identical source string, so offsets line up).
 */
export function renderAbc2svg(content, el, { onSelect } = {}) {
  // Fill the pane (parity with abcjs's responsive:'resize'): abc2svg engraves
  // to its page width — default A4 (~794px) — and AUTO-WRAPS source lines that
  // overflow it, so without this a wide system breaks early no matter how wide
  // the pane is. Inject the pane width as the page width (default-only; an
  // explicit %%pagewidth wins), with slim screen margins. A hidden pane
  // measures 0 → keep abc2svg's own default.
  //
  // The injected prefix shifts every istart abc2svg reports; syms are adjusted
  // back to content-relative offsets below so click/highlight mapping and the
  // editor stay in sync.
  const paneW = Math.round(el.clientWidth || el.parentElement?.clientWidth || 0);
  const ownPageWidth = /^%%pagewidth\b/m.test(content);
  // The width the score is engraved for: the pane's, else abc2svg's own
  // default page (A4, ~794px). A HIDDEN pane (the phone's render pane while
  // the editor shows, a collapsed split) measures 0 and gets the default —
  // the caller's ResizeObserver compares this against the pane once it is
  // visible and re-engraves (see `pageWidth` below).
  const engravedW = paneW >= 300 && !ownPageWidth ? Math.min(paneW, 1600) : DEFAULT_PAGE_WIDTH;
  let prefix = '';
  // Line flow ({compose} default, core/abc-shorthand.js): a source newline
  // does NOT end a staff line — measures flow to the page width and `$`
  // forces a break — unless the document sets its own %%linebreak.
  if (!/^%%linebreak\b/m.test(content)) prefix += `%%linebreak ${DEFAULT_LINEBREAK}\n`;
  if (paneW >= 300 && !ownPageWidth) {
    prefix += `%%pagewidth ${engravedW}\n`;
    if (!/^%%leftmargin\b/m.test(content))  prefix += '%%leftmargin 14\n';
    if (!/^%%rightmargin\b/m.test(content)) prefix += '%%rightmargin 14\n';
  }

  const { chunks, errors, annos } = engrave(prefix + content, { annotate: true });
  if (!chunks.length) return null;

  el.innerHTML = chunks.join('');
  makeResponsive(el);
  explodeGlyphTexts(el);
  explodeBatchedPaths(el);

  // Pair each rect with its anno record via the istart baked into its class.
  // NOT by emission index: abc2svg buffers SVG output per staff and joins the
  // buffers at flush time, so rect DOM order ≠ anno callback order.
  // Offsets are then shifted back by the injected prefix length so sym.start/
  // .end are content-relative (annos from inside the prefix are dropped).
  const byStart = new Map(), decoByStart = new Map();
  annos.forEach(a => {
    const m = a.deco ? decoByStart : byStart;
    if (!m.has(a.start)) m.set(a.start, a);
  });
  const pair = (r, m) => {
    const start = Number((r.getAttribute('class').match(/_(\d+)_/) || [])[1]);
    const a = m.get(start);
    if (!a || start < prefix.length) return null;
    return {
      start: start - prefix.length, end: a.end - prefix.length,
      voice: a.voice, staff: a.staff, type: a.type, el: r, glyphs: null,
      members: a.members?.map(m => m - prefix.length) ?? null,
    };
  };
  const syms = [...el.querySelectorAll('rect.abcr')]
    .map(r => pair(r, byStart)).filter(Boolean).sort((a, b) => a.start - b.start);
  // Slur/beam/tuplet geometry rects — never interactive, only consulted by the
  // muted-staff veil so a silenced voice's slur arcs fade with everything else.
  const decoSyms = [...el.querySelectorAll('rect.abcd')]
    .map(r => pair(r, decoByStart)).filter(Boolean);

  // Every drawn glyph → its symbol (and every beam polygon → its beam), from
  // the SVG's own coordinates — built now, hidden pane or not (see
  // buildGlyphMap). Gives the red/green colouring its targets: the note's own
  // heads, stem, flags, dots, accidentals and ledger lines, like abcjs's note
  // groups; a symbol that drew nothing we recognise falls back to a rect tint.
  buildGlyphMap(el, syms, decoSyms);
  const symByStart = new Map(syms.map(s => [s.start, s]));
  const beams = decoSyms.filter(d => d.type === 'beam' && d.glyphs && d.members?.length);

  // Playback cursor bar: an HTML div positioned over the rect that's sounding.
  const cursor = document.createElement('div');
  cursor.className = 'uf-a2s-cursor';
  cursor.style.display = 'none';
  el.appendChild(cursor);
  // The bar is placed from SCREEN geometry, so it must be re-placed whenever
  // the wrap's size changes: a window/split resize rescales the responsive
  // svg under it, and the phone's render pane APPEARING is the first time
  // there is any geometry at all — the position asked for while the pane was
  // display:none (the cue after an editor selection) had hidden the bar, and
  // nothing re-asked until the next transport event (the "cursor is gone"
  // report, 2026-10). Remember the last request and replay it on resize.
  let lastCursorPairs = null;
  let placeCursor = () => {};
  try {
    new ResizeObserver(() => { if (lastCursorPairs) placeCursor(lastCursorPairs); }).observe(el);
  } catch { /* no ResizeObserver — the next transport event re-places it */ }

  // Click → source range (delegated; rects sit on top of their symbols).
  // Match by element identity — sym.start is content-relative while the class
  // name still carries the raw (prefix-shifted) istart.
  el.addEventListener('click', (ev) => {
    const r = ev.target.closest?.('rect.abcr');
    if (!r) return;
    const sym = syms.find(s => s.el === r);
    if (sym && onSelect) { ev.stopPropagation(); onSelect(sym.start, sym.end); }
  });

  /** Symbols whose start falls in [from, to). */
  const inRange = (from, to) => syms.filter(s => s.start >= from && s.start < to);

  const clearClass = (cls) => {
    el.querySelectorAll(`.${cls}`).forEach(n => n.classList.remove(cls));
  };
  // Note-colouring classes (uf-hl red / uf-play green) go on the symbol's own
  // glyph elements — colouring the note itself like abcjs did. Band/veil
  // classes (uf-range / uf-muted) stay on the overlay rect. Symbols with no
  // mapped glyphs fall back to a rect tint. A beam lights up only when EVERY
  // note under it is lit (a selection of the whole group, not one note of it).
  const GLYPH_CLS = new Set(['uf-hl', 'uf-play']);
  const markPairs = (pairs, cls) => {
    clearClass(cls);
    if (!pairs) return;
    const onGlyph = GLYPH_CLS.has(cls);
    const marked = onGlyph ? new Set() : null;
    for (const p of pairs) {
      inRange(p.from, p.to).forEach((s) => {
        if (onGlyph && s.glyphs) s.glyphs.forEach(g => g.classList.add(cls));
        else s.el.classList.add(cls);
        marked?.add(s.start);
      });
    }
    if (!marked?.size) return;
    for (const b of beams) {
      const notes = b.members.filter(m => symByStart.has(m));
      if (notes.length && notes.every(m => marked.has(m))) b.glyphs.forEach(g => g.classList.add(cls));
    }
  };

  const score = {
    el,
    symCount: syms.length,
    _debug: () => ({
      syms: syms.map(s => ({ start: s.start, voice: s.voice, staff: s.staff, type: s.type,
        y: s.el.getAttribute('y'), h: s.el.getAttribute('height'),
        svg: s.el.ownerSVGElement ? [...el.querySelectorAll('svg')].indexOf(s.el.ownerSVGElement) : -1 })),
      decoSyms: decoSyms.map(s => ({ start: s.start, voice: s.voice, staff: s.staff, type: s.type,
        y: s.el.getAttribute('y'), h: s.el.getAttribute('height'),
        svg: s.el.ownerSVGElement ? [...el.querySelectorAll('svg')].indexOf(s.el.ownerSVGElement) : -1 })),
      mapped: true,
      symsWithGlyphs: syms.filter(s => s.glyphs?.length).length,
      totalGlyphs: syms.reduce((n, s) => n + (s.glyphs?.length ?? 0), 0),
      beamsWithGlyphs: beams.length,
      tspans: el.querySelectorAll('svg tspan').length,
      firstRectBox: (() => { const b = syms[0]?.el.getBoundingClientRect(); return b ? [b.x, b.y, b.width, b.height].map(Math.round) : null; })(),
    }),
    // Width the score was engraved for, so callers can re-engrave when the pane
    // ends up meaningfully different (first layout, window resize). null when
    // the document sets its own %%pagewidth — the user's layout is fixed.
    // LANDMINE (fixed 2026-10): this used to read `prefix ? paneW : 794`, and
    // once the %%linebreak default made `prefix` non-empty on every render a
    // hidden pane reported 0 → no observer → the 794px engraving stayed,
    // scaled down to a thumbnail on phones (the pane is hidden while typing).
    pageWidth: ownPageWidth ? null : engravedW,

    highlightRange(from, to) {
      markPairs(to > from ? [{ from, to }] : null, 'uf-hl');
    },

    setPlaying(pairs)  { markPairs(pairs, 'uf-play');  },
    setRange(pairs)    { markPairs(pairs, 'uf-range'); },

    setVoiceFade(isMuted) {
      // A staff whose every voice is silenced fades WHOLESALE — staff lines,
      // clef, key signature and all — via one bg-tinted band per system.
      // Per-glyph fading leaks (chord top noteheads, stems and beams don't map
      // reliably to one symbol), and a staff that still has an active voice
      // must keep its furniture crisp, so:
      //   fully muted staff  → full-width veil band over the staff
      //   mixed staff        → per-symbol veil on the muted voice's notes/rests
      el.querySelectorAll('.uf-staff-veil').forEach(r => r.remove());
      clearClass('uf-muted');

      const SOUNDING = new Set(['note', 'rest', 'grace', 'mrest']);
      const attrRect = (r) => {
        const v = ['x', 'y', 'width', 'height'].map(a => parseFloat(r.getAttribute(a)));
        return v.every(isFinite) ? v : null;
      };

      // Staff indices are PER SYSTEM: abc2svg hides staves that are tacet for
      // a whole system and renumbers the rest, so the same staff index can
      // hold different voices in different systems. Group by system svg.
      const bySvg = new Map();                // svg → Map(staff → {voices, syms})
      for (const s of syms) {
        const svg = s.el.ownerSVGElement;
        if (!svg || s.staff == null) continue;
        let perStaff = bySvg.get(svg);
        if (!perStaff) bySvg.set(svg, perStaff = new Map());
        let st = perStaff.get(s.staff);
        if (!st) perStaff.set(s.staff, st = { voices: new Set(), syms: [] });
        if (s.voice && SOUNDING.has(s.type)) st.voices.add(s.voice);
        st.syms.push(s);
      }

      // The veil is ONE compound <path> per system svg: overlapping subpaths
      // fill exactly once (nonzero winding), so adjacent bands and outlier
      // note boxes can't stack into a darker double-fade. Bands are sized
      // from the CLEF annos — the only symbol annotated per staff correctly
      // whose box brackets the staff lines + key/meter ('key'/'meter' are
      // engraved per staff but all annotated with the first voice's staff;
      // 'bar' spans the whole system on staff 0; and unioning note extents
      // dragged the band over the title/tempo header text — all real bugs).
      // Notes on ledger lines above/below the band are covered by unioning
      // each sounding symbol's own anno box into the path.
      const PAD = 4;
      for (const [svg, perStaff] of bySvg) {
        const vb = (svg.getAttribute('viewBox') || '').split(/\s+/);
        const w = parseFloat(vb[2]) || parseFloat(svg.getAttribute('width')) || 0;

        const staves = [...perStaff.values()].map((st) => {
          let top = Infinity, bot = -Infinity;
          for (const types of [['clef'], ['bar', 'rest', 'note']]) {   // fallback if no clef
            for (const s of st.syms) {
              if (!types.includes(s.type)) continue;
              const r = attrRect(s.el);
              if (r) { top = Math.min(top, r[1]); bot = Math.max(bot, r[1] + r[3]); }
            }
            if (isFinite(top)) break;
          }
          const faded = st.voices.size > 0 && [...st.voices].every(v => isMuted(v));
          return { st, top, bot, faded };
        }).filter(s => isFinite(s.top)).sort((a, b) => a.top - b.top);

        const rects = [];                     // [x, y, w, h] subpaths to union
        const fadedStaffIds = new Set();
        // Consecutive faded staves merge into one continuous block (a fully
        // muted piano brace fades as a unit, connecting barlines included).
        for (let i = 0; i < staves.length; i++) {
          if (!staves[i].faded) continue;
          let j = i;
          while (j + 1 < staves.length && staves[j + 1].faded) j++;
          rects.push([0, staves[i].top, w, staves[j].bot - staves[i].top + PAD]);
          for (let k = i; k <= j; k++) {
            fadedStaffIds.add(staves[k].st);
            for (const s of staves[k].st.syms) {
              if (!SOUNDING.has(s.type)) continue;
              const r = attrRect(s.el);
              if (r) rects.push(r);
            }
          }
          i = j;
        }
        // Beam/tuplet boxes of fully faded staves (they can poke outside the
        // band). Skipped on mixed staves — such a box spans the notes under
        // it, and veiling it would tint the audible co-voice's notes.
        for (const d of decoSyms) {
          if (d.el.ownerSVGElement !== svg) continue;
          const stEntry = perStaff.get(d.staff);
          if (!stEntry || !fadedStaffIds.has(stEntry)) continue;
          const r = attrRect(d.el);
          if (r) rects.push(r);
        }
        // Slur/tie arcs get NO annotation callback at all — they're drawn as
        // unclassed cubic-bezier <path>s (beams are unclassed too, but use
        // line segments: `m…l…`). Assign each arc to the nearest staff core
        // and union its box when that staff is faded, so a muted voice's
        // slurs fade instead of arcing crisply over a veiled system. The
        // bbox MUST be mapped from the path's local space into root svg
        // coords — abc2svg nests some arcs in <g transform=…> (local y was
        // negative and the veil box landed off-target: the arc showed
        // through with a dashed look where note boxes crossed it, real bug).
        // Needs live geometry (getBBox/getScreenCTM) — skipped in a hidden
        // pane.
        if (rects.length) {
          let rootInv = null;
          try { rootInv = svg.getScreenCTM()?.inverse() ?? null; } catch { /* not rendered */ }
          for (const p of (rootInv ? svg.querySelectorAll('path:not([class])') : [])) {
            if (!/^M[-\d. ]+c/.test(p.getAttribute('d') || '')) continue;
            let bb, m;
            try { bb = p.getBBox(); m = p.getScreenCTM(); } catch { continue; }
            if (!bb || (!bb.width && !bb.height) || !m) continue;
            const t = rootInv.multiply(m);
            const xs = [], ys = [];
            for (const [px, py] of [[bb.x, bb.y], [bb.x + bb.width, bb.y],
                                    [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]) {
              xs.push(t.a * px + t.c * py + t.e);
              ys.push(t.b * px + t.d * py + t.f);
            }
            const rx = Math.min(...xs), ry = Math.min(...ys);
            const rw = Math.max(...xs) - rx, rh = Math.max(...ys) - ry;
            const cy = ry + rh / 2;
            let best = null;
            for (const stv of staves) {
              const dist = Math.abs((stv.top + stv.bot) / 2 - cy);
              if (!best || dist < best.dist) best = { stv, dist };
            }
            if (best?.stv.faded) rects.push([rx, ry, rw, rh]);
          }
        }
        // Mixed staves (still audible): veil only the muted voice's sounding
        // symbols so the shared clef/key/meter/bars stay fully visible.
        for (const stv of staves) {
          if (stv.faded) continue;
          for (const s of stv.st.syms) {
            if (SOUNDING.has(s.type) && s.voice && isMuted(s.voice)) {
              s.el.classList.add('uf-muted');
            }
          }
        }
        if (rects.length) {
          const p = document.createElementNS(_SVG_NS, 'path');
          p.setAttribute('class', 'uf-staff-veil');
          p.setAttribute('d', rects.map(([x, y, rw, rh]) =>
            `M${x.toFixed(1)} ${y.toFixed(1)}h${rw.toFixed(1)}v${rh.toFixed(1)}h${(-rw).toFixed(1)}Z`).join(''));
          svg.appendChild(p);
        }
      }
    },

    /** Park the cursor bar on the first symbol of the first matching pair. */
    cursorAt(pairs) {
      lastCursorPairs = pairs;
      placeCursor(pairs);
    },
  };

  placeCursor = (pairs) => {
      let target = null;
      for (const p of (pairs ?? [])) {
        const hits = inRange(p.from, p.to);
        if (hits.length) { target = hits[0]; break; }
      }
      if (!target) { cursor.style.display = 'none'; return; }
      const svg = target.el.ownerSVGElement;
      if (!svg) { cursor.style.display = 'none'; return; }
      const wrap = el.getBoundingClientRect();
      const r    = target.el.getBoundingClientRect();
      const sr   = svg.getBoundingClientRect();
      // Zero geometry = not laid out (hidden pane / backgrounded tab): a bar
      // positioned from it would be garbage — hide until the next update.
      if (!sr.height || !wrap.width) { cursor.style.display = 'none'; return; }
      cursor.style.left    = `${(r.left + r.right) / 2 - wrap.left - 1}px`;
      cursor.style.top     = `${sr.top - wrap.top}px`;
      cursor.style.height  = `${sr.height}px`;
      cursor.style.display = '';
  };

  return score;
}

/** Export: one self-contained SVG (systems stacked as nested <svg y=…>). */
export function abc2svgExportSvg(content) {
  // %%fullsvg: make every emitted <svg> self-contained — abc2svg then embeds a
  // <style> per svg holding ALL the rules it needs, critically the @font-face
  // for its music font (a data-URI ttf baked into abc2svg-1.js). In-app those
  // rules live in a document-level stylesheet abc2svg injects (abc2svg.sheet),
  // which does NOT travel with a serialized export: without this directive the
  // exported score's SMuFL codepoints have no font and every notehead/clef/rest
  // renders as a tofu box. The directive's value suffixes abc2svg's class names
  // (f0x…) so they can't collide with page CSS.
  content = withDefaultDirective(content, 'fullsvg', 'x');
  content = withDefaultDirective(content, 'linebreak', DEFAULT_LINEBREAK);   // flow, as on screen
  const { chunks } = engrave(content, { preserveSheet: true }); // no annotation rects in exports
  if (!chunks.length) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = chunks.join('');
  let y = 0, maxW = 0;
  const parts = [];
  tmp.querySelectorAll('svg').forEach((svg) => {
    const w = parseFloat(svg.getAttribute('width'))  || 794;
    const h = parseFloat(svg.getAttribute('height')) || 0;
    svg.setAttribute('x', 0);
    svg.setAttribute('y', y);
    parts.push(svg.outerHTML);
    y += h; maxW = Math.max(maxW, w);
  });
  if (!parts.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxW}" height="${y}" viewBox="0 0 ${maxW} ${y}">\n${parts.join('\n')}\n</svg>`;
}

/**
 * Prepend a format directive unless the document already sets it (a user's
 * explicit %%directive always wins). File-level %% lines are valid before X:.
 */
function withDefaultDirective(content, name, value) {
  return new RegExp(`^%%${name}\\b`, 'm').test(content)
    ? content
    : `%%${name} ${value}\n${content}`;
}

/** Export: print-ready HTML body — each system responsive in its own <div>. */
export function abc2svgExportPrintBody(content) {
  // Size the engraving for US-letter (the print window sets @page{size:letter}
  // with 0.5in body padding): 8.5in − 2×0.5in = 7.5in content column. abc2svg's
  // own default is A4 (21cm) with 1.8cm margins — page geometry belongs to the
  // print CSS here, so zero abc2svg's margins and let padding do the framing.
  content = withDefaultDirective(content, 'pagewidth',   '7.5in');
  content = withDefaultDirective(content, 'leftmargin',  '0');
  content = withDefaultDirective(content, 'rightmargin', '0');
  // Measures flow to the print column exactly as they flow to the pane.
  content = withDefaultDirective(content, 'linebreak', DEFAULT_LINEBREAK);
  // Embed the music font in each svg — the print window is a fresh document
  // without abc2svg's injected stylesheet (see abc2svgExportSvg).
  content = withDefaultDirective(content, 'fullsvg', 'x');
  const { chunks } = engrave(content, { preserveSheet: true }); // no annotation rects in exports
  if (!chunks.length) return null;
  const tmp = document.createElement('div');
  tmp.innerHTML = chunks.join('');
  makeResponsive(tmp);
  const parts = [];
  tmp.querySelectorAll('svg').forEach((svg) => {
    svg.style.maxWidth = '';                      // print column controls width
    parts.push(`<div>${svg.outerHTML}</div>`);
  });
  return parts.length ? parts.join('\n') : null;
}
