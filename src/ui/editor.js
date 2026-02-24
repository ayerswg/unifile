/**
 * Editor component — powered by CodeMirror 6
 *
 * Features:
 *   - Catppuccin Mocha theme (dark) / Latte (light)
 *   - DSL-aware syntax highlighting
 *   - Line numbers with comment-thread highlighting:
 *       · Lines with active comment threads get an amber background on the
 *         line number.  Click any line number to open the CommentsPanel.
 *       · While the panel is open, that line gets a subtle amber highlight.
 *       · Clicking in the editor content area (not a line number) closes the panel.
 *   - Active-line highlight, bracket matching
 *   - Autocomplete, selection highlighting
 *   - Tab / Shift+Tab indent · Ctrl+S → commit · Alt+1/2/3 → view modes
 */

import { EditorView, keymap, highlightActiveLine, Decoration,
         highlightActiveLineGutter, drawSelection,
         highlightSpecialChars, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, Transaction } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets,
         closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';

import { catppuccinTheme, catppuccinHighlight } from './editor-theme.js';
import { state, VIEW_MODES, PANELS } from './state.js';
import { getDSL } from '../dsl/registry.js';
import { getActiveThreadForLine } from './comments.js';

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

const setDslHighlight = StateEffect.define();

const dslHighlightField = StateField.define({
  create: () => Decoration.none,

  update(deco, tr) {
    // Keep decoration mapped through document changes.
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setDslHighlight)) {
        if (e.value === null) {
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
// While ABC audio is playing, the source character range for the currently
// sounding note is decorated with a green highlight so the user can follow
// along in the editor text.  Cleared when playback stops.
// ---------------------------------------------------------------------------

const setPlayHighlight = StateEffect.define();

const playHighlightField = StateField.define({
  create: () => Decoration.none,

  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPlayHighlight)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const { from, to } = e.value;
          deco = Decoration.set([
            Decoration.mark({ class: 'cm-play-highlight' }).range(from, to)
          ]);
        }
      }
    }
    return deco;
  },

  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Comment-focus line decoration
//
// When the CommentsPanel is open for a specific line, that line gets a subtle
// amber background + left border accent in the editor.
// ---------------------------------------------------------------------------

const setCommentFocusLine = StateEffect.define();

const commentFocusField = StateField.define({
  create: () => Decoration.none,

  update(deco, tr) {
    // Map existing ranges through document changes
    deco = deco.map(tr.changes);
    // Apply new focus line if an effect arrived
    for (const e of tr.effects) {
      if (e.is(setCommentFocusLine)) {
        if (e.value === null || e.value > tr.state.doc.lines) {
          deco = Decoration.none;
        } else {
          try {
            const line = tr.state.doc.line(e.value);
            deco = Decoration.set([
              Decoration.line({ class: 'cm-comment-focus-line' }).range(line.from)
            ]);
          } catch {
            deco = Decoration.none;
          }
        }
      }
    }
    return deco;
  },

  provide: f => EditorView.decorations.from(f)
});

// ---------------------------------------------------------------------------
// Custom line-number gutter with comment-thread highlighting
//
// Replaces the standard lineNumbers() extension so we can:
//   • Show the line number (same look as default, but narrower)
//   • Add `.cm-has-comments` class to lines with active threads → amber bg
//   • Handle clicks to open the CommentsPanel for that line
// ---------------------------------------------------------------------------

class LineNumMarker extends GutterMarker {
  constructor(lineNum, hasThread) {
    super();
    this.lineNum   = lineNum;
    this.hasThread = hasThread;
    this.elementClass = hasThread ? 'cm-has-comments' : '';
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-ln-text';
    el.textContent = String(this.lineNum);
    if (this.hasThread) el.title = 'Has comment — click to view';
    return el;
  }

  eq(other) {
    return this.lineNum === other.lineNum && this.hasThread === other.hasThread;
  }
}

// Spacer determines initial gutter width
class LineNumSpacer extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-ln-text';
    el.textContent = '0000'; // 4 digits — wide enough for most docs
    return el;
  }
}

const commentLineNumbersExt = gutter({
  class: 'cm-lineNumbers cm-comment-ln',

  lineMarker(view, line) {
    const lineNum   = view.state.doc.lineAt(line.from).number;
    const hasThread = getActiveThreadForLine(lineNum) !== null;
    return new LineNumMarker(lineNum, hasThread);
  },

  lineMarkerChange: () => true,
  initialSpacer: () => new LineNumSpacer(),

  domEventHandlers: {
    click(view, line) {
      const lineNum = view.state.doc.lineAt(line.from).number;
      state.focusedLine = lineNum;
      state.openPanel(PANELS.COMMENTS);
      return true;
    }
  }
});

