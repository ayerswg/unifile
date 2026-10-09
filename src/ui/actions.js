/**
 * The phone shell's actions — two lists, two homes:
 *
 *   • listMenuActions(ctx)         → the title dropdown (pane-switch.js):
 *     file-level things — Document, File, Export, More (settings).  Never on
 *     the bubble.
 *   • listBubbleActions(ctx, view) → the round action button (action-fab.js),
 *     CONTEXTUAL to the pane that is showing:
 *       editor  → text/music verbs: play · one measure per line · piano roll
 *                 (ABC), comment, indent · outdent, undo · redo
 *       render  → play / pause (ABC); zoom to fit · zoom in · zoom out
 *                 (Mermaid) — nothing for other DSLs (bubble hides)
 *       history → Save (the tap: the next version to the device), Save with
 *                 a note…, Save as new major version
 *       library → New document (the tap), Open from device…
 *
 * Every action carries a single UTF-8 TEXT glyph (never an emoji — code points
 * with an emoji presentation get U+FE0E appended so iOS keeps them monochrome)
 * which the button shows in the brand braces: `{▶}`, `{↶}`, `{⚙}` …
 *
 * `ctx` is supplied by app.js: { handlers, editor }.
 */

import { state, PANELS } from './state.js';
import { getDSL, listDSLs } from '../dsl/registry.js';
import { generateQuine, downloadFile, downloadBlob } from '../core/storage.js';
import { showDslHelpModal, showExtensionsModal } from './topbar.js';
import { showArchivedCommentsModal } from './comments.js';
import { zoomAll as mermaidZoom } from '../dsl/mermaid-zoom.js';

const TEXT = '︎';   // variation selector-15: force text presentation

// Landscape phone = the only place the piano roll fits (see piano-roll.js).
const _landscapeMql = window.matchMedia(
  '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'
);

export function currentDslId() {
  return state.activeDslId ?? state.data?.dslType ?? 'markdown';
}

/** A DSL's own actions (`dsl.actions: [{ id, label, glyph, run }]`), if any. */
export function dslActions(dslId = currentDslId()) {
  try { return getDSL(dslId)?.actions ?? []; } catch { return []; }
}

/**
 * The action a fresh install runs on a plain tap of the bubble, per DSL and
 * view.  'menu' = the tap opens the bubble's own grid.
 */
export function defaultPrimary(dslId, view = 'editor') {
  if (view === 'history') return 'save';
  if (view === 'library') return 'new';
  if (dslId === 'abcjs') return 'play';
  // The diagram's render view: a tap re-fits the diagram (zoom to extents).
  if (view === 'render' && dslId === 'mermaid') return 'fit';
  // The spreadsheet's render view is the grid: a tap undoes, like the editors.
  if (view === 'render' && dslId === 'spreadsheet') return 'undo';
  if (view !== 'editor') return 'menu';
  // Mermaid is indentation-shaped (subgraphs, nested nodes) and a soft keyboard
  // has no Tab — so the diagram app's tap is Indent, not Undo.
  return dslId === 'mermaid' ? 'indent' : 'undo';
}

/** Glyphs for the DSL exporters, by exporter key. */
const EXPORT_GLYPHS = { svg: '⬡', pdf: '▤', midi: '♬', png: '▣', epub: '▥', docx: '▤', pptx: '▧', html: '⊞' };

const mk = (a) => ({ key: a.label, disabled: false, star: true, ...a });

