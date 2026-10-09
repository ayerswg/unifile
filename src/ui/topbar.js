/**
 * Desktop top bar
 *
 *   [‹ documents]  [menu ▾]  [editable title]          [Save A04 ●][▾]
 *
 *   - ‹ toggles the document list (the sidebar on the left; see library-pane.js)
 *   - Menu       → file-level verbs (new, save, save as major, open from
 *                  device…), help, blame, export, comments, settings
 *   - Save pill  → appears while the device is behind (changes since the last
 *                  save, or never saved); a click writes the NEXT VERSION to
 *                  the device — `<name>-A04.uni` — and snapshots it into
 *                  history (Ctrl+S; Shift-click = a new major, B00).  The ▾
 *                  half opens the history.
 *   - version pill → the saved version (A03); its dropdown is the history —
 *                  the pending node (note + major switch + Save) while there
 *                  is something to save, then every version: click one to
 *                  open the read-only diff against the working text.
 *
 * There is ONE save — to the device — and ONE linear line of history (no
 * branches, no detached head): each version is a snapshot, a restore brings
 * an old text back as an unsaved change.  The history list is also mounted
 * into the phone's history pane (mountCommitLog).
 */

import { state, PANELS } from './state.js';

/** A DSL's own actions (`dsl.actions: [{ id, label, glyph, run }]`), if any. */
function dslActions(dslId) {
  try { return getDSL(dslId)?.actions ?? []; } catch { return []; }
}
import { shortHash } from '../core/hash.js';
import { nextVersion } from '../core/library.js';
import { showArchivedCommentsModal } from './comments.js';
import { listDSLs, getDSL } from '../dsl/registry.js';
import {
  getExtensionMeta,
  setTextExtension,
  clearExtension,
} from './plugin-extensions.js';

export class TopBar {
  /**
   * @param {HTMLElement} container
   * @param {object} handlers
   */
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._commitOpen = false;
    this._dslMenuOpen = false;
    this._unsub = [];

    this._unsub.push(state.on('change', () => this.render()));
    this._unsub.push(state.on('content-change', () => this._updateDirty()));
    // Refresh the mobile commit-log pane's selected-commit highlight as the diff
    // selection changes (diff-change doesn't emit the generic 'change' event).
    this._unsub.push(state.on('diff-change', () => this._refreshCommitLog()));
    // The device pill + the "on device" marker follow the device-file link.
    this._unsub.push(state.on('device-change', () => this.render()));

    this.render();
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render() {
    const needsSave = state.needsSave;
    const version = state.data?.savedVersion ?? null;
    const next = state.nextSaveVersion;
    const dev = state.deviceFile;
    const saveTitle = next
      ? `Save ${next} to the device${dev?.linked ? ' (into its folder)' : ''} — Ctrl+S · Shift-click = new major version`
      : 'Version limit reached (Z99)';
    const versionTitle = version
      ? `Saved as ${dev?.fileName ?? version}${dev?.savedAt ? ' ' + formatRelative(dev.savedAt) : ''} — history`
      : 'Not saved to the device yet — history';

    this.el.innerHTML = `
      <div class="topbar">
        ${state.library ? `
        <button class="tb-library" id="tb-library" title="Documents (Ctrl+Shift+L)" aria-label="Documents">
          ${iconBack()}
        </button>` : ''}
        <button class="tb-hamburger${this._dslMenuOpen ? ' active' : ''}" id="tb-dsl-menu-toggle"
          title="Menu" aria-label="Menu">
          ${iconHamburger()}
        </button>
        <span
          class="topbar-title"
          contenteditable="true"
          spellcheck="false"
          data-placeholder="Untitled"
          title="Click to edit title"
        >${escHtml(state.title)}</span>

        <div class="topbar-right">
          <div class="vcs-pill-group">
            ${needsSave ? `
              <button class="vcs-pill commit-pill dirty commit-action-pill" id="tb-commit-action"
                title="${escHtml(saveTitle)}">
                <span class="vcs-pill-text">Save${next ? ` <span class="vcs-pill-mono">${escHtml(next)}</span>` : ''}</span>
                <span class="dirty-dot" title="Not saved to the device">●</span>
              </button>
              <button class="vcs-pill commit-pill dirty commit-caret-pill" id="tb-commit-toggle"
                title="History">
                <span class="vcs-pill-caret">▾</span>
              </button>
            ` : `
              <button class="vcs-pill commit-pill saved" id="tb-commit-toggle"
                title="${escHtml(versionTitle)}">
                ${iconCheck()}
                <span class="vcs-pill-text vcs-pill-mono">${escHtml(version ?? '—')}</span>
                <span class="vcs-pill-caret">▾</span>
              </button>
            `}
          </div>
        </div>

      </div>

      <div class="vcs-dropdown dsl-menu-dropdown${this._dslMenuOpen ? ' open' : ''}" id="tb-dsl-menu-dd">
        ${this._renderDslMenuList()}
      </div>
      <div class="vcs-dropdown${this._commitOpen ? ' open' : ''}" id="tb-commit-dd">
        ${this._commitOpen ? this._renderHistory() : ''}
      </div>
    `;

    this._bindEvents();
    this._bindPending(this.el.querySelector('#tb-commit-dd'));
    // Keep the mobile commit-log pane (if mounted) in sync with every re-render
    // — render() fires on state 'change', which covers save/restore/open.
    this._refreshCommitLog();
  }

  /**
   * Mount the commit history into an external container (the mobile far-left
   * pane).  Reuses the same list markup + checkout handler as the topbar
   * dropdown so behaviour stays identical across desktop and mobile.
   */
  mountCommitLog(container) {
    this._commitLogEl = container;
    this._refreshCommitLog();
  }

  _refreshCommitLog() {
    if (!this._commitLogEl) return;
    this._commitLogEl.innerHTML = `<div class="commit-log-pane">${this._renderHistory()}</div>`;
    this._bindPending(this._commitLogEl);
  }

  /** The pending node (while there is something to save) + the version list. */
  _renderHistory() {
    return this._renderPendingNode() + this._renderCommitList();
  }

