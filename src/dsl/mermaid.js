/**
 * Mermaid DSL plugin — the {diagram} app.
 *
 * Always bundled offline — no CDN fetches at runtime.
 * Rendering: mermaid 12 (npm), bundled whole by esbuild — every diagram type
 *            it ships, the `@{ shape: … }` node syntax, `look: handDrawn`, and
 *            BOTH layout engines (dagre + ELK; ELK is mermaid 12's default, so
 *            it can no longer be stubbed out of the bundle).  The live preview
 *            wraps the svg in a zoom/pan stage (mermaid-zoom.js).
 * Front matter: mermaid's `config:` / `displayMode:` keys are read from the
 *            DOCUMENT's front matter (core/mermaid-front-matter.js) — the
 *            layout strips that block before the body reaches render().
 * Export:    SVG, PNG (via canvas)
 *
 * Icons:     Font Awesome 6 Free is bundled (mermaid-icons.js registers the
 *            @iconify-json/fa6-* packs under the `fa`/`fas`/`far`/`fab`/`fal`
 *            prefixes mermaid looks up), so `fa:fa-user` label tokens,
 *            `@{ icon: "fab:github" }` nodes and architecture `(fa:server)`
 *            icons draw offline as inline svg paths — no webfont, no CSS, and
 *            the icons travel inside the SVG / PNG exports.  The editor
 *            completes icon names after `fa:fa-` / `icon: "fa:` and lints a
 *            name the packs don't hold.  Other iconify packs (`logos:` …) are
 *            not bundled — a size decision (core/fa-icons.js has the numbers).
 */

import mermaid from 'mermaid';
import { StreamLanguage } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { hoverTooltip } from '@codemirror/view';
import { registerDSL } from './registry.js';
import { getFrontMatterRange } from '../core/front-matter.js';
import { schemaCompletions, schemaLint } from '../core/fm-schema.js';
import { prepareMermaidSource } from '../core/mermaid-front-matter.js';
import { state } from '../ui/state.js';
import { mountZoomStage } from './mermaid-zoom.js';
import { loadFaIconSets } from './mermaid-icons.js';
import { findFaRefs, lookupFaIcon, faIconNames } from '../core/fa-icons.js';
import { tokenizeLine, createState, copyState, collectSymbols, diagramTypeOf, KEYWORDS, DIRECTIONS,
         FLOW_LINKS, SEQUENCE_ARROWS, CLASS_RELATIONS, ER_RELATIONS } from '../core/mermaid-syntax.js';

// ---------------------------------------------------------------------------
// Mermaid stream language for CodeMirror 6
//
// The tokenizer itself is core/mermaid-syntax.js (pure, Node-tested): it
// follows mermaid's own lexers per diagram family — flowchart node ids are
// mermaid's NODE_STRING (`A-->B` is three tokens, `my-node` one), every link
// form, shape labels, quoted / markdown labels that span lines, `@{ … }`
// metadata, sequence arrows, class relations, ER crow's feet, gantt tasks …
// This wrapper feeds each line through it and hands CodeMirror the spans;
// the cross-line state (open string / label / block) rides in the parser
// state so a label opened on one line keeps colouring the next.
// ---------------------------------------------------------------------------

const mermaidLanguage = StreamLanguage.define({
  name: 'mermaid',
  startState: () => ({ ...createState(), toks: null, i: 0 }),
  copyState: (s) => ({ ...copyState(s), toks: null, i: 0 }),
  token(stream, st) {
    if (stream.sol()) { st.toks = tokenizeLine(stream.string, st); st.i = 0; }
    const toks = st.toks ?? [];
    while (st.i < toks.length && toks[st.i].to <= stream.pos) st.i++;
    const t = toks[st.i];
    if (!t) { stream.skipToEnd(); return null; }
    if (t.from > stream.pos) { stream.pos = t.from; return null; }   // plain text up to the next span
    stream.pos = t.to; st.i++;
    return t.type;
  },
  // Keep the line counter (and any open string) in step on empty lines.
  blankLine(st) { tokenizeLine('', st); },
});

// Initialise once at module load with the theme matching the current colour
// scheme (NOT a hard-coded 'dark' — a diagram must never assume dark mode).
// Every render path re-initialises per call (see _initTheme) because the theme
// is baked into the svg's <style> at render time: a diagram drawn in dark mode
// stays dark until it is drawn again, so preview.js re-renders on 'theme-change'
// (the DSL declares `themeAware: true`).
// logLevel 'fatal' keeps the live linter's caught mermaid.parse() rejections
// from spamming the console on every keystroke while a diagram is incomplete.
_initTheme(_resolveTheme());

/** (Re)initialise mermaid with the given built-in theme before a render. */
function _initTheme(theme) {
  mermaid.initialize({ startOnLoad: false, theme, logLevel: 'fatal' });
}

// ---------------------------------------------------------------------------
// Document front matter → mermaid source
// ---------------------------------------------------------------------------

/** Inner YAML of the current document's leading `---` block (null if none). */
function _docFrontMatterYaml() {
  return getFrontMatterRange(state.currentContent ?? '')?.innerText ?? null;
}

/**
 * What mermaid parses for `text` (a bare body from the layout, or a full
 * document from an export): the document's `config:` / `displayMode:` front
 * matter keys forwarded as a mermaid front matter block, then the body.
 * `body` is the diagram text proper — its offsets are the editor's.
 */
