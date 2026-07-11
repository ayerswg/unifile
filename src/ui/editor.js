/**
 * Editor component — powered by CodeMirror 6
 *
 * Features:
 *   - Catppuccin Mocha theme (dark) / Latte (light)
 *   - DSL-aware syntax highlighting
 *   - Line numbers with comment-thread highlighting:
 *       · Lines with active comment threads get an amber background on the
 *         line number.  Click any line number to open the inline accordion.
 *       · Range-anchored selections are highlighted while the accordion is open.
 *       · Right-click on selected text → "Add comment" context menu.
 *       · Clicking a cm-comment-range re-opens the accordion for that thread.
 *   - Active-line highlight, bracket matching
 *   - Autocomplete, selection highlighting
 *   - Tab / Shift+Tab indent · Ctrl+S → commit · Alt+1/2/3 → view modes
 */

import { EditorView, keymap, Decoration,
         highlightActiveLineGutter, drawSelection,
         highlightSpecialChars, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, Transaction, RangeSetBuilder, Text } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, Language } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets,
         closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';

import { catppuccinTheme, catppuccinHighlight } from './editor-theme.js';
import { highlightTree } from '@lezer/highlight';
import { state, VIEW_MODES, PANELS } from './state.js';
import { getDSL } from '../dsl/registry.js';
import { parseDocSections, activeSectionAt } from '../core/doc-sections.js';
import { parseGlobalFrontMatter } from '../core/front-matter.js';
import { voiceIdOfLine, buildVoiceMap } from '../core/abc-voices.js';
import {
  accordionField,
  openAccordionEffect,
  closeAccordionEffect,
  getThreadsForLine,
  getThreadsForPos,
  bumpThreadVersion
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
// Custom line-number gutter with comment-thread highlighting
//
// Replaces the standard lineNumbers() extension so we can:
//   • Show the line number (same look as default, but narrower)
//   • Add `.cm-has-comments` class to lines with active threads → amber bg
//   • Handle clicks to open the inline accordion for that line
// ---------------------------------------------------------------------------

class LineNumMarker extends GutterMarker {
  constructor(lineNum, hasThread, isActive, voiceMark) {
    super();
    this.lineNum        = lineNum;
    this.hasThread      = hasThread;
    this.isActive       = isActive;
    // voiceMark: 'M' (muted) / 'S' (soloed) shown in the rail for voice lines, else ''.
    this.voiceMark      = voiceMark || '';
    // elementClass is applied to the wrapper gutter cell element by CM6.
    // The active-line + comment classes take visual priority.
    this.elementClass = isActive
      ? 'cm-has-comments cm-accordion-active'
      : (hasThread ? 'cm-has-comments' : '');
  }

  toDOM() {
    const el = document.createElement('div');
    if (this.voiceMark) {
      el.className = 'cm-ln-mark mark-' + this.voiceMark;
      el.textContent = this.voiceMark;
      el.title = this.voiceMark === 'S' ? 'Soloed voice — click to change'
                                        : 'Muted voice — click to change';
      return el;
    }
    el.className = 'cm-ln-text';
    el.textContent = String(this.lineNum);
    el.title = this.hasThread ? 'Comment — click to view' : 'Click for options';
    return el;
  }

  eq(other) {
    return (
      this.lineNum   === other.lineNum   &&
      this.hasThread === other.hasThread &&
      this.isActive  === other.isActive  &&
      this.voiceMark === other.voiceMark
    );
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

/** The M/S voice mark for a line, or '' — only for ABC voice (`V:`) lines. */
function _voiceMarkForLine(lineText) {
  if ((state.data?.dslType) !== 'abcjs') return '';
  const id = voiceIdOfLine(lineText);
  if (id == null) return '';
  if (state.abcSoloVoices.has(id)) return 'S';
  if (state.abcMutedVoices.has(id)) return 'M';
  return '';
}

const commentLineNumbersExt = gutter({
  class: 'cm-lineNumbers cm-comment-ln',

  lineMarker(view, line) {
    const lineInfo   = view.state.doc.lineAt(line.from);
    const threads    = getThreadsForLine(line.from, view.state.doc);
    // Check whether the accordion is currently anchored to this line
    const acc        = view.state.field(accordionField);
    const isActive   = acc.anchorPos !== null &&
      view.state.doc.lineAt(acc.anchorPos).from === lineInfo.from;
    const voiceMark  = _voiceMarkForLine(lineInfo.text);
    return new LineNumMarker(lineInfo.number, threads.length > 0, isActive, voiceMark);
  },

  lineMarkerChange: () => true,
  initialSpacer: () => new LineNumSpacer(),

  domEventHandlers: {
    // Click the gutter → open a small menu of line options (Comment always;
    // Mute / Solo for ABC voice lines). See _showGutterMenu.
    click(view, line, event) {
      const lineDoc = view.state.doc.lineAt(line.from);
      _showGutterMenu(view, event.clientX, event.clientY, lineDoc);
      return true;
    }
  }
});

// ---------------------------------------------------------------------------
// Gutter line-options menu (floating popup on gutter click)
//
// Every line offers "comment"; ABC voice (`V:`) lines also offer Mute / Solo,
// which silence / isolate that voice for the whole song (see state + abcjs.js).
// ---------------------------------------------------------------------------

let _gutterMenuEl = null;

function _hideGutterMenu() {
  _gutterMenuEl?.remove();
  _gutterMenuEl = null;
}

function _showGutterMenu(view, x, y, lineDoc) {
  _hideGutterMenu();

  const threads   = getThreadsForLine(lineDoc.from, view.state.doc);
  const voiceId   = (state.data?.dslType) === 'abcjs' ? voiceIdOfLine(lineDoc.text) : null;

  const menu = document.createElement('div');
  menu.className = 'cm-comment-context-menu cm-gutter-menu';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  const addItem = (label, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'cm-ccm-add';
    btn.textContent = label;
    btn.addEventListener('click', () => { _hideGutterMenu(); onClick(); });
    menu.appendChild(btn);
  };

  addItem(threads.length ? 'View comment' : 'Add comment', () => {
    view.dispatch({
      effects: openAccordionEffect.of({
        anchorPos: lineDoc.to,
        threadId:  threads[0]?.id ?? null,
        newRange:  threads.length ? null : { from: lineDoc.from, to: lineDoc.from },
      })
    });
  });

  if (voiceId != null) {
    addItem(state.abcMutedVoices.has(voiceId) ? 'Unmute voice' : 'Mute voice',
      () => state.toggleVoiceMute(voiceId));
    addItem(state.abcSoloVoices.has(voiceId) ? 'Unsolo voice' : 'Solo voice',
      () => state.toggleVoiceSolo(voiceId));
  }

  document.body.appendChild(menu);
  _gutterMenuEl = menu;

  // Keep the menu on-screen (it's positioned from the click point).
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth)  menu.style.left = Math.max(4, window.innerWidth  - r.width  - 4) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top  = Math.max(4, window.innerHeight - r.height - 4) + 'px';

  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      _hideGutterMenu();
      document.removeEventListener('mousedown', dismiss, true);
    }
  };
  document.addEventListener('mousedown', dismiss, true);
}

