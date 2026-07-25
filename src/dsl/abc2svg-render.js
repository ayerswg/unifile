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
//   .uf-hl           editor-selection / clicked-note highlight
//   .uf-play         playback "now sounding" highlight
//   .uf-range        selected playback range band
//   .uf-muted        muted/non-soloed voice dim (bg-tinted overlay)
// The playback cursor bar is an absolutely-positioned div moved between rects.
//
// abc2svg is a <script>-tag library (populates a global); the esbuild
// `abc2svgExportPlugin` (build.mjs) appends an `export default` for bundling.
import abc2svg from 'abc2svg/abc2svg-1.js';
// String-tablature module (%%strtab): self-registers into abc2svg.modules and
// hooks every new Abc instance (pass-through when no %%strtab directive).
import 'abc2svg/strtab-1.js';

/** True when abc2svg is the active engraver (default; 'abcjs' opts out). */
export function useAbc2svg() {
  try { return localStorage.getItem('uf_engraver') !== 'abcjs'; } catch { return true; }
}

// abc2svg frontends define these hooks; the core calls them. No-ops keep it
// fully offline (no %%abc-include fetches, no dynamic module loads).
abc2svg.abc_end = abc2svg.abc_end || function () {};
abc2svg.loadjs  = abc2svg.loadjs  || function (_fn, relay) { if (relay) relay(); };

// Symbol types whose annotation rects would only add noise (they span other
// symbols' geometry). Same exclusions as abc2svg's own editor.
const SKIP_ANNO = new Set(['beam', 'slur', 'tuplet']);

/**
 * Core engraving pass. Returns { chunks, errors, annos } where `chunks` are the
 * raw SVG strings abc2svg emitted (one per staff system) and `annos` records
 * each annotated symbol { start, end, voice } in emission order (1:1 with the
 * `rect.abcr` elements when `annotate` is on).
 */