function _prepare(text) {
  return prepareMermaidSource(text, _docFrontMatterYaml());
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let _renderCounter = 0;

async function render(content, el) {
  el.innerHTML = '';

  if (!content.trim()) {
    el.innerHTML = '<p class="preview-empty">Enter Mermaid syntax to see a diagram.</p>';
    return;
  }

  // Print layouts (slides / document pages) are always white — force the light
  // 'default' theme.  Everything else follows the current browser/app preference.
  // A `%%{init: {'theme': …}}%%` directive or classDef/style in the source
  // still wins — mermaid layers directives over this site config per render.
  // Re-initialising before each render is safe because renders are sequential
  // (each slide or page is awaited before the next begins).
  const inPrintContext = !!el.closest?.('.uf-slide-frame, .uf-doc-page');
  _initTheme(inPrintContext ? 'default' : _resolveTheme());

  const id = `mermaid-${++_renderCounter}`;
  const { source, body } = _prepare(content);

  try {
    const { svg } = await mermaid.render(id, source);
    el.innerHTML = svg;

    const svgEl = el.querySelector('svg');
    if (svgEl) {
      if (inPrintContext) {
        // Make the SVG fill its container: width="100%" scales to parent,
        // removing height lets it auto-size from viewBox aspect ratio,
        // removing the inline style drops mermaid's own "max-width: Npx".
        svgEl.setAttribute('width', '100%');
        svgEl.removeAttribute('height');
        svgEl.removeAttribute('style');
        svgEl.querySelector('rect.background')?.remove();
      }

      // Annotate individual flowchart nodes with their source positions so
      // click-back lands on the specific node rather than the whole block.
      // (`body` = `content` minus a leading front matter block of its own.)
      _annotateFlowNodes(svgEl, body, el, content.length - body.length);

      // Live preview: zoom & pan by default (diagrams outgrow a pane fast).
      // Print layouts keep the plain, page-sized svg.
      if (!inPrintContext) mountZoomStage(el, svgEl);
    }
  } catch (e) {
    el.innerHTML = `<pre class="error">Mermaid error:\n${e.message}</pre>`;
    // mermaid leaves its scratch container behind when the parse fails
    // (`#d<id>` since mermaid 11; `#<id>` in 10).
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/**
 * Annotate individual flowchart node `<g>` elements with data-doc-from/data-doc-to
 * so that click-back lands on the specific node line rather than the whole block.
 *
 * Works for `graph` / `flowchart` diagrams only — other diagram types have
 * different SVG structures. Falls back gracefully for unknown types.
 *
 * @param {SVGElement} svgEl   The rendered SVG element
 * @param {string}     content The diagram body (offsets as in the editor)
 * @param {Element}    wrapEl  The wrapper element with data-doc-from (absolute offset)
 * @param {number}     [skew]  Chars of `render()`'s input that precede `content`
 *                             (a section-level front matter block), default 0
 */
function _annotateFlowNodes(svgEl, content, wrapEl, skew = 0) {
  // `look: handDrawn` draws nodes as `g.rough-node` (roughjs) instead of `g.node`.
  const nodes = svgEl.querySelectorAll('g.node, g.rough-node');
  if (!nodes.length) return;

  // Absolute document offset where this section's *content* starts (after shebang).
  // dslContentFrom is set by layout renderers; fall back to docFrom for the
  // standalone preview path where docFrom already points at content start.
  const base = parseInt(wrapEl.dataset.dslContentFrom ?? wrapEl.dataset.docFrom ?? '0', 10) + skew;

  for (const node of nodes) {
    // Mermaid node id formats: mermaid 12 "mermaid-7-flowchart-NODEID-N" (svg id,
    // then the diagram type), mermaid 10 "flowchart-NODEID-N" / "mermaid-abc-NODEID-N".
    const rawId = node.id ?? '';
    const m = /^(?:mermaid-[^-]+-)?(?:flowchart-)?(.+?)-\d+$/.exec(rawId);
    if (!m) continue;
    const nodeId = m[1];
    if (!nodeId) continue;

    // Search source text for the node ID at a word boundary (`@` = the
    // `A@{ shape: … }` metadata syntax, `:` = `A:::class`).
    const re = new RegExp(`(?:^|\\s|[\\[\\](){}|>&])${_escRegex(nodeId)}(?:$|[\\s\\[\\](){}|<>\\-=.@:&])`, 'm');
    const match = re.exec(content);
    if (!match) continue;

    // Adjust for any leading non-ID character in the match
    const matchStart = match.index + (match[0].search(new RegExp(_escRegex(nodeId))));
    const lineStart  = content.lastIndexOf('\n', matchStart) + 1;
    const lineEnd    = content.indexOf('\n', matchStart);

    node.dataset.docFrom = base + lineStart;
    node.dataset.docTo   = base + (lineEnd >= 0 ? lineEnd : content.length);
  }
}

function _escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return the mermaid theme that matches the current app/browser colour scheme:
 * `data-theme` on <html> (set by ui/theme.js for a forced light/dark pref), else
 * the OS `prefers-color-scheme`. 'default' is mermaid's light theme.
 */
function _resolveTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light') return 'default';
  if (forced === 'dark')  return 'dark';
  // Auto — follow the OS/browser preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

async function renderToString(content) {
  if (!content.trim()) return '';
  try {
    _initTheme(_resolveTheme());
    const id = `mermaid-noscript-${Date.now()}`;
    const { svg } = await mermaid.render(id, _prepare(content).source);
    return svg;
  } catch {
    return `<pre>${content}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

async function exportSVG(content) {
  // What you see: the app's current colour scheme (never whatever theme the
  // previous render — possibly a print-layout page — happened to leave set).
  _initTheme(_resolveTheme());
  const id = `mermaid-export-${Date.now()}`;
  const { svg } = await mermaid.render(id, _prepare(content).source);
  return new Blob([svg], { type: 'image/svg+xml' });
}

async function exportPNG(content) {
  // The PNG is flattened onto a white canvas below, so it is engraved with
  // the light theme regardless of the app's colour scheme.
  _initTheme('default');
  const id = `mermaid-export-png-${Date.now()}`;
  const { svg } = await mermaid.render(id, _prepare(content).source);

  // mermaid's svg is `width="100%"` + a viewBox, so as an <img> its natural
  // size is the 300px default (every PNG came out 300 px wide) — size the
  // raster from the viewBox instead, at 2× for a crisp export; drawImage
  // re-rasterizes an svg at the destination size, so nothing is upscaled.
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/[\s,]+/).map(Number);
  const vbW = vb?.[2] > 0 ? vb[2] : 800, vbH = vb?.[3] > 0 ? vb[3] : 600;
  const scale = 2;
  const blob = await new Promise(resolve => {
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vbW * scale);
      canvas.height = Math.round(vbH * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(resolve, 'image/png');
    };
    img.src = url;
  });
  return blob;
}

// ---------------------------------------------------------------------------
// Editor intelligence — front-matter schema, autocomplete, lint, hover docs
// ---------------------------------------------------------------------------

/**
 * Front-matter schema for a Mermaid document.  Mermaid has no domain-specific
 * front matter of its own, so this is just the core document keys (each build
 * owns its complete schema per the single-DSL model).
 */
const mermaidFrontMatterSchema = {
  title:  { type: 'string', doc: 'Document title — shown in the top bar and rendered by the layout.' },
  config: { type: 'map', freeform: true, doc: 'Mermaid config, forwarded to every diagram: `look: handDrawn | classic | neo`, `layout: dagre | elk`, `theme: default | dark | forest | neutral | base`, per-diagram keys (`flowchart: { curve: basis }`), …' },
  displayMode: { type: 'enum', values: ['compact'], doc: 'Gantt: `compact` packs tasks onto shared rows.' },
  model:  { type: 'enum', values: ['flow', 'grid', 'spatial', 'timeline', 'graph'],
            doc: 'Document model (how the layout arranges content). `flow` is the default.' },
  layout: { type: 'enum', values: ['webpage', 'document', 'slides'],
            doc: 'Presentation of a flow document.' },
};

// Diagram-type keywords (first meaningful line) → short docs.
const MERMAID_DIAGRAM_TYPES = {
  flowchart: 'Flowchart, e.g. `flowchart TD`.',
  graph: 'Flowchart (older keyword), e.g. `graph LR`.',
  sequenceDiagram: 'Sequence diagram of messages between participants.',
  classDiagram: 'UML class diagram.',
  stateDiagram: 'State diagram.',
  'stateDiagram-v2': 'State diagram (v2 renderer).',
  erDiagram: 'Entity-relationship diagram.',
  gantt: 'Gantt chart / timeline.',
  pie: 'Pie chart.',
  journey: 'User-journey diagram.',
  gitGraph: 'Git branch/commit graph.',
  mindmap: 'Mind map.',
  quadrantChart: 'Quadrant (2×2) chart.',
  requirementDiagram: 'Requirements diagram.',
  timeline: 'Timeline diagram.',
  'block-beta': 'Block diagram (beta).',
  kanban: 'Kanban board — columns of cards.',
  'architecture-beta': 'Cloud / system architecture: groups, services, edges (beta).',
  'packet-beta': 'Network packet / bit-field layout (beta).',
  'xychart-beta': 'XY chart — bar and line series on axes (beta).',
  'sankey-beta': 'Sankey flow diagram from CSV-style rows (beta).',
  'radar-beta': 'Radar / spider chart (beta).',
  'treemap-beta': 'Treemap of nested values (beta).',
  C4Context: 'C4 model: system context diagram.',
  C4Container: 'C4 model: container diagram.',
  C4Component: 'C4 model: component diagram.',
  C4Dynamic: 'C4 model: dynamic diagram.',
  C4Deployment: 'C4 model: deployment diagram.',
  'usecase-beta': 'UML use-case diagram (beta).',
  'venn-beta': 'Venn diagram (beta).',
  'wardley-beta': 'Wardley map (beta).',
  'railroad-beta': 'Railroad (grammar) diagram (beta).',
  'ishikawa-beta': 'Ishikawa / fishbone diagram (beta).',
  'treeView-beta': 'Tree view of nested items (beta).',
  'swimlane-beta': 'Swimlane flowchart (beta).',
};

// `@{ shape: … }` — every shape name mermaid 12 registers (short names + aliases).
const MERMAID_SHAPES = [
  'rect', 'rounded', 'stadium', 'subroutine', 'cyl', 'circle', 'odd', 'diamond', 'hex',
  'lean-r', 'lean-l', 'trap-b', 'trap-t', 'dbl-circ', 'text', 'notch-rect', 'lin-rect',
  'sm-circ', 'fr-circ', 'fork', 'hourglass', 'brace', 'brace-r', 'braces', 'bolt', 'doc',
  'delay', 'h-cyl', 'lin-cyl', 'curv-trap', 'div-rect', 'tri', 'win-pane', 'f-circ',
  'lin-doc', 'notch-pent', 'flip-tri', 'sl-rect', 'docs', 'st-rect', 'bow-rect', 'cross-circ',
  'tag-doc', 'tag-rect', 'paper-tape', 'flag', 'bang', 'cloud', 'browser', 'bucket',
  'console', 'datastore', 'folder', 'person', 'rect',
  // aliases (as in the docs' shape table)
  'proc', 'process', 'rectangle', 'event', 'terminal', 'pill', 'subproc', 'framed-rectangle',
  'db', 'database', 'cylinder', 'data-store', 'directory', 'circ', 'decision', 'question',
  'hexagon', 'prepare', 'lean-right', 'in-out', 'lean-left', 'out-in', 'priority',
  'trapezoid-bottom', 'trapezoid', 'manual', 'trapezoid-top', 'inv-trapezoid',
  'double-circle', 'card', 'notched-rectangle', 'lined-rectangle', 'lined-process',
  'lin-proc', 'shaded-process', 'start', 'small-circle', 'stop', 'framed-circle', 'join',
  'collate', 'comment', 'brace-l', 'com-link', 'lightning-bolt', 'document',
  'half-rounded-rectangle', 'das', 'horizontal-cylinder', 'disk', 'lined-cylinder',
  'curved-trapezoid', 'display', 'div-proc', 'divided-rectangle', 'divided-process',
  'extract', 'triangle', 'internal-storage', 'window-pane', 'junction', 'filled-circle',
  'loop-limit', 'notched-pentagon', 'manual-file', 'flipped-triangle', 'manual-input',
  'sloped-rectangle', 'documents', 'st-doc', 'stacked-document', 'procs', 'processes',
  'stacked-rectangle', 'stored-data', 'bow-tie-rectangle', 'summary', 'crossed-circle',
  'tagged-document', 'tagged-rectangle', 'tag-proc', 'tagged-process', 'lined-document',
];
const MERMAID_NODE_ATTR_DOCS = {
  shape: 'Node shape, e.g. `shape: docs` — see the Node shapes help.',
  label: 'Node text (quote it: `label: "Multiple Documents"`).',
  icon: 'Icon node: a Font Awesome name — `icon: "fa:user"` (solid), `"far:bell"` (regular), `"fab:github"` (brands); built in, offline.',
  form: 'Icon / image node form: `square`, `circle` or `rounded`.',
  pos: 'Label position for icon / image nodes: `t` (top) or `b` (bottom).',
  h: 'Height for icon / image nodes.',
  w: 'Width for icon / image nodes.',
  constraint: 'Image node: `on` keeps the aspect ratio, `off` stretches.',
  img: 'Image URL / data URI for an image node.',
};

// Statement keywords that take arguments get a trailing space on accept.
const NO_SPACE_AFTER = new Set(['end', 'autonumber', 'showData', 'inclusiveEndDates', 'topAxis', 'commit']);
const ID_CHARS = /^[\p{L}\p{N}_.-]*$/u;
// The identifier under the caret (what CodeMirror filters the options by).
const MERMAID_WORD_RE = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;

// Docs for the completion rows (the hover reuses the same tables).
const MERMAID_KEYWORD_DOCS = {
  // flowchart
  subgraph: 'Group nodes into a labelled subgraph. Close it with `end`.',
  end: 'Close a subgraph, block, loop, alt, par, note …',
  direction: 'Set flow direction inside a subgraph (TB, LR, …).',
  classDef: 'Define a reusable node-style class: `classDef big fill:#f9f`.',
  class: 'Apply a style class to one or more nodes: `class A,B big`.',
  click: 'Attach a link or callback interaction to a node.',
  style: 'Inline-style a single node: `style A fill:#f9f`.',
  linkStyle: 'Style edges by index: `linkStyle 0 stroke:#f00`.',
  // sequence
  participant: 'Declare a participant (in display order): `participant A as Alice`.',
  actor: 'Declare a participant drawn as a stick figure.',
  activate: 'Start an activation bar on a participant.',
  deactivate: 'End an activation bar.',
  Note: '`Note left of A: text`, `Note right of A: text`, `Note over A,B: text`.',
  note: 'A note: `note left of A: text` / `note for Class "text"`.',
  loop: 'A loop block: `loop every minute … end`.',
  alt: 'Alternative paths: `alt cond … else other … end`.',
  else: 'The other branch of an `alt`.',
  opt: 'An optional block: `opt cond … end`.',
  par: 'Parallel blocks: `par a … and b … end`.',
  and: 'Another parallel branch of a `par`.',
  critical: 'A critical region: `critical … option … end`.',
  option: 'An option of a `critical` region.',
  break: 'A break block: `break cond … end`.',
  rect: 'A background rectangle: `rect rgb(200,200,255) … end`.',
  autonumber: 'Number every message.',
  box: 'Group participants in a box: `box Purple Alice & Bob … end`.',
  create: '`create participant X` — X comes into being at this message.',
  destroy: '`destroy X` — X ends at this message.',
  links: 'Attach a menu of links to a participant (JSON).',
  link: 'Attach one link: `link A: Label @ url`.',
  properties: 'Attach custom properties to a participant.',
  title: 'The diagram title.',
  // class / state / er
  namespace: 'Group classes: `namespace Shapes { class Square }`.',
  cssClass: 'Apply a class: `cssClass "A,B" name`.',
  callback: 'Bind a callback: `callback A "fn" "tooltip"`.',
  state: 'Declare a state: `state "Description" as s1`, `state Composite { … }`, `state f <<fork>>`.',
  hide: '`hide empty description`.',
  // gantt
  dateFormat: 'The input date format (moment-style): `dateFormat YYYY-MM-DD`.',
  axisFormat: 'The axis label format: `axisFormat %m-%d`.',
  tickInterval: 'Axis ticks: `tickInterval 1week`.',
  excludes: 'Days to skip: `excludes weekends`, `excludes 2024-01-01`.',
  includes: 'Days to include despite `excludes`.',
  todayMarker: '`todayMarker off` or a stroke style.',
  section: 'Start a section.',
  weekday: 'The first weekday of a week tick.',
  // git
  commit: 'A commit: `commit id: "x" tag: "v1" type: HIGHLIGHT`.',
  branch: 'Create (and check out) a branch: `branch develop`.',
  checkout: 'Switch to a branch.',
  switch: 'Switch to a branch (alias of checkout).',
  merge: 'Merge a branch into the current one.',
  'cherry-pick': '`cherry-pick id: "commit-id"`.',
  // pie / xychart / quadrant / radar
  showData: 'Print the values beside the pie labels.',
  'x-axis': 'The x axis: a title and / or `[categories]` or `min --> max`.',
  'y-axis': 'The y axis: a title and / or `min --> max`.',
  bar: 'A bar series: `bar [5, 6, 7]`.',
  line: 'A line series: `line [5, 6, 7]`.',
  // block / architecture
  columns: 'The number of block columns.',
  space: 'An empty block cell.',
  group: 'An architecture group: `group api(cloud)[API]`.',
  service: 'An architecture service: `service db(database)[Database] in api`.',
  junction: 'An edge junction point.',
  requirement: 'A requirement block: `requirement name { id: 1 text: … risk: high verifymethod: test }`.',
  element: 'An element block: `element name { type: … docref: … }`.',
};

const SEQ_NOTE_SIDES = ['left of', 'right of', 'over'];
const CLASS_ANNOTATIONS = ['interface', 'abstract', 'service', 'enumeration'];
const STATE_ANNOTATIONS = ['fork', 'join', 'choice'];

/** The options CodeMirror shows: keywords / ids / classes, each with its kind and docs. */
function _opts(labels, type, extra = {}) {
  return labels.map(label => ({ label, type, info: MERMAID_KEYWORD_DOCS[label], ...extra }));
}
function _kw(labels) {
  return labels.map(label => ({ label, type: 'keyword', info: MERMAID_KEYWORD_DOCS[label],
                                apply: NO_SPACE_AFTER.has(label) ? label : label + ' ' }));
}
function _ids(syms, typed, { boost = 1 } = {}) {
  return [...syms.names.keys()]
    .filter(id => !(id === typed && syms.names.get(id) === 1))   // the id being typed right now
    .map(label => ({ label, type: 'variable', detail: syms.subgraphs.has(label) ? 'subgraph' : 'id', boost }));
}
function _classes(syms, typed = '') {
  return [...syms.classes.keys()]
    .filter(c => !(c === typed && syms.classes.get(c) === 1))   // the name being typed right now
    .map(label => ({ label, type: 'class', detail: 'class' }));
}
function _arrows(list) {
  return list.map(([label, detail]) => ({ label, type: 'text', detail }));
}
const _result = (from, options, validFor = ID_CHARS) => options.length ? { from, options, validFor } : null;

/** Unified completion source: front-matter schema + Mermaid body. */
function mermaidComplete(context) {
  try {
    const doc = context.state.doc.toString();
    const region = getFrontMatterRange(doc);
    if (region && context.pos <= region.bodyFrom) {
      return schemaCompletions(mermaidFrontMatterSchema, region, context.pos, context.explicit);
    }
    return mermaidBodyComplete(context, region ? region.bodyFrom : 0);
  } catch { return null; }
}

/**
 * Body completion, by diagram family and by where the caret sits on the line:
 *   - the header line: diagram types, then (flowchart) directions after the keyword;
 *   - the start of a statement: the family's keywords + the ids already in the document;
 *   - after a link / relation / arrow: the ids;
 *   - a partial link (`A -`, `A ==`): the link forms;
 *   - `:::` / `class A …`: the classDef names; `@{ … }`: attributes + shapes;
 *   - never inside a label, an edge label or a string.
 */
function mermaidBodyComplete(context, bodyFrom) {
  const cmDoc = context.state.doc;
  const line = cmDoc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const word = MERMAID_WORD_RE.exec(before);
  const typed = word ? word[0] : '';
  const from = context.pos - typed.length;
  const want = context.explicit || typed.length > 0;

  // A Font Awesome name being typed: `fa:fa-us…` in any label, or
  // `icon: "fab:gi…` inside `A@{ … }` → the bundled pack's icon names.
  const fa = /\b(fa[bklrs]?):fa-([\w-]*)$/.exec(before)
    || (/@\{[^}]*$/.test(before) && /\bicon\s*:\s*["']?(fa[bklrs]?):([\w-]*)$/.exec(before));
  if (fa) return _faIconCompletions(context.pos - fa[2].length, fa[1]);

  // Inside `A@{ … }`: after `shape:` → the shape names; otherwise the attribute keys.
  if (/@\{[^}]*$/.test(before)) {
    const shapeVal = /\bshape\s*:\s*([\w-]*)$/.exec(before);
    if (shapeVal) {
      return { from: context.pos - shapeVal[1].length,
               options: MERMAID_SHAPES.map(label => ({ label, type: 'constant', detail: 'shape' })), validFor: /^[\w-]*$/ };
    }
    if (/[{,]\s*[\w-]*$/.test(before) && want) {
      return { from, options: Object.entries(MERMAID_NODE_ATTR_DOCS).map(([label, info]) => ({ label, type: 'property', info, apply: `${label}: ` })),
               validFor: /^[\w-]*$/ };
    }
    return null;
  }

  // Inside a quoted string / an unclosed shape label / an edge label → nothing.
  if ((before.match(/"/g) ?? []).length % 2) return null;
  const unbraced = before.replace(/[|}o][|o{]?(?:--|\.\.)[|{o][|o{]?/g, '');   // ER crow's feet carry braces
  const opens = (unbraced.match(/[[({]/g) ?? []).length, closes = (unbraced.match(/[\])}]/g) ?? []).length;
  if (opens > closes) return null;

  const body = cmDoc.sliceString(bodyFrom);
  const info = diagramTypeOf(body);
  const headerLine = info ? cmDoc.lineAt(bodyFrom).number + info.line : null;
  const lineStart = /^\s*[\p{L}\p{N}_.-]*$/u.test(before);   // the caret is in the first word

  // The header line (or any line before the header exists): diagram types,
  // then the direction after a flowchart keyword — never the diagram types
  // again, which is what fuzzy-matched `LR` to `flowchart-elk`.
  if (!info || line.number === headerLine) {
    if (lineStart) {
      if (!want) return null;
      return { from, options: Object.entries(MERMAID_DIAGRAM_TYPES).map(([label, info]) => ({ label, type: 'keyword', info, apply: label + ' ' })),
               validFor: /^[\w-]*$/ };
    }
    if (info?.family === 'flowchart' && /^\s*[\w-]+\s+[A-Za-z]*$/.test(before)) {
      return _result(from, DIRECTIONS.map(label => ({ label, type: 'constant', detail: 'direction' })));
    }
    if (info?.family === 'pie' && /^\s*pie\s+[a-zA-Z]*$/.test(before)) return _result(from, _kw(['title', 'showData']));
    return null;
  }

  const family = info.family;
  const syms = collectSymbols(body);
  const kws = KEYWORDS[family] ?? KEYWORDS.generic;
  // Inside a `{ … }` body (a class's members, an entity's attributes)?  ER
  // crow's feet (`||--o{`, `}|..|{`) carry braces of their own — not blocks.
  const above = cmDoc.sliceString(bodyFrom, line.from).replace(/[|}o][|o{]?(?:--|\.\.)[|{o][|o{]?/g, '');
  const inBlock = (above.match(/\{/g) ?? []).length > (above.match(/\}/g) ?? []).length;

  switch (family) {
    case 'flowchart': {
      if (/^\s*direction\s+[A-Za-z]*$/.test(before)) return _result(from, DIRECTIONS.map(label => ({ label, type: 'constant', detail: 'direction' })));
      if (/:::[\w-]*$/.test(before)) return _result(context.pos - /[\w-]*$/.exec(before)[0].length, _classes(syms), /^[\w-]*$/);
      if (/^\s*class\s+\S+\s+[\w-]*$/.test(before)) return _result(from, _classes(syms));
      if (/^\s*class\s+[\w.,-]*$/.test(before)) return _result(context.pos - /[\w.-]*$/.exec(before)[0].length, _ids(syms, typed));
      if (/^\s*(style|click)\s+[\w.-]*$/.test(before)) return _result(from, _ids(syms, typed));
      if (/^\s*click\s+\S+\s+[a-z]*$/.test(before)) return _result(from, _kw(['href', 'call', 'callback']));
      if (/^\s*(classDef|linkStyle|subgraph)\s/.test(before)) return null;   // a new definition
      // A partial link: `A -`, `A --`, `A -.`, `A ==`, `A <`, `A ~`
      const arrow = /(^|[\s\])}"])([<xo]?[-=.~][-=.~>xo|]*)$/.exec(before);
      if (arrow) return _result(context.pos - arrow[2].length, _arrows(FLOW_LINKS), /^[-=.~<>xo| \w]*$/);
      if (lineStart) return want ? _result(from, [..._kw(kws.start), ..._ids(syms, typed)]) : null;
      // After a link or `&`: the ids
      if (/(?:[-=.~>xo]|&|\|)\s*[\p{L}\p{N}_.-]*$/u.test(before)) return _result(from, _ids(syms, typed));
      return want ? _result(from, [..._ids(syms, typed), ..._opts(kws.inline, 'keyword')]) : null;
    }
    case 'sequence': {
      if (/:\s*[^:]*$/.test(before) && !/^\s*(links|link|properties)\b/.test(before)) return null;   // message text
      if (/^\s*(create\s+)?(participant|actor)\s+\S*$/.test(before)) return null;        // a new name
      if (/^\s*participant\s+\S+\s+[a-z]*$/.test(before)) return _result(from, _kw(['as']));
      if (/^\s*[Nn]ote\s+(left of|right of|over)\s+[^:]*$/.test(before)) return _result(from, _ids(syms, typed));
      const side = /^\s*[Nn]ote\s+([a-z ]*)$/.exec(before);
      if (side) return _result(context.pos - side[1].length, SEQ_NOTE_SIDES.map(label => ({ label, type: 'keyword', apply: label + ' ' })), /^[a-z ]*$/);
      if (/^\s*(activate|deactivate|destroy)\s+\S*$/.test(before)) return _result(from, _ids(syms, typed));
      const arrow = /[^\s:]\s*((?:<<?)?-[-x>)]*)$/.exec(before);
      if (arrow && !/^\s*(participant|actor|box|loop|alt|else|opt|par|and|critical|option|break|rect|title)\b/.test(before))
        return _result(context.pos - arrow[1].length, _arrows(SEQUENCE_ARROWS), /^[-<>x)]*$/);
      if (/(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)[+-]?\s*[^:]*$/.test(before)) return _result(from, _ids(syms, typed));
      if (lineStart) return want ? _result(from, [..._kw(kws.start), ..._ids(syms, typed)]) : null;
      return null;
    }
    case 'class': {
      if (/<<[a-z]*$/.test(before)) return _result(context.pos - /[a-z]*$/.exec(before)[0].length, CLASS_ANNOTATIONS.map(label => ({ label, type: 'keyword', apply: label + '>>' })), /^[a-z]*$/);
      if (/:::[\w-]*$/.test(before)) return _result(context.pos - /[\w-]*$/.exec(before)[0].length, _classes(syms), /^[\w-]*$/);
      if (/^\s*(class|namespace)\s+\S*$/.test(before)) return null;   // a new name
      if (/^\s*note\s+[a-z]*$/.test(before)) return _result(from, _kw(['for']));
      if (/^\s*(note\s+for|cssClass\s+"[^"]*"|style)\s+[\w~]*$/.test(before)) return _result(from, _classes(syms));
      if (/:\s*[^:]*$/.test(before)) return null;   // a label / a member
      if (inBlock) return null;                      // a member line inside `class X { … }`
      const rel = /\s([<*o.-][<|*o.>-]*)$/.exec(before);
      if (rel) return _result(context.pos - rel[1].length, _arrows(CLASS_RELATIONS), /^[<|*o.>-]*$/);
      if (/(?:<\|--|--\|>|<\|\.\.|\.\.\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|--|\.\.)\s*(?:"[^"]*"\s*)?[\w~]*$/.test(before)) return _result(from, _classes(syms, typed));
      if (lineStart) return want ? _result(from, [..._kw(kws.start), ..._classes(syms, typed)]) : null;
      return want ? _result(from, [..._classes(syms, typed), ..._opts(kws.inline, 'keyword')]) : null;
    }
    case 'state': {
      if (/<<[a-z]*$/.test(before)) return _result(context.pos - /[a-z]*$/.exec(before)[0].length, STATE_ANNOTATIONS.map(label => ({ label, type: 'keyword', apply: label + '>>' })), /^[a-z]*$/);
      if (/:::[\w-]*$/.test(before)) return _result(context.pos - /[\w-]*$/.exec(before)[0].length, _classes(syms), /^[\w-]*$/);
      if (/:\s*[^:]*$/.test(before)) return null;
      if (/^\s*state\s+"[^"]*"\s+[a-z]*$/.test(before)) return _result(from, _kw(['as']));
      if (/^\s*state\s+\S*$/.test(before)) return null;
      if (/^\s*note\s+(left of|right of)\s+[\w-]*$/.test(before)) return _result(from, _ids(syms, typed));
      const side = /^\s*note\s+([a-z ]*)$/.exec(before);
      if (side) return _result(context.pos - side[1].length, ['left of', 'right of'].map(label => ({ label, type: 'keyword', apply: label + ' ' })), /^[a-z ]*$/);
      const star = { label: '[*]', type: 'constant', detail: 'start / end' };
      if (/-->\s*[\p{L}\p{N}_[\]*-]*$/u.test(before)) return _result(context.pos - /[\p{L}\p{N}_[\]*-]*$/u.exec(before)[0].length, [..._ids(syms, typed), star], /^[\p{L}\p{N}_[\]*-]*$/u);
      if (/\s(-[->]*)$/.test(before)) return _result(context.pos - /-[->]*$/.exec(before)[0].length, [{ label: '-->', type: 'text', detail: 'transition' }], /^[->]*$/);
      if (lineStart) return want ? _result(context.pos - /[\p{L}\p{N}_[\]*-]*$/u.exec(before)[0].length, [..._kw(kws.start), ..._ids(syms, typed), star], /^[\p{L}\p{N}_[\]*-]*$/u) : null;
      return want ? _result(from, _ids(syms, typed)) : null;
    }
    case 'er': {
      if (/:\s*[^:]*$/.test(before)) return null;
      if (inBlock) {
        // An attribute line: `type name [PK|FK|UK] ["comment"]`
        if (/^\s*\S+\s+\S+\s+[A-Z,\s]*$/.test(before)) return _result(from, _opts(['PK', 'FK', 'UK'], 'keyword'));
        return null;
      }
      const rel = /\s([|}o][|o{.-]*)$/.exec(before);
      if (rel) return _result(context.pos - rel[1].length, _arrows(ER_RELATIONS), /^[|}o{.-]*$/);
      if (/(?:[|}o][|o{]?(?:--|\.\.)[|{o][|o{]?)\s*[\p{L}\p{N}_-]*$/u.test(before)) return _result(from, _ids(syms, typed));
      if (lineStart) return want ? _result(from, [..._ids(syms, typed), ..._kw(kws.start)]) : null;
      return want ? _result(from, _opts(kws.inline, 'keyword')) : null;
    }
    case 'gantt': {
      if (/\b(after|until)\s+[\w-]*$/.test(before)) return _result(from, _ids(syms, typed));
      if (/:[^:]*$/.test(before)) {
        // The tags of a task: `name : done, crit, after a1, 2024-01-01, 3d`
        if (!/,\s*[\w-]*$|:\s*[\w-]*$/.test(before)) return null;
        return _result(from, [..._opts(['done', 'active', 'crit', 'milestone', 'vert'], 'keyword'), ..._kw(['after', 'until']), ..._ids(syms, typed)]);
      }
      if (/^\s*excludes\s+[a-z]*$/.test(before)) return _result(from, _opts(['weekends', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], 'constant'));
      if (lineStart) return want ? _result(from, _kw(kws.start)) : null;
      return null;
    }
    case 'git': {
      if (/^\s*(checkout|switch|merge)\s+[\w-]*$/.test(before)) return _result(from, _ids(syms, typed));
      if (/\btype:\s*[A-Z]*$/.test(before)) return _result(from, _opts(['NORMAL', 'REVERSE', 'HIGHLIGHT'], 'constant'));
      if (/^\s*(commit|merge|cherry-pick)\b.*\s[a-z]*$/.test(before)) return _result(from, ['id', 'tag', 'type', 'parent'].map(label => ({ label, type: 'property', apply: label + ': ' })));
      if (/^\s*branch\s+\S*$/.test(before)) return null;
      if (lineStart) return want ? _result(from, _kw(kws.start)) : null;
      return null;
    }
    default: {
      if (/:\s*[^:]*$/.test(before) && (family === 'pie' || family === 'timeline' || family === 'journey')) return null;
      if (lineStart) {
        const withIds = family === 'architecture' || family === 'block' || family === 'requirement' || family === 'kanban' || family === 'mindmap' || family === 'c4';
        return want ? _result(from, [..._kw(kws.start), ...(withIds ? _ids(syms, typed) : [])]) : null;
      }
      if (want && kws.inline.length) return _result(from, _opts(kws.inline, 'keyword'));
      return null;
    }
  }
}

/** Build a small tooltip DOM node. */
function _hoverDom(title, body) {
  const el = document.createElement('div');
  el.className = 'cm-doc-tooltip';
  const t = document.createElement('strong');
  t.textContent = title;
  el.appendChild(t);
  if (body) { el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(body)); }
  return el;
}

/** Icon-name completions from the merged Font Awesome set of `prefix` (async: the packs load on first use). */
async function _faIconCompletions(from, prefix) {
  const sets = await loadFaIconSets();
  const set = sets[prefix] ?? sets.fa;
  return {
    from,
    options: faIconNames(set).map(label => ({ label, type: 'constant', detail: 'icon' })),
    validFor: /^[\w-]*$/,
  };
}

/** Hover docs for diagram-type and in-diagram keywords. */
const mermaidHover = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  for (const m of line.text.matchAll(/[A-Za-z][\w-]*/g)) {
    const s = m.index, e = s + m[0].length;
    if (col < s || col > e) continue;
    const info = MERMAID_DIAGRAM_TYPES[m[0]] || MERMAID_KEYWORD_DOCS[m[0]]
      || (/@\{[^}]*$/.test(line.text.slice(0, s)) ? MERMAID_NODE_ATTR_DOCS[m[0]] : null);
    if (info) return { pos: line.from + s, end: line.from + e, above: true,
                       create: () => ({ dom: _hoverDom(m[0], info) }) };
  }
  return null;
});

/** Extract a concise reason from a mermaid parse error. */
function _mermaidReason(msg) {
  const lines = String(msg).split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /^Expecting|got ['"]/.test(l)) || lines[0] || 'Syntax error';
}

/**
 * Whole-document linter: front-matter schema diagnostics + a real Mermaid parse
 * (mermaid.parse rejects on invalid syntax, usually with a line number).
 */
async function mermaidLintSource(view) {
  const doc = view.state.doc.toString();
  const docLen = doc.length;
  const region = getFrontMatterRange(doc);
  const diags = [];

  if (region) diags.push(...schemaLint(mermaidFrontMatterSchema, region));

  const bodyFrom = region ? region.bodyFrom : 0;
  const body = doc.slice(bodyFrom);
  if (body.trim()) {
    // Parse exactly what render() parses: the forwarded `config:` block + body.
    const { source, prefixLines } = prepareMermaidSource(body, region?.innerText ?? null);
    try {
      await mermaid.parse(source);   // resolves when the diagram is valid
    } catch (err) {
      // Prefer a structured line (jison hash is 0-based); else scrape the message.
      let lineNo = (err && err.hash && typeof err.hash.line === 'number') ? err.hash.line + 1 : null;
      const msg = (err && (err.str || err.message)) || String(err);
      if (lineNo == null) { const m = /line\s*(\d+)/i.exec(msg); if (m) lineNo = parseInt(m[1], 10); }
      // A bad forwarded `config:` fails in mermaid's YAML parser, whose message
      // ends its first line with `(line:col)` relative to the front matter.
      if (lineNo == null && prefixLines) { const m = /^[^\n]*\((\d+):\d+\)\s*$/m.exec(msg); if (m) lineNo = parseInt(m[1], 10) + 1; }

      // A line inside the forwarded block = the document's own `config:` is bad.
      if (lineNo != null && prefixLines && lineNo <= prefixLines && region) {
        const cfg = region.innerText.search(/^(config|displayMode)\s*:/m);
        const at = region.innerFrom + Math.max(cfg, 0);
        const line = view.state.doc.lineAt(Math.min(at, docLen));
        diags.push({ from: line.from, to: line.to, severity: 'error',
                     message: `Mermaid config: ${_mermaidReason(msg)}` });
        return diags;
      }
      if (lineNo != null && prefixLines) lineNo -= prefixLines;

      // Map the body-relative line to an absolute document line.
      const bodyLines = body.split('\n');
      const li = Math.min(Math.max((lineNo || 1) - 1, 0), bodyLines.length - 1);
      let off = 0;
      for (let i = 0; i < li; i++) off += bodyLines[i].length + 1;
      const line = view.state.doc.lineAt(Math.min(bodyFrom + off, docLen));
      diags.push({ from: line.from, to: line.to, severity: 'error',
                   message: `Mermaid: ${_mermaidReason(msg)}` });
    }

    // Font Awesome references the bundled packs can't draw: mermaid falls back
    // to an `<i class="fa fa-…">` (nothing, with no webfont) or the `?` icon
    // without a word, so the editor says it.  The packs load on the first
    // document that mentions one (never for a diagram without icons).
    const refs = findFaRefs(body);
    if (refs.length) {
      const sets = await loadFaIconSets();
      for (const r of refs) {
        const set = sets[r.prefix];
        const message = !set
          ? `Font Awesome Kit icons (${r.prefix}:) are not available offline`
          : lookupFaIcon(set, r.name) ? null
          : `Unknown Font Awesome icon "${r.name}"`;
        if (message) diags.push({ from: bodyFrom + r.from, to: bodyFrom + r.to, severity: 'warning', message });
      }
    }
  }

  return diags
    .map(d => ({ ...d, from: Math.max(0, Math.min(d.from, docLen)), to: Math.max(0, Math.min(d.to, docLen)) }))
    .filter(d => d.from <= d.to);
}

// ---------------------------------------------------------------------------
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    mermaidLanguage,
    mermaidLanguage.data.of({ autocomplete: mermaidComplete }),
    linter(mermaidLintSource, { delay: 500 }),
    mermaidHover,
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const mermaidDSL = {
  id: 'mermaid',
  label: 'Mm',
  version: '1.0.0',
  name: 'Mermaid',
  extensions: ['.mmd', '.mermaid'],
  editorMode: 'mermaid',
  // Mod-/ (editor.js): `%%` comments; a `%%{init}%%` directive is code and comments out as `%% %%{…`.
  commentTokens: { line: '%%', directive: /^%%\{/ },
  // The theme is baked into each rendered svg — preview.js re-renders a
  // document that uses this DSL whenever the app's colour theme changes.
  themeAware: true,
  // Shown in Settings → About (the bundled icon packs require attribution).
  credits: [{ what: 'Font Awesome Free icons', license: 'CC BY 4.0', url: 'https://fontawesome.com/license/free' }],

  render,
  renderToString,
  getEditorExtensions,

  exporters: {
    svg: { label: 'SVG', mime: 'image/svg+xml', ext: '.svg', export: exportSVG },
    // `binary`: the dialog downloads the Blob as is — a text() round-trip
    // corrupts PNG bytes (every {diagram} PNG export was unreadable before).
    png: { label: 'PNG', mime: 'image/png',     ext: '.png', export: exportPNG, binary: true }
  },

  detect(content) {
    return !!diagramTypeOf(content);
  }
};

registerDSL(mermaidDSL);
export default mermaidDSL;
