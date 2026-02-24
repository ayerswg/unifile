/**
 * Shared CodeMirror 6 theme — Catppuccin Mocha (dark) with light fallback.
 *
 * Imported by:
 *   - editor.js      (base theme + shared highlight style)
 *   - dsl plugins    (highlight style only, for getEditorExtensions())
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// ---------------------------------------------------------------------------
// Base editor theme (colours, fonts, gutters, selection, etc.)
// ---------------------------------------------------------------------------

export const catppuccinTheme = EditorView.theme(
  {
    '&': {
      background: '#1e1e2e',
      color: '#cdd6f4',
      height: '100%',
      fontSize: '14px',
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace'
    },
    '.cm-scroller': { overflow: 'auto', lineHeight: '1.65' },
    '.cm-content': { caretColor: '#89b4fa', padding: '8px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#89b4fa' },
    '.cm-focused': { outline: 'none' },
    // Gutter
    '.cm-gutters': {
      background: '#181825',
      color: '#4a4a6a',
      border: 'none',
      borderRight: '1px solid #313244',
      paddingRight: '2px',
      userSelect: 'none'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 6px 0 4px',
      minWidth: '26px',
      textAlign: 'right',
      fontSize: '12px'
    },
    '.cm-activeLineGutter': { background: '#28283e', color: '#89b4fa' },
    // Lines
    '.cm-activeLine': { background: 'rgba(36,36,58,.7)' },
    '.cm-line': { padding: '0 4px 0 0' },
    // Selection
    '.cm-selectionBackground': { background: '#45475a' },
    '&.cm-focused .cm-selectionBackground': { background: '#383857' },
    '&.cm-focused .cm-selectionMatch': { background: '#45475a55' },
    '.cm-selectionMatch': { background: '#45475a44' },
    // Matching brackets
    '.cm-matchingBracket': {
      background: '#45475a',
      color: '#89b4fa !important',
      fontWeight: 'bold'
    },
    '.cm-nonmatchingBracket': { color: '#f38ba8 !important' },
    // Search highlight
    '.cm-searchMatch': { background: '#f9e2af33', outline: '1px solid #f9e2af66' },
    '.cm-searchMatch.cm-searchMatch-selected': { background: '#f9e2af66' },
    // Tooltip / autocomplete
    '.cm-tooltip': {
      background: '#313244',
      border: '1px solid #45475a',
      borderRadius: '6px',
      boxShadow: '0 4px 16px rgba(0,0,0,.5)',
      color: '#cdd6f4'
    },
    '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: '#45475a',
      color: '#89b4fa'
    },
    '.cm-completionLabel': { flex: 1 },
    '.cm-completionDetail': { color: '#6c7086', fontStyle: 'italic', marginLeft: '6px' },
    // Placeholder
    '.cm-placeholder': { color: '#6c7086' },
    // Line-number gutter with comment-thread highlighting
    // Lines with an active comment thread get an amber background.
    // Clicking any line number opens the CommentsPanel for that line.
    '.cm-lineNumbers.cm-comment-ln': { cursor: 'pointer' },
    '.cm-lineNumbers.cm-comment-ln .cm-gutterElement': {
      padding: '0 6px 0 4px',
      minWidth: '26px',
      textAlign: 'right',
      fontSize: '12px',
      transition: 'background .1s, color .1s'
    },
    '.cm-lineNumbers.cm-comment-ln .cm-gutterElement:hover': {
      background: 'rgba(137,180,250,.12)',
      color: '#89b4fa'
    },
    '.cm-lineNumbers.cm-comment-ln .cm-gutterElement.cm-has-comments': {
      background: 'rgba(251,191,36,.22)',
      color: '#f9e2af'
    },
    '.cm-lineNumbers.cm-comment-ln .cm-gutterElement.cm-has-comments:hover': {
      background: 'rgba(251,191,36,.38)'
    },
    '.cm-ln-text': {
      display: 'block',
      width: '100%',
      textAlign: 'right'
    },
    // Line highlighted when its comment thread is open in the sidebar
    '.cm-comment-focus-line': {
      background: 'rgba(251,191,36,.09)',
      borderLeft: '2px solid rgba(251,191,36,.45)'
    }
  },
  { dark: true }
);

/**
 * Light-mode override. Wraps an @media rule that CodeMirror can't automatically
 * handle, so we apply it as a second theme that is always added.
 */
export const catppuccinThemeLight = EditorView.theme(
  {
    '@media (prefers-color-scheme: light)': {
      '&': { background: '#eff1f5', color: '#4c4f69' },
      '.cm-gutters': { background: '#e6e9ef', color: '#9ca0b0', borderRight: '1px solid #ccd0da' },
      '.cm-activeLineGutter': { background: '#dce0e8', color: '#1e66f5' },
      '.cm-activeLine': { background: 'rgba(230,233,239,.6)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: '#ccd0da' },
      '.cm-matchingBracket': { background: '#ccd0da', color: '#1e66f5 !important' },
      '.cm-cursor': { borderLeftColor: '#1e66f5' },
      '.cm-tooltip': { background: '#dce0e8', border: '1px solid #ccd0da', color: '#4c4f69' },
      // Comment-highlighted line numbers in light mode
      '.cm-lineNumbers.cm-comment-ln .cm-gutterElement:hover': {
        background: 'rgba(30,102,245,.1)', color: '#1e66f5'
      },
      '.cm-lineNumbers.cm-comment-ln .cm-gutterElement.cm-has-comments': {
        background: 'rgba(223,142,29,.18)', color: '#df8e1d'
      },
      '.cm-lineNumbers.cm-comment-ln .cm-gutterElement.cm-has-comments:hover': {
        background: 'rgba(223,142,29,.32)'
      }
    }
  }
);

// ---------------------------------------------------------------------------
// Syntax highlighting — shared across all DSLs
// ---------------------------------------------------------------------------

/**
 * Catppuccin Mocha highlight style for Lezer syntax trees.
 *
 * Markdown-specific:
 *   tags.heading*  → bold + accent-coloured (no font-size override)
 *   tags.strong    → bold (** markers + content both appear bold)
 *   tags.emphasis  → italic
 *   tags.meta      → muted (the **, *, # delimiters themselves)
 *
 * Generic:
 *   keywords, operators, strings, comments, etc.
 */
export const catppuccinHighlight = HighlightStyle.define([
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
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
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
