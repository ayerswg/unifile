/**
 * Markdown DSL plugin
 *
 * Always bundled offline — no CDN fetches at runtime.
 * Rendering: marked (npm) + DOMPurify (npm), bundled by esbuild.
 * Export:    HTML blob, plain text blob, PDF via browser print dialog,
 *            DOCX via the `docx` npm package.
 *
 * Front matter: YAML block delimited by `---` at the start of the document.
 *   Supported keys: title, subtitle, author, date.
 *   Renders as a centered header block above the document body.
 *
 * Page breaks: `---` (markdown horizontal rule) renders as a visible
 *   page-break marker in preview and forces a real page break in print/PDF/DOCX.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { markdown as cmMarkdown, commonmarkLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { Language, syntaxHighlighting } from '@codemirror/language';
import { keymap } from '@codemirror/view';
import { markdownKeymap } from '@codemirror/lang-markdown';

// GFM-only editor language: CommonMark + GFM extensions (tables, strikethrough,
// task lists, autolinks) — exactly what `marked` renders with `gfm: true`.
// We deliberately exclude the Subscript (~x~) and Superscript (^x^) extensions
// that markdownLanguage bundles, because marked does NOT render those and they
// would produce false syntax highlights (e.g. ~word~ lit up as if meaningful).
const gfmEditorLanguage = new Language(
  commonmarkLanguage.data,
  commonmarkLanguage.parser.configure([GFM]),
  [],
  'markdown'
);
import { catppuccinHighlight } from '../ui/editor-theme.js';
import { registerDSL } from './registry.js';
import {
  Document, Paragraph, TextRun, HeadingLevel,
  AlignmentType, PageBreak, Packer,
  Table, TableRow, TableCell, WidthType, LevelFormat
} from 'docx';

// ---------------------------------------------------------------------------
// marked configuration — set options and override hr renderer for page breaks
// ---------------------------------------------------------------------------

marked.setOptions({ gfm: true, breaks: true });

// Override `---` (hr) to output a page-break div instead of <hr>.
// This div shows as a labelled separator in the preview and triggers an
// actual page break in print/PDF/DOCX output.
marked.use({
  renderer: {
    hr() {
      return '<div class="page-break"><span>page break</span></div>\n';
    }
  }
});

// Strict GFM strikethrough: only ~~double-tilde~~ should render as <del>.
// marked's built-in regex is `~~?` which also accepts ~single-tilde~.
// We override the `del` tokenizer to:
//   ~~double~~ → normal del token  (strikethrough)
//   ~single~   → plain text token  (consumes the `~` so the fallback
//                tokenizer never sees it; marked chains the original when
//                the override returns `false`, so we must return truthy)
marked.use({
  tokenizer: {
    del(src) {
      const cap = /^(~~?)(?=[^\s~])([\s\S]*?[^\s~])\1(?=[^~]|$)/.exec(src);
      if (cap) {
        if (cap[1] === '~~') {
          return { type: 'del', raw: cap[0], text: cap[2],
                   tokens: this.lexer.inlineTokens(cap[2]) };
        }
        // Single tilde — consume the `~` as plain text and stop.
        return { type: 'text', raw: '~', text: '~' };
      }
      return false;
    }
  }
});

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/**
 * Strip YAML front matter from the start of content and return the parsed
 * key/value pairs plus the remaining body text.
 *
 * Supported block format:
 *   ---
 *   title: My Document
 *   subtitle: "A subtitle with: a colon"
 *   author: Jane Smith
 *   date: 2026-02-28
 *   ---
 */
function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    // Strip surrounding single or double quotes
    if (/^["'](.*)["']$/.test(val)) val = val.slice(1, -1);
    meta[kv[1]] = val;
  }

  return { meta, body: content.slice(match[0].length) };
}

/**
 * Build the HTML for the front matter title/subtitle/author/date block.
 * Returns an empty string if none of the fields are present.
 */