  /**
   * Wire a rendered history (the phone pane or the desktop dropdown): version
   * clicks → the diff, and the pending node's note / major switch / Save.
   * Everything is class-scoped to the container, since both can be mounted
   * at once.
   */
  _bindPending(root) {
    if (!root) return;
    root.querySelectorAll('.dd-commit-item').forEach(item => {
      item.addEventListener('click', () => {
        const hash = item.dataset.hash;
        if (hash) this._onCommitClick(hash);
      });
    });
    const msg = root.querySelector('.clp-msg');
    if (msg) {
      const grow = () => {
        if (!msg.value) { msg.style.height = ''; return; }
        msg.style.height = '0px';
        msg.style.height = Math.min(msg.scrollHeight, 140) + 'px';
      };
      msg.addEventListener('input', grow);
      requestAnimationFrame(grow);
      msg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
          e.preventDefault(); this._savePending(root);
        }
      });
      // Typing a note must not close the desktop dropdown.
      msg.addEventListener('click', (e) => e.stopPropagation());
    }
    const major = root.querySelector('.clp-major');
    const next = root.querySelector('.clp-next');
    if (major && next) {
      major.addEventListener('change', () => {
        next.textContent = nextVersion(state.data?.savedVersion ?? null, { major: major.checked }) ?? '—';
      });
    }
    root.querySelector('.clp-commit')?.addEventListener('click', (e) => { e.stopPropagation(); this._savePending(root); });
    root.querySelector('.commit-log-pending')?.addEventListener('click', (e) => e.stopPropagation());
  }

  /**
   * The pending node shown at the top of the history while the device is
   * behind.  Styled distinctly from real versions (a hollow, dashed node), it
   * carries an optional note, the version the save will write (with a switch
   * to make it a new major) and the Save button — so a save is composed right
   * where it will land.
   */
  _renderPendingNode() {
    if (!state.needsSave) return '';
    const cur = state.data?.savedVersion ?? null;
    const minor = state.nextSaveVersion, major = state.nextMajorVersion;
    const label = !cur ? 'Never saved to the device'
      : state.isDirty ? `Changed since ${escHtml(cur)}` : `${escHtml(cur)} not on the device`;
    return `
      <div class="commit-log-pending" aria-label="Not saved to the device">
        <div class="clp-graph"><span class="clp-node"></span></div>
        <div class="clp-body">
          <div class="clp-label">${label}</div>
          <textarea class="clp-msg" rows="1" autocomplete="off"
            placeholder="Note on this version (optional)"></textarea>
          <div class="clp-row">
            <span class="clp-version">Save as <b class="clp-next">${escHtml(minor ?? '—')}</b></span>
            ${major ? `<label class="clp-major-label" title="Start a new major version (${escHtml(major)})">
              <input type="checkbox" class="clp-major"> major</label>` : ''}
            <button class="clp-commit" type="button"${minor ? '' : ' disabled'}>Save</button>
          </div>
        </div>
      </div>`;
  }

  _savePending(root) {
    if (this._saving || !state.needsSave || !this.handlers?.onSave) return;
    const message = root?.querySelector('.clp-msg')?.value.trim() || '';
    const major   = !!root?.querySelector('.clp-major')?.checked;
    this._saving = true;
    Promise.resolve(this.handlers.onSave({ message, major }))
      .catch(err => console.warn('[history] save failed:', err?.message))
      .finally(() => { this._saving = false; this._refreshCommitLog(); });
  }

  _updateDirty() {
    // Desktop: the save pill structure changes fundamentally when needsSave
    // flips (single button ↔ split button), so that path needs a full re-render.
    const hasSplitBtn = !!this.el.querySelector('#tb-commit-action');
    if (hasSplitBtn !== state.needsSave) {
      this.render();
    }
    // Keep the mobile history pane's pending node in sync as edits land.
    this._refreshCommitLog();
  }

  // ---------------------------------------------------------------------------
  // Dropdown content
  // ---------------------------------------------------------------------------

  _renderDslMenuList() {
    const hasCommits = (state.vcs?.log()?.length ?? 0) > 0;
    const next = state.nextSaveVersion;
    const major = state.nextMajorVersion;
    const activeDslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    const dslName = DSL_HELP[activeDslId]?.name ?? activeDslId;
    return `
      <ul class="tools-menu-list">
        <li class="tools-menu-item" id="tb-new-doc" title="${state.library ? 'A new, empty document in the library' : 'Discard this document and start a new one'}">
          ${iconNewDoc()} New document
        </li>
        ${state.library ? `
        <li class="tools-menu-item" id="tb-library-item" title="The documents of this app (Ctrl+Shift+L)">
          ${iconLibrary()} Documents…
          <kbd>⌃⇧L</kbd>
        </li>` : ''}
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item${state.needsSave && next ? '' : ' disabled'}" id="tb-save"
          title="Write the text to the device as ${escHtml(next ? `<name>-${next}.uni` : '…')} and keep the snapshot in history (Ctrl+S)">
          ${iconCommit()} Save${next ? ` <span class="tools-menu-ver">${escHtml(next)}</span>` : ''}
          <kbd>⌃S</kbd>
        </li>
        <li class="tools-menu-item${major ? '' : ' disabled'}" id="tb-save-major"
          title="Start a new major version: the next save is ${escHtml(major ?? '—')} (Ctrl+Shift+S)">
          ${iconCommit()} Save as new major${major ? ` <span class="tools-menu-ver">${escHtml(major)}</span>` : ''}
          <kbd>⌃⇧S</kbd>
        </li>
        <li class="tools-menu-item" id="tb-open-device" title="Open a <name>-<version>.uni from the device (Ctrl+Shift+O)">
          ${iconImport()} Open from device…
          <kbd>⌃⇧O</kbd>
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-dsl-help" title="Syntax reference for ${escHtml(dslName)}">
          ${iconHelp()} ${escHtml(dslName)} help…
        </li>
        ${dslActions(activeDslId).map(a => `
        <li class="tools-menu-item tb-dsl-action" data-action="${escHtml(a.id)}" title="${escHtml(a.label)}">
          <span class="tools-menu-glyph">${escHtml(a.glyph ?? '·')}</span> ${escHtml(a.label)}
        </li>`).join('')}
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item${hasCommits ? '' : ' disabled'}" id="tb-blame"
          title="${hasCommits ? 'Blame view (Ctrl+Shift+B)' : 'Available after the first save'}">
          ${iconBlame()} Blame view
          <kbd>⌃⇧B</kbd>
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-export" title="Export document (Ctrl+Shift+E)">
          ${iconExport()} Export…
          <kbd>⌃⇧E</kbd>
        </li>
        ${listDSLs().some(d => (d.extensionSlots?.length ?? 0) > 0) ? `
        <li class="tools-menu-item" id="tb-extensions" title="Configure DSL extensions">
          ${iconPlugin()} Extensions…
        </li>` : ''}
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-comment" title="Comment on the selected text (Ctrl+Alt+M) — or right-click the text">
          ${iconComment()} Comment on selection
          <kbd>⌃⌥M</kbd>
        </li>
        <li class="tools-menu-item" id="tb-archived-comments" title="Browse resolved comment threads">
          ${iconComment()} Resolved comments…
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-settings-item" title="Settings (Ctrl+Shift+,)">
          ${iconGear()} Settings
          <kbd>⌃⇧,</kbd>
        </li>
      </ul>
    `;
  }

  _renderCommitList() {
    const vcs = state.vcs;
    if (!vcs) return '<p class="dd-empty">No saves yet.</p>';

    const log = vcs.log();
    const currentHash = state.headHash;

    // Device marker: the version the device file carries (the last save) —
    // changed-since shows on the pending node above.
    const dev = state.deviceFile;
    const exportedHash = dev?.savedHead ?? null;
    const exportedWhen = dev?.savedAt ? formatRelative(dev.savedAt) : '';

    // While a diff is open, mark the commit currently selected as its RIGHT
    // (source) side so the commit-log pane shows what's being compared/merged.
    const selectedHash = state.diff?.right && state.diff.right !== 'WORKING' ? state.diff.right : null;

    return `
      <div class="dd-section-label">History</div>
      <ul class="dd-commit-list">
        ${log.map(c => `
          <li class="dd-commit-item${c.hash === currentHash ? ' current' : ''}${c.hash === exportedHash ? ' exported' : ''}${c.hash === selectedHash ? ' selected' : ''}"
            data-hash="${c.hash}">
            <div class="dd-commit-meta">
              ${c.tag ? `<span class="dd-commit-tag">${escHtml(c.tag)}</span>` : `<span class="dd-commit-hash">${shortHash(c.hash)}</span>`}
              ${c.hash === exportedHash
                ? `<span class="dd-commit-exported" title="On the device${dev?.fileName ? ' as ' + escHtml(dev.fileName) : ''}${exportedWhen ? ' (' + escHtml(exportedWhen) + ')' : ''}${dev?.saved ? '' : ' — changed since'}">${_iconExported()} on device</span>`
                : ''}
              <span class="dd-commit-date">${formatRelative(c.timestamp)}</span>
            </div>
            <div class="dd-commit-msg">${c.message ? escHtml(c.message) : '<span class="dd-commit-nomsg">(no message)</span>'}</div>
            <div class="dd-commit-author">${escHtml(c.author)}</div>
          </li>
        `).join('')}
        ${log.length === 0 ? '<li class="dd-empty">No saves yet.</li>' : ''}
      </ul>
    `;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  _bindEvents() {
    // Title editing
    const titleEl = this.el.querySelector('.topbar-title');
    if (titleEl) {
      titleEl.addEventListener('blur', () => {
        const newTitle = titleEl.textContent.trim() || 'Untitled';
        if (newTitle !== state.title) {
          state.update({ data: { ...state.data, title: newTitle } });
        }
      });
      titleEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
      });
    }

    // Save — the primary part of the split pill while the device is behind:
    // the next version to the device (Shift-click = a new major version).
    const commitActionBtn = this.el.querySelector('#tb-commit-action');
    if (commitActionBtn) {
      commitActionBtn.addEventListener('click', (e) => {
        state.emit(e.shiftKey ? 'save-major' : 'save-document');
      });
    }
    // The document list (a collapsible sidebar on desktop)
    this.el.querySelector('#tb-library')?.addEventListener('click', () => {
      const open = document.getElementById('unifile-app')?.hasAttribute('data-library');
      state.emit(open ? 'close-library' : 'open-library');
    });

    // DSL menu toggle (far-left icon button)
    const dslMenuBtn = this.el.querySelector('#tb-dsl-menu-toggle');
    if (dslMenuBtn) {
      dslMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._dslMenuOpen = !this._dslMenuOpen;
        if (this._dslMenuOpen) this._commitOpen = false;
        this._syncDropdowns();
      });
    }

    // Commit pill toggle (caret / history dropdown)
    const commitPillBtn = this.el.querySelector('#tb-commit-toggle');
    if (commitPillBtn) {
      commitPillBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._commitOpen = !this._commitOpen;
        if (this._commitOpen) this._dslMenuOpen = false;
        this._syncDropdowns();
      });
    }

    // Close all dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!this.el.contains(e.target)) {
        this._commitOpen = false;
        this._dslMenuOpen = false;
        this._syncDropdowns();
      }
    });

    this._bindDropdownEvents();
  }

  _syncDropdowns() {
    // DSL menu dropdown
    const dslMenuDd = this.el.querySelector('#tb-dsl-menu-dd');
    if (dslMenuDd) {
      dslMenuDd.classList.toggle('open', this._dslMenuOpen);
      if (this._dslMenuOpen) dslMenuDd.innerHTML = this._renderDslMenuList();
    }
    // History dropdown (the pending node + every version)
    const commitDd = this.el.querySelector('#tb-commit-dd');
    if (commitDd) {
      commitDd.classList.toggle('open', this._commitOpen);
      if (this._commitOpen) { commitDd.innerHTML = this._renderHistory(); this._bindPending(commitDd); }
    }
    // Sync the DSL menu button active state
    const dslMenuBtn = this.el.querySelector('#tb-dsl-menu-toggle');
    if (dslMenuBtn) dslMenuBtn.classList.toggle('active', this._dslMenuOpen);

    this._bindDropdownEvents();
  }

  _bindDropdownEvents() {
    const item = (id, fn) => this.el.querySelector(id)?.addEventListener('click', () => {
      if (this.el.querySelector(id)?.classList.contains('disabled')) return;
      this._dslMenuOpen = false;
      this._syncDropdowns();
      fn();
    });
    item('#tb-new-doc',      () => state.emit('new-document'));
    item('#tb-library-item', () => state.emit('open-library'));
    item('#tb-save',         () => state.emit('save-document'));
    item('#tb-save-major',   () => state.emit('save-major'));
    item('#tb-open-device',  () => state.emit('open-from-device'));

    // DSL help modal — uses active section DSL or document default
    this.el.querySelector('#tb-dsl-help')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showDslHelpModal(state.activeDslId ?? state.data?.dslType ?? 'markdown');
    });

    // The DSL's own verbs ({slides}: Insert image…).
    this.el.querySelectorAll('.tb-dsl-action').forEach(li => li.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      const act = dslActions(state.activeDslId ?? state.data?.dslType ?? 'markdown').find(a => a.id === li.dataset.action);
      act?.run(this.handlers ?? {});
    }));

    // DSL menu items
    this.el.querySelector('#tb-blame')?.addEventListener('click', () => {
      if (!this.el.querySelector('#tb-blame')?.classList.contains('disabled')) {
        this._dslMenuOpen = false;
        this._syncDropdowns();
        if (state.activePanel === PANELS.BLAME) state.closePanel();
        else state.openPanel(PANELS.BLAME);
      }
    });
    this.el.querySelector('#tb-export')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.EXPORT) state.closePanel();
      else state.openPanel(PANELS.EXPORT);
    });
    this.el.querySelector('#tb-extensions')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showExtensionsModal();
    });

    this.el.querySelector('#tb-comment')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      state.emit('comment-selection');
    });

    this.el.querySelector('#tb-archived-comments')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showArchivedCommentsModal();
    });

    this.el.querySelector('#tb-settings-item')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.SETTINGS) state.closePanel();
      else state.openPanel(PANELS.SETTINGS);
    });

    // A save in the history list → the read-only diff against the working text
    this.el.querySelectorAll('.dd-commit-item').forEach(li => {
      li.addEventListener('click', () => {
        const hash = li.dataset.hash;
        if (hash) this._onCommitClick(hash);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // History navigation
  // ---------------------------------------------------------------------------

  /**
   * Clicking a save opens the read-only diff (that save vs the working text);
   * the diff bar's "Restore" brings its text back.  Clicking the current save
   * with nothing changed does nothing.
   */
  _onCommitClick(hash) {
    this._commitOpen = false;
    this._syncDropdowns?.();
    if (!hash) return;
    // Already diffing → the clicked save becomes the RIGHT side, keeping the
    // current LEFT selection.
    if (state.diff) { state.openDiff(state.diff.left, hash); return; }
    // Nothing to compare if this commit's content IS the current working state
    // (e.g. clicking the head with no uncommitted changes).
    if (state.vcs?.getContentAt(hash) === state.currentContent) return;
    // Working text = LEFT, the clicked save = RIGHT.
    state.openDiff('WORKING', hash);
  }

}

// ---------------------------------------------------------------------------
// Icon SVGs (inline, no external deps)
// ---------------------------------------------------------------------------

function iconHamburger() {
  return `<svg width="14" height="12" viewBox="0 0 14 12" fill="currentColor" aria-hidden="true">
    <rect x="0" y="0"  width="14" height="2" rx="1"/>
    <rect x="0" y="5"  width="14" height="2" rx="1"/>
    <rect x="0" y="10" width="14" height="2" rx="1"/>
  </svg>`;
}

function iconCommit() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="1" y1="8" x2="5" y2="8" stroke="currentColor" stroke-width="2"/>
    <line x1="11" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2"/>
  </svg>`;
}

function iconExport() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1v9M4 6l4 4 4-4M2 13h12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
  </svg>`;
}

function iconBack() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>`;
}

function iconLibrary() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="4" height="12" rx="1"/><rect x="7" y="2" width="4" height="12" rx="1"/><path d="M12 3l2.5 10.5"/></svg>`;
}

function iconCheck() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;
}

