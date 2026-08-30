/**
 * uDraft — app shell.
 *
 * The uPub shell pattern (see upub/app.js): one editing surface, a thin title
 * bar, bottom sheets for everything else, linear history on `main`.  Reuses
 * unifile's core (VCS, storage) and the SHARED custom line editor
 * (upub/editor.js) with uDraft's own syntax module plugged in.  On top of the
 * uPub baseline:
 *
 *   • the title bar's EYE toggles the rendered blueprint (floor tabs when the
 *     document has several floors, an issue strip for diagnostics, and
 *     click-to-source on every drawn entity via data-doc-from/to);
 *   • the `/` slash menu inserts uDraft statement templates with the first
 *     placeholder pre-selected;
 *   • a context-aware AUTOCOMPLETE popup (a second SlashMenu instance — same
 *     positioning, same keyboard/touch handling) offers statement keywords at
 *     line start, declared room ids after `of` / `/` / `swing`, sides after
 *     `align`/`from`/`on`/`along`/`facing`, and fixture types.
 *
 * All the iOS layout/scroll machinery is inherited verbatim from uPub — see
 * CLAUDE.md "Mobile / iOS" before touching any of it.
 */

/* global UNIFILE_VERSION, UNIFILE_BUILT, UNIFILE_COMMIT, UNIFILE_COMMIT_AT */

import {
  IS_QUINE, captureTemplate, loadEmbeddedData, generateQuine,
  saveToIDB, loadFromIDB, downloadBlob, shareOrDownloadFile,
  requestPersistentStorage, loadUserPrefs, saveUserPrefs,
  saveDraft, loadDraft, clearDraft, markBackedUp, loadBackupMark,
} from '../core/storage.js';
import { VCS } from '../core/vcs.js';
import { shortHash } from '../core/hash.js';
import { UPubEditor } from '../upub/editor.js';
import { SlashMenu } from '../upub/slash-menu.js';
import { renderMarkdown } from '../upub/preview.js';
import * as udSyntax from './syntax.js';
import { parseDocument, formatArea, tokenizeLine, STATEMENT_KEYWORDS, FIXTURES } from '../core/udraft/parse.js';
import { layoutDocument } from '../core/udraft/layout.js';
import { renderFloorSvg, renderExportSvg, renderPrintBody, exportStyles, scopeExtent } from '../core/udraft/svg.js';
import { GUIDE_MD } from './guide-content.js';

const VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';
const BUILT = (typeof UNIFILE_BUILT !== 'undefined') ? UNIFILE_BUILT : 'dev';
const COMMIT = (typeof UNIFILE_COMMIT !== 'undefined') ? UNIFILE_COMMIT : '';
const COMMIT_AT = (typeof UNIFILE_COMMIT_AT !== 'undefined') ? UNIFILE_COMMIT_AT : '';
const DOC_ID = 'udraft';