// ---------------------------------------------------------------------------
// Muted-voice fade (editor)
//
// Lines belonging to a muted/non-soloed ABC voice are dimmed so it's clear
// they won't sound or highlight during playback. Rebuilt on doc change and
// whenever the mute/solo selection changes (refreshVoiceFadeEffect).
// ---------------------------------------------------------------------------

const refreshVoiceFadeEffect = StateEffect.define();

function _buildVoiceFade(editorState) {
  if ((state.data?.dslType) !== 'abcjs') return Decoration.none;
  if (state.abcMutedVoices.size === 0 && state.abcSoloVoices.size === 0) return Decoration.none;
  const doc = editorState.doc;
  const vmap = buildVoiceMap(doc.toString());
  const builder = new RangeSetBuilder();
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const id = vmap.at(line.from);
    if (id != null && state.isVoiceMuted(id)) {
      builder.add(line.from, line.from, Decoration.line({ class: 'cm-voice-muted' }));
    }
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
      highlightTree(tree, catppuccinHighlight, (tFrom, tTo, classes) => {
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
  commentLineNumbersExt,        // replaces lineNumbers(); comment + voice-mark gutter
  accordionField,               // inline accordion widget + range marks
  // Gutter line-number cell for the active line gets an accent highlight (the
  // left rail on mobile). We intentionally do NOT highlightActiveLine() the
  // content background — a full-width line tint fights with the text-selection
  // highlight and makes the actively selected text hard to see (see app.css).
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  drawSelection(),
  // NOTE: highlightSelectionMatches() intentionally omitted — selecting text
  // should not light up every other occurrence of that text in the document.

  // Editing quality
  history(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  // NOTE: line wrapping intentionally omitted — long DSL lines scroll
  // horizontally inside the editor (cm-scroller) rather than wrapping. On mobile
  // this nests inside the pane scroll-snap strip: swiping the code scrolls it,
  // and at the edge the gesture chains out to snap to the next pane.

  // DSL range highlight (e.g. from clicking a note in ABC preview)
  dslHighlightField,

  // Playback cursor highlight (green, tracks currently playing note)
  playHighlightField,

  // Muted-voice fade — dims lines of muted / non-soloed ABC voices
  voiceFadeField,

  // Shebang line decoration (#! section headers appear muted/italic)
  shebangDecoField,

  // Collapsible front-matter / ABC-header sections (default-collapsed on load
  // so the music body is what you see first).
  sectionCollapseExtension,

  // Inject the catppuccin highlight CSS rules so sectionSyntaxField's
  // Decoration.mark({ class }) spans get styled. Using the StyleModule directly
  // (instead of syntaxHighlighting(catppuccinHighlight)) injects the CSS without
  // triggering automatic whole-doc tree scanning.
  EditorView.styleModule.of(catppuccinHighlight.module),

  // Per-section syntax highlighting
  sectionSyntaxField,

  // Theme
  catppuccinTheme,
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
    // Format: align measures/voices when the active DSL provides a formatter.
    { key: 'Alt-Shift-f', preventDefault: true, run: (view) => alignActiveDsl(view) },
    { key: 'Alt-1', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.EDITOR);  return true; } },
    { key: 'Alt-2', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.SPLIT);   return true; } },
    { key: 'Alt-3', preventDefault: true, run: () => { state.setViewMode(VIEW_MODES.PREVIEW); return true; } }
  ]);
}