function iconGear() {
  return `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
    <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
  </svg>`;
}

function iconEllipsis() {
  return `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3" cy="8" r="1.5"/>
    <circle cx="8" cy="8" r="1.5"/>
    <circle cx="13" cy="8" r="1.5"/>
  </svg>`;
}

function iconBlame() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="14" height="2" rx="1"/>
    <rect x="1" y="7" width="9" height="2" rx="1"/>
    <rect x="1" y="12" width="11" height="2" rx="1"/>
    <circle cx="13.5" cy="8" r="2.5" fill="var(--accent)"/>
  </svg>`;
}

function iconImport() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1v9M4 6l4 4 4-4M2 13h12" stroke="currentColor" stroke-width="2"
      fill="none" stroke-linecap="round" transform="scale(1,-1) translate(0,-16)"/>
  </svg>`;
}

function iconPlugin() {
  // Box with down-arrow: "install / bring in a module"
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.5 10a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 0 0 1h2A1.5 1.5 0 0 0 14 9.5v-8A1.5 1.5 0 0 0 12.5 0h-9A1.5 1.5 0 0 0 2 1.5v8A1.5 1.5 0 0 0 3.5 11h2a.5.5 0 0 0 0-1h-2z"/>
    <path d="M7.646 15.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 14.293V5.5a.5.5 0 0 0-1 0v8.793l-2.146-2.147a.5.5 0 0 0-.708.708l3 3z"/>
  </svg>`;
}

function iconComment() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1h12zm-2 2H4a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0 2H4a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0 2H4a.5.5 0 0 0 0 1h5a.5.5 0 0 0 0-1H4z"/>
  </svg>`;
}

function iconHelp() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
    <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/>
  </svg>`;
}

function iconNewDoc() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M9 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9 1zm0 1.414L12.086 5.5H9.5A.5.5 0 0 1 9 5V2.414zM4 2h4v3a1.5 1.5 0 0 0 1.5 1.5h3v7a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-11A.5.5 0 0 1 4 2z"/>
    <path d="M8 8a.5.5 0 0 1 .5.5V10h1.5a.5.5 0 0 1 0 1H8.5v1.5a.5.5 0 0 1-1 0V11H6a.5.5 0 0 1 0-1h1.5V8.5A.5.5 0 0 1 8 8z"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// DSL help content
// ---------------------------------------------------------------------------

const DSL_HELP = {
  markdown: {
    name: 'Markdown',
    docsUrl: 'https://github.github.com/gfm/',
    docsLabel: 'GFM Specification',
    sections: [
      {
        title: 'Headings',
        content: `<pre><code># Heading 1
## Heading 2
### Heading 3
# Centred heading {.center}</code></pre>
<p class="help-note"><code>{.center}</code>, <code>{.right}</code> or <code>{.left}</code> at the end of a heading or paragraph aligns it — in the preview and in every export.</p>`
      },
      {
        title: 'Emoji',
        content: `<pre><code>Ship it :rocket:   →   Ship it 🚀
Type :sm… and pick from the menu</code></pre>
<p class="help-note">Typing <code>:</code> followed by letters opens an emoji menu (GitHub shortcodes, fully offline). A complete <code>:shortcode:</code> turns into the emoji on the closing colon.</p>`
      },
      {
        title: 'Emphasis',
        content: `<pre><code>**bold**   *italic*   ~~strikethrough~~