const SEED = `---
title: Lakeside Cottage
units: imperial
---
# Welcome to uDraft — rooms in, blueprint out.  Tap the eye to see the plan.
# Three floors share one origin, so the same relative placements stack the
# stair shaft (hall → landing → stairwell) exactly on top of itself.

floor 1 "Main Floor"

room living    16' x 13'
room kitchen   11' x 10'   east of living, align north
room dining    11' x 8'    south of kitchen, align west offset 2'
room hall       5' x 9'    south of living, align west
room bath       6' x 9'    east of hall
room porch  outline E 9' S 6' W 9' close   north of living, align west

stairs hall 3' x 9' up, along west

door   living south    3'    at 6" from east, swing in east    # front door
door   living/porch    3'    centered, swing living west
door   living/kitchen  2'8"  at 1' from north, swing kitchen north
door   hall/bath       2'6"  centered, swing bath north
opening living/hall    4'    centered
opening kitchen/dining 5'    centered
window living west     4'    at 2'
window living west     4'    at 8'
window kitchen north   3'    centered
window dining south    4'    centered
window bath east       2'    centered

fixture kitchen sink   30" on north at 2'
fixture kitchen range  30" on north at 6'
fixture kitchen fridge on east at 6"
fixture bath  toilet   on west at 1'
fixture bath  tub      on south

label living "Living Room"
note  porch  "screened"

floor 2 "Second Floor"

room bedroom   16' x 13'                                # over the living room
room landing    5' x 9'    south of bedroom, align west # over the hall
room bath       6' x 9'    east of landing              # over the main bath
room office    11' x 10'   east of bedroom, align north # over the kitchen

stairs landing 3' x 9' down, along west

door   bedroom/landing 2'8"  centered, swing bedroom west
door   landing/bath    2'6"  centered, swing bath north
door   bedroom/office  2'8"  at 1' from north, swing office north
window bedroom west    4'    at 2'
window bedroom west    4'    at 8'
window office north    3'    centered
window bath east       2'    centered

fixture bedroom bed    on west at 3'
fixture bath  toilet   on west at 1'
fixture bath  shower   on south
fixture office table   on north

label bedroom "Primary Bedroom"

floor 0 "Basement"

room rec       16' x 13'                                # under the living room
room stairwell  5' x 9'    south of rec, align west     # under the hall
room utility   10' x 9'    east of stairwell

stairs stairwell 3' x 9' up, along west

opening rec/stairwell    4'    centered
door    stairwell/utility 2'6" centered, swing utility north

fixture utility washer       on south at 1'
fixture utility dryer        on south at 4'
fixture utility water-heater on east

label rec "Rec Room"
note  rec "below grade"
`;

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class UDraftApp {
  async init() {
    this.version = VERSION;
    this.build = BUILT;
    if (IS_QUINE) captureTemplate();

    // ── Load document ──────────────────────────────────────────────────────
    let data = null;
    if (!IS_QUINE) {
      try { data = await loadFromIDB(DOC_ID); } catch { /* fresh */ }
    }
    data = data || loadEmbeddedData();
    this.data = data;
    this.vcs = new VCS(data);
    this.title = data.title || 'Untitled';
    this.content = data.currentContent ?? this.vcs.headContent ?? '';
    if (!this.content && !this.vcs.headHash) {
      this.content = SEED;
      this.title = 'Lakeside Cottage';
    }
    if (IS_QUINE) {
      const draft = loadDraft();
      if (draft && draft.headHash === this.vcs.headHash && draft.content !== this.content) {
        this.content = draft.content;
      }
    }

    this.prefs = loadUserPrefs();
    this._applyTheme(this.prefs.udTheme || 'auto');
    this.activeFloor = 0;
    this.scene = layoutDocument(parseDocument(this.content));

    // ── Shell ──────────────────────────────────────────────────────────────
    this._buildShell();
    this._trackViewportHeight();
    this._lockWindowScroll();

    this.editor = new UPubEditor(document.getElementById('wr-sheet'), {
      syntax: udSyntax,
      onChange: () => this._onEdit(),
      onSlash: (ctx) => this._onSlashCtx(ctx),
      onCaret: () => this._onCaret(),
    });
    this.editor.setValue(this.content);
    this._refreshDirty();
    this._refreshCount();
    this._bindSlashMenu();
    this._bindAutocomplete();
    this._bindEditingChrome();
    this._bindScrollChrome();
    this._guardFocusScroll();

    if (!IS_QUINE && 'serviceWorker' in navigator) {
      this._bindServiceWorker();
      requestPersistentStorage();
    }
    this._autoUpdateCheck();
  }

  // -------------------------------------------------------------------------
  // Self-updating PWA — identical mechanics to uPub (see upub/app.js and
  // CLAUDE.md "PWA update apply" — never reload on a timer mid-install).
  // -------------------------------------------------------------------------

  _bindServiceWorker() {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(console.warn);
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', async () => {
      if (!hadController) { hadController = true; return; }
      if (this._reloading) return;
      this._reloading = true;
      try { await this._persistNow(); } catch { /* best effort */ }
      location.reload();
    });
    const poke = () => navigator.serviceWorker.getRegistration()
      .then(reg => reg?.update()).catch(() => {});
    poke();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poke();
    });
  }

  _autoUpdateCheck() {
    if (IS_QUINE || location.protocol === 'file:') return;
    setTimeout(async () => {
      try {
        const remote = await this._fetchRemoteVersion();
        if (this._isNewer(remote)) {
          this._toast(`v${remote} is available — tap to update`, {
            duration: 10000,
            onTap: () => this._applyUpdate(),
          });
        }
      } catch { /* offline */ }
    }, 2500);
  }

  async _fetchRemoteVersion() {
    const res = await fetch(`../version.json?_=${Date.now()}`, { cache: 'no-store' });
    const info = await res.json();
    return info.latest ?? info.stable ?? info.version;
  }

  _isNewer(remote) {
    return String(remote).localeCompare(String(VERSION), undefined,
      { numeric: true, sensitivity: 'base' }) > 0;
  }

  async _applyUpdate() {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) { location.reload(); return; }
    await reg.update();
    const drive = (sw) => {
      if (!sw) return;
      if (sw.state === 'installed') sw.postMessage('skipWaiting');
      else sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') sw.postMessage('skipWaiting');
      });
    };
    if (reg.waiting) drive(reg.waiting);
    else if (reg.installing) drive(reg.installing);
    else reg.addEventListener('updatefound', () => drive(reg.installing));
  }

  // -------------------------------------------------------------------------
  // Shell
  // -------------------------------------------------------------------------

  _buildShell() {
    const root = document.getElementById('unifile-app');
    root.className = 'wr-app ud-app';
    root.innerHTML = `
      <header id="wr-top">
        <input id="wr-title" type="text" value="${esc(this.title)}" aria-label="Document title"
               autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
        <span id="wr-dirty" title="Uncommitted changes" hidden></span>
        <div id="wr-top-actions">
          <button id="wr-count" title="Plan stats" aria-label="Plan stats"></button>
          <button id="wr-btn-preview" class="wr-icon-btn" title="Blueprint" aria-label="Toggle blueprint">${ICONS.eye}</button>
          <button id="wr-btn-menu" class="wr-icon-btn" title="Menu" aria-label="Menu">${ICONS.dots}</button>
        </div>
      </header>
      <main id="wr-main">
        <div id="wr-scroll"><div id="wr-sheet"></div></div>
        <div id="wr-preview" hidden>
          <div id="ud-ptabs" hidden></div>
          <div id="ud-ctxbar" hidden>
            <button id="ud-ctx-back" aria-label="Back">‹</button>
            <div id="ud-ctx-text"></div>
          </div>
          <div id="ud-issues" hidden></div>
          <div id="ud-plan"></div>
          <div id="ud-edit" hidden>
            <button id="ud-edit-chip"><code></code><span class="ud-edit-pencil">✎</span></button>
            <div id="ud-edit-body" hidden>
              <div id="ud-edit-host"></div>
              <button id="ud-edit-close" aria-label="Done editing">⌄</button>
            </div>
          </div>
          <div id="ud-zoomctl">
            <button data-z="out" title="Zoom out" aria-label="Zoom out">−</button>
            <button data-z="fit" title="Fit" aria-label="Fit to view">⛶</button>
            <button data-z="in" title="Zoom in" aria-label="Zoom in">+</button>
          </div>
        </div>
      </main>
      <div id="wr-overlay" hidden>
        <div id="wr-modal" role="dialog" aria-modal="true"></div>
      </div>`;

    const titleEl = document.getElementById('wr-title');
    titleEl.addEventListener('change', () => {
      this.title = titleEl.value.trim() || 'Untitled';
      document.title = this.title;
      this._persistSoon();
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { titleEl.blur(); this.editor.focus(); }
    });
    document.title = this.title;

    document.getElementById('wr-count').addEventListener('click', () => {
      this._countMode = ((this._countMode || 0) + 1) % 3;
      this._refreshCount();
    });
    document.getElementById('wr-btn-preview').addEventListener('click', () => this.togglePreview());
    document.getElementById('wr-btn-menu').addEventListener('click', () => this._openMenu());
    document.getElementById('wr-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'wr-overlay') this._closeSheet();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeSheet();
    });

    // Blueprint interaction (hierarchical — see _bindPlanNav):
    //   tap a room       → enter the room's context (breadcrumb bar, zoom in)
    //   tap an object    → select it: highlight + its specifics in the bar
    //   tap empty space  → step back out (selection first, then room context)
    //   LONG-PRESS       → jump to the DSL line that defines it (the ‹/›
    //                      button in the bar does the same for the selection)
    document.getElementById('ud-issues').addEventListener('click', (e) => {
      const row = e.target.closest('[data-doc-from]');
      if (row) this._jumpToSource(+row.dataset.docFrom, +row.dataset.docTo);
    });
    document.getElementById('ud-ptabs').addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-floor]');
      if (!tab) return;
      this.activeFloor = +tab.dataset.floor;
      this._view = null;                                  // new floor, fresh fit
      this._ctxRoomId = null;
      this._selFrom = null;
      this._renderPreview();
    });
    this._bindZoom();
    this._bindPlanNav();
  }

  // -------------------------------------------------------------------------
  // Plan navigation — room context, object selection, long-press to source
  // -------------------------------------------------------------------------

  _bindPlanNav() {
    const plan = document.getElementById('ud-plan');
    this._ctxRoomId = null;      // the room the view is "in" (null = floor)
    this._selFrom = null;        // selected entity's data-doc-from (null = none)

    // Navigation is strictly HIERARCHICAL: at floor level everything resolves
    // to a ROOM (tapping a door before entering a room takes you into the
    // room it belongs to); objects become selectable only inside their room.
    plan.addEventListener('click', (e) => {
      if (this._planDragged || this._lpFired) return;
      const g = e.target.closest('[data-ent]');
      if (!g) { this._navUp(); return; }
      if (g.dataset.ent === 'room') { this._tapRoom(g.dataset.roomId); return; }
      if (g.dataset.docFrom != null) this._tapEnt(+g.dataset.docFrom);
    });
    plan.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('ud-ctx-back').addEventListener('click', () => this._navUp());
    document.getElementById('ud-ctx-text').addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]')?.dataset.nav;
      if (nav === 'floor') this._setScope(null, null);
      else if (nav === 'room') this._setScope(this._ctxRoomId, null);
    });
    this._bindScopeEdit();
  }

  _ctxRoom() {
    if (!this._ctxRoomId) return null;
    return this.scene.floors[this.activeFloor]?.rooms.find(r => r.id === this._ctxRoomId) ?? null;
  }

  /** The record the current scope points at (selected entity, else the room). */
  _scopeRec() {
    if (this._selFrom != null) return this._entIndex?.get(this._selFrom) ?? null;
    return this._ctxRoom();
  }

  /** The scope descriptor the renderer/extent helpers understand. */
  _scope() {
    if (this._selFrom != null) return { entFrom: this._selFrom };
    if (this._ctxRoomId) return { roomId: this._ctxRoomId };
    return null;
  }

  /** Which room an entity belongs to (a door reads as its `into` room). */
  _roomOfRec(rec) {
    if (!rec) return null;
    return rec.roomId ?? rec.into ?? rec.rooms?.[0] ?? null;
  }

  _tapRoom(id) {
    if (this._ctxRoomId === id && this._selFrom == null) return;
    this._setScope(id, null);
  }

  _tapEnt(from) {
    const rec = this._entIndex?.get(from);
    if (!rec) return;                                     // auto dims etc.
    const inCtx = this._ctxRoomId
      && (rec.roomId === this._ctxRoomId || rec.rooms?.includes(this._ctxRoomId));
    if (!inCtx) {
      const owner = this._roomOfRec(rec);
      if (owner) this._setScope(owner, null);             // hierarchy: room first
      return;
    }
    this._setScope(this._ctxRoomId, this._selFrom === from ? null : from);
  }

  /** Step up one level: object → room → floor. */
  _navUp() {
    if (this._selFrom != null) this._setScope(this._ctxRoomId, null);
    else if (this._ctxRoomId) this._setScope(null, null);
  }

  /**
   * The one scope setter: floor (null,null) → room (id,null) → object
   * (id,from).  Re-renders the plan so the scope's live dimension
   * annotations draw onto the blueprint, then animates the view extents
   * to the scope.
   */
  _setScope(roomId, from) {
    this._ctxRoomId = roomId;
    this._selFrom = from;
    this._renderPreview();
    this._zoomToScope();
  }

  _zoomToScope() {
    const svg = document.querySelector('#ud-plan svg');
    if (!svg || !svg._udBase) return;
    const scope = this._scope();
    const floor = this.scene.floors[this.activeFloor];
    if (scope?.entFrom != null && floor) {
      // Object scope: frame the object + its annotations (inside the
      // isolated room render).
      const ext = scopeExtent(floor, scope);
      if (ext) {
        const m = this.scene.meta.wallExt / 1000 + 700;
        this._animateView(svg, [
          ext.x / 1000 - m, ext.y / 1000 - m,
          ext.w / 1000 + 2 * m, ext.h / 1000 + 2 * m,
        ]);
        return;
      }
    }
    // Floor fit, or room isolation: the freshly rendered viewBox IS the frame
    // (the isolation render's own bounds cover the room, its outside dims and
    // the neighbour arrows).
    this._animateView(svg, svg._udBase.slice(), () => {
      this._view = null;
      svg.setAttribute('viewBox', svg._udBase.join(' '));
    });
  }

  /** Sync selection/context classes + the context bar + the scope editor. */
  _applyPlanState() {
    const svg = document.querySelector('#ud-plan svg');
    if (svg) {
      for (const el of svg.querySelectorAll('.ud-selected')) el.classList.remove('ud-selected');
      for (const el of svg.querySelectorAll('.ud-ctx')) el.classList.remove('ud-ctx');
      if (this._ctxRoomId) {
        // Both room layers (interior hit path + label group) carry the id.
        for (const el of svg.querySelectorAll(`[data-room-id="${CSS.escape(this._ctxRoomId)}"]`)) {
          el.classList.add('ud-ctx');
        }
      }
      if (this._selFrom != null) {
        svg.querySelector(`[data-ent][data-doc-from="${this._selFrom}"]`)
          ?.classList.add('ud-selected');
      }
    }
    this._updateCtxBar();
    this._updateEditPanel();
  }

  /**
   * The top bar is BREADCRUMBS ONLY — dimensions and specifics are drawn on
   * the plan itself, not written up here.  Every level above the current one
   * is a button back up.
   */
  _updateCtxBar() {
    const bar = document.getElementById('ud-ctxbar');
    const room = this._ctxRoom();
    const sel = this._selFrom != null ? this._entIndex?.get(this._selFrom) : null;
    if (!room && !sel) { bar.hidden = true; return; }
    bar.hidden = false;

    const floor = this.scene.floors[this.activeFloor];
    const floorName = floor ? (floor.title || (floor.num != null ? `Floor ${floor.num}` : 'Floor')) : 'Floor';
    const crumbs = [`<button class="ud-crumb-btn" data-nav="floor">${esc(floorName)}</button>`];
    let title;
    if (sel) {
      if (room) crumbs.push(`<button class="ud-crumb-btn" data-nav="room">${esc(room.label.toUpperCase())}</button>`);
      title = esc((sel.kind === 'fixture' ? sel.type : sel.kind).toUpperCase());
    } else {
      title = esc(room.label.toUpperCase());
    }
    const sep = '<span class="ud-crumb-sep">›</span>';
    document.getElementById('ud-ctx-text').innerHTML =
      `<span class="ud-crumbs">${crumbs.join(sep)}${sep}<b>${title}</b></span>`;
  }

  // -------------------------------------------------------------------------
  // Scope editor — a second instance of the shared line editor at the bottom
  // of the preview, syntax-highlighted, MULTI-LINE, editing exactly the
  // statements that make up the current scope:
  //   • object scope → its one statement;
  //   • room scope   → the `room` line plus every statement that references
  //     the room (openings, fixtures, stairs, label/note/dim).
  // The pane's rows are anchored to their doc line indexes; every keystroke
  // reconciles the pane back into the main document row-by-row (a prefix/
  // suffix diff handles Enter/joins/paste), so scattered source lines edit
  // in place without being reordered.  Long-press on the plan opens this.
  // -------------------------------------------------------------------------

  _bindScopeEdit() {
    this._editOpen = false;
    this._paneAnchors = [];       // doc line index per pane row
    this._paneLines = [];         // what the pane last reflected
    this._paneSyncing = false;
    this.scopeEditor = new UPubEditor(document.getElementById('ud-edit-host'), {
      syntax: udSyntax,
      onChange: () => this._paneChanged(),
    });
    document.getElementById('ud-edit-chip').addEventListener('click', () => this._openScopeEditor());
    document.getElementById('ud-edit-close').addEventListener('click', () => this._closeScopeEditor());
    this.scopeEditor.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this._closeScopeEditor(); }
    });
  }

  _openScopeEditor() {
    if (!this._scopeRec()) return;
    this._editOpen = true;
    this._populatePane();
    this._updateEditPanel();
    this.scopeEditor.focus();
  }

  _closeScopeEditor() {
    this._editOpen = false;
    this.scopeEditor.root.blur();
    this._updateEditPanel();
    // Revalidate scope that was pinned while typing.
    this._renderPreview();
  }

  /** The doc line indexes that make up the current scope. */
  _paneStatements() {
    const floor = this.scene.floors[this.activeFloor];
    if (!floor) return [];
    if (this._selFrom != null) {
      const rec = this._entIndex?.get(this._selFrom);
      return rec ? [rec.line] : [];
    }
    const room = this._ctxRoom();
    if (!room) return [];
    const lines = new Set([room.line]);
    if (room.labelStmt) lines.add(room.labelStmt.line);
    for (const o of floor.openings) if (o.rooms?.includes(room.id)) lines.add(o.line);
    for (const f of floor.fixtures) if (f.roomId === room.id) lines.add(f.line);
    for (const st of floor.stairs) if (st.roomId === room.id) lines.add(st.line);
    return [...lines].sort((a, b) => a - b);
  }

  _populatePane() {
    const ed = this.editor;
    this._paneAnchors = this._paneStatements();
    this._paneLines = this._paneAnchors.map(i => ed.lines[i] ?? '');
    this._paneSyncing = true;
    this.scopeEditor.setValue(this._paneLines.join('\n'));
    this._paneSyncing = false;
  }

  /** Reconcile the pane's rows back into the main document. */
  _paneChanged() {
    if (this._paneSyncing || !this._editOpen) return;
    const ed = this.editor;
    const newLines = this.scopeEditor.getValue().split('\n');
    const old = this._paneLines;
    const anchors = this._paneAnchors;
    if (!anchors.length) return;
    // Common prefix / suffix → the changed row window.
    let p = 0;
    while (p < old.length && p < newLines.length && old[p] === newLines[p]) p++;
    let sfx = 0;
    while (sfx < old.length - p && sfx < newLines.length - p
      && old[old.length - 1 - sfx] === newLines[newLines.length - 1 - sfx]) sfx++;
    const oldN = old.length - p - sfx;
    const newMid = newLines.slice(p, newLines.length - sfx);
    ed._pushUndo('type');
    const n = Math.min(oldN, newMid.length);
    for (let i = 0; i < n; i++) ed.lines[anchors[p + i]] = newMid[i];
    if (newMid.length > n) {
      // Rows added (Enter/paste): insert after the last written row — or,
      // for a pure insertion, after the previous pane row.
      const afterDoc = n > 0 ? anchors[p + n - 1] : (p > 0 ? anchors[p - 1] : anchors[0] - 1);
      const extras = newMid.slice(n);
      ed.lines.splice(afterDoc + 1, 0, ...extras);
      for (let i = 0; i < anchors.length; i++) if (anchors[i] > afterDoc) anchors[i] += extras.length;
      anchors.splice(p + n, 0, ...extras.map((_, k) => afterDoc + 1 + k));
    } else if (oldN > n) {
      // Rows removed (join/delete): drop them from the doc too.
      const dead = anchors.slice(p + n, p + oldN).sort((a, b) => b - a);
      anchors.splice(p + n, oldN - n);
      for (const li of dead) {
        ed.lines.splice(li, 1);
        for (let i = 0; i < anchors.length; i++) if (anchors[i] > li) anchors[i]--;
      }
    }
    this._paneLines = newLines.slice();
    ed._render();
    ed.onChange();
  }

  _updateEditPanel() {
    const panel = document.getElementById('ud-edit');
    const chip = document.getElementById('ud-edit-chip');
    const rec = this._scopeRec();
    const editing = this._paneFocused();
    if (!rec && !editing) {
      panel.hidden = true;
      this._editOpen = false;
      return;
    }
    panel.hidden = false;
    chip.hidden = this._editOpen;
    document.getElementById('ud-edit-body').hidden = !this._editOpen;
    if (!this._editOpen && rec) {
      const stmts = this._paneStatements();
      const first = this.editor.lines[stmts[0]] ?? '';
      chip.querySelector('code').textContent =
        stmts.length > 1 ? `${first.trim()}  … +${stmts.length - 1} more` : first;
    } else if (this._editOpen && !editing && rec) {
      // Scope changed while the pane is open but idle → show the new scope.
      this._populatePane();
    }
  }

  _paneFocused() {
    return this.scopeEditor && this.scopeEditor.root.contains(document.activeElement);
  }

  _animateView(svg, target, done) {
    const from = (this._view ?? svg._udBase).slice();
    const t0 = performance.now();
    const MS = 220;
    const token = (this._animToken = {});
    const step = (now) => {
      if (this._animToken !== token) return;              // a gesture took over
      const t = Math.min((now - t0) / MS, 1);
      const e = 1 - Math.pow(1 - t, 3);                   // ease-out cubic
      this._applyView(svg, from.map((v, i) => v + (target[i] - v) * e));
      if (t < 1) requestAnimationFrame(step);
      else done?.();
    };
    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // Blueprint zoom & pan — by REWRITING THE SVG VIEWBOX, not CSS transforms:
  // a CSS-scaled svg is rasterized at its layout size and blurs when zoomed;
  // narrowing the viewBox re-renders the vectors crisp at any depth.
  // Wheel zooms at the cursor, one-finger/pointer drag pans, two fingers
  // pinch, the −/⛶/+ buttons cover discoverability (⛶ = back to fit).
  // `this._view` ([x y w h] or null = fit) survives live re-renders while
  // editing and resets on floor switch.
  // -------------------------------------------------------------------------

  _bindZoom() {
    const plan = document.getElementById('ud-plan');
    this._view = null;
    this._planDragged = false;
    const svgEl = () => plan.querySelector('svg');

    const zoomAt = (cx, cy, f) => {
      const svg = svgEl();
      if (!svg || !svg._udBase) return;
      const b = svg._udBase;
      const v = this._view ?? b.slice();
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = new DOMPoint(cx, cy).matrixTransform(ctm.inverse());
      const w = Math.min(Math.max(v[2] / f, b[2] / 50), b[2] * 2);   // 50× in … 2× out
      const rf = v[2] / w;
      this._applyView(svg, [
        pt.x - (pt.x - v[0]) / rf,
        pt.y - (pt.y - v[1]) / rf,
        w, v[3] / rf,
      ]);
    };
    this._zoomAt = zoomAt;

    plan.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._animToken = null;                             // gesture beats animation
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
    }, { passive: false });

    // Pointer pan + pinch + LONG-PRESS (≈550 ms hold without movement = jump
    // to the pressed entity's DSL line).  setPointerCapture throws for
    // stale/synthetic pointer ids — wrapped, do not remove (see CLAUDE.md
    // piano-roll notes).
    const ptrs = new Map();
    let moved = 0;
    let lpTimer = null;
    const LP_MS = 550;
    const cancelLp = () => { clearTimeout(lpTimer); lpTimer = null; };
    const mid = () => {
      const [a, b] = [...ptrs.values()];
      return b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
        : { x: a.x, y: a.y, d: 0 };
    };
    // NO pointer capture on pointerdown: capturing there retargets the
    // compatibility `click` to the plan div itself, so taps never reach the
    // entity groups (real bug — synthetic-event tests masked it).  Capture
    // only once a drag actually latches, when click targeting no longer
    // matters and the pan must survive leaving the element.
    plan.addEventListener('pointerdown', (e) => {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelLp();
      if (ptrs.size === 1) {
        moved = 0;
        this._lpFired = false;
        const target = e.target;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          if (moved > 8 || ptrs.size !== 1) return;
          // LONG-PRESS = focus the pressed thing and open its EDIT PANE
          // (the scoped, syntax-highlighted editor at the bottom).
          const g = target.closest?.('[data-ent]');
          if (!g) return;
          this._lpFired = true;                           // swallow the tail click
          if (g.dataset.ent === 'room') {
            this._setScope(g.dataset.roomId, null);
          } else if (g.dataset.docFrom != null) {
            const rec = this._entIndex?.get(+g.dataset.docFrom);
            if (!rec) return;
            const owner = this._roomOfRec(rec);
            const inCtx = this._ctxRoomId
              && (rec.roomId === this._ctxRoomId || rec.rooms?.includes(this._ctxRoomId));
            if (inCtx) this._setScope(this._ctxRoomId, +g.dataset.docFrom);
            else if (owner) this._setScope(owner, null);
          } else return;
          this._openScopeEditor();
        }, LP_MS);
      }
    });
    plan.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const before = mid();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = mid();
      moved += Math.hypot(after.x - before.x, after.y - before.y);
      if (moved > 8) cancelLp();
      if (moved <= 2 && ptrs.size === 1) return;          // jitter — not a pan yet
      try { plan.setPointerCapture(e.pointerId); } catch { /* stale id */ }
      this._animToken = null;
      const svg = svgEl();
      if (!svg || !svg._udBase) return;
      if (ptrs.size === 2 && before.d > 0 && after.d > 0) {
        zoomAt(after.x, after.y, after.d / before.d);
      }
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const v = this._view ?? svg._udBase.slice();
      this._applyView(svg, [
        v[0] - (after.x - before.x) / ctm.a,
        v[1] - (after.y - before.y) / ctm.d,
        v[2], v[3],
      ]);
      e.preventDefault();
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      cancelLp();
      if (!ptrs.size && moved > 6) {
        // The click that follows this drag is a pan, not a selection.
        this._planDragged = true;
        setTimeout(() => { this._planDragged = false; }, 0);
      }
    };
    plan.addEventListener('pointerup', up);
    plan.addEventListener('pointercancel', up);

    document.getElementById('ud-zoomctl').addEventListener('click', (e) => {
      const z = e.target.closest('button')?.dataset.z;
      if (!z) return;
      const svg = svgEl();
      if (!svg) return;
      if (z === 'fit') { this._animToken = null; this._view = null; svg.setAttribute('viewBox', svg._udBase.join(' ')); return; }
      const r = plan.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, z === 'in' ? 1.4 : 1 / 1.4);
    });
  }

  _applyView(svg, v) {
    this._view = v;
    svg.setAttribute('viewBox', v.map(n => Math.round(n * 100) / 100).join(' '));
  }

  _jumpToSource(from, to) {
    this.togglePreview(false);
    this.editor.focus();
    this.editor._setSelOffsets(from, to);
    // Bring the line into view (the editor spans the whole scroller).
    requestAnimationFrame(() => {
      const rect = this.editor.caretRect();
      const scroll = document.getElementById('wr-scroll');
      const box = scroll.getBoundingClientRect();
      if (rect && (rect.top < box.top || rect.bottom > box.bottom)) {
        scroll.scrollTop += rect.top - (box.top + box.height * 0.4);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Slash insertion menu — uDraft statement templates.
  // `sel` marks the placeholder (relative offsets into tpl) selected on insert.
  // -------------------------------------------------------------------------

  static SLASH_ITEMS = [
    { id: 'room',    label: 'Room',           hint: "12' x 10'", block: true, keywords: 'rect box space',
      tpl: "room name 12' x 10' east of other", ph: 'name' },
    { id: 'outline', label: 'Room (outline)', hint: 'L-shape',   block: true, keywords: 'irregular walk legs',
      tpl: "room name outline E 12' S 8' W 12' close", ph: 'name' },
    { id: 'door',    label: 'Door',           hint: `2'8"`,      block: true, keywords: 'swing entry',
      tpl: `door a/b 2'8" centered, swing b north`, ph: 'a/b' },
    { id: 'extdoor', label: 'Exterior door',  hint: 'swing in',  block: true, keywords: 'front entry outside',
      tpl: `door room south 3' centered, swing in west`, ph: 'room' },
    { id: 'window',  label: 'Window',         hint: "4'",        block: true, keywords: 'glass light',
      tpl: "window room south 4' centered", ph: 'room' },
    { id: 'opening', label: 'Opening',        hint: 'no leaf',   block: true, keywords: 'archway cased passage',
      tpl: "opening a/b 6' centered", ph: 'a/b' },
    { id: 'stairs',  label: 'Stairs',         hint: 'up/down',   block: true, keywords: 'steps stairway',
      tpl: "stairs room 3' x 9' up, along west", ph: 'room' },
    { id: 'fixture', label: 'Fixture',        hint: 'sink…',     block: true, keywords: 'sink range fridge toilet tub shower appliance',
      tpl: 'fixture room sink on north', ph: 'room' },
    { id: 'label',   label: 'Label',          hint: '"…"',       block: true, keywords: 'name rename title',
      tpl: 'label room "Text"', ph: 'room' },
    { id: 'note',    label: 'Note',           hint: '(…)',       block: true, keywords: 'annotation remark',
      tpl: 'note room "text"', ph: 'room' },
    { id: 'dim',     label: 'Dimension',      hint: '⟵⟶',       block: true, keywords: 'measure size',
      tpl: 'dim room south', ph: 'room' },
    { id: 'floor',   label: 'Floor',          hint: 'storey',    block: true, keywords: 'level storey story',
      tpl: 'floor 2 "Second Floor"', ph: '2' },
    { id: 'fm',      label: 'Front matter',   hint: '---',       block: true, keywords: 'title units scale settings meta',
      tpl: '---\ntitle: Untitled\nunits: imperial\nscale: 1/4in\n---', ph: 'Untitled' },
    { id: 'undo',    label: 'Undo',           keywords: 'revert back' },
    { id: 'redo',    label: 'Redo',           keywords: 'again forward' },
  ];

  _bindSlashMenu() {
    this.slash = new SlashMenu(document.getElementById('wr-main'), {
      items: UDraftApp.SLASH_ITEMS,
      onPick: (item, ctx) => {
        this.editor._applyEdit(ctx.start, ctx.caret, '', ctx.start, ctx.start, 'none');
        if (item.tpl) this._insertSnippet(item.tpl, item.ph);
        else if (item.id === 'undo') this.editor.undo();
        else if (item.id === 'redo') this.editor.redo();
      },
    });
    // Menu keyboard nav runs in the capture phase so it beats the editor's
    // own keydown handling; the autocomplete menu gets first refusal.
    this.editor.root.addEventListener('keydown', (e) => {
      if (this.auto?.isOpen) {
        const ctxStart = this.auto.ctx?.start;
        if (this.auto.handleKey(e)) {
          if (e.key === 'Escape') this._autoDismissed = ctxStart ?? null;
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!this.slash.isOpen) return;
      const ctxStart = this.slash.ctx?.start;
      if (this.slash.handleKey(e)) {
        if (e.key === 'Escape') this._slashDismissed = ctxStart ?? null;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /** Insert `tpl` at the caret, selecting the placeholder `ph` inside it. */
  _insertSnippet(tpl, ph) {
    const sel = this.editor._selOffsets();
    if (!sel) return;
    const phAt = ph ? tpl.indexOf(ph) : -1;
    const s = sel.start + (phAt >= 0 ? phAt : tpl.length);
    const e = sel.start + (phAt >= 0 ? phAt + ph.length : tpl.length);
    this.editor._applyEdit(sel.start, sel.end, tpl, s, e, 'format');
  }

  _onSlashCtx(ctx) {
    if (!this.slash) return;
    if (!ctx) {
      this._slashDismissed = null;
      this.slash.close();
      return;
    }
    this._closeAuto();
    if (this._slashDismissed === ctx.start) { this.slash.close(); return; }
    this.slash.open(ctx, this.editor.caretRect());
  }

  // -------------------------------------------------------------------------
  // Autocomplete — a second SlashMenu fed context-aware candidates.
  // -------------------------------------------------------------------------

  _bindAutocomplete() {
    this.auto = new SlashMenu(document.getElementById('wr-main'), {
      items: [],
      onPick: (item, ctx) => {
        const insert = item.insert ?? item.label;
        this.editor._applyEdit(ctx.start, ctx.caret, insert,
          ctx.start + insert.length, ctx.start + insert.length, 'type');
      },
    });
    this.auto.el.id = 'ud-auto';
  }

  _closeAuto() {
    this._autoDismissed = null;
    this.auto?.close();
  }

  _onCaret() {
    if (!this.auto) return;
    if (this.slash?.isOpen || document.activeElement !== this.editor.root) { this.auto.close(); return; }
    const ctx = this._completionCtx();
    if (!ctx) { this._closeAuto(); return; }
    if (this._autoDismissed === ctx.start) { this.auto.close(); return; }
    this.auto.items = ctx.items;
    this.auto.open(ctx, this.editor.caretRect());
  }

  /**
   * Work out what the word under the caret could complete to.
   * @returns {null | {start,caret,query,atLineStart,items}} start/caret are
   *   absolute offsets of the word (SlashMenu removes/replaces [start,caret)).
   */
  _completionCtx() {
    const ed = this.editor;
    if (ed._composing) return null;
    const sel = ed._selOffsets();
    if (!sel || sel.start !== sel.end) return null;
    const { lineIdx, lineStart, col } = ed._lineAt(sel.start);
    const info = ed.infos[lineIdx];
    if (!info || info.type === 'fm' || info.type === 'fm-fence' || info.type === 'comment') return null;
    const line = ed.lines[lineIdx];
    const before = line.slice(0, col);
    const m = /([a-z][a-z0-9_-]*)$/i.exec(before);
    if (!m) return null;
    const word = m[1];
    const wordStart = col - word.length;
    const beforeWord = before.slice(0, wordStart);
    const toks = tokenizeLine(beforeWord);

    const item = (label, hint, insert) => ({ id: label, label, hint, insert, keywords: '' });
    // Room ids are floor-scoped, so the same "bath" can exist per storey —
    // dedupe for the popup.
    const roomItems = () => [...new Set((this.scene ? this.scene.floors.flatMap(f => f.rooms) : [])
      .map(r => r.id))].map(id => item(id, 'room'));
    const sideItems = () => ['north', 'south', 'east', 'west'].map(s => item(s, 'side'));

    let items = null;
    if (!toks.length) {
      if (!/^\s*$/.test(beforeWord)) return null;
      items = STATEMENT_KEYWORDS.map(k => item(k, 'statement', k + ' '));
    } else {
      const kw = toks[0].t === 'word' ? toks[0].v.toLowerCase() : null;
      const last = toks[toks.length - 1];
      const lw = last.t === 'word' ? last.v.toLowerCase() : null;
      if (last.t === 'slash') items = roomItems();
      else if (lw === 'of') items = roomItems();
      else if (lw === 'swing') items = [...roomItems(), item('in', 'inward'), item('out', 'outward')];
      else if (lw === 'align' || lw === 'from' || lw === 'on' || lw === 'along' || lw === 'facing') items = sideItems();
      else if (kw === 'fixture' && toks.length === 2) items = Object.keys(FIXTURES).map(t => item(t, 'fixture', t + ' '));
      else if (toks.length === 1 && ['door', 'window', 'opening', 'stairs', 'fixture', 'label', 'note', 'dim'].includes(kw)) {
        items = roomItems();
      }
    }
    if (!items || !items.length) return null;
    return {
      start: lineStart + wordStart,
      caret: sel.start,
      query: word,
      atLineStart: true,
      items,
    };
  }

  // -------------------------------------------------------------------------
  // Content lifecycle
  // -------------------------------------------------------------------------

  _onEdit() {
    this.content = this.editor.getValue();
    this.scene = layoutDocument(parseDocument(this.content));
    this._refreshDirty();
    this._refreshCount();
    this._persistSoon();
    if (!document.getElementById('wr-preview').hidden) this._renderPreview();
  }

  get isDirty() { return this.content !== (this.vcs.headContent ?? ''); }

  _refreshDirty() {
    const el = document.getElementById('wr-dirty');
    if (el) el.hidden = !this.isDirty;
  }

  _refreshCount() {
    const el = document.getElementById('wr-count');
    if (!el || !this.scene) return;
    const rooms = this.scene.floors.reduce((n, f) => n + f.rooms.length, 0);
    const area = this.scene.floors.reduce((n, f) => n + f.rooms.reduce((a, r) => a + r.areaUm2, 0), 0);
    const errs = this.scene.issues.filter(i => i.severity === 'error').length;
    const mode = this._countMode || 0;
    el.textContent = mode === 0 ? `${rooms} room${rooms === 1 ? '' : 's'}`
      : mode === 1 ? formatArea(area, this.scene.meta.units)
      : errs ? `${errs} issue${errs === 1 ? '' : 's'}` : 'no issues';
    el.classList.toggle('ud-has-issues', errs > 0);
  }

  _currentData() {
    return {
      ...this.data,
      ...this.vcs.serialize(),
      version: VERSION,
      title: this.title,
      dslType: 'udraft',
      currentContent: this.content,
    };
  }

  _persistSoon() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => this._persistNow(), 400);
  }

  async _persistNow() {
    const data = this._currentData();
    this.data = data;
    if (IS_QUINE) {
      saveDraft(this.content, this.vcs.headHash);
    } else {
      try { await saveToIDB(DOC_ID, data); } catch (e) { console.warn('autosave failed', e); }
    }
  }

  async commit(message) {
    const author = (this.prefs.name || '').trim() || 'anonymous';
    const email = (this.prefs.email || '').trim() || '';
    await this.vcs.commit({ content: this.content, message: message || '', author, email });
    clearDraft();
    this._refreshDirty();
    await this._persistNow();
  }

  setContent(text) {
    this.content = text;
    this.editor.setValue(text);
    this.scene = layoutDocument(parseDocument(text));
    this._refreshDirty();
    this._refreshCount();
    this._persistSoon();
  }

  // -------------------------------------------------------------------------
  // Blueprint preview (the eye)
  // -------------------------------------------------------------------------

  togglePreview(force) {
    const pane = document.getElementById('wr-preview');
    const on = force ?? pane.hidden;
    pane.hidden = !on;
    document.getElementById('unifile-app').toggleAttribute('data-preview', on);
    document.getElementById('wr-btn-preview').classList.toggle('active', on);
    if (on) this._renderPreview();
  }

  _renderPreview() {
    const scene = this.scene;
    const floors = scene.floors;
    if (this.activeFloor >= floors.length) this.activeFloor = 0;

    // Floor tabs (only when there is more than one floor), ordered by floor
    // number when every floor has one — basement (0, -1…) left, upper right.
    const tabs = document.getElementById('ud-ptabs');
    if (floors.length > 1) {
      tabs.hidden = false;
      const order = floors.map((f, i) => i);
      if (floors.every(f => f.num != null)) order.sort((a, b) => floors[a].num - floors[b].num);
      tabs.innerHTML = order.map(i => {
        const f = floors[i];
        const name = f.title || (f.num != null ? `Floor ${f.num}` : `Floor ${i + 1}`);
        return `<button data-floor="${i}" class="${i === this.activeFloor ? 'active' : ''}">${esc(name)}</button>`;
      }).join('');
    } else {
      tabs.hidden = true;
    }

    // Issue strip (tap → source line).
    const strip = document.getElementById('ud-issues');
    if (scene.issues.length) {
      strip.hidden = false;
      strip.innerHTML = scene.issues.slice(0, 20).map(i =>
        `<button class="ud-issue ud-${i.severity}" data-doc-from="${i.from}" data-doc-to="${i.to}">`
        + `<b>${i.line + 1}</b> ${esc(i.message)}</button>`).join('');
    } else {
      strip.hidden = true;
      strip.innerHTML = '';
    }

    const floor = floors[this.activeFloor];
    const plan = document.getElementById('ud-plan');
    if (!floor || !floor.rooms.length) {
      plan.innerHTML = '<p class="ud-empty">Declare a room to start drawing — try <code>room living 16\' x 13\'</code>, or type <code>/</code>.</p>';
      this._ctxRoomId = null;
      this._selFrom = null;
      this._entIndex = new Map();
      this._applyPlanState();
      return;
    }

    // Index the floor's records by their statement offset — the inspector's
    // lookup for a clicked group — and drop context/selection that no longer
    // resolves.  EXCEPT while the scope editor's input is focused: a
    // half-typed statement must not collapse the scope out from under the
    // person typing it (the issue strip already shows what's wrong).
    const idx = new Map();
    for (const r of floor.rooms) idx.set(r.from, { kind: 'room', ...r });
    for (const o of floor.openings) idx.set(o.from, o);
    for (const f of floor.fixtures) idx.set(f.from, { kind: 'fixture', ...f });
    for (const st of floor.stairs) idx.set(st.from, { kind: 'stairs', ...st });
    for (const d of floor.dims) { if (d.from != null) idx.set(d.from, { kind: 'dim', ...d }); }
    this._entIndex = idx;
    const editingScope = this._paneFocused?.();
    if (!editingScope) {
      if (this._ctxRoomId && !floor.rooms.some(r => r.id === this._ctxRoomId)) this._ctxRoomId = null;
      if (this._selFrom != null && !idx.has(this._selFrom)) this._selFrom = null;
    }

    const { svg } = renderFloorSvg(floor, scene.meta, {
      interactive: true,
      scope: this._scope(),
      isolate: this._ctxRoomId ?? undefined,              // room drill-down = isolation
    });
    plan.innerHTML = svg;
    // Live edits re-render the svg out from under the zoom state — remember
    // the rendered (fit) viewBox and re-apply the user's window over it.
    const el = plan.querySelector('svg');
    el._udBase = el.getAttribute('viewBox').split(' ').map(Number);
    if (this._view) el.setAttribute('viewBox', this._view.map(n => Math.round(n * 100) / 100).join(' '));
    this._applyPlanState();
  }

  // -------------------------------------------------------------------------
  // Sheets / toast (same shell furniture as uPub)
  // -------------------------------------------------------------------------

  _openSheet(html, cls = '') {
    const overlay = document.getElementById('wr-overlay');
    const modal = document.getElementById('wr-modal');
    modal.className = cls;
    modal.innerHTML = html;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
    return modal;
  }

  _closeSheet() {
    const overlay = document.getElementById('wr-overlay');
    if (overlay.hidden) return;
    overlay.classList.remove('open');
    overlay.hidden = true;
    document.getElementById('wr-modal').innerHTML = '';
  }

  _toast(msg, { onTap, duration = 2600 } = {}) {
    document.querySelector('.wr-toast')?.remove();
    const el = document.createElement('div');
    el.className = 'wr-toast' + (onTap ? ' wr-toast-action' : '');
    el.textContent = msg;
    if (onTap) {
      el.addEventListener('click', () => {
        el.textContent = 'Updating…';
        onTap();
      });
    }
    document.getElementById('unifile-app').appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, duration);
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  _openMenu() {
    const modal = this._openSheet(`
      <div class="wr-menu">
        <button data-act="preview">Blueprint</button>
        <button data-act="history">History${this.isDirty ? ' <span class="wr-menu-dot"></span>' : ''}</button>
        <button data-act="export">Export…</button>
        <button data-act="import">Import data file…</button>
        <button data-act="new">New document</button>
        <hr>
        <button data-act="guide">Guide</button>
        <button data-act="settings">Settings</button>
        <button data-act="about">About</button>
      </div>`);
    modal.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      this._closeSheet();
      const go = {
        preview: () => this.togglePreview(true),
        history: () => this._openHistory(),
        export: () => this._openExport(),
        import: () => this._importData(),
        new: () => this._newDocument(),
        guide: () => this._openGuide(),
        settings: () => this._openSettings(),
        about: () => this._openAbout(),
      };
      go[act]?.();
    });
  }

  // ── History ───────────────────────────────────────────────────────────────

  _openHistory() {
    const commits = this.vcs.log();
    const backup = loadBackupMark(this._backupScope());
    const fmtDate = (t) => new Date(t).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    const pending = this.isDirty ? `
      <div class="wr-pending">
        <div class="wr-pending-head"><span class="wr-node"></span>Uncommitted changes</div>
        <div class="wr-pending-row">
          <input id="wr-commit-msg" type="text" placeholder="Message (optional)" autocomplete="off">
          <button id="wr-commit-btn" class="wr-primary">Commit</button>
        </div>
      </div>` : '<div class="wr-clean">Everything committed.</div>';

    const list = commits.length ? commits.map(c => `
      <div class="wr-commit" data-hash="${c.hash}">
        <div class="wr-commit-line">
          <span class="wr-commit-msg">${esc(c.message || '(no message)')}</span>
          ${c.tag ? `<span class="wr-tag">${esc(c.tag)}</span>` : ''}
          ${backup && backup.headHash === c.hash ? '<span class="wr-tag wr-exported">exported</span>' : ''}
        </div>
        <div class="wr-commit-meta">${esc(shortHash(c.hash))} · ${esc(c.author || '')} · ${fmtDate(c.timestamp)}</div>
        <button class="wr-restore" data-hash="${c.hash}">Restore</button>
      </div>`).join('') : '<div class="wr-clean">No commits yet.</div>';

    const modal = this._openSheet(`
      <div class="wr-sheet-head">History</div>
      <div class="wr-sheet-body">${pending}<div class="wr-log">${list}</div></div>`, 'tall');

    modal.querySelector('#wr-commit-btn')?.addEventListener('click', async () => {
      const msg = modal.querySelector('#wr-commit-msg').value.trim();
      await this.commit(msg);
      this._closeSheet();
      this._toast('Committed');
    });
    modal.addEventListener('click', (e) => {
      const btn = e.target.closest('.wr-restore');
      if (!btn) return;
      const hash = btn.dataset.hash;
      if (hash === this.vcs.headHash && !this.isDirty) { this._closeSheet(); return; }
      if (!confirm('Restore this version into the editor? Your current text stays in history only if committed.')) return;
      this.setContent(this.vcs.getContentAt(hash));
      this._closeSheet();
      this._toast('Restored — commit to keep it');
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  _slug() {
    return (this.title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'plan';
  }

  _backupScope() { return IS_QUINE ? location.href : DOC_ID; }

  _openExport() {
    const modal = this._openSheet(`
      <div class="wr-sheet-head">Export</div>
      <div class="wr-menu">
        <button data-act="pdf"><b>PDF</b> — printed at true scale (${esc(this.scene.meta.scale)})</button>
        <button data-act="svg">SVG — vector drawing of the current floor</button>
        <button data-act="png">PNG — image of the current floor</button>
        <button data-act="txt">Text (.udraft.txt) — the raw source</button>
        <button data-act="data">Data file (.unifile.json) — text + full history</button>
        ${IS_QUINE ? '<button data-act="quine">Save a copy (.html) — app + document in one file</button>' : ''}
      </div>`);
    modal.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      this._closeSheet();
      try {
        if (act === 'pdf') this._exportPdf();
        if (act === 'svg') await shareOrDownloadFile(renderExportSvg(this.scene, this.activeFloor), this._slug() + '.svg', 'image/svg+xml');
        if (act === 'png') await this._exportPng();
        if (act === 'txt') await shareOrDownloadFile(this.content, this._slug() + '.udraft.txt', 'text/plain');
        if (act === 'data') await this._exportData();
        if (act === 'quine') await this._exportQuine();
      } catch (err) {
        if (err?.name !== 'AbortError') this._toast('Export failed: ' + err.message);
      }
    });
  }

  /** Print window sized so the plan is at true drawing scale (see svg.js). */
  _exportPdf() {
    const win = window.open('', '_blank');
    if (!win) { this._toast('Allow pop-ups to export a PDF'); return; }
    const body = renderPrintBody(this.scene, this.title);
    win.document.write(`<!doctype html><html><head><meta charset="utf-8">`
      + `<title>${esc(this.title)}</title>`
      + `<style>@page{size:letter;margin:0}html,body{margin:0}body{padding:0.5in}</style>`
      + `</head><body>${body}</body></html>`);
    win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* user closed it */ } }, 350);
  }

  async _exportPng() {
    const floor = this.scene.floors[this.activeFloor];
    const { svg, widthMm, heightMm } = renderFloorSvg(floor, this.scene.meta, {
      background: true, styles: exportStyles(this.scene.meta.style),
    });
    const pxW = 2048;
    const pxH = Math.round(pxW * heightMm / widthMm);
    const sized = svg.replace('<svg ', `<svg width="${pxW}" height="${pxH}" `);
    const blob = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = pxW; canvas.height = pxH;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob(resolve, 'image/png');
      };
      img.onerror = () => reject(new Error('could not rasterize the SVG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    });
    await this._shareOrDownloadBlob(blob, this._slug() + '.png');
  }

  async _exportData() {
    const json = JSON.stringify(this._currentData(), null, 2);
    const res = await shareOrDownloadFile(json, this._slug() + '.unifile.json', 'application/json');
    if (res !== 'cancelled' && this.vcs.headHash) {
      markBackedUp(this._backupScope(), this.vcs.headHash);
    }
  }

  async _exportQuine() {
    const floor = this.scene.floors[this.activeFloor];
    const still = floor && floor.rooms.length
      ? renderFloorSvg(floor, this.scene.meta, { styles: exportStyles(this.scene.meta.style), background: true }).svg
      : '';
    const html = generateQuine(this._currentData(), still, this.title);
    await shareOrDownloadFile(html, this._slug() + '.html', 'text/html');
  }

  async _shareOrDownloadBlob(blob, filename) {
    try {
      if (navigator.canShare && typeof File !== 'undefined') {
        const file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    downloadBlob(blob, filename);
  }

  _importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data.branches || !data.commits) throw new Error('not a unifile data file');
        if (!confirm(`Replace the current document with “${data.title || 'Untitled'}” (including its history)?`)) return;
        this.data = data;
        this.vcs = new VCS(data);
        this.title = data.title || 'Untitled';
        document.getElementById('wr-title').value = this.title;
        document.title = this.title;
        this.setContent(data.currentContent ?? this.vcs.headContent ?? '');
        await this._persistNow();
        this._toast('Imported');
      } catch (err) {
        this._toast('Import failed: ' + err.message);
      }
    });
    input.click();
  }

  _newDocument() {
    if (!confirm('Start a new document? The current document and its history will be replaced'
      + (IS_QUINE ? '.' : ' (export a data file first if you want to keep it).'))) return;
    this.data = {
      version: VERSION, title: 'Untitled', dslType: 'udraft',
      currentBranch: 'main', branches: { main: { name: 'main', head: null } },
      commits: {}, comments: {}, password: null,
    };
    this.vcs = new VCS(this.data);
    this.title = 'Untitled';
    document.getElementById('wr-title').value = this.title;
    document.title = this.title;
    this.setContent('');
    this._persistNow();
  }

  // ── Guide / Settings / About ─────────────────────────────────────────────

  _openGuide() {
    this._openSheet(`
      <div class="wr-sheet-head">Guide</div>
      <div class="wr-sheet-body wr-prose">${renderMarkdown(GUIDE_MD)}</div>`, 'tall');
  }

  _openSettings() {
    const modal = this._openSheet(`
      <div class="wr-sheet-head">Settings</div>
      <div class="wr-sheet-body">
        <label class="wr-field">Author name
          <input id="wr-set-name" type="text" value="${esc(this.prefs.name || '')}" autocomplete="name" placeholder="Used for commits & the title block">
        </label>
        <label class="wr-field">Email
          <input id="wr-set-email" type="email" value="${esc(this.prefs.email || '')}" autocomplete="email" placeholder="Optional, for commits">
        </label>
        <label class="wr-field">Theme
          <select id="wr-set-theme">
            <option value="auto">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>`);
    modal.querySelector('#wr-set-theme').value = this.prefs.udTheme || 'auto';
    modal.querySelector('#wr-set-name').addEventListener('change', (e) => {
      this.prefs.name = e.target.value; saveUserPrefs({ name: e.target.value });
    });
    modal.querySelector('#wr-set-email').addEventListener('change', (e) => {
      this.prefs.email = e.target.value; saveUserPrefs({ email: e.target.value });
    });
    modal.querySelector('#wr-set-theme').addEventListener('change', (e) => {
      this.prefs.udTheme = e.target.value;
      saveUserPrefs({ udTheme: e.target.value });
      this._applyTheme(e.target.value);
    });
  }

  _applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-wr-theme', mode);
    else root.removeAttribute('data-wr-theme');
  }

  _openAbout() {
    const canUpdate = !IS_QUINE && location.protocol !== 'file:';
    const modal = this._openSheet(`
      <div class="wr-sheet-head">About</div>
      <div class="wr-sheet-body">
        <p><b>uDraft</b> v${esc(VERSION)}
          <span class="wr-mut">· build ${esc(BUILT)}${COMMIT
            ? ` · ${esc(COMMIT)}${COMMIT_AT ? ` (${esc(COMMIT_AT.slice(0, 16).replace('T', ' '))}Z)` : ''}` : ''}</span></p>
        <p class="wr-mut">${IS_QUINE ? 'Single-file mode — this document and the app live in one .html file.'
          : 'App mode — your document is stored on this device (IndexedDB).'}</p>
        <p class="wr-mut">Fully offline. Nothing leaves your device. <br>unifile.app</p>
        ${canUpdate ? '<button id="wr-update-btn" class="wr-primary">Check for updates</button><div id="wr-update-status" class="wr-mut"></div>' : ''}
      </div>`);
    modal.querySelector('#wr-update-btn')?.addEventListener('click', () => this._checkUpdate(modal));
  }

  async _checkUpdate(modal) {
    const status = modal.querySelector('#wr-update-status');
    const btn = modal.querySelector('#wr-update-btn');
    status.textContent = 'Checking…';
    try {
      const remote = await this._fetchRemoteVersion();
      if (!this._isNewer(remote)) { status.textContent = `Up to date (v${VERSION}).`; return; }
      status.textContent = `v${remote} available.`;
      btn.textContent = 'Update & reload';
      btn.onclick = () => {
        btn.textContent = 'Updating…';
        btn.disabled = true;
        this._applyUpdate();
      };
    } catch {
      status.textContent = 'Could not reach unifile.app (offline?).';
    }
  }

  // -------------------------------------------------------------------------
  // Editing / reading chrome + iOS viewport handling — inherited from uPub
  // verbatim (see upub/app.js for the full rationale of every piece; all of
  // it is load-bearing on device).
  // -------------------------------------------------------------------------

  _bindEditingChrome() {
    document.addEventListener('focusin', () => this._updateEditingChrome());
    document.addEventListener('focusout', () => setTimeout(() => this._updateEditingChrome(), 50));
    this._updateEditingChrome();
  }

  _updateEditingChrome() {
    const focused = document.activeElement === this.editor?.root;
    const kb = window.visualViewport ? !!this._kbOpen : true;
    const editing = !!(focused && kb && window.matchMedia('(pointer: coarse)').matches);
    document.getElementById('unifile-app').toggleAttribute('data-editing', editing);
  }

  _bindScrollChrome() {
    const app = document.getElementById('unifile-app');
    const H = 47;
    let p = 0;
    let lastTop = 0;
    let snapTimer = null;
    const apply = () => {
      app.style.setProperty('--wr-hide', String(p));
      app.toggleAttribute('data-scroll-hidden', p >= 1);
    };
    const snap = () => {
      app.removeAttribute('data-scroll-tracking');
      const target = (lastTop <= H || p < 0.5) ? 0 : 1;
      if (target !== p) { p = target; apply(); }
    };
    const watch = (el) => {
      let last = el.scrollTop;
      el.addEventListener('scroll', () => {
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        const top = Math.min(Math.max(0, el.scrollTop), max);
        const d = top - last;
        last = top;
        if (d === 0) return;
        if (d < 0 && top >= max - 1) return;   // bottom-edge clamp, not the user
        lastTop = top;
        app.setAttribute('data-scroll-tracking', '');
        p = Math.min(Math.max(p + d / H, 0), 1, top / H);
        apply();
        clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, 140);
      }, { passive: true });
    };
    watch(document.getElementById('wr-scroll'));
    watch(document.getElementById('wr-preview'));
  }

  _trackViewportHeight() {
    this._vvBase = {};
    const set = () => {
      const vv = window.visualViewport;
      const h = Math.round(vv?.height ?? window.innerHeight);
      const top = Math.round(vv?.offsetTop ?? 0);
      const root = document.documentElement.style;
      root.setProperty('--app-height', `${h}px`);
      root.setProperty('--app-vv-top', `${top}px`);
      const key = window.innerWidth;
      if (!this._vvBase[key] || h > this._vvBase[key]) this._vvBase[key] = h;
      this._kbOpen = this._vvBase[key] - h > 60;
      this._updateEditingChrome();
    };
    set();
    window.addEventListener('resize', set);
    window.addEventListener('orientationchange', () => { set(); setTimeout(set, 300); });
    window.visualViewport?.addEventListener('resize', set);
    window.visualViewport?.addEventListener('scroll', set);
    window.addEventListener('pageshow', set);
    [50, 200, 500].forEach(ms => setTimeout(set, ms));
  }

  _guardFocusScroll() {
    const scroll = document.getElementById('wr-scroll');
    let tapTop = null;
    let guardUntil = 0;
    let fixing = false;

    scroll.addEventListener('pointerdown', () => {
      tapTop = scroll.scrollTop;
      guardUntil = document.activeElement === this.editor.root ? 0 : Date.now() + 900;
    }, { capture: true, passive: true });
    scroll.addEventListener('touchmove', () => { guardUntil = 0; }, { passive: true });
    scroll.addEventListener('wheel', () => { guardUntil = 0; }, { passive: true });

    const fix = () => {
      if (fixing || Date.now() > guardUntil) return;
      if (document.activeElement !== this.editor.root) return;
      const box = scroll.getBoundingClientRect();
      const rect = this.editor.caretRect();
      if (!rect || !box.height) return;
      const pad = 8;
      if (rect.bottom >= box.top + pad && rect.top <= box.bottom - pad) return;
      fixing = true;
      if (tapTop != null) scroll.scrollTop = tapTop;
      const r2 = this.editor.caretRect();
      if (r2 && (r2.top < box.top + pad || r2.bottom > box.bottom - pad)) {
        scroll.scrollTop += r2.top - (box.top + box.height * 0.6);
      }
      fixing = false;
    };

    scroll.addEventListener('scroll', fix, { passive: true });
    window.visualViewport?.addEventListener('resize', () => setTimeout(fix, 0));
    this.editor.root.addEventListener('focus', () => {
      [0, 60, 160, 350, 650].forEach(ms => setTimeout(fix, ms));
    });
  }

  _lockWindowScroll() {
    const reset = () => {
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      const se = document.scrollingElement;
      if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
    };
    window.addEventListener('scroll', reset, { passive: true });
    window.visualViewport?.addEventListener('scroll', reset);
    window.visualViewport?.addEventListener('resize', reset);
    document.addEventListener('focusout', () => setTimeout(reset, 50));
  }
}
