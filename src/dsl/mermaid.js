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
 * Icons (`@{ icon: … }`, architecture `(logos:…)`) need an iconify pack
 * registered via mermaid.registerIconPacks — mermaid fetches none itself; no
 * pack is bundled yet, so only mermaid's built-in architecture icons draw.
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

// ---------------------------------------------------------------------------
// Simple Mermaid stream language for CodeMirror 6
// Provides keyword, operator, string, and comment highlighting.
// ---------------------------------------------------------------------------

// Every diagram keyword mermaid 12 detects (the first meaningful line).
const MERMAID_KEYWORDS = /^(graph|flowchart|flowchart-elk|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|gantt|pie|journey|gitGraph|mindmap|quadrantChart|erDiagram|requirementDiagram|requirement|timeline|kanban|packet-beta|packet|architecture-beta|xychart-beta|xychart|sankey-beta|sankey|radar-beta|treemap-beta|treemap|block-beta|block|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|usecase-beta|venn-beta|wardley-beta|railroad-beta|ishikawa-beta|treeView-beta|swimlane-beta|cynefin-beta|zenuml)\b/;

// Keys of the `@{ shape: …, label: …, icon: … }` node-metadata syntax (mermaid ≥ 11.3).
const MERMAID_NODE_ATTRS = /^(shape|label|icon|form|pos|h|w|constraint|img|dir)(?=\s*:)/;

const mermaidLanguage = StreamLanguage.define({
  name: 'mermaid',
  token(stream) {
    // Comments
    if (stream.match(/%%.*$/)) return 'comment';
    // Diagram type keywords (at start of meaningful lines)
    if (stream.sol() && stream.match(MERMAID_KEYWORDS)) return 'keyword';
    // Subgraph / direction keywords
    if (stream.match(/\b(subgraph|end|direction|LR|RL|TD|TB|BT)\b/)) return 'keyword';
    // `A@{ shape: docs, label: "…" }` — the @ and the attribute names
    if (stream.match(/@(?=\{)/)) return 'punctuation';
    if (stream.match(MERMAID_NODE_ATTRS)) return 'propertyName';
    // Edge labels and arrows
    if (stream.match(/-->|==>|-\.->|--[^>]*-->|===[^>]*==>/)) return 'operator';
    if (stream.match(/->|\|/)) return 'separator';
    // Quoted strings
    if (stream.match(/"[^"]*"/)) return 'string';
    if (stream.match(/'[^']*'/)) return 'string';
    // Node shape openers/closers
    if (stream.match(/[\[\](){}><]/)) return 'punctuation';
    // identifiers
    if (stream.match(/[A-Za-z_][A-Za-z0-9_-]*/)) return 'name';
    stream.next();
    return null;
  }
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

  const blob = await new Promise(resolve => {
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
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
  icon: 'Iconify icon name (`icon: "fa:user"`) — needs a registered icon pack.',
  form: 'Icon / image node form: `square`, `circle` or `rounded`.',
  pos: 'Label position for icon / image nodes: `t` (top) or `b` (bottom).',
  h: 'Height for icon / image nodes.',
  w: 'Width for icon / image nodes.',
  constraint: 'Image node: `on` keeps the aspect ratio, `off` stretches.',
  img: 'Image URL / data URI for an image node.',
};

// In-diagram keywords → short docs (completion + hover).
const MERMAID_KEYWORD_DOCS = {
  subgraph: 'Group nodes into a labelled subgraph. Close it with `end`.',
  end: 'Close a subgraph or block.',
  direction: 'Set flow direction inside a subgraph (TB, LR, …).',
  classDef: 'Define a reusable node-style class.',
  class: 'Apply a style class to one or more nodes.',
  click: 'Attach a link or callback interaction to a node.',
  style: 'Inline-style a single node.',
  linkStyle: 'Style edges by index.',
};

const MERMAID_DIRECTIONS = ['TB', 'TD', 'BT', 'RL', 'LR'];
const MERMAID_WORD_RE = /[A-Za-z][\w-]*$/;

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

/** Absolute offset of the first non-blank, non-comment body line. */
function _firstBodyLineFrom(cmDoc, bodyFrom) {
  let pos = bodyFrom;
  while (pos <= cmDoc.length) {
    const line = cmDoc.lineAt(pos);
    const t = line.text.trim();
    if (t && !t.startsWith('%%')) return line.from;
    if (line.to >= cmDoc.length) break;
    pos = line.to + 1;
  }
  return bodyFrom;
}

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

function mermaidBodyComplete(context, bodyFrom) {
  const cmDoc = context.state.doc;
  const line = cmDoc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const word = before.match(MERMAID_WORD_RE);
  const from = word ? context.pos - word[0].length : context.pos;

  // Inside `A@{ … }`: after `shape:` → the shape names; otherwise the attribute keys.
  const meta = /@\{[^}]*$/.exec(before);
  if (meta) {
    const shapeVal = /\bshape\s*:\s*([\w-]*)$/.exec(before);
    if (shapeVal) {
      return {
        from: context.pos - shapeVal[1].length,
        options: MERMAID_SHAPES.map(label => ({ label, type: 'constant', detail: 'shape' })),
        validFor: /^[\w-]*$/,
      };
    }
    if (context.explicit || (word && /[{,]\s*[\w-]*$/.test(before))) {
      return {
        from,
        options: Object.entries(MERMAID_NODE_ATTR_DOCS).map(([label, info]) => ({ label, type: 'property', info, apply: `${label}: ` })),
        validFor: /^[\w-]*$/,
      };
    }
    return null;
  }

  // First meaningful body line → diagram type.
  if (line.from === _firstBodyLineFrom(cmDoc, bodyFrom) && (context.explicit || word)) {
    return {
      from,
      options: Object.entries(MERMAID_DIAGRAM_TYPES)
        .map(([label, info]) => ({ label, type: 'keyword', info })),
      validFor: /^[\w-]*$/,
    };
  }

  // Later lines → keywords + directions.  CodeMirror filters by the typed text,
  // so node ids (no keyword match) simply won't show a popup.
  if (context.explicit || word) {
    return {
      from,
      options: [
        ...Object.entries(MERMAID_KEYWORD_DOCS).map(([label, info]) => ({ label, type: 'keyword', info })),
        ...MERMAID_DIRECTIONS.map(d => ({ label: d, type: 'constant', detail: 'direction' })),
      ],
      validFor: /^[\w-]*$/,
    };
  }
  return null;
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
  // The theme is baked into each rendered svg — preview.js re-renders a
  // document that uses this DSL whenever the app's colour theme changes.
  themeAware: true,

  render,
  renderToString,
  getEditorExtensions,

  exporters: {
    svg: { label: 'SVG', mime: 'image/svg+xml', ext: '.svg', export: exportSVG },
    png: { label: 'PNG', mime: 'image/png',     ext: '.png', export: exportPNG }
  },

  detect(content) {
    return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|kanban|quadrantChart|requirementDiagram|xychart|sankey|packet|architecture|block|radar|treemap|C4)/m
      .test(content.trim());
  }
};

registerDSL(mermaidDSL);
export default mermaidDSL;
