/**
 * The phone shell's actions — two lists, two homes:
 *
 *   • listMenuActions(ctx)         → the title dropdown (pane-switch.js):
 *     file-level things — Document, File, Export, More (settings).  Never on
 *     the bubble.
 *   • listBubbleActions(ctx, view) → the round action button (action-fab.js),
 *     CONTEXTUAL to the pane that is showing:
 *       editor → text/music verbs: play · one measure per line · piano roll
 *                (ABC), indent · outdent, undo · redo
 *       render → play / pause (ABC) — nothing for other DSLs (bubble hides)
 *       commit → the branches (tap one to switch), New branch…, Commit…
 *                (the bubble itself reads `{⑂} <branch>` in this view)
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

/**
 * The action a fresh install runs on a plain tap of the bubble, per DSL and
 * view.  'menu' = the tap opens the bubble's own grid (the commit view: pick a
 * branch).
 */
export function defaultPrimary(dslId, view = 'editor') {
  if (view === 'commit') return 'menu';
  if (dslId === 'abcjs') return 'play';
  if (view !== 'editor') return 'menu';
  // Mermaid is indentation-shaped (subgraphs, nested nodes) and a soft keyboard
  // has no Tab — so the diagram app's tap is Indent, not Undo.
  return dslId === 'mermaid' ? 'indent' : 'undo';
}

/** Glyphs for the DSL exporters, by exporter key. */
const EXPORT_GLYPHS = { svg: '⬡', pdf: '▤', midi: '♬', png: '▣', epub: '▥', docx: '▤', pptx: '▧' };

const mk = (a) => ({ key: a.label, disabled: false, star: true, ...a });

// ---------------------------------------------------------------------------
// Bubble (contextual)
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx   { handlers, editor }
 * @param {string} view  'editor' | 'render' | 'commit'
 * @returns {Array<{id,label,key,glyph,run,disabled,star}>}
 *   key  — stable sort key (labels like Play/Pause change; the tile shouldn't move)
 *   star — false = can't be made the tap action (branch rows)
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
    if (isAbc) play();
    return acts;
  }

  if (view === 'commit') {
    const vcs = state.vcs;
    const detached = state.isDetached;
    for (const b of vcs?.listBranches?.() ?? []) {
      const cur = b.isCurrent && !detached;
      acts.push(mk({ id: `branch:${b.name}`, label: b.name, key: `0 ${b.name}`, glyph: cur ? '●' : '○',
        star: false, current: cur, run: () => switchBranch(b.name) }));
    }
    acts.push(mk({ id: 'branch-new', label: 'New branch…', key: '1 new', glyph: '⑂', star: false, run: () => newBranch() }));
    acts.push(mk({ id: 'commit', label: 'Commit…', key: '2 commit', glyph: '◉', star: false,
      disabled: !state.isDirty, run: () => composeCommit() }));
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
  add({ id: 'new-doc', label: 'New document…', glyph: '+', group: 'document',
        run: () => showNewDocumentModal(ctx.handlers) });
  add({ id: 'rename', label: 'Rename document…', glyph: '✎', group: 'document', run: () => renameDoc() });
  add({ id: 'help', label: 'Help…', glyph: '?', group: 'document', run: () => showDslHelpModal(dslId) });
  add({ id: 'blame', label: 'Blame view', glyph: '⌕', group: 'document', disabled: !hasCommits,
        run: () => state.activePanel === PANELS.BLAME ? state.closePanel() : state.openPanel(PANELS.BLAME) });

  add({ id: 'save-data', label: 'Save data file…', glyph: '↧', group: 'file',
        run: () => state.emit('save-data-file') });
  add({ id: 'open-data', label: 'Open data file…', glyph: '↥', group: 'file',
        run: () => state.emit('open-data-file') });
  add({ id: 'merge', label: 'Import & merge…', glyph: '⋎', group: 'file',
        run: () => state.activePanel === PANELS.MERGE ? state.closePanel() : state.openPanel(PANELS.MERGE) });
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

  add({ id: 'archived', label: 'Archived comments…', glyph: '❝', group: 'more',
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

/** Commit from the phone: the composer is the pending node at the top of the log. */
export function composeCommit() {
  state.emit('mobile-goto-pane', 'commit');
  const log = document.getElementById('uf-commit-log');
  log?.scrollTo?.({ top: 0, behavior: 'smooth' });
  const msg = log?.querySelector('#clp-msg');
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
