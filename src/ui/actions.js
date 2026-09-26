/**
 * The phone shell's action registry — ONE list, two consumers:
 *
 *   • the title dropdown (pane-switch.js) shows it as a grouped menu, with the
 *     live branch list spliced into the "Branch" group;
 *   • the floating action button (action-fab.js) shows it as an alphabetical
 *     grid on long-press, and runs the chosen PRIMARY action on a plain tap.
 *
 * Every action carries a single UTF-8 TEXT glyph (never an emoji — code points
 * with an emoji presentation get U+FE0E appended so iOS keeps them monochrome)
 * which the button shows in the brand braces: `{▶}`, `{↶}`, `{⚙}` …
 *
 * `ctx` is supplied by app.js: { handlers, editor, openTopMenu() }.
 */

import { state, PANELS } from './state.js';
import { getDSL, listDSLs } from '../dsl/registry.js';
import { generateQuine, downloadFile, downloadBlob } from '../core/storage.js';
import {
  showNewDocumentModal, showDslHelpModal, showExtensionsModal,
} from './topbar.js';
import { showArchivedCommentsModal } from './comments.js';

const TEXT = '︎';   // variation selector-15: force text presentation

// Landscape phone = the only place the piano roll fits (see piano-roll.js).
const _landscapeMql = window.matchMedia(
  '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'
);

export function currentDslId() {
  return state.activeDslId ?? state.data?.dslType ?? 'markdown';
}

/** The action a fresh install runs on a plain tap of the button, per DSL. */
export function defaultPrimary(dslId) {
  return dslId === 'abcjs' ? 'play' : 'undo';
}

/** Glyphs for the DSL exporters, by exporter key. */
const EXPORT_GLYPHS = { svg: '⬡', pdf: '▤', midi: '♬', png: '▣', epub: '▥', docx: '▤', pptx: '▧' };

/**
 * @param {object} ctx  { handlers, editor, openTopMenu }
 * @returns {Array<{id,label,key,glyph,group,run,disabled,menu}>}
 *   key   — stable sort key (labels like Play/Pause change; the tile shouldn't move)
 *   group — 'edit' | 'branch' | 'document' | 'file' | 'export' | 'more'
 *   menu  — false = grid-only (the dropdown lists menu options, not editing verbs)
 */