function renderFrontMatterBlock(meta) {
  if (!meta.title && !meta.subtitle && !meta.author && !meta.date) return '';
  return `<div class="fm-header">
    ${meta.title    ? `<h1 class="fm-title">${escHtml(meta.title)}</h1>` : ''}
    ${meta.subtitle ? `<p class="fm-subtitle">${escHtml(meta.subtitle)}</p>` : ''}
    ${meta.author   ? `<p class="fm-author">${escHtml(meta.author)}</p>` : ''}
    ${meta.date     ? `<p class="fm-date">${escHtml(meta.date)}</p>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function safeHtml(raw) {
  return DOMPurify.sanitize(raw);
}

async function render(content, el) {
  const { meta, body } = parseFrontMatter(content || '');
  el.innerHTML = renderFrontMatterBlock(meta) + safeHtml(marked.parse(body));

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
  const { meta, body } = parseFrontMatter(content || '');
  return renderFrontMatterBlock(meta) + safeHtml(marked.parse(body));
}

// ---------------------------------------------------------------------------
// Exporters
// ---------------------------------------------------------------------------

/** Shared CSS injected into HTML and PDF exports. */
const EXPORT_CSS = `
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a2e; }
  h1,h2,h3,h4 { line-height: 1.3; margin-top: 1.5em; }
  h1 { font-size: 2em; border-bottom: 1px solid #ddd; padding-bottom: .3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
  pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { font-family: monospace; background: #f0f0f0; padding: .1em .3em; border-radius: 3px; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ccc; margin-left: 0; padding-left: 1em; color: #666; }
  img { max-width: 100%; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: .4em .8em; }
  th { background: #f5f5f5; }

  /* Front matter header block */
  .fm-header { text-align: center; margin: 1.5em 0 2.5em; padding-bottom: 1.5em; border-bottom: 1px solid #ddd; }
  .fm-title { font-size: 2.2em; font-weight: 700; border: none; padding: 0; margin: 0 0 0.25em; }
  .fm-subtitle { font-size: 1.15em; font-style: italic; color: #555; margin: 0 0 0.5em; }
  .fm-author { font-size: 0.95em; color: #555; margin: 0; }
  .fm-date { font-size: 0.85em; color: #888; margin: 0.25em 0 0; }

  /* Page break — force break when printing */
  .page-break { break-after: page; page-break-after: always; height: 0; margin: 2em 0; border-top: 1px dashed #ccc; }
  .page-break span { display: none; }
`;

async function exportHTML(content) {
  const body = await renderToString(content);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Export</title>
<style>${EXPORT_CSS}</style>
</head>
<body>${body}</body>
</html>`;
  return new Blob([html], { type: 'text/html' });
}

async function exportPDF(content) {
  const body = await renderToString(content);
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <style>${EXPORT_CSS}</style>
  </head><body>${body}</body></html>`);
  win.document.close();
  win.print();
  return null; // handled by print dialog
}

async function exportText(content) {
  // Strip front matter from plain text export
  const { body } = parseFrontMatter(content || '');
  return new Blob([body], { type: 'text/plain' });
}

// ---------------------------------------------------------------------------
// DOCX export
// ---------------------------------------------------------------------------

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];

/**
 * Convert a marked inline-tokens array to an array of docx TextRun objects.
 * `opts` carries inherited formatting (bold, italics, strike, font).
 */
function inlineToRuns(tokens = [], opts = {}) {
  const runs = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case 'text':
        // text tokens may themselves have nested inline tokens
        if (tok.tokens?.length) {
          runs.push(...inlineToRuns(tok.tokens, opts));
        } else if (tok.text) {
          runs.push(new TextRun({ text: tok.text, ...opts }));
        }
        break;
      case 'escape':
        if (tok.text) runs.push(new TextRun({ text: tok.text, ...opts }));
        break;
      case 'strong':
        runs.push(...inlineToRuns(tok.tokens, { ...opts, bold: true }));
        break;
      case 'em':
        runs.push(...inlineToRuns(tok.tokens, { ...opts, italics: true }));
        break;
      case 'del':
        runs.push(...inlineToRuns(tok.tokens, { ...opts, strike: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({ text: tok.text, font: 'Courier New', ...opts }));
        break;
      case 'link':
        // Render link text only (no hyperlink support for now)
        runs.push(new TextRun({ text: tok.text || tok.href, ...opts }));
        break;
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      case 'html':
        // Skip raw inline HTML
        break;
      default:
        if (tok.text) runs.push(new TextRun({ text: tok.text, ...opts }));
        break;
    }
  }
  return runs;
}