function engrave(content, { annotate = false } = {}) {
  const chunks = [], errors = [], annos = [];
  let abc = null;
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
      if (SKIP_ANNO.has(type)) return;
      annos.push({ start, end: stop, voice: s?.p_v?.id ?? null });
      // The abc2svg editor's exact pattern: out_sxsy/sh map staff coords → SVG.
      abc.out_svg(`<rect class="abcr _${start}_" x="`);
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
  let prefix = '';
  if (paneW >= 300 && !/^%%pagewidth\b/m.test(content)) {
    prefix += `%%pagewidth ${Math.min(paneW, 1600)}\n`;
    if (!/^%%leftmargin\b/m.test(content))  prefix += '%%leftmargin 14\n';
    if (!/^%%rightmargin\b/m.test(content)) prefix += '%%rightmargin 14\n';
  }

  const { chunks, errors, annos } = engrave(prefix + content, { annotate: true });
  if (!chunks.length) return null;

  el.innerHTML = chunks.join('');
  makeResponsive(el);
  explodeGlyphTexts(el);

  // Pair each rect with its anno record via the istart baked into its class.
  // NOT by emission index: abc2svg buffers SVG output per staff and joins the
  // buffers at flush time, so rect DOM order ≠ anno callback order.
  // Offsets are then shifted back by the injected prefix length so sym.start/
  // .end are content-relative (annos from inside the prefix are dropped).
  const rects = [...el.querySelectorAll('rect.abcr')];
  const byStart = new Map();
  annos.forEach(a => { if (!byStart.has(a.start)) byStart.set(a.start, a); });
  const syms = rects.map((r) => {
    const start = Number((r.getAttribute('class').match(/_(\d+)_/) || [])[1]);
    const a = byStart.get(start);
    if (!a || start < prefix.length) return null;
    return {
      start: start - prefix.length, end: a.end - prefix.length,
      voice: a.voice, el: r, glyphs: null,
    };
  }).filter(Boolean).sort((a, b) => a.start - b.start);

  // Map drawn glyphs to symbols geometrically: an element belongs to the
  // smallest annotation box containing its centre (screen space, so staff
  // <g transform> contexts don't matter). Gives the red/green note colouring
  // its targets — the note's own paths/texts/uses, like abcjs's note groups.
  // Built LAZILY on first highlight use: at render time the pane may have no
  // layout yet (hidden pane / first paint), where every box measures 0×0.
  // Until it succeeds, highlights fall back to the overlay-rect tint.
  let glyphsMapped = false;
  const ensureGlyphMap = () => {
    if (glyphsMapped) return;
    const symBoxes = syms
      .map(s => ({ s, b: s.el.getBoundingClientRect() }))
      .filter(({ b }) => b.width > 0 && b.height > 0);
    if (!symBoxes.length) return;               // no layout yet — retry next call
    let assigned = 0;
    el.querySelectorAll('svg :is(path, text, tspan, use, ellipse, circle, polygon)').forEach((gl) => {
      if (gl.classList.contains('abcr')) return;
      if (gl.tagName === 'text' && gl.firstElementChild) return;   // exploded container
      const b = gl.getBoundingClientRect();
      if (!b.width && !b.height) return;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      let best = null;
      for (const { s, b: rb } of symBoxes) {
        if (cx < rb.x || cx > rb.right || cy < rb.y || cy > rb.bottom) continue;
        if (b.width > rb.width * 3) continue;   // spans neighbours (staff/bar lines)
        const area = rb.width * rb.height;
        if (!best || area < best.area) best = { s, area };
      }
      if (best) { (best.s.glyphs ??= []).push(gl); assigned++; }
    });
    // Only latch a map that actually assigned glyphs: at render time the music
    // font may not have loaded yet, so every tspan measures 0×0 and nothing
    // maps — latching then would freeze the empty map forever. Retrying on the
    // next highlight call (font loaded by then) succeeds.
    if (assigned) glyphsMapped = true;
    else syms.forEach(s => { s.glyphs = null; });
  };

  // Playback cursor bar: an HTML div positioned over the rect that's sounding.
  const cursor = document.createElement('div');
  cursor.className = 'uf-a2s-cursor';
  cursor.style.display = 'none';
  el.appendChild(cursor);

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
  // mapped glyphs fall back to a rect tint.
  const GLYPH_CLS = new Set(['uf-hl', 'uf-play']);
  const markPairs = (pairs, cls) => {
    clearClass(cls);
    if (!pairs) return;
    const onGlyph = GLYPH_CLS.has(cls);
    if (onGlyph) ensureGlyphMap();
    for (const p of pairs) {
      inRange(p.from, p.to).forEach((s) => {
        if (onGlyph && s.glyphs) s.glyphs.forEach(g => g.classList.add(cls));
        else s.el.classList.add(cls);
      });
    }
  };

  return {
    el,
    symCount: syms.length,
    _debug: () => ({
      mapped: glyphsMapped,
      symsWithGlyphs: syms.filter(s => s.glyphs?.length).length,
      totalGlyphs: syms.reduce((n, s) => n + (s.glyphs?.length ?? 0), 0),
      tspans: el.querySelectorAll('svg tspan').length,
      firstRectBox: (() => { const b = syms[0]?.el.getBoundingClientRect(); return b ? [b.x, b.y, b.width, b.height].map(Math.round) : null; })(),
    }),
    // Width the score was engraved for, so callers can re-engrave when the pane
    // ends up meaningfully different (first layout, window resize). null when
    // the document sets its own %%pagewidth — the user's layout is fixed.
    pageWidth: /^%%pagewidth\b/m.test(content)
      ? null
      : (prefix ? Math.min(paneW, 1600) : 794),

    highlightRange(from, to) {
      markPairs(to > from ? [{ from, to }] : null, 'uf-hl');
    },

    setPlaying(pairs)  { markPairs(pairs, 'uf-play');  },
    setRange(pairs)    { markPairs(pairs, 'uf-range'); },

    setVoiceFade(isMuted) {
      ensureGlyphMap();
      for (const s of syms) {
        const muted = !!(s.voice && isMuted(s.voice));
        // Fade the glyphs themselves (abcjs-style opacity dim); the rect veil
        // is the fallback for symbols with no mapped glyphs.
        if (s.glyphs) {
          s.glyphs.forEach(g => g.classList.toggle('uf-muted', muted));
          s.el.classList.remove('uf-muted');
        } else {
          s.el.classList.toggle('uf-muted', muted);
        }
      }
    },

    /** Park the cursor bar on the first symbol of the first matching pair. */
    cursorAt(pairs) {
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
    },
  };
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
  const { chunks } = engrave(content);            // no annotation rects in exports
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
  // Embed the music font in each svg — the print window is a fresh document
  // without abc2svg's injected stylesheet (see abc2svgExportSvg).
  content = withDefaultDirective(content, 'fullsvg', 'x');
  const { chunks } = engrave(content);            // no annotation rects in exports
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