/**
 * Run the active DSL's source formatter (e.g. ABC voice alignment) over the whole
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
// Context-menu state (floating "Add comment" popup on right-click + selection)
// ---------------------------------------------------------------------------

let _ctxMenuEl = null;

/**
 * Show the "Add comment" floating context menu.
 * @param {EditorView} view
 * @param {number} x  clientX from the contextmenu event
 * @param {number} y  clientY
 * @param {number} anchorPos  line.to where the block widget will be placed
 * @param {number|null} selFrom  selection start (null for whole-line comments)
 * @param {number|null} selTo   selection end   (null for whole-line comments)
 */
function _showContextMenu(view, x, y, anchorPos, selFrom, selTo) {
  _hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'cm-comment-context-menu';
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.innerHTML  = `<button class="cm-ccm-add">Add comment</button>`;

  menu.querySelector('.cm-ccm-add').addEventListener('click', () => {
    _hideContextMenu();
    view.dispatch({
      effects: openAccordionEffect.of({
        anchorPos,
        threadId: null,
        newRange: (selFrom !== null && selTo !== null) ? { from: selFrom, to: selTo } : null
      })
    });
  });

  document.body.appendChild(menu);
  _ctxMenuEl = menu;

  const dismiss = (e) => {
    if (!menu.contains(e.target)) {
      _hideContextMenu();
      document.removeEventListener('mousedown', dismiss, true);
    }
  };
  document.addEventListener('mousedown', dismiss, true);
}

function _hideContextMenu() {
  _ctxMenuEl?.remove();
  _ctxMenuEl = null;
}

// ---------------------------------------------------------------------------
// Thread position mapping (called from updateListener on docChanged)
// ---------------------------------------------------------------------------