/**
 * Build a multi-level numbering config for the docx Document.
 * `format` is LevelFormat.BULLET or LevelFormat.DECIMAL.
 * Levels 0–8 are pre-defined; paragraph indentation is applied directly
 * on each list Paragraph rather than inside the numbering definition to
 * avoid interactions that can produce unexpectedly small text.
 */
function makeNumberingConfig(reference, format) {
  return {
    reference,
    levels: Array.from({ length: 9 }, (_, level) => ({
      level,
      format,
      text: format === LevelFormat.BULLET ? '•' : `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
    }))
  };
}

/**
 * Recursively convert a marked list token to an array of docx Paragraph
 * objects using the native Word numbering system.
 *
 * Bullet lists share a single 'bullet-list' numbering reference.
 * Each ordered list gets its own unique reference so that counters
 * reset independently (e.g. two separate numbered lists both start at 1).
 *
 * `level` is the 0-based nesting depth; `ctx` is the shared mutable context
 * that accumulates numbering configs and tracks the ordered-list counter.
 */
function listToParas(token, level, ctx) {
  const isOrdered = token.ordered;
  let ref;
  if (isOrdered) {
    ref = `ordered-list-${ctx.orderedListIdx++}`;
    ctx.numbering.push(makeNumberingConfig(ref, LevelFormat.DECIMAL));
  } else {
    ref = 'bullet-list'; // pre-defined config; not added per-list
  }

  const paras = [];
  for (const item of token.items) {
    // First content block inside the item is 'text' (tight list) or
    // 'paragraph' (loose list — blank lines between items).
    const firstBlock = item.tokens?.[0];
    let runs = [];
    if (firstBlock?.type === 'text') {
      const toks = firstBlock.tokens?.length
        ? firstBlock.tokens
        : [{ type: 'text', text: firstBlock.text }];
      runs = inlineToRuns(toks);
    } else if (firstBlock?.type === 'paragraph') {
      runs = inlineToRuns(firstBlock.tokens);
    }

    paras.push(new Paragraph({
      style: "Normal",
      children: runs.length ? runs : [new TextRun({ text: '' })],
      numbering: { reference: ref, level },
      indent: { left: (level + 1) * 720, hanging: 360 },
    }));

    // Remaining sub-tokens: nested lists, continuation paragraphs, etc.
    for (const subTok of item.tokens?.slice(1) ?? []) {
      if (subTok.type === 'list') {
        // Recurse one level deeper — inherits same parent ref for bullets,
        // gets its own ref for ordered so the counter resets properly.
        paras.push(...listToParas(subTok, level + 1, ctx));
      } else {
        paras.push(...tokenToParas(subTok, { indent: level + 1 }, ctx));
      }
    }
  }
  return paras;
}

/** Map a markdown table-cell alignment to a docx AlignmentType. */
function cellAlign(align) {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right')  return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

/**
 * Convert a marked table token to a docx Table with proper rows and cells.
 * Header row cells are rendered bold; column alignment is respected.
 * Each column receives an equal share of the text-area width (US Letter page
 * with standard margins ≈ 9360 twips wide).
 */
function tableToDocx(token) {
  const numCols = Math.max((token.header || []).length, 1);
  const colWidth = Math.floor(9360 / numCols); // twips per column

  // marked stores alignment on each cell object directly (cell.align) and
  // also on the table's top-level align array; prefer the per-cell value.
  const makeCell = (cell, i, bold = false) => new TableCell({
    width: { size: colWidth, type: WidthType.DXA },
    children: [new Paragraph({
      style: "Normal",
      alignment: cellAlign(cell.align ?? token.align?.[i]),
      children: inlineToRuns(
        cell.tokens?.length ? cell.tokens : [{ type: 'text', text: cell.text }],
        bold ? { bold: true } : {}
      )
    })]
  });

  const headerRow = new TableRow({
    tableHeader: true,
    children: (token.header || []).map((cell, i) => makeCell(cell, i, true))
  });

  const dataRows = (token.rows || []).map(row => new TableRow({
    children: row.map((cell, i) => makeCell(cell, i, false))
  }));

  return new Table({
    columnWidths: Array(numCols).fill(colWidth),
    rows: [headerRow, ...dataRows]
  });
}

/**
 * Convert a single marked block token to an array of docx block elements
 * (Paragraph or Table). `indent` is used for blockquote nesting only.
 * `ctx` accumulates the numbering configs needed by lists.
 */
function tokenToParas(token, { indent = 0 } = {}, ctx) {
  switch (token.type) {
    case 'heading': {
      const level = HEADING_LEVELS[Math.min(token.depth - 1, 5)];
      return [new Paragraph({ heading: level, children: inlineToRuns(token.tokens) })];
    }

    case 'paragraph':
      return [new Paragraph({
        // Explicit "Normal" style so Word never inherits the preceding
        // heading's paragraph style for this content paragraph.
        style: "Normal",
        children: inlineToRuns(token.tokens),
        indent: indent ? { left: indent * 720 } : undefined
      })];

    case 'code': {
      // One paragraph per line to preserve code block line breaks in Word
      const lines = (token.text || '').split('\n');
      return lines.map((line, i) => new Paragraph({
        style: "Normal",
        children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 20 })],
        spacing: i === 0 ? { before: 100 } : { before: 0, after: 0 },
      }));
    }

    case 'blockquote':
      return (token.tokens || []).flatMap(t => tokenToParas(t, { indent: indent + 1 }, ctx));

    case 'list':
      return listToParas(token, 0, ctx);

    case 'hr':
      // `---` → page break in DOCX
      return [new Paragraph({ style: "Normal", children: [new PageBreak()] })];

    case 'space':
      return [new Paragraph({ style: "Normal" })];

    case 'table':
      return [tableToDocx(token)];

    default:
      return [];
  }
}

async function exportDocx(content) {
  const { meta, body } = parseFrontMatter(content || '');
  const tokens = marked.lexer(body);

  // ctx accumulates numbering configs as lists are encountered and tracks
  // the per-ordered-list counter used to generate unique reference strings.
  const ctx = {
    numbering: [makeNumberingConfig('bullet-list', LevelFormat.BULLET)],
    orderedListIdx: 0,
  };

  const children = [];

  // Front matter — use dedicated paragraph styles (FMTitle / FMSubtitle /
  // FMAuthor / FMDate) so that the alignment and run properties live in the
  // style table rather than as direct paragraph properties.  Direct paragraph
  // `alignment` is also set as a belt-and-suspenders backup in case a
  // particular Word build prefers the inline property over the style entry.
  if (meta.title) {
    children.push(new Paragraph({
      style: 'Title',
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.title })],
    }));
  }
  if (meta.subtitle) {
    children.push(new Paragraph({
      style: 'Subtitle',
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.subtitle })],
    }));
  }
  if (meta.author) {
    children.push(new Paragraph({
      style: 'Author',
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.author })],
    }));
  }
  if (meta.date) {
    children.push(new Paragraph({
      style: 'Date',
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: meta.date })],
    }));
  }

  // Convert body tokens to docx block elements
  for (const token of tokens) {
    children.push(...tokenToParas(token, {}, ctx));
  }

  // Explicitly define paragraph styles so Word has a complete style table.
  //
  // - "Normal" must be defined so that `style: "Normal"` on body paragraphs
  //   reliably resolves to Calibri 11pt instead of falling back to whatever
  //   Word infers as the document default.
  //
  // - Each heading style carries `next: 'Normal'`, which is the OOXML signal
  //   that the paragraph following a heading should revert to body-text style.
  //   Without this, Word keeps using the heading style for subsequent paragraphs.
  //
  // IMPORTANT: using `styles.paragraphStyles` (not `styles.default.document`)
  // generates `<w:style>` elements in word/styles.xml, NOT `<w:docDefaults>`.
  // This means it does NOT interfere with direct paragraph `alignment` props,
  // so the centred front-matter title/subtitle/author/date paragraphs are safe.
  const doc = new Document({
    styles: {
      paragraphStyles: [
        // ── Body / default ──────────────────────────────────────────────────
        {
          id: 'Normal',
          name: 'Body',
          quickFormat: true,
          run: { font: 'Calibri', size: 22 },          // 11 pt body text
        },

        // ── Front matter block ───────────────────────────────────────────────
        // All formatting (alignment, font, size, spacing) lives in the style
        // definition.  Paragraphs also carry a direct `alignment` property as
        // a backup, but putting it here is the most reliable path for Word.
        {
          id: 'Title', name: 'Title',
          basedOn: 'Normal', next: 'Normal',
          run:       { bold: true, size: 52, font: 'Calibri' },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 160 } },
        },
        {
          id: 'Subtitle', name: 'Subtitle',
          basedOn: 'Normal', next: 'Normal',
          run:       { italics: true, size: 28 },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 80 } },
        },
        {
          id: 'Author', name: 'Author',
          basedOn: 'Normal', next: 'Normal',
          run:       { size: 24 },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 40 } },
        },
        {
          id: 'Date', name: 'Date',
          basedOn: 'Normal', next: 'Normal',
          run:       { size: 22, color: '888888' },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 400 } },
        },

        // ── Headings (next: 'Normal' makes Word revert to body after a heading)
        {
          id: 'Heading1', name: 'Heading 1',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 32, font: 'Calibri Light', color: '2F5496' },
          paragraph: { spacing: { before: 240, after: 0 }, keepNext: true },
        },
        {
          id: 'Heading2', name: 'Heading 2',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 26, font: 'Calibri Light', color: '2F5496' },
          paragraph: { spacing: { before: 200, after: 0 }, keepNext: true },
        },
        {
          id: 'Heading3', name: 'Heading 3',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 24, font: 'Calibri Light', color: '1F3864' },
          paragraph: { spacing: { before: 160, after: 0 }, keepNext: true },
        },
        {
          id: 'Heading4', name: 'Heading 4',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 22, font: 'Calibri Light', color: '2F5496' },
          paragraph: { spacing: { before: 140, after: 0 }, keepNext: true },
        },
        {
          id: 'Heading5', name: 'Heading 5',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 22, color: '2F5496' },
          paragraph: { spacing: { before: 120, after: 0 }, keepNext: true },
        },
        {
          id: 'Heading6', name: 'Heading 6',
          basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run:       { bold: true, size: 22, color: '595959' },
          paragraph: { spacing: { before: 100, after: 0 }, keepNext: true },
        },
      ],
    },
    numbering: { config: ctx.numbering },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

// ---------------------------------------------------------------------------
// CodeMirror 6 editor extensions
// ---------------------------------------------------------------------------

function getEditorExtensions() {
  return [
    // GFM-only base: strikethrough, tables, task lists — no subscript/superscript.
    cmMarkdown({ base: gfmEditorLanguage }),
    // Continue list items on Enter, smart delete with Backspace
    keymap.of(markdownKeymap),
    // Catppuccin syntax highlighting — **bold**, *italic*, ~~struck~~, etc.
    syntaxHighlighting(catppuccinHighlight)
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    docx: {
      label: 'Word (.docx)',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext: '.docx',
      binary: true,
      export: exportDocx
    },
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
