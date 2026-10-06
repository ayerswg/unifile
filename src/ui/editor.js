/**
 * Editor component — powered by CodeMirror 6
 *
 * Features:
 *   - The iA Writer surface: one monospaced size, tall accent caret, NO gutter
 *     (theme tokens in app.css + editor-theme.js)
 *   - DSL-aware per-section syntax highlighting
 *   - Inline comments (comments.js): commented text carries a persistent
 *     highlight; select text → right-click / long-press (or Mod-Alt-M, or the
 *     phone bubble's Comment) → a card attached to the selection; click a
 *     highlight to open its thread.  The same context menu carries Copy / Cut /
 *     Paste and, on an ABC voice line, Mute / Solo for that voice.
 *   - Bracket matching, autocomplete, column selection (Alt+drag)
 *   - Tab / Shift+Tab indent · Ctrl+S → commit · Alt+1/2/3 → view modes
 */

import { EditorView, keymap, Decoration, drawSelection,
         rectangularSelection, crosshairCursor,
         highlightSpecialChars } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, Transaction, Annotation, RangeSetBuilder, Text } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentWithTab, undo, redo, indentMore, indentLess } from '@codemirror/commands';
import { indentOnInput, bracketMatching, Language } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets,
         closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';

import { editorTheme, editorHighlight } from './editor-theme.js';
import { highlightTree } from '@lezer/highlight';
import { state, VIEW_MODES, PANELS } from './state.js';
import { getDSL } from '../dsl/registry.js';
import { parseDocSections, activeSectionAt } from '../core/doc-sections.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { buildVoiceMap } from '../core/abc-voices.js';
import {
  commentsExtension,
  commentCardField,
  openCommentEffect,
  closeCommentEffect,
  refreshCommentsEffect,
  getThreadsForPos,
  getThreadsInRange,
  listOpenThreads,
  mapThreadPositions,
  clampThreadPositions
} from './comments.js';
import { sectionCollapseExtension, resetCollapseEffect,
         refreshSectionsEffect, landscapePhoneMql } from './editor-sections.js';

// ---------------------------------------------------------------------------
// DSL-source range highlight
//
// When a DSL plugin emits 'dsl-select' (e.g. clicking a note in the ABC
// preview), the corresponding character range in the editor is decorated
// with a distinct mark so the user can see what maps to the clicked element.
//
// Transactions dispatched in response to a DSL click are tagged with this
// userEvent so the updateListener can distinguish them from user-initiated
// selection changes and avoid prematurely clearing the decoration.
// ---------------------------------------------------------------------------

const DSL_SELECT_EVENT = 'dsl.select';

// Marks a whole-document swap (checkout / branch switch / open) — comment
// threads are clamped, not mapped, through it (see comments.js).
const docReplaceAnnotation = Annotation.define();

const setDslHighlight = StateEffect.define();

const dslHighlightField = StateField.define({
  create: () => Decoration.none,

  update(deco, tr) {
    // Keep decoration mapped through document changes.
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDslHighlight)) {
        if (e.value === null || e.value.from >= e.value.to) {
          deco = Decoration.none;
        } else {
          const { from, to } = e.value;
          deco = Decoration.set([
            Decoration.mark({ class: 'cm-dsl-highlight' }).range(from, to)
          ]);
        }
      }
    }
    // Auto-clear when the user moves the selection or edits the document,
    // as long as this transaction didn't come from a DSL element click.
    // Handling it here (inside the field update) avoids a secondary dispatch
    // from updateListener, which would interfere with drawSelection()
    // rendering the selection background during drag-select.
    if (deco.size > 0 && (tr.selectionSet || tr.docChanged)) {
      if (tr.annotation(Transaction.userEvent) !== DSL_SELECT_EVENT) {
        deco = Decoration.none;
      }
    }
    return deco;
  },

  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Playback cursor decoration
//
// While ABC audio is playing, all currently-sounding note ranges (one per
// voice) are decorated with green text colour so the user can follow along.
// The value emitted on 'abc-play-cursor' is Array<{from,to}> | null.
// ---------------------------------------------------------------------------

const setPlayHighlight = StateEffect.define();

const playHighlightField = StateField.define({
  create: () => Decoration.none,

  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPlayHighlight)) {
        if (!e.value || e.value.length === 0) {
          deco = Decoration.none;
        } else {
          // Build a sorted, non-empty set of marks — one per simultaneously
          // playing voice.  Clamp to document bounds to avoid CM6 errors.
          const docLen = tr.state.doc.length;
          const marks = e.value
            .filter(r => r.from < r.to && r.from < docLen)
            .map(r => Decoration.mark({ class: 'cm-play-note' })
              .range(r.from, Math.min(r.to, docLen)))
            .sort((a, b) => a.from - b.from);
          deco = marks.length ? Decoration.set(marks, true) : Decoration.none;
        }
      }
    }
    return deco;
  },

  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Shebang line decoration