// ---------------------------------------------------------------------------
// Static base extensions — same for every DSL
// ---------------------------------------------------------------------------

const baseExtensions = [
  commentLineNumbersExt,        // replaces lineNumbers(); also handles comment highlighting
  commentFocusField,            // amber line highlight when comments panel is open
  highlightActiveLineGutter(),
  highlightActiveLine(),
  highlightSpecialChars(),
  drawSelection(),
  highlightSelectionMatches(),

  // Editing quality
  history(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  EditorView.lineWrapping,

  // DSL range highlight (e.g. from clicking a note in ABC preview)
  dslHighlightField,

  // Playback cursor highlight (green, tracks currently playing note)
  playHighlightField,

  // Theme
  catppuccinTheme,
  syntaxHighlighting(catppuccinHighlight),
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
        if (state.isDirty) state.openPanel(PANELS.COMMIT);
        return true;
      }
    },
    { key: 'Alt-1', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.EDITOR);  return true; } },
    { key: 'Alt-2', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.SPLIT);   return true; } },
    { key: 'Alt-3', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.PREVIEW); return true; } }
  ]);
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
    this._unsub.push(state.on('branch-switch',({ content }) => this.setValue(content)));
    this._unsub.push(state.on('view-mode-change', () => this._updateVisibility()));

    // Panel changes → update visibility + update comment-focus decoration
    this._unsub.push(state.on('panel-change', (panel) => {
      this._updateVisibility();
      const lineNum = panel === PANELS.COMMENTS ? state.focusedLine : null;
      if (this._view) {
        this._view.dispatch({ effects: setCommentFocusLine.of(lineNum) });
      }
    }));

    // Comment mutations → re-render gutter markers
    this._unsub.push(state.on('comments-change', () => {
      if (this._view) this._view.dispatch({});
    }));

    // DSL element clicked in preview → highlight the source range in the editor.
    // The transaction is tagged with DSL_SELECT_EVENT so the updateListener
    // can skip the 'editor-select' emission (ABC already handled its own click)
    // and avoid clearing the decoration we're about to set.
    this._unsub.push(state.on('dsl-select', ({ from, to }) => {
      if (!this._view) return;
      // Clamp to document length to guard against stale positions.
      const docLen = this._view.state.doc.length;
      const safeFrom = Math.min(from, docLen);
      const safeTo   = Math.min(to,   docLen);
      this._view.dispatch({
        effects: setDslHighlight.of({ from: safeFrom, to: safeTo }),
        selection: { anchor: safeFrom, head: safeTo },
        scrollIntoView: true,
        annotations: Transaction.userEvent.of(DSL_SELECT_EVENT)
      });
      this._view.focus();
    }));

    // ABC playback cursor → highlight the currently sounding note in green.
    // event is { from, to } while playing, or null when stopped.
    this._unsub.push(state.on('abc-play-cursor', (event) => {
      if (!this._view) return;
      const effect = event
        ? setPlayHighlight.of({ from: event.from, to: event.to })
        : setPlayHighlight.of(null);
      this._view.dispatch({ effects: effect });
    }));

    // DSL change → swap language extension
    this._unsub.push(state.on('change', () => {
      const dsl = state.data?.dslType ?? 'markdown';
      if (dsl !== this._currentDsl) {
        this._currentDsl = dsl;
        this._swapLanguage(dsl);
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
      if (update.docChanged) state.setContent(update.state.doc.toString());

      // When the user changes the selection (without also editing the document),
      // notify DSL previews so they can highlight the corresponding elements.
      // Skip when the selection change came from a DSL click (the preview already
      // knows which element was clicked) and skip on doc changes (the preview will
      // fully re-render, making any position-based highlight immediately stale).
      if (update.selectionSet && !update.docChanged) {
        const isDslSelect = update.transactions.some(
          tr => tr.annotation(Transaction.userEvent) === DSL_SELECT_EVENT
        );
        if (!isDslSelect) {
          const sel = update.state.selection.main;
          state.emit('editor-select', { from: sel.from, to: sel.to });
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

    // Close the comments panel when clicking in the editor content area
    // (not on a line number). Uses bubble phase so it fires AFTER CM6's
    // gutter handler has already opened/switched the panel for that line.
    this.el.addEventListener('click', (e) => {
      if (state.activePanel !== PANELS.COMMENTS) return;
      // Don't close if the click was on a gutter element (line numbers)
      if (e.target.closest('.cm-gutters')) return;
      state.closePanel();
    });
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
    this._view.dispatch({ changes: { from: 0, to: current.length, insert: text ?? '' } });
  }

  focus() { this._view?.focus(); }

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