export function listActions(ctx = {}) {
  const dslId = currentDslId();
  const isAbc = dslId === 'abcjs';
  const editor = ctx.editor;
  const acts = [];
  const add = (a) => acts.push({ key: a.label, menu: true, disabled: false, ...a });

  // ── Editing verbs (grid only) ─────────────────────────────────────────
  if (isAbc) {
    const playing = !!state.abcPlaying;
    add({ id: 'play', label: playing ? 'Pause' : 'Play', key: 'Play / pause',
          glyph: playing ? '⏸' + TEXT : '▶' + TEXT, group: 'edit', menu: false,
          run: () => state.emit('abc-play') });
    add({ id: 'align', label: 'One measure per line', glyph: '⫴', group: 'edit', menu: false,
          run: () => { editor?.alignActiveDsl(); } });
    if (_landscapeMql.matches) {
      add({ id: 'roll', label: state.pianoRollOpen ? 'Close piano roll' : 'Piano roll', key: 'Piano roll',
            glyph: '▦', group: 'edit', menu: false,
            run: () => state.togglePianoRoll() });
    }
  }
  add({ id: 'undo', label: 'Undo', glyph: '↶', group: 'edit', menu: false, run: () => { editor?.undo(); } });
  add({ id: 'redo', label: 'Redo', glyph: '↷', group: 'edit', menu: false, run: () => { editor?.redo(); } });
  add({ id: 'commit', label: 'Commit…', glyph: '◉', group: 'edit', menu: false,
        run: () => state.emit('mobile-goto-pane', 'commit') });

  // ── Branch ────────────────────────────────────────────────────────────
  add({ id: 'branch-switch', label: 'Switch branch…', glyph: '⇄', group: 'branch', menu: false,
        run: () => ctx.openTopMenu?.('branch') });
  add({ id: 'branch-new', label: 'New branch…', glyph: '⑂', group: 'branch', run: () => newBranch() });

  // ── Document ──────────────────────────────────────────────────────────
  const hasCommits = (state.vcs?.log?.().length ?? 0) > 0;
  add({ id: 'new-doc', label: 'New document…', glyph: '+', group: 'document',
        run: () => showNewDocumentModal(ctx.handlers) });
  add({ id: 'rename', label: 'Rename document…', glyph: '✎', group: 'document', run: () => renameDoc() });
  add({ id: 'help', label: 'Help…', key: 'Help', glyph: '?', group: 'document',
        run: () => showDslHelpModal(dslId) });
  add({ id: 'blame', label: 'Blame view', glyph: '⌕', group: 'document', disabled: !hasCommits,
        run: () => state.activePanel === PANELS.BLAME ? state.closePanel() : state.openPanel(PANELS.BLAME) });

  // ── File ──────────────────────────────────────────────────────────────
  add({ id: 'save-data', label: 'Save data file…', glyph: '↧', group: 'file',
        run: () => state.emit('save-data-file') });
  add({ id: 'open-data', label: 'Open data file…', glyph: '↥', group: 'file',
        run: () => state.emit('open-data-file') });
  add({ id: 'merge', label: 'Import & merge…', glyph: '⋎', group: 'file',
        run: () => state.activePanel === PANELS.MERGE ? state.closePanel() : state.openPanel(PANELS.MERGE) });
  if (listDSLs().some(d => (d.extensionSlots?.length ?? 0) > 0)) {
    add({ id: 'extensions', label: 'Extensions…', glyph: '⧉', group: 'file', run: () => showExtensionsModal() });
  }

  // ── Export ────────────────────────────────────────────────────────────
  let exporters = {};
  try { exporters = getDSL(dslId)?.exporters ?? {}; } catch {}
  for (const [key, exp] of Object.entries(exporters)) {
    add({ id: `export:${key}`, label: `Export ${exp.label ?? key}`, glyph: EXPORT_GLYPHS[key] ?? '↗',
          group: 'export', run: () => exportFormat(dslId, key) });
  }
  add({ id: 'export-app', label: 'Export as app (.html)…', glyph: '⊡', group: 'export',
        run: () => exportApp(ctx.handlers) });

  // ── More ──────────────────────────────────────────────────────────────
  add({ id: 'archived', label: 'Archived comments…', glyph: '❝', group: 'more',
        run: () => showArchivedCommentsModal() });
  add({ id: 'settings', label: 'Settings', glyph: '⚙' + TEXT, group: 'more',
        run: () => state.activePanel === PANELS.SETTINGS ? state.closePanel() : state.openPanel(PANELS.SETTINGS) });

  return acts;
}

export const GROUP_LABELS = {
  edit: 'Edit', branch: 'Branch', document: 'Document', file: 'File', export: 'Export', more: 'More',
};

// ---------------------------------------------------------------------------
// Shared behaviours (moved off the old pane-switch so the grid can run them too)
// ---------------------------------------------------------------------------

export function renameDoc() {
  const current = state.title || '';
  const next = (window.prompt('Document title:', current) || '').trim();
  if (!next || next === current) return;
  state.update({ data: { ...state.data, title: next } });
}

export function switchBranch(name) {
  if (!name || !state.vcs || (name === state.currentBranch && !state.isDetached)) return;
  if (state.isDirty) state.stash = { content: state.currentContent, fromHash: state.headHash };
  const baseContent = state.vcs.switchBranch(name);
  const newHash = state.vcs.headHash;
  let content = baseContent;
  if (state.stash && state.stash.fromHash === newHash) { content = state.stash.content; state.stash = null; }
  state.update({ currentContent: content, isDirty: content !== baseContent });
  state.emit('branch-switch', { name, content });
}

export function newBranch() {
  const name = (window.prompt('New branch name:') || '').trim();
  if (!name) return;
  if (!/^[A-Za-z0-9/_-]+$/.test(name)) { window.alert('Branch name may only contain letters, numbers, /, _ and -'); return; }
  try { state.vcs.createBranch(name, state.headHash); }
  catch (err) { window.alert(err?.message || 'Could not create branch.'); return; }
  state.update({ data: { ...state.data, ...state.vcs.serialize() } });
  switchBranch(name);
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