***bold italic***   \`inline code\`</code></pre>`
      },
      {
        title: 'Lists',
        content: `<pre><code>- Unordered item
  - Nested item
1. Ordered item
2. Second item
- [ ] Task (unchecked)
- [x] Task (checked)</code></pre>`
      },
      {
        title: 'Links & Images',
        content: `<pre><code>[link text](https://example.com)
![alt text](image.png)
![alt](img.png){width=50% align=center}</code></pre>
<p class="help-note">Image attributes: <code>width</code>, <code>height</code> (px or %), <code>align</code> (left/center/right)</p>`
      },
      {
        title: 'Code Blocks',
        content: `<pre><code>\`\`\`javascript
const x = 42;
console.log(x);
\`\`\`</code></pre>`
      },
      {
        title: 'Tables',
        content: `<pre><code>| Name   | Age |
|--------|----:|
| Alice  |  30 |
| Bob    |  25 |</code></pre>
<p class="help-note">Rows above the <code>|---|</code> line are the header. Alignment: <code>:---</code> left, <code>:---:</code> center, <code>---:</code> right; by default numbers sit right and text left. <strong>Tab / Shift-Tab</strong> move between cells (past the last cell: a new row), <strong>Alt-Shift-F</strong> (⋯ → Align table columns) lines the pipes up, ⋯ → <strong>Insert table</strong> drops in a blank 3×3, and a block copied from a spreadsheet pastes as a table. A table is also a small spreadsheet — see <em>Table formulas</em>.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Formulas',
        content: `<pre><code>| Item   | Qty | Price | Total       |
|--------|----:|------:|------------:|
| Apples |   3 |  1.20 | =B*C        |
| Pears  |   2 |  0.80 | =B*C        |
| Total  |     |       | =SUM(D2:D3) |</code></pre>
<p class="help-note">A cell that starts with <code>=</code> is a formula (Excel's grammar): <code>=B2*C2</code>, <code>=SUM(D2:D9)</code>, <code>=SUM(B:B)</code>, <code>=IF(B2&gt;10, "big", "small")</code>. <strong>A bare column letter means this row</strong> — <code>=B*C</code> on every row, no renumbering. Columns are A, B, C…; rows count from 1 at the first row (the header is row 1, as in Excel; the <code>|---|</code> line is not a row). A table with a formula shows the letters and numbers in the preview; hover a formula in the text for its value. <code>'=</code> (an apostrophe) forces text.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Across Tables',
        content: `<pre><code># Budget
| … |

# Summary
| Spent | =Budget!D4       |
| Avg   | ='Q1 Sales'!B9   |</code></pre>
<p class="help-note">The heading above a table is its name: <code>=Budget!D4</code> reads cell D4 of the table under <em># Budget</em> (quote a name with spaces). Tables with no heading are <code>Sheet1</code>, <code>Sheet2</code>… Results are shown, never written into the text, so a diff is only what you typed.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Functions',
        content: `<pre><code>SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN STDEV
SUMIF COUNTIF AVERAGEIF SUMPRODUCT LARGE SMALL RANK
IF IFERROR AND OR NOT ISBLANK ISNUMBER ISTEXT ISERROR
ROUND ROUNDUP ROUNDDOWN INT TRUNC CEILING FLOOR ABS MOD POWER SQRT
EXP LN LOG LOG10 PI
LEN UPPER LOWER PROPER TRIM LEFT RIGHT MID FIND SEARCH SUBSTITUTE
CONCAT TEXTJOIN REPT TEXT VALUE N
VLOOKUP HLOOKUP INDEX MATCH ROW COLUMN ROWS COLUMNS</code></pre>
<p class="help-note">Type a few letters after <code>=</code> (or Ctrl-Space) for the completion menu with a one-line description of each. Operators: <code>+ - * / ^</code>, <code>&amp;</code> joins text, <code>= &lt;&gt; &lt; &gt; &lt;= &gt;=</code> compare, <code>%</code> is a percentage. Errors read as in Excel — <code>#DIV/0!</code>, <code>#NAME?</code>, <code>#VALUE!</code>, <code>#REF!</code>, <code>#N/A</code>, <code>#CIRC!</code> (circular) — and are underlined in the text.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Merged Cells',
        content: `<pre><code>| Region   | Q1 | Q2 |
|----------|---:|---:|
| North    ||  5 |        North spans TWO columns
| Total    |  8 ||       the 8 spans Q1 and Q2
| ^^       |  1 |  2 |   ^^ merges with the cell above</code></pre>
<p class="help-note"><code>||</code> (nothing between the pipes) extends the cell before it across the next column — <code>| |</code> with a space is an empty cell. <code>^^</code> as a cell's whole content merges it into the cell above. Merges survive into the Word and Excel exports.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Values & Formatting',
        content: `<pre><code>| 1,200 | $3.50 | 12% | TRUE | (5) |     read as 1200 · 3.5 · 0.12 · TRUE · -5
| =TEXT(D4, "#,##0.00") | =ROUND(D4, 1) |
| **bold** | *italic* | \`code\` | a \\| b |</code></pre>
<p class="help-note">A literal cell shows exactly what you typed; its <em>value</em> in a formula is the number it reads as. <code>TEXT(x, "0.00")</code>, <code>"#,##0"</code>, <code>"0%"</code>, <code>"$#,##0.00"</code> format a result; <code>decimals: 2</code> in the front matter rounds every non-integer result for display. Markdown inline formatting works inside a cell; <code>\\|</code> is a literal pipe.</p>`
      },
      {
        group: 'Table formulas',
        title: 'Exports',
        content: `<pre><code>Tables as Excel (.xlsx)   every table a sheet; formulas kept, cells merged
Word (.docx) · HTML · PDF  computed values, merged cells</code></pre>
<p class="help-note">The .xlsx opens in Excel, Numbers, LibreOffice and Google Sheets with live formulas; column formulas (<code>=B*C</code>) are written out per row (<code>=B2*C2</code>).</p>`
      },
      {
        title: 'Blockquotes',
        content: `<pre><code>> This is a blockquote.
> It can span multiple lines.
>
> > Nested blockquote</code></pre>`
      },
      {
        title: 'Front Matter',
        content: `<pre><code>---
title: My Document
subtitle: A subtitle
author: Jane Smith
date: today
---</code></pre>
<p class="help-note"><code>title</code>, <code>subtitle</code>, <code>author</code>, <code>date</code> render as a title block (<code>date: today</code> prints the current date). <code>model</code> / <code>model2</code> pick the coordinate model (flow / grid / spatial / timeline / graph); <code>layout: document</code> previews the paginated pages. Keys autocomplete inside the block.</p>`
      },
      {
        title: 'PDF page setup',
        group: 'Front Matter',
        content: `<pre><code>---
title: Quarterly report
page: a4            # letter · a4 · a5 · legal
margin: 1in         # or 2cm 2.5cm, or 72px 80px
font: serif         # serif · sans · mono · any family
header-left: {title}
header-right: {date}
footer: Page {page} of {total}
page-numbers: off   # on · off · bottom-right …
title-page: true
---</code></pre>
<p class="help-note">The PDF export paginates itself, so the browser adds no URL or date. Header/footer slots (<code>header</code>, <code>header-left</code>, <code>header-right</code>, <code>footer</code>…) take <code>{page}</code> <code>{total}</code> <code>{title}</code> <code>{subtitle}</code> <code>{author}</code> <code>{date}</code>. <code>page-numbers: on</code> centres them in the footer. <code>===</code> on its own line forces a page break.</p>`
      },
      {
        title: 'Page Breaks',
        content: `<pre><code>Content on page 1.

===

Content on page 2.</code></pre>
<p class="help-note"><code>===</code> on its own line forces a page break in the PDF and DOCX exports (and starts a new section in the preview). <code>---</code> is a horizontal rule.</p>`
      }
    ]
  },

  mermaid: {
    name: 'Mermaid',
    docsUrl: 'https://mermaid.js.org/intro/',
    docsLabel: 'Mermaid Docs',
    sections: [
      {
        group: 'Flowcharts',
        title: 'Flowchart',
        content: `<pre><code>flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do thing]
    B -->|No| D[Skip]
    C --> E[End]</code></pre>
<p class="help-note">Directions: <code>TD</code> top-down, <code>LR</code> left-right, <code>BT</code>, <code>RL</code>. Node shapes: <code>[rect]</code> <code>(rounded)</code> <code>{diamond}</code> <code>((circle))</code> <code>[/parallelogram/]</code></p>`
      },
      {
        group: 'Flowcharts',
        title: 'Node shapes @{ }',
        content: `<pre><code>flowchart TD
    A@{ shape: manual-file, label: "File Handling" }
    B@{ shape: manual-input, label: "User Input" }
    C@{ shape: docs, label: "Multiple Documents" }
    D@{ shape: procs, label: "Process Automation" }
    E@{ shape: paper-tape, label: "Paper Records" }
    A --> B --> C --> D --> E</code></pre>
<p class="help-note"><code>id@{ shape: …, label: "…" }</code> picks any of mermaid's ~30 shapes by name: <code>rect</code> <code>rounded</code> <code>stadium</code> <code>subproc</code> <code>cyl</code> <code>circle</code> <code>diamond</code> <code>hex</code> <code>lean-r</code> <code>lean-l</code> <code>trap-t</code> <code>trap-b</code> <code>dbl-circ</code> <code>text</code> <code>notch-rect</code> <code>lin-rect</code> <code>sm-circ</code> <code>fr-circ</code> <code>fork</code> <code>hourglass</code> <code>brace</code> <code>bolt</code> <code>doc</code> <code>docs</code> <code>lin-doc</code> <code>tag-doc</code> <code>delay</code> <code>h-cyl</code> <code>lin-cyl</code> <code>disk</code> <code>das</code> <code>curv-trap</code> <code>div-rect</code> <code>tri</code> <code>flip-tri</code> <code>win-pane</code> <code>f-circ</code> <code>cross-circ</code> <code>notch-pent</code> <code>sl-rect</code> <code>st-rect</code> <code>procs</code> <code>bow-rect</code> <code>tag-rect</code> <code>paper-tape</code> <code>flag</code> <code>odd</code>. Type <code>shape:</code> for the full list with autocomplete.</p>`
      },
      {
        group: 'Flowcharts',
        title: 'Look, layout & theme',
        content: `<pre><code>---
title: Order flow
config:
  look: handDrawn
  layout: elk
  theme: forest
---
flowchart LR
    A[Order] --> B{In stock?}
    B -- yes --> C[Ship]
    B -- no  --> D[Back-order]</code></pre>
<p class="help-note">Mermaid's <code>config:</code> lives in the document's front matter and applies to every diagram: <code>look</code> = <code>classic</code> · <code>handDrawn</code> · <code>neo</code>; <code>layout</code> = <code>elk</code> (default, best with many edges) · <code>dagre</code>; <code>theme</code> = <code>default</code> · <code>dark</code> · <code>forest</code> · <code>neutral</code> · <code>base</code>; plus per-diagram keys such as <code>flowchart: { curve: basis }</code>. A <code>%%{init: {…}}%%</code> directive in the body still works too.</p>`
      },
      {
        title: 'Sequence Diagram',
        content: `<pre><code>sequenceDiagram
    Alice->>Bob: Hello Bob!
    Bob-->>Alice: Hello Alice!
    Alice->>Bob: How are you?
    Note over Alice,Bob: A note</code></pre>`
      },
      {
        title: 'Class Diagram',
        content: `<pre><code>classDiagram
    Animal <|-- Duck
    Animal <|-- Cat
    class Animal {
        +String name
        +makeSound() void
    }
    class Duck {
        +quack() void
    }</code></pre>`
      },
      {
        title: 'State Diagram',
        content: `<pre><code>stateDiagram-v2
    [*] --> Idle
    Idle --> Running : start
    Running --> Idle : stop
    Running --> [*] : finish</code></pre>`
      },
      {
        title: 'Gantt Chart',
        content: `<pre><code>gantt
    title Project Plan
    dateFormat YYYY-MM-DD
    section Design
        Wireframes : 2026-01-01, 7d
        Mockups    : 7d
    section Dev
        Backend    : 2026-01-15, 14d
        Frontend   : 7d</code></pre>`
      },
      {
        title: 'Pie Chart',
        content: `<pre><code>pie title Browser Share
    "Chrome"  : 65.3
    "Safari"  : 19.1
    "Firefox" : 4.0
    "Other"   : 11.6</code></pre>`
      },
      {
        title: 'ER Diagram',
        content: `<pre><code>erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    USER {
        int id PK
        string name
        string email
    }</code></pre>`
      },
      {
        title: 'Git Graph',
        content: `<pre><code>gitGraph
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature</code></pre>`
      },
      {
        title: 'Mindmap',
        content: `<pre><code>mindmap
  root((Central Idea))
    Topic A
      Subtopic 1
      Subtopic 2
    Topic B
      Subtopic 3</code></pre>`
      },
      {
        title: 'Timeline',
        content: `<pre><code>timeline
    title History of unifile
    2026-07 : Dedicated apps
    2026-09 : {slides} : Site plans
    2026-10 : Inline comments</code></pre>`
      },
      {
        title: 'Kanban',
        content: `<pre><code>kanban
  Todo
    [Write the docs]
    [Fix the lint]@{ assigned: 'me', priority: 'High' }
  In progress
    [Ship mermaid 12]
  Done
    [Zoom &amp; pan]</code></pre>`
      },
      {
        title: 'XY Chart',
        content: `<pre><code>xychart-beta
    title "Monthly revenue"
    x-axis [jan, feb, mar, apr]
    y-axis "Revenue (k)" 0 --> 100
    bar  [30, 55, 70, 90]
    line [25, 50, 65, 85]</code></pre>`
      },
      {
        title: 'Architecture',
        content: `<pre><code>architecture-beta
    group api(cloud)[API]
    service db(database)[Database] in api
    service disk(disk)[Storage] in api
    service server(server)[Server] in api
    db:L -- R:server
    disk:T -- B:server</code></pre>
<p class="help-note">Built-in icons: <code>cloud</code> <code>database</code> <code>disk</code> <code>internet</code> <code>server</code>. Other icon sets (<code>logos:…</code>, <code>@{ icon: … }</code>) need an icon pack, which this offline build does not ship.</p>`
      },
      {
        title: 'Packet',
        content: `<pre><code>packet-beta
0-15: "Source Port"
16-31: "Destination Port"
32-63: "Sequence Number"
64-95: "Acknowledgment Number"</code></pre>`
      },
      {
        title: 'Block Diagram',
        content: `<pre><code>block-beta
columns 3
  a["Frontend"] b["API"] c[("DB")]
  a --> b
  b --> c</code></pre>`
      },
      {
        title: 'Sankey',
        content: `<pre><code>sankey-beta
Solar,Electricity,60
Wind,Electricity,40
Electricity,Homes,70
Electricity,Industry,30</code></pre>`
      },
      {
        title: 'Comments',
        content: `<pre><code>%% This is a comment</code></pre>`
      }
    ]
  },

  abcjs: {
    name: 'ABC Notation',
    docsUrl: 'https://abcnotation.com/wiki/abc:standard:v2.1',
    docsLabel: 'ABC Standard v2.1',
    sections: [
      // ── Getting started ──────────────────────────────────────────────────
      {
        group: 'Getting started',
        title: 'Document Structure',
        content: `<pre><code>---              &lt;- front matter (optional, unifile)
title: My Tune
---
X:1              &lt;- tune header starts here
T:My Tune
M:4/4
L:1/8
K:G              &lt;- K: ends the header
GABc d2 e2 |     &lt;- music body</code></pre>
<p class="help-note">A document is an optional <code>---</code> <strong>front matter</strong> block, then the <strong>tune header</strong> (fields like <code>X:</code> <code>T:</code> <code>M:</code>), then the <strong>music body</strong>. <code>K:</code> is required and marks where the header ends and the notes begin.</p>`
      },
      {
        group: 'Getting started',
        title: 'Minimal Example',
        content: `<pre><code>X:1
T:Ode to Joy
M:4/4
L:1/4
Q:100
K:C
E E F G | G F E D | C C D E | E3/2 D/ D2 |</code></pre>`
      },

      // ── Front matter (unifile) ───────────────────────────────────────────
      {
        group: 'Front matter (unifile)',
        title: 'The --- Block',
        content: `<pre><code>---
title: Silence Speaks
author: A. Composer
midi:
  octave: c3
---</code></pre>
<p class="help-note">unifile adds an optional YAML block before <code>X:1</code>. It sets the document <code>title</code> (the tune's <code>T:</code> is derived from it unless you write an explicit <code>T:</code>) and configures playback under <code>midi:</code>. It is unifile-specific — plain <code>.abc</code> files ignore it.</p>`
      },
      {
        group: 'Front matter (unifile)',
        title: 'MIDI: Dynamics & Accents',
        content: `<pre><code>---
midi:
  map:
    ff:     { velocity: 120 }   # sticky level (1-127)
    pp:     { velocity: 40 }
    accent: { velocity: +25 }   # per-note bump (+/-)
    soft:   { velocity: 0.8 }   # scale of default
---</code></pre>
<p class="help-note">Standard ABC dynamics (<code>!ff!</code>…<code>!pp!</code>) already affect velocity. <code>midi.map</code> lets you redefine any marking: an integer is an absolute level, <code>+n</code>/<code>-n</code> is a per-note bump (accents), a decimal scales the default.</p>`
      },
      {
        group: 'Front matter (unifile)',
        title: 'MIDI: Articulations / Keyswitches',
        content: `<pre><code>---
midi:
  octave: c3          # octave that middle C (60) is named
  lead-ms: 20         # fire keyswitch this early
  hold: momentary     # momentary | held
  map:
    pizzicato: { note: C0 }        # keyswitch note
    legato:    { cc: 32, value: 6 }
    arco:      { program: 1 }
---
K:C
!pizzicato! CDEF | !arco! G4 |</code></pre>
<p class="help-note">Route <code>!name!</code> markings to a keyswitch <code>note</code>, a <code>cc</code>, or a <code>program</code> change for external instruments (MIDI-out only). <code>octave</code> matches your sampler's octave numbering (<code>c3</code> = Kontakt). Marks are sticky until changed.</p>`
      },
      {
        group: 'Front matter (unifile)',
        title: 'MIDI: Per-Voice Mix',
        content: `<pre><code>---
midi:
  voices:
    1: { channel: 1, volume: 100, pan: 54 }
    2: { channel: 2, volume: 85,  pan: 74, velocity: 0.9 }
---</code></pre>
<p class="help-note">Per voice (by number): <code>channel</code>, <code>volume</code> (CC7), <code>pan</code> (CC10, 0-127), a velocity <code>scale</code>, and its own <code>map</code>/<code>keyswitches</code> that override the global ones. Applies on the external MIDI path.</p>`
      },

      // ── Tune header ──────────────────────────────────────────────────────
      {
        group: 'Tune header',
        title: 'Header Fields',
        content: `<pre><code>X:1           % Reference number (required, first line)
T:My Song     % Title  (subsequent T: = subtitle)
C:Composer    % Composer
O:Ireland     % Origin
R:reel        % Rhythm
M:4/4         % Meter (time signature)
L:1/8         % Default (unit) note length
Q:1/4=120     % Tempo (quarter = 120 bpm)
K:G           % Key — must be LAST; ends the header</code></pre>
<p class="help-note">Fields are <code>Letter:</code> at the start of a line. Everything from <code>X:</code> down to <code>K:</code> is the header; the body follows <code>K:</code>.</p>`
      },
      {
        group: 'Tune header',
        title: 'Meter (M:)',
        content: `<pre><code>M:4/4      % four-four
M:C        % common time (= 4/4)
M:C|       % cut time  (= 2/2)
M:6/8      % compound
M:3/4      % waltz
M:none     % free / no meter</code></pre>`
      },
      {
        group: 'Tune header',
        title: 'Key & Mode (K:)',
        content: `<pre><code>K:C            % C major
K:Am           % A minor
K:Gm           % G minor
K:D mix        % D mixolydian (dor/phr/lyd/loc…)
K:Eb           % E-flat major
K:C clef=bass  % set clef in the key field
K:none         % no key signature</code></pre>
<p class="help-note">A second <code>K:</code> mid-body (or inline <code>[K:…]</code>) changes key from that point.</p>`
      },

      // ── Notes & rhythm ───────────────────────────────────────────────────
      {
        group: 'Notes & rhythm',
        title: 'Notes & Octaves',
        content: `<pre><code>C D E F G A B    % lower octave (middle C … B)
c d e f g a b    % octave above
C, D,            % comma  = an octave lower
c' d'            % apostrophe = an octave higher
C,, ... c''      % stack for further octaves</code></pre>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Accidentals',
        content: `<pre><code>^C   % sharp
^^C  % double sharp
_E   % flat
__E  % double flat
=F   % natural</code></pre>
<p class="help-note">An accidental lasts to the end of the bar (like standard notation).</p>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Note Lengths',
        content: `<pre><code>A     % the unit length (set by L:)
A2    % twice as long
A/2   % half   (A/ is shorthand for A/2)
A/4   % quarter
A3    % three units
A3/2  % dotted (one-and-a-half units)</code></pre>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Broken Rhythm',
        content: `<pre><code>A&gt;B   % dotted A, halved B   (= A3/2 B/2)
A&lt;B   % halved A, dotted B
A&gt;&gt;B  % double-dotted</code></pre>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Rests',
        content: `<pre><code>z     % rest (same length rules as notes: z2, z/2…)
Z     % whole-bar rest  (Z2 = two bars)
x     % invisible rest</code></pre>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Tuplets',
        content: `<pre><code>(3ABC        % triplet — 3 in the time of 2
(3ABC (3DEF  % two triplets
(5ABCDE      % 5 in the time of 2 (simple meter)
(6ABCDEF     % 6 in the time of 2
(3:2:4 A2Bc  % general: p in time of q, over r notes</code></pre>
<p class="help-note">Shorthand <code>(p</code> fits <em>p</em> notes into the usual time; the full form <code>(p:q:r</code> spells it out (<em>p</em> notes in the time of <em>q</em>, spanning <em>r</em> notes).</p>`
      },
      {
        group: 'Notes & rhythm',
        title: 'Ties, Slurs & Chords',
        content: `<pre><code>A-A      % tie (same pitch, joined into one)
(ABCD)   % slur over a phrase
[CEG]    % chord — notes sounding together
[CEG]2   % chord with a length
[C2E2G2] % lengths inside a chord</code></pre>
<p class="help-note"><strong>Slur vs chord:</strong> <code>(CEG)</code> = three separate slurred notes; <code>[CEG]</code> = one chord.</p>`
      },

      // ── Notation ─────────────────────────────────────────────────────────
      {
        group: 'Notation',
        title: 'Barlines & Repeats',
        content: `<pre><code>|       % barline
||      % double barline
|]      % final (thin-thick) barline
|:      % start repeat
:|      % end repeat
::      % end + start repeat
|1  :|2 % first / second endings</code></pre>`
      },
      {
        group: 'Notation',
        title: 'Grace Notes',
        content: `<pre><code>{g}A     % grace note before A
{gege}B  % multiple grace notes
{/g}A    % acciaccatura (slashed)</code></pre>`
      },
      {
        group: 'Notation',
        title: 'Decorations & Ornaments',
        content: `<pre><code>.A          % staccato (dot)
!trill!A    % trill
!fermata!A  % pause
!turn!A  !mordent!A  !accent!A
!&gt;!A        % accent (shorthand)
HA          % legacy fermata (H = !fermata!)</code></pre>
<p class="help-note">Write the decoration immediately before the note. Many <code>!name!</code> decorations are available; unknown ones are ignored on the score but can still drive playback via <code>midi.map</code>.</p>`
      },
      {
        group: 'Notation',
        title: 'Dynamics',
        content: `<pre><code>!pp!A !p!A !mp!A !mf!A !f!A !ff!A
!crescendo(! ABCD !crescendo)!
!diminuendo(! ABCD !diminuendo)!</code></pre>
<p class="help-note">These affect both the printed marking and playback velocity.</p>`
      },
      {
        group: 'Notation',
        title: 'Chord Symbols & Text',
        content: `<pre><code>"Gm7"A       % chord symbol above the note
"^above"A    % annotation above
"_below"A    % annotation below
"&lt;"A "&gt;"A     % left / right of the note</code></pre>`
      },
      {
        group: 'Notation',
        title: 'Lyrics (w:)',
        content: `<pre><code>K:C
CDEF GABc |
w: Twin-kle twin-kle lit-tle star</code></pre>
<p class="help-note">A <code>w:</code> line under a music line aligns syllables to notes. <code>-</code> splits a word across notes, <code>_</code> holds a syllable, <code>*</code> skips a note.</p>`
      },
      {
        group: 'Notation',
        title: 'Inline Fields & Comments',
        content: `<pre><code>ABC [M:3/4] DEF     % change meter mid-line
GAB [K:D] cde       % change key mid-line
[V:2] C,4           % switch voice inline
% a full-line comment
ABC % end-of-line comment</code></pre>`
      },

      // ── Voices & layout ──────────────────────────────────────────────────
      {
        group: 'Voices & layout',
        title: 'Multiple Voices',
        content: `<pre><code>V:1 clef=treble name="Flute"
V:2 clef=bass   name="Cello"
K:C
[V:1] e2fe d2ed | c2dc B4 |
[V:2] C,4 G,4   | C,8    |</code></pre>
<p class="help-note">Declare voices with <code>V:</code> in the header (id, then options like <code>clef=</code>, <code>name=</code>, <code>transpose=</code>). In the body, prefix lines with <code>[V:id]</code> or a standalone <code>V:id</code> line.</p>`
      },
      {
        group: 'Voices & layout',
        title: 'Grand Staff & Staff Groups',
        content: `<pre><code>%%score {(RH) | (LH)}
V:RH clef=treble
V:LH clef=bass
K:C
[V:RH] E2G2 c2e2 | d2c2 B2A2 |
[V:LH] C,2G,,2 C,2E,2 | G,,2C,2 E,2G,,2 |</code></pre>
<p class="help-note"><code>%%score</code> lays out staves: <code>{ }</code> = piano brace, <code>[ ]</code> = bracket, <code>( )</code> = voices sharing one staff. A <code>|</code> between the groups makes barlines <strong>bridge the staves</strong> (needed for a proper grand staff). Place it before <code>K:</code>.</p>`
      },
      {
        group: 'Voices & layout',
        title: 'Clefs',
        content: `<pre><code>V:1 clef=treble    % treble (G)
V:2 clef=bass      % bass (F)
V:3 clef=alto      % alto (C)
V:4 clef=tenor
clef=treble+8      % octave up   (-8 = down)
clef=none          % no clef / percussion</code></pre>`
      },
      {
        group: 'Voices & layout',
        title: 'Tablature',
        content: `<pre><code>%%tablature instrument=guitar capo=0 label=Tab
%%tablature instrument=mandolin</code></pre>
<p class="help-note">Adds a tab staff under the notes. Instruments: <code>guitar</code>, <code>mandolin</code>, <code>violin</code>, <code>fiddle</code>, <code>fiveString</code>. Put <code>%%tablature</code> directives before <code>K:</code>.</p>`
      },
      {
        group: 'Voices & layout',
        title: 'Formatting Directives',
        content: `<pre><code>%%staffwidth 500
%%scale 1.2
%%stretchlast true
%%titlefont Helvetica 18</code></pre>
<p class="help-note"><code>%%</code> directives tune layout and fonts. They can go in the file header or the tune header.</p>`
      },

      // ── Playback (unifile) ───────────────────────────────────────────────
      {
        group: 'Playback (unifile)',
        title: 'Sound & Transport',
        content: `<p class="help-note">Playback uses a built-in, fully-offline acoustic piano. Use the transport bar (play / scrubber / time) at the bottom on desktop; on phones tap the round action button (hold it for every action, drag it to another corner). Put the cursor in a note to play from there; select a range to play just that range.</p>
<p class="help-note">A custom soundfont URL can be set under <strong>Settings → Extensions</strong> (<code>soundfont-url</code>).</p>`
      },
      {
        group: 'Playback (unifile)',
        title: 'Mute / Solo Voices',
        content: `<p class="help-note"><strong>Right-click</strong> (long-press on Android) any <code>V:</code> line, or any line of that voice, and choose <strong>Mute voice</strong> or <strong>Solo voice</strong>; the piano roll's voice chips have M / S buttons too. Muted voices don't sound or highlight and are dimmed in the editor and score (an <code>M</code> sits in the margin of every line of the voice); Solo isolates a voice (marked <code>S</code>) and mutes the rest. It's a live, per-session setting — not saved with the document.</p>`
      },
      {
        group: 'Playback (unifile)',
        title: 'External MIDI Output',
        content: `<p class="help-note">Under <strong>Settings → Audio output</strong> you can route playback to an external MIDI port (e.g. macOS IAC → a DAW/sampler) instead of the internal piano. This is where <code>midi.map</code> keyswitches, per-voice channels, volume and pan take effect. Web MIDI is Chromium-only.</p>`
      }
    ]
  },

  slides: {
    name: 'Slides',
    docsUrl: 'https://marpit.marp.app/markdown',
    docsLabel: 'Marpit Markdown reference',
    sections: [
      {
        group: 'Deck',
        title: 'Slides',
        content: `<pre><code># First slide

Some text.

---

# Second slide

- a bullet
- another</code></pre>
<p class="help-note"><code>---</code> on its own line starts a new slide (<code>===</code> works too). Plain Markdown inside — headings, lists, emphasis, code, tables, links. A line break in the text is a line break on the slide.</p>`
      },
      {
        group: 'Deck',
        title: 'Front Matter',
        content: `<pre><code>---
title: Quarterly review
theme: gaia
paginate: true
size: 16:9
header: "Acme Inc."
footer: "2026"
---</code></pre>
<p class="help-note">The opening YAML block sets the deck-wide directives. <code>theme</code> is <code>default</code>, <code>gaia</code> or <code>uncover</code> (bundled, offline). <code>size</code> is <code>16:9</code> (1280×720) or <code>4:3</code>. <code>headingDivider: 2</code> starts a slide at every <code>#</code>/<code>##</code> without needing <code>---</code>.</p>`
      },
      {
        group: 'Deck',
        title: 'Per-slide Directives',
        content: `<pre><code>&lt;!-- _class: lead --&gt;
# A title slide

---

&lt;!-- _backgroundColor: #123 --&gt;
&lt;!-- _color: white --&gt;
&lt;!-- _paginate: false --&gt;
# Dark slide</code></pre>
<p class="help-note">An HTML comment with an underscored name applies to that slide only; without the underscore it applies from that slide onward. <code>lead</code> (centred) and <code>invert</code> come with the bundled themes.</p>`
      },
      {
        group: 'Images',
        title: 'Inserting Images',
        content: `<p class="help-note"><strong>Paste or drop an image file</strong> into the editor (desktop), or use <strong>Insert image…</strong> from the ⋯ menu / the phone action bubble (opens the photo library). The image is stored <em>with the document</em> — not as text — and a reference line is inserted:</p>
<pre><code>![photo](photo.jpg)</code></pre>
<p class="help-note">The editor shows a thumbnail under that line. SVG files work too. Large photos are downscaled to 2560 px on the long side. Deleting every reference to an image drops it from the document at the next save.</p>`
      },
      {
        group: 'Images',
        title: 'Sizing & Backgrounds',
        content: `<pre><code>![w:400](photo.jpg)          width 400px
![h:200](logo.svg)           height 200px
![bg](photo.jpg)             full-slide background
![bg left](photo.jpg)        split: image left, text right
![bg right:40%](photo.jpg)   split at 40%
![bg blur grayscale](photo.jpg)
![bg](a.jpg) ![bg](b.jpg)    two backgrounds side by side</code></pre>
<p class="help-note">Marp's image keywords go in the alt text. Filters: <code>blur</code>, <code>brightness</code>, <code>contrast</code>, <code>grayscale</code>, <code>invert</code>, <code>opacity</code>, <code>sepia</code>.</p>`
      },
      {
        group: 'Styling',
        title: 'Custom CSS',
        content: `<pre><code>&lt;style&gt;
section { font-size: 28px; }
h1 { color: #3498db; }
&lt;/style&gt;

&lt;style scoped&gt;
h1 { color: crimson; }   /* this slide only */
&lt;/style&gt;</code></pre>
<p class="help-note">A <code>&lt;style&gt;</code> block tweaks the theme for the whole deck; <code>scoped</code> limits it to the slide it sits in. Raw HTML other than these (and directive comments) is shown as text.</p>`
      },
      {
        group: 'Export',
        title: 'PDF & HTML',
        content: `<p class="help-note"><strong>Export → PDF</strong> opens the print dialog with one slide per page at the deck's own size — choose "Save as PDF". <strong>Export → HTML</strong> writes one self-contained file: the slides stacked for reading, and a click (or <kbd>F</kbd>) starts a full-screen presentation — <kbd>←</kbd> <kbd>→</kbd> to move, <kbd>Esc</kbd> to leave. It prints one slide per page too. Images travel inside both.</p>`
      }
    ]
  },
  spreadsheet: {
    name: 'Spreadsheet',
    docsUrl: 'https://unifile.app/spreadsheet/',
    docsLabel: '{spreadsheet} on unifile.app',
    sections: [
      {
        group: 'The file',
        title: 'Sheets',
        content: `<pre><code>---
name: Budget
header: 1
freeze: cols 1
filter: on
sort: D desc
decimals: 2
---
A1:D1  Item, Qty, Price, Total {bold, bg: #eef}
A2:C2  Apples, 3, 1.20
A3:C3  Pears, 2, 0.80
D2:D3  =B*C {format: $#,##0.00}
A4:C4  Total {merge}
D4     =SUM(D2:D3)</code></pre>
<p class="help-note">A sheet is a YAML block between <code>---</code> fences — the sheet-wide settings — followed by one line per cell or range: <code>&lt;range&gt; &lt;values&gt; {settings}</code>. Another <code>---</code> block starts the next sheet. Addresses are Excel's: <code>B3</code>, <code>A1:D9</code>, <code>A</code> / <code>A:C</code> (whole columns), <code>3</code> / <code>3:5</code> (whole rows). A line starting with <code>#</code> is a remark.</p>
<p class="help-note">Most editing happens in the <strong>grid</strong> (the eye / render pane): type to replace a cell, <kbd>Enter</kbd> / <kbd>Tab</kbd> to move, <kbd>F2</kbd> to edit in place, click a letter or number for a whole column or row, right-click (long-press on a phone) for the menu, drag the small square at the selection's corner to <strong>fill</strong> a series (numbers, dates, <code>Item 1</code>…, formulas with their references moved). Every change rewrites the text — tidily, so a one-cell edit is a one-line diff — and lands in the same undo history as typing. <strong>Import Excel / CSV…</strong> (the ⋯ menu) reads an .xlsx or .csv into this format.</p>`
      },
      {
        group: 'The file',
        title: 'Sheet Settings',
        content: `<pre><code>name: Budget              the sheet's name (Sheet1, Sheet2 … when absent)
header: 1                 header rows: bold, frozen, left out of sort and filter
freeze: rows 1, cols 2    frozen panes beyond the header
filter: on                ▾ buttons on the header
filter: B > 0; A contains "x"   …and active criteria (; between them)
sort: D desc, A asc       a VIEW sort — rows never move in the text
width: 12                 default column width (characters)
height: 28                default row height (px)
decimals: 2               rounding for formula results without a format</code></pre>
<p class="help-note">Any other key is kept with the sheet (<code>owner: Will</code>). <code>sort</code> and <code>filter</code> are a view, like Excel's autofilter: addresses never change. The toolbar's A↓ / Z↓ buttons instead reorder the rows in the text once (a data sort). Header rows are never sorted or filtered.</p>`
      },
      {
        group: 'The file',
        title: 'Values & Formulas',
        content: `<pre><code>A2:D2  Apples, 3, 1.20, =B*C      a row: values fill the range left to right
A3     "line one\\nline two"        \\n inside quotes = a line break (Alt+Enter in the grid)
A2:A9  Apples                     one value fills every cell
D2:D9  =B*C                       one formula fills a column (this row's B × C)
B:B    =A*2                       an open range fills the used rows
A3     "Pears, green"             quote text that holds a comma
A4:C4  Plums, , 2.50              an empty item clears the cell
D10    =SUM(D2:D9)
D11    =IF(D10>100, "big", "small")
B2     =Costs!B2                  another sheet (='Q1 Sales'!A1 with spaces)</code></pre>
<p class="help-note">Numbers (<code>1,200</code> inside quotes, <code>$3.50</code>, <code>12%</code>) read as numbers but show as typed; <code>'=x</code> forces text. Formulas use Excel's grammar: <code>+ - * / ^ &amp;</code>, comparisons, <code>%</code>, <code>$A$1</code>. <strong>A bare column letter is the cell in this row</strong> — the one addition — so one formula serves a whole column and survives sorting and inserted rows. ~70 functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTIF, SUMIF, AVERAGEIF, IF, IFERROR, AND, OR, NOT, ROUND, INT, MOD, ABS, SQRT, POWER, LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM, CONCAT, TEXTJOIN, FIND, SUBSTITUTE, TEXT, VLOOKUP, HLOOKUP, INDEX, MATCH, LARGE, SMALL, MEDIAN, STDEV, RANK, SUMPRODUCT, ROW, COLUMN… Errors are Excel's (<code>#DIV/0!</code>, <code>#NAME?</code>, <code>#REF!</code>, <code>#CIRC!</code>). Later lines win when ranges overlap.</p>`
      },
      {
        group: 'Settings',
        title: 'Sequences',
        content: `<pre><code>A2:A13  {seq: 1}                         1, 2, 3 …
A2:A13  {seq: 100, step: -5}             100, 95, 90 …
B2:B13  {seq: 2026-01-31, step: 1 month} 2026-01-31, 2026-02-28, 2026-03-31 …
C2:C8   {seq: Mon}                       Mon, Tue … Sun, Mon
D2:D13  {seq: Jan}                       Jan … Dec
A:A     {seq: Item 1}                    Item 1, Item 2 … (the used rows)</code></pre>
<p class="help-note">A sequence generates the cells of its range instead of listing them: numbers, ISO dates (step <code>1</code> / <code>7</code> / <code>2 weeks</code> / <code>1 month</code> / <code>1 year</code>), month and weekday names (the start's spelling is kept), or text ending in a number. Generated cells are real to formulas and exports; typing into one writes an explicit value that wins. ⋯ → <em>Fill with a sequence…</em> in the grid.</p>`
      },
      {
        group: 'Settings',
        title: 'Formatting',
        content: `<pre><code>A1:D1  {bold, bg: #eef, align: center}
D      {format: $#,##0.00}
B2:B9  {italic, color: #888, size: 12, font: mono}
A2:A9  {wrap, valign: top, border: bottom}
C3     {bold: off, color: none}
A1:D1  Item, Qty, Price, Total {bold}     settings may ride on a value line</code></pre>
<p class="help-note">Flags: <code>bold italic underline strike wrap</code>. Keys: <code>color</code>, <code>bg</code> (a CSS name or <code>#hex</code>), <code>size</code> (px), <code>font</code> (<code>mono</code> / <code>serif</code> / <code>sans</code>), <code>align</code> (<code>left</code> / <code>center</code> / <code>right</code>), <code>valign</code> (<code>top</code> / <code>middle</code> / <code>bottom</code>), <code>border</code> (<code>top</code>, <code>bottom</code>, <code>left</code>, <code>right</code>, a list, or alone for all sides), <code>format</code>. Later lines win per property; <code>bold: off</code> / <code>color: none</code> clear one inside a wider range.</p>
<p class="help-note">Number formats: <code>0</code>, <code>0.00</code>, <code>#,##0</code>, <code>#,##0.00</code>, <code>0%</code>, <code>0.0%</code>, <code>$#,##0.00</code> (any currency sign), <code>0.00E+00</code>, <code>text</code>, <code>general</code>; quote a pattern with spaces: <code>format: "#,##0 kg"</code>. A literal cell with a format shows the formatted number (<code>1200</code> → <code>1,200</code>).</p>`
      },
      {
        group: 'Settings',
        title: 'Conditional Formatting',
        content: `<pre><code>D2:D9  {rule: > 100, bold, color: green}
D2:D9  {rule: between 10 and 20, bg: #ffe}
A2:A9  {rule: contains "urgent", bg: #fdd}
B2:B9  {rule: blank, bg: #eee}
C2:C9  {rule: top 3, bold}
D2:D9  {rule: =D>C, color: red}          a formula, per row
A2:A9  {rule: duplicate, color: #c00}
E2:E9  {scale: #fff #1a8cf5}             2 or 3 colours</code></pre>
<p class="help-note"><code>rule</code> makes the block's properties conditional. Conditions: <code>&gt; &gt;= &lt; &lt;= = &lt;&gt;</code> a value (any expression — <code>&gt; B1*2</code>), <code>between a and b</code>, <code>contains</code> / <code>starts</code> / <code>ends "text"</code>, <code>blank</code>, <code>filled</code>, <code>error</code>, <code>duplicate</code>, <code>unique</code>, <code>top n</code>, <code>bottom n</code>, or <code>=formula</code> evaluated for each cell with the row's bare-column refs. Rules apply in order after the plain styles; a <code>scale</code> shades numbers from the lowest to the highest value. The ◈ toolbar button lists and adds rules.</p>`
      },
      {
        group: 'Settings',
        title: 'Dates',
        content: `<pre><code>A2     2026-01-31                 an ISO date is a date value
B2     =A2+30                     2026-03-02 — arithmetic keeps the date
C2     =B2-A2                     30 (days between)
D2     =EDATE(A2, 1)              2026-02-28     =EOMONTH(A2, 0)
E2     =DATEDIF(A2, B2, "d")      d · m · y · ym · md · yd
F2     =TEXT(A2, "mmmm d, yyyy")  January 31, 2026
G2     =TODAY()   =DATE(2026, 7, 4)   =YEAR(A2)  =MONTH(A2)  =DAY(A2)  =WEEKDAY(A2)
A2:A9  {format: d mmm yyyy}       31 Jan 2026 — also dd/mm/yyyy, mmm yyyy, dddd, hh:mm</code></pre>
<p class="help-note">Dates are Excel serials underneath (<code>2026-01-31 14:30</code> carries a time), so they sort, compare (<code>rule: > "2026-01-01"</code>), subtract and feed <code>MIN</code>/<code>MAX</code>; a <code>{seq: 2026-01-31, step: 1 month}</code> generates them. The .xlsx export writes real date cells.</p>`
      },
      {
        group: 'Settings',
        title: 'Data Bars & Charts',
        content: `<pre><code>B2:B9  {bar: #2a78d6}                                   a data bar behind each value
A1:C9  {chart: column, title: "Sales", at: E2, size: 480x300}
A1:C9  {chart: line}        {chart: area}   {chart: pie}   {chart: scatter}
A1:C9  {chart: bar, series: rows, legend: off}</code></pre>
<p class="help-note">A chart line names its <em>data</em>: the first column holds the categories (the x values of a scatter), the first row the series names when it reads as a header, every other column a series (<code>series: rows</code> transposes). <code>at</code> is the top-left cell the chart floats at (default: right of the data), <code>size</code> its pixels. In the grid, hover a chart for edit / move / remove; ▥ on the toolbar inserts one from the selection. Charts go into the .xlsx as native Excel charts and into the HTML / PDF exports as pictures.</p>`
      },
      {
        group: 'Settings',
        title: 'Merge, Comment, Size, Hide',
        content: `<pre><code>A4:C4  Total {merge}         the top-left cell spans the range
B3     {comment: "Market price, October"}
A      {width: 18}           columns, in characters
B:D    {width: 10}
3      {height: 40}          rows, in px
C:D    {hidden}
5:7    {hidden}</code></pre>
<p class="help-note">A comment shows as an orange corner in the grid (hover for the text) and exports as an Excel note. Widths can also be dragged on the column edge; double-click the edge to reset.</p>`
      },
      {
        group: 'Export',
        title: 'Excel, CSV, HTML, PDF',
        content: `<p class="help-note"><strong>Export → Excel</strong> writes a real .xlsx: formulas (with their values cached, so they show at once and recalculate on edit), generated sequences as values, merges, number formats, fonts, fills, borders, alignment, conditional-format rules and colour scales, column widths, row heights, frozen panes, hidden rows / columns, the autofilter and cell comments. <strong>CSV</strong> exports the sheet the grid shows (values). <strong>HTML</strong> is one self-contained file of every sheet with its formatting; <strong>PDF</strong> prints it landscape.</p>`
      }
    ]
  }
};

export function showDslHelpModal(dslType) {
  const help = DSL_HELP[dslType] ?? DSL_HELP.markdown;

  // A stable id per section (for the nav anchors + scroll-spy).
  const slug = (s, i) =>
    'dslhelp-' + i + '-' + String(s.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Build the body (sections, with a heading whenever the group changes) and the
  // navigation list (grouped the same way) in one pass so they stay in sync.
  let sectionsHtml = '';
  let navHtml = '';
  let lastGroup = null;
  help.sections.forEach((s, i) => {
    const id = slug(s, i);
    if (s.group && s.group !== lastGroup) {
      lastGroup = s.group;
      sectionsHtml += `<div class="dsl-help-group-title">${escHtml(s.group)}</div>`;
      navHtml += `<div class="dsl-help-nav-group">${escHtml(s.group)}</div>`;
    }
    sectionsHtml += `
      <div class="dsl-help-section" id="${id}">
        <h3 class="dsl-help-section-title">${escHtml(s.title)}</h3>
        <div class="dsl-help-section-body">${s.content}</div>
      </div>`;
    navHtml += `<button type="button" class="dsl-help-nav-item" data-target="${id}">${escHtml(s.title)}</button>`;
  });

  const overlay = document.createElement('div');
  overlay.className = 'dsl-help-overlay';
  overlay.innerHTML = `
    <div class="dsl-help-modal dsl-help-modal--nav" role="dialog" aria-modal="true" aria-label="${escHtml(help.name)} syntax reference">
      <div class="dsl-help-header">
        <div class="dsl-help-title">
          <span class="dsl-help-badge">${escHtml(help.name)}</span>
          Syntax Reference
        </div>
        <button class="dsl-help-close" aria-label="Close">&times;</button>
      </div>
      <div class="dsl-help-main">
        <nav class="dsl-help-nav" aria-label="Sections">${navHtml}</nav>
        <div class="dsl-help-body">
          ${sectionsHtml}
        </div>
      </div>
      <div class="dsl-help-footer">
        <a class="dsl-help-docs-link" href="${escHtml(help.docsUrl)}" target="_blank" rel="noopener noreferrer">
          ${iconExternalLink()} ${escHtml(help.docsLabel)}
        </a>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.dsl-help-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const body = overlay.querySelector('.dsl-help-body');
  const nav  = overlay.querySelector('.dsl-help-nav');
  const navItems = [...nav.querySelectorAll('.dsl-help-nav-item')];

  // Nav click → scroll the target section to the top of the scroll container.
  // offsetTop is relative to the positioned overlay (not the body), so measure
  // the delta with bounding rects and offset from the body's current scroll.
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.dsl-help-nav-item');
    if (!btn) return;
    const target = overlay.querySelector('#' + CSS.escape(btn.dataset.target));
    if (!target) return;
    const delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTo({ top: Math.max(0, body.scrollTop + delta - 8) });
    setActive(btn.dataset.target);   // immediate highlight; scroll-spy keeps it synced
  });

  const setActive = (id) => {
    navItems.forEach(b => b.classList.toggle('active', b.dataset.target === id));
    // Keep the active item visible in the (independently scrolling) nav —
    // vertical sidebar on desktop, horizontal chip strip on mobile.
    nav.querySelector('.dsl-help-nav-item.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // Scroll-spy: the active section is the last one whose top has reached (just
  // past) the top of the scrolling body. A scroll listener is used rather than
  // IntersectionObserver, which doesn't fire reliably inside a nested scroller
  // in every environment.
  const sections = [...overlay.querySelectorAll('.dsl-help-section')];
  const syncActive = () => {
    const bodyTop = body.getBoundingClientRect().top;
    let currentId = sections[0]?.id ?? null;
    for (const sec of sections) {
      if (sec.getBoundingClientRect().top - bodyTop <= 24) currentId = sec.id;
      else break;
    }
    if (currentId) setActive(currentId);
  };
  body.addEventListener('scroll', syncActive, { passive: true });
  syncActive();

  // Focus the modal for keyboard accessibility
  overlay.querySelector('.dsl-help-modal').focus?.();
}

// Modal to configure a built-in DSL's extension slots (e.g. the ABC soundfont).
// There is no runtime plugin installation — every build bundles its one DSL — so
// this only surfaces the extensionSlots declared by the DSLs in this build.
export function showExtensionsModal() {
  const overlay = document.createElement('div');
  overlay.className = 'dsl-help-overlay';

  const renderRow = (dsl) => `
      <div class="plugin-mgr-row plugin-mgr-row--builtin" data-id="${escHtml(dsl.id)}">
        <div class="plugin-mgr-row-header">
          <code class="plugin-mgr-shebang">#!${escHtml(dsl.id)}</code>
          <span class="plugin-mgr-name">${escHtml(dsl.name ?? dsl.id)}</span>
        </div>
        ${_renderSlots(dsl.id, dsl.extensionSlots ?? [])}
      </div>
    `;

  const renderContent = () => {
    const dslsWithSlots = listDSLs().filter(d => (d.extensionSlots?.length ?? 0) > 0);
    return `
      <div class="dsl-help-modal" role="dialog" aria-modal="true" aria-label="Extensions" tabindex="-1">
        <div class="dsl-help-header">
          <div class="dsl-help-title">Extensions</div>
          <button class="dsl-help-close" aria-label="Close">&times;</button>
        </div>
        <div class="dsl-help-body plugin-mgr-body">
          ${dslsWithSlots.length
            ? `<div class="plugin-mgr-list">${dslsWithSlots.map(renderRow).join('')}</div>`
            : '<p class="plugin-mgr-empty">This build has no configurable extensions.</p>'}
        </div>
      </div>
    `;
  };

  overlay.innerHTML = renderContent();
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.dsl-help-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const refresh = () => {
    overlay.innerHTML = renderContent();
    overlay.querySelector('.dsl-help-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    bindActions();
  };

  const bindActions = () => {
    // ── Text slot: save on Enter or blur ──────────────────────────────────
    overlay.querySelectorAll('.plugin-ext-text-input').forEach(input => {
      const { dslId, slotId } = input.dataset;

      const save = () => {
        setTextExtension(dslId, slotId, input.value);
        // Update the clear-button visibility without full refresh.
        const clearBtn = input.closest('.plugin-ext-slot')?.querySelector('.plugin-ext-clear');
        if (clearBtn) clearBtn.style.display = input.value.trim() ? '' : 'none';
      };

      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', save);
    });

    // ── Clear button (text and file slots) ────────────────────────────────
    overlay.querySelectorAll('.plugin-ext-clear').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { dslId, slotId } = btn.dataset;
        await clearExtension(dslId, slotId);
        refresh(); // full refresh so all event bindings stay clean
      });
    });
  };

  bindActions();
}

// ---------------------------------------------------------------------------
// Extension slot renderer helpers
// ---------------------------------------------------------------------------

/** Render the collapsible Extensions section for a plugin row. */
function _renderSlots(dslId, slots) {
  if (!slots || slots.length === 0) return '';
  return `
    <details class="plugin-ext-details">
      <summary class="plugin-ext-summary">Extensions</summary>
      <div class="plugin-ext-body">
        ${slots.map(slot => _renderSlot(dslId, slot)).join('')}
      </div>
    </details>
  `;
}

/** Render a single extension slot row inside the plugin expander. */
function _renderSlot(dslId, slot) {
  const meta = getExtensionMeta(dslId, slot.id);

  if (slot.type === 'text') {
    const current = meta?.value ?? '';
    return `
      <div class="plugin-ext-slot" data-slot-id="${escHtml(slot.id)}">
        <div class="plugin-ext-slot-header">
          <span class="plugin-ext-label">${escHtml(slot.label)}</span>
          <button class="plugin-ext-clear" data-dsl-id="${escHtml(dslId)}" data-slot-id="${escHtml(slot.id)}"
            title="Clear value" style="${current ? '' : 'display:none'}">Clear</button>
        </div>
        ${slot.description ? `<p class="plugin-ext-desc">${escHtml(slot.description)}</p>` : ''}
        <input
          class="plugin-ext-text-input"
          type="text"
          data-dsl-id="${escHtml(dslId)}"
          data-slot-id="${escHtml(slot.id)}"
          value="${escHtml(current)}"
          placeholder="${escHtml(slot.placeholder ?? '')}"
          spellcheck="false"
        />
      </div>
    `;
  }

  // file type — placeholder for future file upload support
  const filename = meta?.filename ?? null;
  return `
    <div class="plugin-ext-slot" data-slot-id="${escHtml(slot.id)}">
      <div class="plugin-ext-slot-header">
        <span class="plugin-ext-label">${escHtml(slot.label)}</span>
        ${filename ? `<button class="plugin-ext-clear" data-dsl-id="${escHtml(dslId)}" data-slot-id="${escHtml(slot.id)}" title="Remove file">Remove</button>` : ''}
      </div>
      ${slot.description ? `<p class="plugin-ext-desc">${escHtml(slot.description)}</p>` : ''}
      <div class="plugin-ext-file-value">
        ${filename
          ? `<span class="plugin-ext-filename">${escHtml(filename)}</span>`
          : '<span class="plugin-ext-no-file">No file set</span>'}
      </div>
    </div>
  `;
}

function iconExternalLink() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M10.604 1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1zM3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2z"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _iconExported() {
  // Down-into-tray: a durable save written out of the sandbox.
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 1a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V1.75A.75.75 0 0 1 8 1z"/>
    <path d="M2.75 11a.75.75 0 0 1 .75.75V13.5h9v-1.75a.75.75 0 0 1 1.5 0v2.25a.75.75 0 0 1-.75.75h-10.5a.75.75 0 0 1-.75-.75v-2.25A.75.75 0 0 1 2.75 11z"/>
  </svg>`;
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