//
// Lines that start with #! (section declarations like "#!mermaid@1.0.0")
// are given a distinct muted/italic appearance via the .cm-shebang-line class
// so the user can visually distinguish them from content.
// ---------------------------------------------------------------------------

function _buildShebangDecos(editorState) {
  const doc      = editorState.doc;
  const sections = parseDocSections(doc.toString());
  if (sections.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder();
  for (const sect of sections) {
    const line = doc.lineAt(sect.from);
    builder.add(line.from, line.from, Decoration.line({ class: 'cm-shebang-line' }));
  }
  return builder.finish();
}

const shebangDecoField = StateField.define({
  create(editorState) { return _buildShebangDecos(editorState); },
  update(deco, tr)    { return tr.docChanged ? _buildShebangDecos(tr.state) : deco; },
  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// ABC voice lookup (for the muted-voice fade + the Mute / Solo menu items)
// ---------------------------------------------------------------------------

// Voice map over the whole editor doc, cached per (immutable) doc instance —
// the fade asks per line, so don't rebuild the map for each one.
let _docVmapCache = { doc: null, vmap: null };
function _docVoiceMap(doc) {
  if (_docVmapCache.doc !== doc) {
    _docVmapCache = { doc, vmap: buildVoiceMap(doc.toString()) };
  }
  return _docVmapCache.vmap;
}

/** The voice a doc line belongs to (via `V:` lines OR inline `[V:id]`), or null. */
function _voiceIdAtLine(doc, line) {
  if ((state.data?.dslType) !== 'abcjs') return null;
  // Blank / `%` comment / `%%` directive lines never sound — no voice for them.
  const t = line.text.trim();
  if (t === '' || t.startsWith('%')) return null;
  return _docVoiceMap(doc).at(line.from);
}

// ---------------------------------------------------------------------------
// Muted-voice fade (editor)
//
// Lines belonging to a muted/non-soloed ABC voice are dimmed so it's clear
// they won't sound or highlight during playback, and every line of a muted
// (M) / soloed (S) voice carries a mark in its left margin (CSS ::before on
// the line class — no gutter). Rebuilt on doc change and whenever the
// mute/solo selection changes (refreshVoiceFadeEffect).
// ---------------------------------------------------------------------------

const refreshVoiceFadeEffect = StateEffect.define();

function _buildVoiceFade(editorState) {
  if ((state.data?.dslType) !== 'abcjs') return Decoration.none;
  if (state.abcMutedVoices.size === 0 && state.abcSoloVoices.size === 0) return Decoration.none;
  const doc = editorState.doc;
  const builder = new RangeSetBuilder();
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const id = _voiceIdAtLine(doc, line);
    if (id == null) continue;
    const cls = [];
    if (state.abcSoloVoices.has(id)) cls.push('cm-voice-S');
    else if (state.abcMutedVoices.has(id)) cls.push('cm-voice-M');
    if (state.isVoiceMuted(id)) cls.push('cm-voice-muted');
    if (cls.length) builder.add(line.from, line.from, Decoration.line({ class: cls.join(' ') }));
  }
  return builder.finish();
}

const voiceFadeField = StateField.define({
  create: (s) => _buildVoiceFade(s),
  update(deco, tr) {
    if (tr.docChanged || tr.effects.some(e => e.is(refreshVoiceFadeEffect))) {
      return _buildVoiceFade(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Per-section syntax highlighting
//
// Instead of reconfiguring a whole-doc language on every cursor-section
// change (which recolours the entire editor), we use highlightTree() to
// parse each section independently and emit per-section Decoration.mark
// spans with the correct token classes.
//
// rebuildSectionHighlightsEffect is dispatched when the document's default
// DSL changes (metadata-only change, no docChanged) or a plugin is installed.
// ---------------------------------------------------------------------------

const rebuildSectionHighlightsEffect = StateEffect.define();

/** Recursively find the first Language/LanguageSupport instance in an extension. */
function _extractLanguage(ext) {
  if (!ext) return null;
  if (ext instanceof Language) return ext;
  if (ext?.language instanceof Language) return ext.language;  // LanguageSupport
  if (Array.isArray(ext)) {
    for (const e of ext) {
      const found = _extractLanguage(e);
      if (found) return found;
    }
  }
  return null;
}

/** Build per-section syntax decoration set for the current document. */
function _buildSectionHighlights(editorState) {
  const text     = editorState.doc.toString();
  const sections = parseDocSections(text);
  const builder  = new RangeSetBuilder();
  const defaultDslId = state.data?.dslType ?? 'markdown';

  function addHighlights(from, to, dslId) {
    if (from >= to) return;
    const rangeText = text.slice(from, to);
    try {
      const dsl  = getDSL(dslId);
      const exts = dsl.getEditorExtensions?.() ?? [];
      const lang = _extractLanguage(exts);
      if (!lang) return;
      const tree = lang.parser.parse(rangeText);
      highlightTree(tree, editorHighlight, (tFrom, tTo, classes) => {
        if (tFrom >= tTo) return;
        builder.add(from + tFrom, from + tTo, Decoration.mark({ class: classes }));
      });
    } catch { /* non-fatal: DSL not loaded yet or parse error */ }
  }

  // Global YAML front matter: highlight it as YAML (keys / fences / comments),
  // NOT with the section DSL — otherwise the ABC tokenizer paints a–g letters
  // inside keys like `midi`/`legato` as note pitches.
  const { bodyFrom } = parseGlobalFrontMatter(text);
  if (bodyFrom > 0) addFrontMatterHighlights(0, bodyFrom);
  const bodyStart = Math.max(bodyFrom, 0);

  if (sections.length === 0) {
    addHighlights(bodyStart, text.length, defaultDslId);
  } else {
    if (sections[0].from > bodyStart) {
      addHighlights(bodyStart, sections[0].from, defaultDslId);
    }
    for (const sect of sections) {
      addHighlights(sect.contentFrom, sect.to, sect.dslId);
    }
  }
  return builder.finish();

  // --- front-matter (YAML) highlighter -------------------------------------
  function addFrontMatterHighlights(from, to) {
    let pos = from;
    for (const raw of text.slice(from, to).split(/(?<=\n)/)) {
      const lineStart = pos;
      pos += raw.length;
      const line = raw.replace(/\r?\n$/, '');
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (trimmed.startsWith('---')) {                       // fence
        builder.add(lineStart, lineStart + line.length, Decoration.mark({ class: 'cm-fm-fence' }));
        continue;
      }
      // Detect an inline comment first (# preceded by whitespace, or whole-line)
      // but add marks in source order (key before comment) for RangeSetBuilder.
      let codeEnd = line.length;
      let commentAt = -1;
      const cm = line.match(/(^|\s)#.*$/);
      if (cm) {
        const off = cm.index + (cm[1] ? cm[1].length : 0);
        codeEnd = off; commentAt = lineStart + off;
      }
      const km = line.slice(0, codeEnd).match(/^(\s*)([^:\s][^:]*):/);
      if (km) {
        const kFrom = lineStart + km[1].length;
        builder.add(kFrom, kFrom + km[2].length, Decoration.mark({ class: 'cm-fm-key' }));
      }
      if (commentAt >= 0) {
        builder.add(commentAt, lineStart + line.length, Decoration.mark({ class: 'cm-fm-comment' }));
      }
    }
  }
}

const sectionSyntaxField = StateField.define({
  create: (editorState) => _buildSectionHighlights(editorState),
  update: (deco, tr) => {
    if (tr.docChanged || tr.effects.some(e => e.is(rebuildSectionHighlightsEffect))) {
      return _buildSectionHighlights(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Static base extensions — same for every DSL
// ---------------------------------------------------------------------------

const baseExtensions = [
  // No gutter and no active-line tint (iA Writer has neither): the caret marks
  // the line. Comments live in the text as highlights + an anchored card.
  commentsExtension,
  highlightSpecialChars(),
  drawSelection(),
  // Vertical (column) selection, following the common IDE convention:
  // Alt+drag selects a rectangle (one cursor per row — multiple selections are
  // already enabled above); the crosshair cursor while Alt is held signals the
  // mode. Type/delete then edits every row of the column at once.
  rectangularSelection(),
  crosshairCursor(),
  // NOTE: highlightSelectionMatches() intentionally omitted — selecting text
  // should not light up every other occurrence of that text in the document.

  // Editing quality
  history(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  // NOTE: line wrapping is a per-DSL choice — abcjs turns it on in its
  // getEditorExtensions() (music wraps; one measure per line via the formatter).
  // Other DSLs keep horizontal scrolling inside cm-scroller.

  // DSL range highlight (e.g. from clicking a note in ABC preview)
  dslHighlightField,

  // Playback cursor highlight (green, tracks currently playing note)
  playHighlightField,

  // Muted-voice fade — dims lines of muted / non-soloed ABC voices
  voiceFadeField,

  // Shebang line decoration (#! section headers appear muted/italic)
  shebangDecoField,

  // Collapsible front-matter section (default-collapsed on load so the body is
  // what you see first).
  sectionCollapseExtension,

  // Inject the highlight CSS rules so sectionSyntaxField's
  // Decoration.mark({ class }) spans get styled. Using the StyleModule directly
  // (instead of syntaxHighlighting(editorHighlight)) injects the CSS without
  // triggering automatic whole-doc tree scanning.
  EditorView.styleModule.of(editorHighlight.module),

  // Per-section syntax highlighting
  sectionSyntaxField,

  // Theme
  editorTheme,
];

// ---------------------------------------------------------------------------
// Unifile-specific keymap
// ---------------------------------------------------------------------------

function makeUnifileKeymap() {
  return keymap.of([
    {
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        state.emit('save-document');
        return true;
      }
    },
    // Format the source when the active DSL provides a formatter (ABC: one measure per line).
    { key: 'Alt-Shift-f', preventDefault: true, run: (view) => alignActiveDsl(view) },
    // Comment on the selection (the Google Docs chord).
    { key: 'Mod-Alt-m', preventDefault: true, run: (view) => { commentOnSelection(view); return true; } },
    { key: 'Alt-1', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.EDITOR);  return true; } },
    { key: 'Alt-2', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.SPLIT);   return true; } },
    { key: 'Alt-3', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.PREVIEW); return true; } }
  ]);
}

/**
 * Run the active DSL's source formatter (ABC: one measure per line) over the whole
 * document, preserving the caret's line/column as best we can. Returns true when
 * handled (so a keybinding stops here), false when the DSL has no formatter.
 * @param {EditorView} view
 */
function alignActiveDsl(view) {
  if (!view) return false;
  const dslId = state.activeDslId ?? state.data?.dslType;
  let dsl;
  try { dsl = getDSL(dslId); } catch { return false; }
  if (typeof dsl.alignSource !== 'function') return false;

  const cur  = view.state.doc.toString();
  const next = dsl.alignSource(cur);
  if (next === cur) return true;

  // Keep the caret on the same line/column after reflowing whitespace.
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const col  = head - line.from;
  const nDoc = Text.of(next.split('\n'));
  const ln   = Math.min(line.number, nDoc.lines);
  const nl   = nDoc.line(ln);
  const pos  = Math.min(nl.from + col, nl.to);

  view.dispatch({
    changes: { from: 0, to: cur.length, insert: next },
    selection: { anchor: pos },
    scrollIntoView: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Comment helpers
// ---------------------------------------------------------------------------

/**
 * The range a "Comment" acts on: the selection when there is one, else the
 * word under the caret, else the caret's line (trimmed).
 */
function _commentTarget(view, pos = null) {
  const sel = view.state.selection.main;
  if (sel.from < sel.to) return { from: sel.from, to: sel.to };
  const at = pos ?? sel.head;
  const word = view.state.wordAt(at);
  if (word && word.from < word.to) return { from: word.from, to: word.to };
  const line = view.state.doc.lineAt(at);
  const text = line.text;
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (text.trim()) return { from: line.from + lead, to: line.to - trail };
  return { from: line.from, to: line.from };
}

/**
 * Open the card for the selection: an existing thread under it, else the
 * composer for a new one.  Used by the context menu, Mod-Alt-M and the phone
 * bubble's Comment action.
 */
export function commentOnSelection(view, pos = null) {
  if (!view) return false;
  const range = _commentTarget(view, pos);
  const existing = getThreadsInRange(range.from, Math.max(range.to, range.from + 1));
  if (existing.length && view.state.selection.main.empty) {
    view.dispatch({ effects: openCommentEffect.of({ threadId: existing[0].id }) });
    return true;
  }
  view.dispatch({
    selection: { anchor: range.from, head: range.to },
    effects: openCommentEffect.of({ range })
  });
  return true;
}

// ---------------------------------------------------------------------------
// Context menu — right-click / long-press on the text
//
//   Comment            on the selection (or the word / line under the pointer)
//   Copy · Cut · Paste the usual clipboard verbs (Paste only where the browser
//                      lets a page read the clipboard)
//   Mute / Solo voice  on an ABC voice line (a `V:` line, an inline `[V:id]`
//                      line, or a music / lyrics line under a `V:` line)
// ---------------------------------------------------------------------------

let _menuEl = null;

function _hideMenu() {
  _menuEl?.remove();
  _menuEl = null;
}

/**
 * @param {EditorView} view
 * @param {number} x  clientX
 * @param {number} y  clientY
 * @param {number|null} pos  document position under the pointer
 */
function _showEditorMenu(view, x, y, pos) {
  _hideMenu();
  const sel = view.state.selection.main;
  const hasSel = sel.from < sel.to;
  const items = [];

  const target = _commentTarget(view, pos);
  const under = getThreadsInRange(target.from, Math.max(target.to, target.from + 1));
  items.push({
    label: under.length && !hasSel ? 'Open comment' : 'Comment',
    glyph: '❝',
    run: () => commentOnSelection(view, pos)
  });

  if (hasSel) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    items.push({ label: 'Copy', run: () => navigator.clipboard?.writeText(text).catch(() => {}) });
    items.push({ label: 'Cut', run: () => {
      navigator.clipboard?.writeText(text).catch(() => {});
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' }, selection: { anchor: sel.from },
                      annotations: Transaction.userEvent.of('delete.cut') });
      view.focus();
    } });
  }
  if (navigator.clipboard?.readText) {
    items.push({ label: 'Paste', run: async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { return; }
      if (!text) return;
      const s = view.state.selection.main;
      view.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length },
                      annotations: Transaction.userEvent.of('input.paste') });
      view.focus();
    } });
  }

  if (pos !== null) {
    const line = view.state.doc.lineAt(pos);
    const voiceId = _voiceIdAtLine(view.state.doc, line);
    if (voiceId != null) {
      items.push({ sep: true });
      items.push({ label: (state.abcMutedVoices.has(voiceId) ? 'Unmute voice ' : 'Mute voice ') + voiceId,
                   glyph: 'M', run: () => state.toggleVoiceMute(voiceId) });
      items.push({ label: (state.abcSoloVoices.has(voiceId) ? 'Unsolo voice ' : 'Solo voice ') + voiceId,
                   glyph: 'S', run: () => state.toggleVoiceSolo(voiceId) });
    }
  }

  const menu = document.createElement('div');
  menu.className = 'uf-ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { const hr = document.createElement('div'); hr.className = 'uf-ctx-sep'; menu.appendChild(hr); continue; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'uf-ctx-item';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<span class="uf-ctx-glyph">${it.glyph ?? ''}</span><span class="uf-ctx-label"></span>`;
    btn.querySelector('.uf-ctx-label').textContent = it.label;
    // Keep the editor's selection: a mousedown on the menu must not move the caret.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => { _hideMenu(); it.run(); });
    menu.appendChild(btn);
  }
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  document.body.appendChild(menu);
  _menuEl = menu;

  // Keep the menu on-screen (it's positioned from the pointer).
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth)   menu.style.left = Math.max(4, window.innerWidth  - r.width  - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(4, window.innerHeight - r.height - 4) + 'px';

  const dismiss = (e) => {
    if (menu.contains(e.target)) return;
    _hideMenu();
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(e); };
  // Deferred: the pointerdown / contextmenu that opened the menu is still bubbling.
  setTimeout(() => {
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

// ---------------------------------------------------------------------------
// Editor component
// ---------------------------------------------------------------------------

export class Editor {
  constructor(container) {
    this.el = container;
    this._unsub = [];
    this._currentDsl = state.data?.dslType ?? 'markdown';
    this._languageCompartment = new Compartment();
    this._view = null;

    this._build();

    this._unsub.push(state.on('checkout',     ({ content }) => this.setValue(content)));

    // Rotating between portrait/landscape suppresses or restores the section
    // bars (see editor-sections.js). Rebuild them without disturbing the
    // per-section collapse state.
    landscapePhoneMql.addEventListener('change', () => {
      this._view?.dispatch({ effects: refreshSectionsEffect.of(null) });
    });
    this._unsub.push(state.on('view-mode-change', () => this._updateVisibility()));

    this._unsub.push(state.on('panel-change', () => {
      this._updateVisibility();
    }));

    // "Comment on selection" from the ⋯ menu / the phone bubble.
    this._unsub.push(state.on('comment-selection', () => this.commentSelection()));

    // Thread data mutations (new / reply / resolve) → rebuild the highlights + card.
    this._unsub.push(state.on('comments-change', () => {
      if (this._view) this._view.dispatch({ effects: refreshCommentsEffect.of(null) });
    }));

    // Voice mute/solo change → refresh the M/S line marks + the muted-voice fade.
    this._unsub.push(state.on('abc-voices-change', () => {
      if (this._view) this._view.dispatch({ effects: refreshVoiceFadeEffect.of(null) });
    }));

    // DSL element clicked in preview → highlight the source range in the editor.
    // The transaction is tagged with DSL_SELECT_EVENT so the updateListener
    // can skip the 'editor-select' emission (ABC already handled its own click)
    // and avoid clearing the decoration we're about to set.
    this._unsub.push(state.on('dsl-select', ({ from, to }) => {
      if (!this._view) return;
      // Clamp to document length to guard against stale positions.
      const docLen = this._view.state.doc.length;
      const safeFrom = Math.min(from,  docLen);
      let   safeTo   = Math.min(to ?? from, docLen);
      // Trim trailing newlines so clicking a block doesn't visually include
      // the blank separator line that follows it in the source.
      const doc = this._view.state.doc;
      while (safeTo > safeFrom && doc.sliceString(safeTo - 1, safeTo) === '\n') safeTo--;
      // Use the native CM6 text selection as the visual highlight — same
      // appearance as drag-selecting text.  If there's a real range, select
      // it; otherwise just move the cursor.
      const hasRange = safeFrom < safeTo;
      // On phones the editor is a separate horizontal-scroll pane.  Focusing it
      // or scrolling it into view would yank the strip over to the DSL pane —
      // so on mobile we set the selection (highlight) but DON'T focus/scroll;
      // the highlight is waiting when the user pulls over to the editor pane.
      const mobile = window.matchMedia('(max-width: 640px)').matches;
      this._view.dispatch({
        selection: hasRange
          ? { anchor: safeFrom, head: safeTo }
          : { anchor: safeFrom, head: safeFrom },
        scrollIntoView: !mobile,
        annotations: Transaction.userEvent.of(DSL_SELECT_EVENT)
      });
      if (!mobile) this._view.focus();
    }));

    // A DSL asked for a block of text (an image reference) at `at`, else at the
    // cursor, on its own line(s): a blank line is replaced in place, a line
    // with content gets the block after it, and a blank line is kept on both
    // sides.  Lands in the undo history like any typing.
    this._unsub.push(state.on('editor-insert-block', ({ text, at }) => {
      if (!this._view || !text) return;
      const doc = this._view.state.doc;
      const pos = Math.max(0, Math.min(at ?? this._view.state.selection.main.head, doc.length));
      const line = doc.lineAt(pos);
      const prevBlank = line.number === 1 || !doc.line(line.number - 1).text.trim();
      const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
      const nextBlank = !next || !next.text.trim();
      let from, to, insert;
      if (!line.text.trim()) {
        from = line.from; to = line.to;
        insert = (prevBlank ? '' : '\n') + text + (nextBlank ? '' : '\n');
      } else {
        from = to = line.to;
        insert = '\n\n' + text + (nextBlank ? '' : '\n');
      }
      const head = from + insert.length - (nextBlank ? 0 : 1);
      const mobile = window.matchMedia('(max-width: 640px)').matches;
      this._view.dispatch({ changes: { from, to, insert }, selection: { anchor: head }, scrollIntoView: !mobile });
      if (!mobile) this._view.focus();
    }));

    // A DSL surface (the piano roll) edited the source directly → dispatch the
    // text changes through CM so they land in the undo history and flow out via
    // the normal updateListener → state.setContent path.  Changes are given in
    // original-document coordinates (CM composes them).  Tagged DSL_SELECT_EVENT
    // so 'editor-select' isn't re-emitted (the roll manages its own audition).
    this._unsub.push(state.on('dsl-edit', ({ changes, selection }) => {
      if (!this._view || !changes?.length) return;
      const docLen = this._view.state.doc.length;
      if (changes.some(c => c.from > docLen || (c.to ?? c.from) > docLen)) return; // stale
      this._view.dispatch({
        changes,
        ...(selection ? {
          selection: {
            anchor: Math.min(selection.anchor, docLen),
            head: Math.min(selection.head ?? selection.anchor, docLen),
          },
        } : {}),
        annotations: Transaction.userEvent.of(DSL_SELECT_EVENT),
      });
    }));

    // ABC playback cursor → colour the currently sounding notes green.
    // ranges is Array<{from,to}> (one entry per voice) while playing, or null.
    this._unsub.push(state.on('abc-play-cursor', (ranges) => {
      if (!this._view) return;
      this._view.dispatch({ effects: setPlayHighlight.of(ranges ?? null) });
    }));

    // DSL change → swap language compartment for features (completions, indent)
    // and rebuild per-section syntax highlights.
    this._unsub.push(state.on('change', () => {
      if (state.activeDslId !== null) return;
      const dsl = state.data?.dslType ?? 'markdown';
      if (dsl !== this._currentDsl) {
        this._currentDsl = dsl;
        this._swapLanguage(dsl);
        if (this._view) {
          this._view.dispatch({ effects: rebuildSectionHighlightsEffect.of(null) });
        }
      }
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    this._view?.destroy();
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  _build() {
    const dslId = this._currentDsl;
    const langExts = this._getDslExtensions(dslId);

    const updateListener = EditorView.updateListener.of((update) => {
      // Focus in/out → the phone shell hides its top bar while typing
      // (app.js _bindEditingChrome) and the action button keeps its state.
      if (update.focusChanged) state.emit('editor-focus', { focused: update.view.hasFocus });

      // Map thread char-offset positions through any document change BEFORE
      // broadcasting the new content so subscribers see fresh positions.
      const docReplaced = update.docChanged && update.transactions.some(tr => tr.annotation(docReplaceAnnotation));
      if (docReplaced) clampThreadPositions(update.state.doc.length);
      if (update.docChanged && (docReplaced || mapThreadPositions(update.changes))) {
        // The highlight field mapped its own decorations during this
        // transaction; rebuild from the mapped thread offsets before paint so
        // the two can never drift (and a thread whose text was deleted drops
        // its highlight).
        Promise.resolve().then(() => {
          if (this._view) this._view.dispatch({ effects: refreshCommentsEffect.of(null) });
        });
      }

      if (update.docChanged) {
        state.setContent(update.state.doc.toString(), {
          cursorPos: update.state.selection.main.head,
        });

        // Announce single typed characters so DSLs can audition what was just
        // written (ABC plays the typed note once the preview re-renders).
        // Only real keystrokes ('input.type') — paste/undo/autocomplete stay silent.
        if (update.transactions.some(tr => tr.isUserEvent('input.type'))) {
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            if (inserted.length === 1) {
              state.emit('editor-type', { pos: fromB, ch: inserted.toString() });
            }
          });
        }
      }

      // Detect whether this update came from a DSL-element click (dsl-select event).
      // Used in two places below: to suppress editor-select, and to annotate
      // active-section-change so layout-mode renderers can skip a needless re-render.
      const isDslSelect = (update.selectionSet || update.docChanged) &&
        update.transactions.some(
          tr => tr.annotation(Transaction.userEvent) === DSL_SELECT_EVENT
        );

      // When the user changes the selection (without also editing the document),
      // notify DSL previews so they can highlight the corresponding elements.
      // Skip when the selection change came from a DSL click (the preview already
      // knows which element was clicked) and skip on doc changes (the preview will
      // fully re-render, making any position-based highlight immediately stale).
      if (update.selectionSet && !update.docChanged && !isDslSelect) {
        const sel = update.state.selection.main;
        state.emit('editor-select', { from: sel.from, to: sel.to });
      }

      // Active section tracking — update state.activeDslId / activeSectionRange
      // whenever the cursor moves or the document changes.
      if (update.selectionSet || update.docChanged) {
        const pos  = update.state.selection.main.head;
        const doc  = update.state.doc;
        // parseDocSections scans the entire document.  Cache it per doc instance
        // (the Text object only changes when the document changes) so pure cursor
        // moves / note-click selections don't re-parse on every event — this is
        // the hot path that made clickback feel slow on larger scores.
        if (this._sectionsCacheDoc !== doc) {
          this._sectionsCacheDoc   = doc;
          this._sectionsCacheValue = parseDocSections(doc.toString());
        }
        const sects = this._sectionsCacheValue;
        const sect  = activeSectionAt(sects, pos);

        const newDslId = sect ? sect.dslId : null;
        const newRange = sect ? { from: sect.contentFrom, to: sect.to } : null;

        const changed =
          newDslId !== state.activeDslId ||
          newRange?.from !== state.activeSectionRange?.from ||
          newRange?.to   !== state.activeSectionRange?.to;

        if (changed) {
          state.activeDslId        = newDslId;
          state.activeSectionRange = newRange;
          // Effective DSL: section DSL or document default
          const effectiveDsl = newDslId ?? state.data?.dslType ?? 'markdown';
          if (effectiveDsl !== this._currentDsl) {
            this._currentDsl = effectiveDsl;
            // Guard against CM6 dispatch failures (e.g. plugin extensions with
            // isolated module instances) so the section-change event always fires.
            try { this._swapLanguage(effectiveDsl); } catch { /* continue */ }
          }
          state.emit('active-section-change', {
            dslId:         effectiveDsl,
            range:         newRange,
            version:       sect?.version ?? null,
            fromDslSelect: isDslSelect,
          });
        }
      }
    });

    const editorState = EditorState.create({
      doc: state.currentContent,
      extensions: [
        ...baseExtensions,
        this._languageCompartment.of(langExts),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        makeUnifileKeymap(),
        updateListener,
        EditorView.contentAttributes.of({ 'aria-label': 'Document editor' })
      ]
    });

    this._view = new EditorView({ state: editorState, parent: this.el });
    this._updateVisibility();

    this._bindCommentGestures();
  }

  // ---------------------------------------------------------------------------
  // Comment gestures: click a highlight → its card; right-click / long-press →
  // the context menu; a click elsewhere in the text closes the card.
  // ---------------------------------------------------------------------------

  _bindCommentGestures() {
    const content = this._view.contentDOM;

    // Click in the text (not inside the card — it stops propagation) closes
    // the card; a click on a comment highlight opens that thread instead.
    this.el.addEventListener('mousedown', (e) => {
      const view = this._view;
      if (!view || e.button !== 0) return;
      _hideMenu();
      if (e.target.closest('.uf-comment-card, .cm-tooltip')) return;
      if (e.target.closest('.cm-comment-range, .cm-comment-point')) return;   // handled on click
      if (view.state.field(commentCardField).range) view.dispatch({ effects: closeCommentEffect.of(null) });
    });
    this.el.addEventListener('click', (e) => {
      const view = this._view;
      if (!view) return;
      const hit = e.target.closest('.cm-comment-range, .cm-comment-point');
      if (!hit) return;
      // A drag that ended here is a selection, not a tap on the comment.
      if (!view.state.selection.main.empty) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const threads = hit.dataset.thread && state.data?.commentThreads?.[hit.dataset.thread]
        ? [state.data.commentThreads[hit.dataset.thread]]
        : (pos !== null ? getThreadsForPos(pos) : []);
      if (threads.length) view.dispatch({ effects: openCommentEffect.of({ threadId: threads[0].id }) });
    });

    // Right-click (and Android long-press, which fires contextmenu).
    content.addEventListener('contextmenu', (e) => {
      const view = this._view;
      if (!view) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return;
      e.preventDefault();
      const sel = view.state.selection.main;
      // Outside the selection the caret moves there first (native behaviour) so
      // "Comment" targets the word under the pointer.
      if (sel.empty || pos < sel.from || pos > sel.to) {
        view.dispatch({ selection: { anchor: pos } });
      }
      _showEditorMenu(view, e.clientX, e.clientY, pos);
    });

    // Long-press on SELECTED text (iOS fires no contextmenu). Only inside an
    // existing selection: elsewhere the long-press is the OS's own
    // select-text gesture and must not be touched.
    let press = null;
    const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
    content.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType === 'mouse') return;
      const view = this._view;
      if (!view) return;
      const sel = view.state.selection.main;
      if (sel.empty) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null || pos < sel.from || pos > sel.to) return;
      const x = e.clientX, y = e.clientY;
      press = { x, y, timer: setTimeout(() => {
        press = null;
        _showEditorMenu(view, x, y, pos);
        // iOS would start dragging the selection once the finger moves; our
        // menu is up, so swallow the drag for a moment.
        const stop = (ev) => ev.preventDefault();
        content.addEventListener('dragstart', stop, { once: true });
        setTimeout(() => content.removeEventListener('dragstart', stop), 1200);
      }, 480) };
    });
    content.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancel();
    });
    content.addEventListener('pointerup', cancel);
    content.addEventListener('pointercancel', cancel);
    document.addEventListener('selectionchange', () => { if (press) cancel(); });
  }

  // ---------------------------------------------------------------------------
  // Language compartment
  // ---------------------------------------------------------------------------

  _getDslExtensions(dslId) {
    try {
      const dsl = getDSL(dslId);
      return dsl.getEditorExtensions?.() ?? [];
    } catch { return []; }
  }

  _swapLanguage(dslId) {
    if (!this._view) return;
    this._view.dispatch({
      effects: this._languageCompartment.reconfigure(this._getDslExtensions(dslId))
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getValue() { return this._view?.state.doc.toString() ?? ''; }

  setValue(text) {
    if (!this._view) return;
    const current = this._view.state.doc.toString();
    if (current === text) return;
    // Loading a different document (checkout / branch switch / open) re-applies
    // the load-time section collapse defaults.
    this._view.dispatch({
      changes: { from: 0, to: current.length, insert: text ?? '' },
      effects: [resetCollapseEffect.of(null), closeCommentEffect.of(null)],
      annotations: docReplaceAnnotation.of(true),
    });
  }

  focus() { this._view?.focus(); }
  hasFocus() { return !!this._view?.hasFocus; }

  /**
   * Put the selection on a range (a search hit from the library) and scroll it
   * into view; focuses on desktop (phones keep the keyboard down).
   */
  goTo(from, to = from) {
    if (!this._view) return;
    const len = this._view.state.doc.length;
    const a = Math.max(0, Math.min(from ?? 0, len)), h = Math.max(a, Math.min(to ?? a, len));
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    this._view.dispatch({ selection: { anchor: a, head: h }, scrollIntoView: true });
    if (!mobile) this._view.focus();
  }

  /** Undo / redo through CM's history (the phone action button's Undo/Redo). */
  undo() { return this._view ? undo(this._view) : false; }
  redo() { return this._view ? redo(this._view) : false; }

  /**
   * Indent / outdent the selected lines by one indent unit (the phone action
   * button's Indent/Outdent — a soft keyboard has no Tab / Shift-Tab).  Same
   * commands `indentWithTab` binds on hardware keyboards.
   */
  indent()  { return this._view ? indentMore(this._view) : false; }
  outdent() { return this._view ? indentLess(this._view) : false; }

  /**
   * Run the active DSL's source formatter (ABC: one measure per line) over the
   * document. Returns true when a formatter ran. Used by the mobile format button;
   * the Alt-Shift-F keybinding calls the same logic.
   */
  alignActiveDsl() { return alignActiveDsl(this._view); }

  /**
   * Comment on the selection (or the word / line at the caret): opens the
   * composer card, or the existing thread under the caret.  The phone bubble's
   * Comment action and the ⋯ menu call this.
   */
  commentSelection() { return commentOnSelection(this._view); }

  /** True when the document has an open (unresolved) comment thread. */
  hasComments() { return listOpenThreads().length > 0; }

  /**
   * Ask CodeMirror to re-measure its layout.  Needed after the editor pane is
   * revealed from `display:none` (mobile pane switch) — CM6 can't measure while
   * hidden, so the first paint after showing may be stale until we nudge it.
   */
  refresh() { this._view?.requestMeasure(); }

  /**
   * Expose the underlying CM6 EditorView document for migration etc.
   * @returns {import('@codemirror/state').Text}
   */
  getDoc() { return this._view?.state.doc ?? null; }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  _updateVisibility() {
    const { viewMode, activePanel } = state;
    const hidden = viewMode === VIEW_MODES.PREVIEW || activePanel === PANELS.BLAME;
    this.el.style.display = hidden ? 'none' : '';
    this.el.style.flex = (!hidden && viewMode === VIEW_MODES.EDITOR) ? '1 1 100%' : '1 1 50%';
  }
}
