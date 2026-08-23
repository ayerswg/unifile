/**
 * Writer preview — Markdown → sanitized HTML for the in-app preview pane,
 * the guide sheet, and the quine's no-JS fallback.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseGlobalFrontMatter } from '../core/front-matter.js';

/** Render a full document (front matter stripped) to sanitized HTML. */
export function renderDocument(content) {
  const { bodyFrom } = parseGlobalFrontMatter(content);
  return renderMarkdown(content.slice(bodyFrom));
}

/** Render a Markdown string to sanitized HTML. */
export function renderMarkdown(md) {
  const html = marked.parse(String(md ?? ''), { gfm: true, breaks: false, async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
