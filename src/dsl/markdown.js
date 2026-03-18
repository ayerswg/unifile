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
import { Language } from '@codemirror/language';
import { keymap, EditorView, ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
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
import { registerDSL } from './registry.js';
import {
  Document, Paragraph, TextRun, HeadingLevel,
  AlignmentType, PageBreak, Packer,
  Table, TableRow, TableCell, WidthType, LevelFormat, ImageRun
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
// Image extension — ![alt](url){width=40% align=right}
// ---------------------------------------------------------------------------
//
// A custom marked inline extension that handles the `{attrs}` suffix after
// standard markdown images.  Without the suffix the built-in image tokenizer
// runs unchanged.  With the suffix this extension captures:
//   width  – CSS value applied as an inline style, e.g. 40%, 320px
//   height – CSS value applied as an inline style
//   align  – left | center | right → floated / block-centred
//
// Data URLs (base64-encoded images) are explicitly allowed through DOMPurify
// so that pasted or dropped images survive the sanitise step.

marked.use({
  extensions: [{
    name: 'imageAttrs',
    level: 'inline',
    // Signal to marked where this pattern *might* start in the source
    start(src) { return src.indexOf('!['); },
    tokenizer(src) {
      // Require {attrs} suffix — fall through to built-in image for plain ![alt](url)
      const cap = /^!\[([^\[\]]*)\]\(([^)]*)\)\{([^}]*)\}/.exec(src);
      if (!cap) return;
      return {
        type:  'imageAttrs',
        raw:   cap[0],
        alt:   cap[1].trim(),
        href:  cap[2].trim(),
        attrs: parseImageAttrs(cap[3]),
      };
    },
    renderer(token) {
      return renderImageHtml(token.href, token.alt, token.attrs);
    }
  }]
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
  // ADD_DATA_URI_TAGS: allow data: URIs in img src so that base64-encoded
  // images pasted/dropped by the user survive the sanitiser pass.
  return DOMPurify.sanitize(raw, { ADD_DATA_URI_TAGS: ['img'] });
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

  // Place page-break ruler markers after the browser has done a layout pass
  requestAnimationFrame(() => addPageRuler(el));
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
  img { max-width: 100%; height: auto; display: block; }
  /* Image alignment helpers */
  img.img-left   { float: left;  margin: 0 1.2em 0.8em 0; display: inline-block; }
  img.img-right  { float: right; margin: 0 0 0.8em 1.2em; display: inline-block; }
  img.img-center { margin-left: auto; margin-right: auto; }
  /* Clear floats after any block that may contain floated images */
  p::after { content: ''; display: table; clear: both; }
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
      case 'image':
        // Standard markdown image with no {attrs} suffix
        runs.push(imageRunFromDataUrl(tok.href, tok.text || '', {}));
        break;
      case 'imageAttrs':
        // Extended image with {width= align= height=} attrs
        runs.push(imageRunFromDataUrl(tok.href, tok.alt || '', tok.attrs || {}));
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
 * Extract plain text from a marked cell token (used for column-width estimation).
 * Recursively flattens nested inline tokens.
 */
function cellPlainText(cell) {
  if (!cell) return '';
  function tokText(t) {
    if (t.tokens?.length) return t.tokens.map(tokText).join('');
    return t.text || t.raw || '';
  }
  if (cell.tokens?.length) return cell.tokens.map(tokText).join('');
  return cell.text || '';
}

/**
 * Convert a marked table token to a docx Table with proper rows and cells.
 * Header row cells are rendered bold; column alignment is respected.
 *
 * Column widths are distributed proportionally by the maximum character length
 * of content in each column (header + all data rows), matching how HTML auto-
 * layout narrows short columns and widens content-heavy ones.  A minimum of
 * 720 twips (~0.5") is enforced per column so narrow columns stay readable.
 *
 * Total table width = 9360 twips (US Letter minus 1" L+R margins).
 */
function tableToDocx(token) {
  const numCols = Math.max((token.header || []).length, 1);
  const TOTAL_TWIPS = 9360;
  const MIN_COL    = 720; // ~0.5 inch minimum per column

  // Measure the longest plain-text content in each column
  const maxLens = Array(numCols).fill(1);
  (token.header || []).forEach((cell, i) => {
    maxLens[i] = Math.max(maxLens[i], cellPlainText(cell).length + 2);
  });
  (token.rows || []).forEach(row => {
    row.forEach((cell, i) => {
      if (i < numCols) maxLens[i] = Math.max(maxLens[i], cellPlainText(cell).length + 2);
    });
  });

  // Distribute twips proportionally
  const totalLen  = maxLens.reduce((a, b) => a + b, 0);
  let colWidths   = maxLens.map(len =>
    Math.max(Math.round(len / totalLen * TOTAL_TWIPS), MIN_COL)
  );

  // If enforcing minimums pushed us over budget, scale everything back down
  let sum = colWidths.reduce((a, b) => a + b, 0);
  if (sum > TOTAL_TWIPS) {
    const scale = TOTAL_TWIPS / sum;
    colWidths = colWidths.map(w => Math.max(Math.round(w * scale), 500));
    sum = colWidths.reduce((a, b) => a + b, 0);
  }
  // Give any rounding remainder to the last column so widths sum exactly
  colWidths[colWidths.length - 1] += TOTAL_TWIPS - colWidths.reduce((a, b) => a + b, 0);

  // marked stores alignment on each cell object directly (cell.align) and
  // also on the table's top-level align array; prefer the per-cell value.
  const makeCell = (cell, i, bold = false) => new TableCell({
    width: { size: colWidths[i], type: WidthType.DXA },
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
    columnWidths: colWidths,
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
    // Collapse base64 image data URLs to a readable widget in the editor
    imageDataUrlPlugin,
    // Handle paste/drop of image files → insert as markdown with base64 data URL
    imageDropPaste,
    // Style for the collapsed data-URL widget.
    // verticalAlign: 'text-bottom' keeps the pill flush with the text baseline
    // so it sits in the monospaced line without pushing the line-height around.
    EditorView.theme({
      '.cm-data-url-img': {
        display: 'inline-block',
        background: 'rgba(137,180,250,.15)',
        border: '1px solid rgba(137,180,250,.3)',
        borderRadius: '3px',
        padding: '0 6px',
        fontSize: '11px',
        lineHeight: '1.6',
        color: '#89b4fa',
        cursor: 'default',
        verticalAlign: 'text-bottom',
        userSelect: 'none',
        pointerEvents: 'none'
      }
    })
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
// Page-break ruler
// ---------------------------------------------------------------------------

/**
 * Estimated printable content height in CSS pixels for one page of a US Letter
 * document with default 1-inch margins (top + bottom), rendered at 96 DPI.
 *   11" total − 2" margins = 9" × 96 px/in = 864 px
 *
 * This is used as the reference height for both PDF (browser print) and DOCX
 * (Word default margins).  The preview ruler is intentionally approximate —
 * the preview column is wider than the printed column, so text reflows
 * differently, but heading / paragraph / image block heights give a good
 * enough visual approximation of where page boundaries will fall.
 */
const PAGE_CONTENT_HEIGHT_PX = 864;

/**
 * Insert absolutely-positioned ruler lines into the preview element (`el`)
 * to show where content will paginate in PDF / DOCX export.
 *
 * Algorithm
 * ─────────
 * 1. Walk from the top of the content accumulating height.
 * 2. Every PAGE_CONTENT_HEIGHT_PX of content → auto page break.
 * 3. Whenever a `.page-break` div (from `---` in the source) is reached
 *    before the next automatic boundary, insert a break there instead and
 *    reset the page meter from that position.
 *
 * Markers are rendered as horizontal dashed lines with a small "p2", "p3"…
 * badge on the far right so they are unobtrusive but clearly visible.
 *
 * `requestAnimationFrame` in the caller ensures layout has settled before
 * we read offsetTop / scrollHeight values.
 */
function addPageRuler(el) {
  // Make `el` the containing block so absolute children position against it.
  // `.preview-content` may already be position:relative; setting it again is harmless.
  el.style.position = 'relative';

  // Clear stale markers from the previous render
  el.querySelectorAll('.page-ruler-line').forEach(m => m.remove());

  const totalH = el.scrollHeight;
  if (totalH < 10) return; // nothing rendered yet

  // Collect manual break positions from `---` → `.page-break` divs
  const manuals = [];
  el.querySelectorAll('.page-break').forEach(pb => manuals.push(pb.offsetTop));
  manuals.sort((a, b) => a - b);

  // Walk from the content top, placing auto breaks and honouring manual ones
  const markers = [];
  let cursor   = 0; // current "page start" in px
  let pageNum  = 2; // first break starts page 2
  let mi       = 0; // index into manuals[]

  while (cursor < totalH) {
    const nextAuto = cursor + PAGE_CONTENT_HEIGHT_PX;

    // Advance the manual pointer past any break that's at or before cursor
    while (mi < manuals.length && manuals[mi] <= cursor) mi++;

    if (mi < manuals.length && manuals[mi] < nextAuto) {
      // A manual break fires before the next automatic boundary
      cursor = manuals[mi];
      markers.push({ top: cursor, page: pageNum, manual: true });
      pageNum++;
      mi++;
    } else {
      // Automatic break at the next page boundary
      cursor = nextAuto;
      if (cursor < totalH) {
        markers.push({ top: cursor, page: pageNum, manual: false });
        pageNum++;
      }
    }
  }

  // Render each marker
  for (const { top, page } of markers) {
    const line = document.createElement('div');
    line.className = 'page-ruler-line';
    line.style.top = `${top}px`;
    line.innerHTML = `<span class="page-ruler-label">p${page}</span>`;
    el.appendChild(line);
  }
}

/**
 * Parse an image attribute string like `width=40% align=right height=200px`
 * into a plain object `{ width, height, align }`.
 */
function parseImageAttrs(str) {
  const attrs = {};
  for (const m of (str || '').matchAll(/([\w-]+)=([^\s}]+)/g)) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Render an <img> element with optional alignment class and inline size styles.
 * `href` is passed through unchanged so that data: URLs are preserved verbatim
 * (DOMPurify is configured separately to allow them).
 */
function renderImageHtml(href, alt, attrs) {
  attrs = attrs || {};
  const styles = [];
  if (attrs.width)  styles.push(`width:${attrs.width}`);
  if (attrs.height) styles.push(`height:${attrs.height}`);
  const cls = { left: 'img-left', right: 'img-right', center: 'img-center' }[attrs.align] || '';
  return `<img src="${href}" alt="${escHtml(alt || '')}"`
    + (cls          ? ` class="${cls}"`           : '')
    + (styles.length ? ` style="${styles.join(';')}"` : '')
    + '>';
}

// ---------------------------------------------------------------------------
// DOCX image helper
// ---------------------------------------------------------------------------

/**
 * Content width of a US Letter page with 1" margins (in pixels at 72 DPI).
 * Used to convert percentage widths to absolute pixel dimensions for ImageRun.
 *   6.5 inches × 72 dpi = 468 px
 */
const DOCX_PAGE_WIDTH_PX = 468;

/**
 * Convert a data URL to an ImageRun for DOCX export.
 * If the href is not a data URL, or conversion fails, returns a TextRun with
 * bracketed alt text as a fallback.
 *
 * Width/height attrs support px and % units; when only width is given the
 * height defaults to a 4:3 ratio so the image is always valid in Word.
 */
function imageRunFromDataUrl(href, alt, attrs) {
  attrs = attrs || {};
  const dataMatch = href && href.match(/^data:(image\/([^;]+));base64,(.+)$/);
  if (!dataMatch) {
    // External URL or unsupported scheme — fall back to italic alt text
    const label = alt || href || 'image';
    return new TextRun({ text: `[Image: ${label}]`, italics: true });
  }

  const [, , subtype, base64] = dataMatch;
  const docxType = subtype.replace('jpeg', 'jpg'); // 'jpg' | 'png' | 'gif' | 'bmp' | 'svg'

  // Decode base64 → Uint8Array
  let bytes;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return new TextRun({ text: `[Image: ${alt || ''}]`, italics: true });
  }

  // Resolve dimensions
  let w = DOCX_PAGE_WIDTH_PX;
  let h = Math.round(w * 0.75); // default 4:3

  if (attrs.width) {
    if (attrs.width.endsWith('%'))   w = Math.round(parseFloat(attrs.width)  / 100 * DOCX_PAGE_WIDTH_PX);
    else if (attrs.width.endsWith('px')) w = parseInt(attrs.width, 10);
  }
  if (attrs.height) {
    if (attrs.height.endsWith('%'))  h = Math.round(parseFloat(attrs.height) / 100 * DOCX_PAGE_WIDTH_PX);
    else if (attrs.height.endsWith('px')) h = parseInt(attrs.height, 10);
  } else if (attrs.width) {
    // No explicit height — derive from width using 4:3
    h = Math.round(w * 0.75);
  }

  try {
    return new ImageRun({ type: docxType, data: bytes, transformation: { width: w, height: h } });
  } catch {
    return new TextRun({ text: `[Image: ${alt || ''}]`, italics: true });
  }
}

// ---------------------------------------------------------------------------
// CodeMirror — image paste / drop  +  data-URL collapse widget
// ---------------------------------------------------------------------------

/**
 * Read a File as a base64 data URL (resolves with the data: string).
 */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(/** @type {string} */ (e.target.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Convert an image File to a base64 data URL and insert it at `pos` in the
 * CodeMirror editor as a markdown image with default attrs.
 */
async function insertImageFile(view, file, pos) {
  pos = pos ?? view.state.selection.main.head;
  const dataUrl = await readFileAsDataUrl(file);
  const snippet = `![](${dataUrl}){width=100% align=center}`;
  view.dispatch({
    changes:   { from: pos, insert: snippet },
    selection: { anchor: pos + snippet.length }
  });
}

/**
 * Small inline widget shown in the editor instead of a long base64 data URL.
 * Clicking / selecting it restores the raw text so the user can delete it.
 */
class DataUrlWidget extends WidgetType {
  constructor(mime) { super(); this.mime = mime; }
  eq(other) { return other.mime === this.mime; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-data-url-img';
    span.textContent = `📷 ${this.mime}`;
    span.title = 'Embedded image (base64) – backspace or select line to delete';
    return span;
  }
  ignoreEvent() { return true; }
}

/**
 * ViewPlugin that collapses embedded base64 image data URLs to a compact
 * `📷 image/jpeg` pill widget.  The pill is always shown — the base64 data
 * is never exposed in the editor (use Select-All + Delete on the line, or
 * position the cursor next to the pill and press Backspace, to remove it).
 */
const imageDataUrlPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = this._build(view); }
    update(update) {
      if (update.docChanged) this.decorations = this._build(update.view);
    }
    _build(view) {
      const builder = new RangeSetBuilder();
      const doc = view.state.doc.toString();

      let search = 0;
      while (true) {
        // Find `](data:image/` which marks the start of an embedded image URL
        const bracket = doc.indexOf('](data:image/', search);
        if (bracket === -1) break;

        // Verify a `![` precedes it on the same line
        const imgOpen = doc.lastIndexOf('![', bracket);
        if (imgOpen === -1 || doc.slice(imgOpen, bracket).includes('\n')) {
          search = bracket + 1; continue;
        }

        const urlStart = bracket + 2;               // 'd' in 'data:...'
        const urlEnd   = doc.indexOf(')', urlStart);
        if (urlEnd === -1) break;

        // Extract MIME type from 'data:<mime>;<enc>,...'
        const mimeEnd = doc.indexOf(';', urlStart);
        if (mimeEnd === -1 || mimeEnd > urlEnd) { search = urlEnd; continue; }
        const mime = doc.slice(urlStart + 5, mimeEnd); // drop leading 'data:'

        builder.add(urlStart, urlEnd, Decoration.replace({ widget: new DataUrlWidget(mime) }));
        search = urlEnd + 1;
      }
      return builder.finish();
    }
  },
  { decorations: v => v.decorations }
);

/**
 * EditorView DOM-event handler that intercepts paste and drop events
 * carrying image files, converts them to base64 data URLs and inserts them
 * as markdown image syntax.
 */
const imageDropPaste = EditorView.domEventHandlers({
  paste(event, view) {
    const items = Array.from(event.clipboardData?.items || []);
    const imgItem = items.find(i => i.type.startsWith('image/'));
    if (!imgItem) return false;
    event.preventDefault();
    const file = imgItem.getAsFile();
    if (file) insertImageFile(view, file);
    return true;
  },
  drop(event, view) {
    const files = Array.from(event.dataTransfer?.files || []);
    const imgFile = files.find(f => f.type.startsWith('image/'));
    if (!imgFile) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    insertImageFile(view, imgFile, pos ?? undefined);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const markdownDSL = {
  id: 'markdown',
  label: 'Md',
  version: '1.0.0',
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