// ---------------------------------------------------------------------------
// Bubble (contextual)
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx   { handlers, editor }
 * @param {string} view  'editor' | 'render' | 'history' | 'library'
 * @returns {Array<{id,label,key,glyph,run,disabled,star}>}
 *   key  — stable sort key (labels like Play/Pause change; the tile shouldn't move)
 *   star — false = can't be made the tap action
 */
export function listBubbleActions(ctx = {}, view = 'editor') {
  const dslId = currentDslId();
  const isAbc = dslId === 'abcjs';
  const editor = ctx.editor;
  const acts = [];

  const play = () => {
    const playing = !!state.abcPlaying;
    acts.push(mk({ id: 'play', label: playing ? 'Pause' : 'Play', key: 'Play / pause',
      glyph: playing ? '⏸' + TEXT : '▶' + TEXT, run: () => state.emit('abc-play') }));
  };

  if (view === 'render') {
    // A DSL whose render view is itself an editing surface ({spreadsheet}'s
    // grid) supplies the bubble's verbs there: `dsl.renderActions`.
    let renderActs = [];
    try { renderActs = getDSL(dslId)?.renderActions ?? []; } catch { /* no DSL */ }
    for (const a of renderActs) acts.push(mk({ id: a.id, label: a.label, glyph: a.glyph ?? '·', run: () => a.run({ editor }) }));
    if (isAbc) play();
    if (dslId === 'mermaid') {
      // The diagram's zoom stage (mermaid-zoom.js) obeys these from anywhere.
      acts.push(mk({ id: 'fit', label: 'Zoom to fit', glyph: '⛶', run: () => mermaidZoom('fit') }));
      acts.push(mk({ id: 'zoom-in', label: 'Zoom in', glyph: '+', run: () => mermaidZoom('in') }));
      acts.push(mk({ id: 'zoom-out', label: 'Zoom out', glyph: '−', run: () => mermaidZoom('out') }));
    }
    return acts;
  }

  if (view === 'history') {
    const next = state.nextSaveVersion;
    acts.push(mk({ id: 'save', label: next ? `Save ${next}` : 'Save', key: '0 save', glyph: '◉', disabled: !state.needsSave,
      run: () => state.emit('save-document') }));
    acts.push(mk({ id: 'save-msg', label: 'Save with a note…', key: '1 save msg', glyph: '✎', star: false,
      disabled: !state.needsSave, run: () => composeCommit() }));
    const major = state.nextMajorVersion;
    if (major) acts.push(mk({ id: 'save-major', label: `Save as ${major}`, key: '2 major', glyph: '⇈', star: false,
      run: () => state.emit('save-major') }));
    return acts;
  }

  if (view === 'library') {
    acts.push(mk({ id: 'new', label: 'New document', key: '0 new', glyph: '+', run: () => state.emit('new-document') }));
    acts.push(mk({ id: 'open-device', label: 'Open from device…', key: '1 open', glyph: '⤒', star: false,
      run: () => state.emit('open-from-device') }));
    return acts;
  }

  // editor
  if (isAbc) {
    play();
    acts.push(mk({ id: 'align', label: 'One measure per line', glyph: '⫴',
      run: () => { editor?.alignActiveDsl(); } }));
    if (_landscapeMql.matches) {
      acts.push(mk({ id: 'roll', label: state.pianoRollOpen ? 'Close piano roll' : 'Piano roll', key: 'Piano roll',
        glyph: '▦', run: () => state.togglePianoRoll() }));
    }
  }
  // The DSL's own verbs (e.g. {slides}: Insert image… → the photo library).
  for (const a of dslActions(dslId)) {
    acts.push(mk({ id: a.id, label: a.label, glyph: a.glyph ?? '·', run: () => a.run({ editor }) }));
  }
  // Comment on the selection (or the word at the caret) — the phone's sure way
  // in, beside the long-press on selected text (editor.js).
  acts.push(mk({ id: 'comment', label: 'Comment', glyph: '❝', run: () => state.emit('comment-selection') }));
  // Indent / outdent the selected lines — every text app, since a soft keyboard
  // has no Tab / Shift-Tab.
  acts.push(mk({ id: 'indent', label: 'Indent', glyph: '⇥', run: () => { editor?.indent(); } }));
  acts.push(mk({ id: 'outdent', label: 'Outdent', glyph: '⇤', run: () => { editor?.outdent(); } }));
  acts.push(mk({ id: 'undo', label: 'Undo', glyph: '↶', run: () => { editor?.undo(); } }));
  acts.push(mk({ id: 'redo', label: 'Redo', glyph: '↷', run: () => { editor?.redo(); } }));
  return acts;
}

// ---------------------------------------------------------------------------
// Title dropdown (file level)
// ---------------------------------------------------------------------------

export const GROUP_LABELS = { document: 'Document', file: 'File', export: 'Export', more: 'More' };
export const MENU_GROUPS = ['document', 'file', 'export', 'more'];

/**
 * @param {object} ctx  { handlers, editor }
 * @returns {Array<{id,label,glyph,group,run,disabled}>}
 */
export function listMenuActions(ctx = {}) {
  const dslId = currentDslId();
  const acts = [];
  const add = (a) => acts.push(mk(a));

  const hasCommits = (state.vcs?.log?.().length ?? 0) > 0;
  add({ id: 'new-doc', label: 'New document', glyph: '+', group: 'document',
        run: () => state.emit('new-document') });
  add({ id: 'rename', label: 'Rename document…', glyph: '✎', group: 'document', run: () => renameDoc() });
  add({ id: 'help', label: 'Help…', glyph: '?', group: 'document', run: () => showDslHelpModal(dslId) });
  for (const a of dslActions(dslId)) {
    add({ id: `dsl:${a.id}`, label: a.label, glyph: a.glyph ?? '·', group: 'document', run: () => a.run(ctx) });
  }
  add({ id: 'blame', label: 'Blame view', glyph: '⌕', group: 'document', disabled: !hasCommits,
        run: () => state.activePanel === PANELS.BLAME ? state.closePanel() : state.openPanel(PANELS.BLAME) });

  const next = state.nextSaveVersion;
  const major = state.nextMajorVersion;
  add({ id: 'save', label: next ? `Save ${next} to device` : 'Save', glyph: '◉', group: 'file', disabled: !state.needsSave,
        run: () => state.emit('save-document') });
  if (major) add({ id: 'save-major', label: `Save as ${major} (new major)`, glyph: '⇈', group: 'file',
        run: () => state.emit('save-major') });
  add({ id: 'history', label: state.data?.savedVersion ? `History — at ${state.data.savedVersion}` : 'History', glyph: '◷', group: 'file',
        run: () => state.emit('mobile-goto-pane', 'history') });
  add({ id: 'open-device', label: 'Open from device…', glyph: '⤒', group: 'file',
        run: () => state.emit('open-from-device') });
  if (state.library) {
    add({ id: 'library', label: 'Documents…', glyph: '‹', group: 'file',
          run: () => state.emit('open-library') });
  }
  if (listDSLs().some(d => (d.extensionSlots?.length ?? 0) > 0)) {
    add({ id: 'extensions', label: 'Extensions…', glyph: '⧉', group: 'file', run: () => showExtensionsModal() });
  }

  let exporters = {};
  try { exporters = getDSL(dslId)?.exporters ?? {}; } catch {}
  for (const [key, exp] of Object.entries(exporters)) {
    add({ id: `export:${key}`, label: `Export ${exp.label ?? key}`, glyph: EXPORT_GLYPHS[key] ?? '↗',
          group: 'export', run: () => exportFormat(dslId, key) });
  }
  add({ id: 'export-app', label: 'Export as app (.html)…', glyph: '⊡', group: 'export',
        run: () => exportApp(ctx.handlers) });

  add({ id: 'archived', label: 'Resolved comments…', glyph: '❝', group: 'more',
        run: () => showArchivedCommentsModal() });
  add({ id: 'settings', label: 'Settings', glyph: '⚙' + TEXT, group: 'more',
        run: () => state.activePanel === PANELS.SETTINGS ? state.closePanel() : state.openPanel(PANELS.SETTINGS) });

  return acts;
}

// ---------------------------------------------------------------------------
// Shared behaviours
// ---------------------------------------------------------------------------

export function renameDoc() {
  const current = state.title || '';
  const next = (window.prompt('Document title:', current) || '').trim();
  if (!next || next === current) return;
  state.update({ data: { ...state.data, title: next } });
}

/** Save with a note from the phone: the composer is the pending node at the top of the history. */
export function composeCommit() {
  state.emit('mobile-goto-pane', 'history');
  const log = document.getElementById('uf-commit-log');
  log?.scrollTo?.({ top: 0, behavior: 'smooth' });
  const msg = log?.querySelector('.clp-msg');
  if (msg) setTimeout(() => msg.focus(), 50);
}

export async function exportFormat(dslId, key) {
  let exp; try { exp = getDSL(dslId)?.exporters?.[key]; } catch {}
  if (!exp) return;
  try {
    const result = await exp.export(state.currentContent);
    if (result instanceof Blob) {
      const name = slug(state.title) + (exp.ext ?? '');
      if (exp.binary) downloadBlob(result, name);
      else downloadFile(await result.text(), name, exp.mime);
    }
    // null → handled elsewhere (e.g. PDF via print dialog)
  } catch (err) {
    window.alert(`Export failed: ${err?.message ?? err}`);
  }
}

export async function exportApp(handlers) {
  try {
    const preview = await handlers?.renderPreview?.() ?? '';
    const data = { ...state.data, ...(state.vcs?.serialize?.() ?? {}) };
    const html = generateQuine(data, preview, state.title);
    downloadFile(html, slug(state.title) + '.html', 'text/html');
  } catch (err) {
    window.alert(`Export failed: ${err?.message ?? err}`);
  }
}

export function slug(s) {
  return (String(s || 'untitled').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled');
}

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
