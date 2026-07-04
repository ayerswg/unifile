/**
 * Mermaid DSL plugin
 *
 * Always bundled offline — no CDN fetches at runtime.
 * Rendering: mermaid (npm), bundled by esbuild.
 * Export:    SVG, PNG (via canvas)
 *
 * Supports flowcharts, sequence diagrams, class diagrams,
 * state diagrams, gantt charts, pie charts, and more.
 */

import mermaid from 'mermaid';
import { StreamLanguage } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { hoverTooltip } from '@codemirror/view';
import { registerDSL } from './registry.js';
import { getFrontMatterRange } from '../core/front-matter.js';
import { schemaCompletions, schemaLint } from '../core/fm-schema.js';

// ---------------------------------------------------------------------------
// Simple Mermaid stream language for CodeMirror 6
// Provides keyword, operator, string, and comment highlighting.
// ---------------------------------------------------------------------------

const MERMAID_KEYWORDS = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|gantt|pie|journey|gitGraph|mindmap|quadrantChart|erDiagram|requirementDiagram|C4Context|C4Container|block-beta)\b/;

const mermaidLanguage = StreamLanguage.define({
  name: 'mermaid',
  token(stream) {
    // Comments
    if (stream.match(/%%.*$/)) return 'comment';
    // Diagram type keywords (at start of meaningful lines)
    if (stream.sol() && stream.match(MERMAID_KEYWORDS)) return 'keyword';
    // Subgraph / direction keywords
    if (stream.match(/\b(subgraph|end|direction|LR|RL|TD|TB|BT)\b/)) return 'keyword';
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

// Initialise once at module load with the dark theme (app default).
// The render() function re-initialises per-call based on rendering context.
// logLevel 'fatal' keeps the live linter's caught mermaid.parse() rejections
// from spamming the console on every keystroke while a diagram is incomplete.
mermaid.initialize({ startOnLoad: false, theme: 'dark', logLevel: 'fatal' });

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
  // Re-initialising before each render is safe because renders are sequential
  // (each slide or page is awaited before the next begins).
  const inPrintContext = !!el.closest?.('.uf-slide-frame, .uf-doc-page');
  mermaid.initialize({ startOnLoad: false, theme: inPrintContext ? 'default' : _resolveTheme(), logLevel: 'fatal' });

  const id = `mermaid-${++_renderCounter}`;

  try {
    const { svg } = await mermaid.render(id, content);
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
      _annotateFlowNodes(svgEl, content, el);
    }
  } catch (e) {
    el.innerHTML = `<pre class="error">Mermaid error:\n${e.message}</pre>`;
    document.getElementById(id)?.remove();
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
 * @param {string}     content The mermaid source text passed to render()
 * @param {Element}    wrapEl  The wrapper element with data-doc-from (absolute offset)
 */
function _annotateFlowNodes(svgEl, content, wrapEl) {
  const nodes = svgEl.querySelectorAll('g.node');
  if (!nodes.length) return;

  // Absolute document offset where this section's *content* starts (after shebang).
  // dslContentFrom is set by layout renderers; fall back to docFrom for the
  // standalone preview path where docFrom already points at content start.
  const base = parseInt(wrapEl.dataset.dslContentFrom ?? wrapEl.dataset.docFrom ?? '0', 10);

  for (const node of nodes) {
    // Mermaid node id format: "flowchart-NODEID-N" or "mermaid-abc-NODEID-N"
    const rawId = node.id ?? '';
    const m = /^(?:flowchart-|mermaid-[^-]+-|mermaid-[a-z0-9]+-)?(.+?)-\d+$/.exec(rawId);
    if (!m) continue;
    const nodeId = m[1];
    if (!nodeId) continue;

    // Search source text for the node ID at a word boundary.
    const re = new RegExp(`(?:^|\\s|[\\[\\](){}|>])${_escRegex(nodeId)}(?:$|[\\s\\[\\](){}|<>\\-=.])`, 'm');
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

/** Return the mermaid theme that matches the current app/browser colour scheme. */
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
    const id = `mermaid-noscript-${Date.now()}`;
    const { svg } = await mermaid.render(id, content);
    return svg;
  } catch {
    return `<pre>${content}</pre>`;
  }
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

async function exportSVG(content) {
  const id = `mermaid-export-${Date.now()}`;
  const { svg } = await mermaid.render(id, content);
  return new Blob([svg], { type: 'image/svg+xml' });
}

async function exportPNG(content) {
  const id = `mermaid-export-png-${Date.now()}`;
  const { svg } = await mermaid.render(id, content);

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
    const info = MERMAID_DIAGRAM_TYPES[m[0]] || MERMAID_KEYWORD_DOCS[m[0]];
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
    try {
      await mermaid.parse(body);   // resolves when the diagram is valid
    } catch (err) {
      // Prefer a structured line (jison hash is 0-based); else scrape the message.
      let lineNo = (err && err.hash && typeof err.hash.line === 'number') ? err.hash.line + 1 : null;
      const msg = (err && (err.str || err.message)) || String(err);
      if (lineNo == null) { const m = /line\s*(\d+)/i.exec(msg); if (m) lineNo = parseInt(m[1], 10); }

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

  render,
  renderToString,
  getEditorExtensions,

  exporters: {
    svg: { label: 'SVG', mime: 'image/svg+xml', ext: '.svg', export: exportSVG },
    png: { label: 'PNG', mime: 'image/png',     ext: '.png', export: exportPNG }
  },

  detect(content) {
    return /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|journey|gitGraph)/m
      .test(content.trim());
  }
};

registerDSL(mermaidDSL);
export default mermaidDSL;
