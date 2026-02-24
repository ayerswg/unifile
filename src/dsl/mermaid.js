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
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { catppuccinHighlight } from '../ui/editor-theme.js';
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

// Initialise once at module load
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

  const id = `mermaid-${++_renderCounter}`;

  try {
    const { svg } = await mermaid.render(id, content);
    el.innerHTML = svg;
  } catch (e) {
    el.innerHTML = `<pre class="error">Mermaid error:\n${e.message}</pre>`;
    document.getElementById(id)?.remove();
  }
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
    syntaxHighlighting(catppuccinHighlight)
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const mermaidDSL = {
  id: 'mermaid',
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
