/**
 * Markdown DSL plugin
 *
 * Always bundled offline — no CDN fetches at runtime.
 * Rendering: marked (npm) + DOMPurify (npm), bundled by esbuild.
 * Export:    HTML blob, plain text blob, PDF via browser print dialog
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdown as cmMarkdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { catppuccinHighlight } from '../ui/editor-theme.js';
import { registerDSL } from './registry.js';

// Configure once at module load
marked.setOptions({ gfm: true, breaks: true });

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function safeHtml(raw) {
  return DOMPurify.sanitize(raw);
}

async function render(content, el) {
  el.innerHTML = safeHtml(marked.parse(content || ''));

  // Add copy buttons to fenced code blocks
  el.querySelectorAll('pre > code').forEach(code => {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(code.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    code.parentElement.style.position = 'relative';
    code.parentElement.appendChild(btn);
  });
}

export async function renderToString(content) {
  return safeHtml(marked.parse(content || ''));
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

async function exportHTML(content) {
  const body = await renderToString(content);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Export</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
  pre{background:#f5f5f5;padding:1em;border-radius:4px;overflow-x:auto}
  code{font-family:monospace}
  blockquote{border-left:4px solid #ccc;margin-left:0;padding-left:1em;color:#666}
  img{max-width:100%}
</style>
</head>
<body>${body}</body>
</html>`;
  return new Blob([html], { type: 'text/html' });
}

async function exportPDF(content) {
  const body = await renderToString(content);
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <style>body{font-family:system-ui,sans-serif;margin:40px;line-height:1.6}</style>
  </head><body>${body}</body></html>`);
  win.document.close();
  win.print();
  return null; // handled by print dialog
}

async function exportText(content) {
  return new Blob([content], { type: 'text/plain' });
}

// ---------------------------------------------------------------------------
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    // Full Markdown language with inline formatting awareness
    cmMarkdown(),
    // Continue list items on Enter, smart delete with Backspace
    keymap.of(markdownKeymap),
    // Catppuccin syntax highlighting — makes **bold** appear bold, etc.
    syntaxHighlighting(catppuccinHighlight)
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const markdownDSL = {
  id: 'markdown',
  name: 'Markdown',
  extensions: ['.md', '.markdown'],
  editorMode: 'markdown',

  render,
  renderToString,
  getEditorExtensions,

  exporters: {
    html: { label: 'HTML',        mime: 'text/html',        ext: '.html', export: exportHTML },
    pdf:  { label: 'PDF (print)', mime: 'application/pdf',  ext: '.pdf',  export: exportPDF  },
    text: { label: 'Plain text',  mime: 'text/plain',       ext: '.md',   export: exportText }
  },

  detect(content) {
    return /^#{1,6}\s/m.test(content) ||
           /^\s*[-*+]\s/m.test(content) ||
           /^```/m.test(content);
  }
};

registerDSL(markdownDSL);
export default markdownDSL;