export function mapThreadPositions(changes) {
  const threads = state.data?.commentThreads;
  if (!threads) return;

  let bumped = false;
  for (const t of Object.values(threads)) {
    if (t.from === undefined || t.archived) continue;
    const newFrom = changes.mapPos(t.from, 1);
    const newTo   = Math.max(newFrom, changes.mapPos(t.to, -1));

    if (t.from < t.to && newFrom >= newTo) {
      // The range was meaningful but the text was completely deleted.
      // Auto-archive so the dead thread doesn't linger on the gutter.
      t.archived = true;
      t.from = newFrom;
      t.to   = newFrom;
      bumped = true;
    } else if (newFrom !== t.from || newTo !== t.to) {
      t.from = newFrom;
      t.to   = newTo;
    }
  }
  if (bumped) {
    bumpThreadVersion();
    // Mark document dirty so the auto-archive is persisted on next commit
    state.update({ data: state.data, isDirty: true });
  }
  // Gutter redraws automatically (lineMarkerChange: () => true)
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

    // Rotating between portrait/landscape suppresses or restores the section
    // bars (see editor-sections.js). Rebuild them without disturbing the
    // per-section collapse state.
    landscapePhoneMql.addEventListener('change', () => {
      this._view?.dispatch({ effects: refreshSectionsEffect.of(null) });
    });
    this._unsub.push(state.on('view-mode-change', () => this._updateVisibility()));

    // Panel changes → update visibility only (accordion is now in CM6 state)
    this._unsub.push(state.on('panel-change', () => {
      this._updateVisibility();
    }));

    // Thread data mutations (archive/restore) → force gutter re-render
    this._unsub.push(state.on('comments-change', () => {
      if (this._view) this._view.dispatch({});
    }));

    // Voice mute/solo change → refresh the gutter M/S marks + the muted-voice fade.
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
      // Map thread char-offset positions through any document change BEFORE
      // broadcasting the new content so subscribers see fresh positions.
      if (update.docChanged) {
        mapThreadPositions(update.changes);
        // The gutter reads thread positions from state.data (mutated above),
        // but it already rendered once against the new doc during this same
        // transaction.  Queue a micro-task dispatch so the gutter re-evaluates
        // with the corrected positions before the browser paints.
        Promise.resolve().then(() => { if (this._view) this._view.dispatch({}); });
      }

      if (update.docChanged) {
        state.setContent(update.state.doc.toString(), {
          cursorPos: update.state.selection.main.head,
        });
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

    // ── mousedown: close accordion when clicking editor content (not on an
    //   accordion widget, not on a cm-comment-range, not on the gutter).
    //   Also handle clicks on comment ranges to re-open the accordion.
    this.el.addEventListener('mousedown', (e) => {
      const view = this._view;
      if (!view) return;

      // Always hide the floating context menu on any mousedown in the editor
      _hideContextMenu();

      // Never close when clicking inside the accordion itself
      // (its children call e.stopPropagation())

      // Gutter clicks are handled by the gutter extension — ignore here
      if (e.target.closest('.cm-gutters')) return;

      // If click is on a comment-range highlight, open/switch to that thread
      if (e.target.closest('.cm-comment-range')) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos !== null) {
          const threads = getThreadsForPos(pos);
          if (threads.length > 0) {
            const t       = threads[0];
            const lineEnd = view.state.doc.lineAt(t.from).to;
            e.preventDefault(); // prevent text-selection change
            view.dispatch({
              effects: openAccordionEffect.of({ anchorPos: lineEnd, threadId: t.id })
            });
            return;
          }
        }
      }

      // Clicking anywhere else in the editor content → close the accordion
      view.dispatch({ effects: closeAccordionEffect.of(null) });
    });

    // Comments are line-level: click the gutter to create/view one (see the
    // commentLineNumbersExt click handler). No selection/range comment menu.
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
      effects: resetCollapseEffect.of(null),
    });
  }

  focus() { this._view?.focus(); }

  /**
   * Run the active DSL's source formatter (ABC voice/measure alignment) over the
   * document. Returns true when a formatter ran. Used by the mobile align button;
   * the Alt-Shift-F keybinding calls the same logic.
   */
  alignActiveDsl() { return alignActiveDsl(this._view); }

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
