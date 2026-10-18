/**
 * Shared CodeMirror 6 theme — the iA Writer look, driven by the app's CSS tokens.
 *
 * Every colour is a `var(--…)` from app.css, so dark / light / auto come from
 * the same `--bg` / `--text` / `--accent` set as the rest of the shell (no
 * per-theme hex here, no `!important` forced overrides in app.css).  Sizing
 * (16px / 1.7, the tall 2px caret, the line margins) lives in app.css under
 * "EDITOR SURFACE" so the phone media query can retune it.
 *
 * Imported by:
 *   - editor.js      (base theme + shared highlight style)
 *   - dsl plugins    (highlight style only, for getEditorExtensions())
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// ---------------------------------------------------------------------------
// Base editor theme (structure + token-driven colours; no gutter)
// ---------------------------------------------------------------------------

export const editorTheme = EditorView.theme({
  '&': {
    background: 'var(--bg)',
    color: 'var(--text)',
    height: '100%',
    fontFamily: 'var(--font-mono)'
  },
  '.cm-scroller': { overflow: 'auto', lineHeight: '1.7' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-focused': { outline: 'none' },
  // Selection — !important beats drawSelection()'s injected rule
  // (.ͼN.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground).
  '.cm-selectionBackground': { background: 'color-mix(in srgb, var(--accent) 22%, transparent) !important' },
  '&.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, var(--accent) 30%, transparent) !important' },
  '.cm-selectionMatch': { background: 'color-mix(in srgb, var(--text) 10%, transparent)' },
  '.cm-matchingBracket': { background: 'var(--bg-surface)', color: 'var(--accent) !important', fontWeight: 'bold' },
  '.cm-nonmatchingBracket': { color: 'var(--error) !important' },
  '.cm-searchMatch': { background: 'color-mix(in srgb, var(--warning) 25%, transparent)', outline: '1px solid color-mix(in srgb, var(--warning) 50%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { background: 'color-mix(in srgb, var(--warning) 45%, transparent)' },
  // Tooltip / autocomplete
  '.cm-tooltip': {
    background: 'var(--bg-alt)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,.35)',
    color: 'var(--text)'
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--bg-surface)', color: 'var(--accent)' },
  '.cm-completionLabel': { flex: 1 },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'italic', marginLeft: '6px' },
  '.cm-placeholder': { color: 'var(--text-muted)' }
});

// ---------------------------------------------------------------------------
// Syntax highlighting — shared across all DSLs
// ---------------------------------------------------------------------------

/**
 * Highlight style for Lezer syntax trees — colours are the `--hl-*` tokens.
 *
 * Markdown-specific (iA Writer): prose is ONE colour; a heading is bold text in
 * the same colour; the marks (#, **, -, >) recede to grey via tags.meta.
 *   tags.heading*  → bold (no font-size override, no colour change)
 *   tags.strong    → bold (** markers + content both appear bold)
 *   tags.emphasis  → italic
 *   tags.meta      → muted (the **, *, # delimiters themselves)
 *
 * Generic:
 *   keywords, operators, strings, comments, etc.
 */
export const editorHighlight = HighlightStyle.define([
  // ── Markdown headings ────────────────────────────────────────────────────
  // No fontSize overrides — varying sizes break CodeMirror's line spacing.
  {
    tag: [tags.heading1, tags.heading2, tags.heading3,
          tags.heading4, tags.heading5, tags.heading6],
    color: 'var(--hl-heading)',
    fontWeight: 'bold'
  },

  // ── Markdown inline ───────────────────────────────────────────────────────
  // Note: `tags.strong` is applied to the ENTIRE **…** span including markers,
  // so both the ** characters and the text between them appear bold — giving
  // the user an instant visual cue about the rendered output.
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--hl-strike)' },

  // Horizontal rule / thematic break
  { tag: tags.contentSeparator, color: 'var(--hl-sep)' },

  // ── Links & URLs ──────────────────────────────────────────────────────────
  { tag: [tags.url], color: 'var(--hl-link)', textDecoration: 'underline' },
  { tag: [tags.link], color: 'var(--hl-link)' },
  { tag: tags.labelName, color: 'var(--hl-link)' },

  // ── Code spans & blocks ───────────────────────────────────────────────────
  {
    tag: [tags.monospace, tags.special(tags.string)],
    color: 'var(--hl-code)',
    background: 'var(--hl-code-bg)'
  },
  { tag: tags.processingInstruction, color: 'var(--hl-fence)' }, // code fence markers

  // ── Blockquote ────────────────────────────────────────────────────────────
  { tag: tags.quote, color: 'var(--hl-quote)', fontStyle: 'italic' },

  // ── Markdown / generic meta (delimiters: **, *, #, >, -, etc.) ───────────
  { tag: tags.meta, color: 'var(--hl-meta)' },
  { tag: tags.punctuation, color: 'var(--hl-punct)' },

  // ── Generic tokens (used by mermaid / abcjs stream parsers) ──────────────
  { tag: tags.keyword, color: 'var(--hl-keyword)', fontWeight: 'bold' },
  { tag: tags.operator, color: 'var(--hl-operator)' },
  { tag: tags.separator, color: 'var(--hl-meta)' },
  { tag: tags.atom, color: 'var(--hl-atom)' },
  { tag: tags.number, color: 'var(--hl-number)' },
  { tag: tags.string, color: 'var(--hl-string)' },
  { tag: tags.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: tags.name, color: 'var(--hl-name)' },
  { tag: tags.typeName, color: 'var(--hl-type)' },
  { tag: tags.className, color: 'var(--hl-class)' },
  { tag: tags.propertyName, color: 'var(--hl-property)' },
  { tag: tags.variableName, color: 'var(--hl-variable)' },
  { tag: tags.function(tags.variableName), color: 'var(--hl-function)' },
  { tag: tags.definition(tags.variableName), color: 'var(--hl-function)' },
  { tag: tags.invalid, color: 'var(--hl-atom)', textDecoration: 'underline wavy' }
]);
