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
import { registerDSL } from './registry.js';

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
mermaid.initialize({ startOnLoad: false, theme: 'dark' });

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
  mermaid.initialize({ startOnLoad: false, theme: inPrintContext ? 'default' : _resolveTheme() });

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
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    mermaidLanguage,
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
