/**
 * Top bar component
 *
 * Layout (left → right):
 *   [DSL menu icon ▾]  [editable title]  [↑commit]  [branch ▾][hash ▾]
 *
 * The view-mode toggle (Editor / Split / Preview) has been moved to the
 * pane divider bar — click it to cycle through modes.
 *
 * Two independent VCS dropdowns:
 *   - Branch pill  → lists all branches; click to switch
 *   - Commit pill  → lists commits on current branch; click to checkout
 *                    When dirty: becomes a split button — left half commits,
 *                    right half (▾) opens the history dropdown.
 *
 * The DSL icon at the far left is a dropdown menu that replaces the former
 * ⋯ tools menu and ⚙ settings gear.
 */

import { state, PANELS } from './state.js';
import { shortHash } from '../core/hash.js';
import { loadUserPrefs, loadBackupMark } from '../core/storage.js';
import { showArchivedCommentsModal } from './comments.js';
import { listDSLs } from '../dsl/registry.js';
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
    this._branchOpen = false;
    this._commitOpen = false;
    this._dslMenuOpen = false;
    this._unsub = [];

    this._unsub.push(state.on('change', () => this.render()));
    this._unsub.push(state.on('content-change', () => this._updateDirty()));
    // Refresh the mobile commit-log pane's selected-commit highlight as the diff
    // selection changes (diff-change doesn't emit the generic 'change' event).
    this._unsub.push(state.on('diff-change', () => this._refreshCommitLog()));

    this.render();
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render() {
    const { isDirty } = state;
    const hash = state.shortHeadHash;
    const branch = state.currentBranch;
    const isDetached = state.isDetached;

    this.el.innerHTML = `
      <div class="topbar">
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
            <button class="vcs-pill branch-pill${isDetached ? ' detached' : ''}" id="tb-branch-toggle"
              title="${isDetached ? 'Detached HEAD — click to manage branches' : `Branch: ${escHtml(branch)}`}">
              ${iconBranch()}
              <span class="vcs-pill-text">${isDetached ? '⚠ detached' : escHtml(branch)}</span>
              <span class="vcs-pill-caret">▾</span>
            </button>
            ${isDirty ? `
              <button class="vcs-pill commit-pill dirty commit-action-pill" id="tb-commit-action"
                title="Commit changes (Ctrl+S)">
                <span class="vcs-pill-text vcs-pill-mono">${escHtml(hash)}</span>
                <span class="dirty-dot" title="Uncommitted changes">●</span>
              </button>
              <button class="vcs-pill commit-pill dirty commit-caret-pill" id="tb-commit-toggle"
                title="View commits on this branch">
                <span class="vcs-pill-caret">▾</span>
              </button>
            ` : `
              <button class="vcs-pill commit-pill" id="tb-commit-toggle"
                title="Commit: ${escHtml(hash)}">
                <span class="vcs-pill-text vcs-pill-mono">${escHtml(hash)}</span>
                <span class="vcs-pill-caret">▾</span>
              </button>
            `}
          </div>
        </div>

      </div>

      <div class="vcs-dropdown dsl-menu-dropdown${this._dslMenuOpen ? ' open' : ''}" id="tb-dsl-menu-dd">
        ${this._renderDslMenuList()}
      </div>
      <div class="vcs-dropdown${this._branchOpen ? ' open' : ''}" id="tb-branch-dd">
        ${this._branchOpen ? this._renderBranchList() : ''}
      </div>
      <div class="vcs-dropdown${this._commitOpen ? ' open' : ''}" id="tb-commit-dd">
        ${this._commitOpen ? this._renderCommitList() : ''}
      </div>
    `;

    this._bindEvents();
    // Keep the mobile commit-log pane (if mounted) in sync with every re-render
    // — render() fires on state 'change', which covers commit/checkout/branch.
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
    this._commitLogEl.innerHTML =
      `<div class="commit-log-pane">${this._renderPendingNode()}${this._renderCommitList()}</div>`;

    this._commitLogEl.querySelectorAll('.dd-commit-item').forEach(item => {
      item.addEventListener('click', () => {
        const hash = item.dataset.hash;
        if (hash) this._onCommitClick(hash);
      });
    });

    // Pending (uncommitted) node: inline optional message + version, commit here.
    const msg = this._commitLogEl.querySelector('#clp-msg');
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
          e.preventDefault(); this._commitPending();
        }
      });
    }
    this._commitLogEl.querySelector('#clp-commit')
      ?.addEventListener('click', () => this._commitPending());
  }

  /**
   * The pending-commit node shown at the top of the log while there are
   * uncommitted changes.  It's styled distinctly from real commits (a hollow,
   * dashed node) and carries the message field + commit action inline, so a new
   * commit is composed right where it will land.  Message and version are both
   * optional.
   */
  _renderPendingNode() {
    if (!state.isDirty) return '';
    const head = state.vcs?.log?.()?.[0];
    const suggested = head?.tag ? _incPatch(head.tag) : '';
    return `
      <div class="commit-log-pending" aria-label="Uncommitted changes">
        <div class="clp-graph"><span class="clp-node"></span></div>
        <div class="clp-body">
          <div class="clp-label">Uncommitted changes</div>
          <textarea class="clp-msg" id="clp-msg" rows="1" autocomplete="off"
            placeholder="Describe this change (optional)"></textarea>
          <div class="clp-row">
            <input class="clp-ver" id="clp-ver" type="text" autocomplete="off"
              placeholder="v ${escHtml(suggested || '0.0.0')}" value="${escHtml(suggested)}"
              aria-label="Version (optional)">
            <button class="clp-commit" id="clp-commit" type="button">Commit</button>
          </div>
        </div>
      </div>`;
  }

  _commitPending() {
    if (this._committing || !state.isDirty || !this.handlers?.onCommit) return;
    const message = this._commitLogEl?.querySelector('#clp-msg')?.value.trim() || '';
    const tag     = this._commitLogEl?.querySelector('#clp-ver')?.value.trim() || undefined;

    // Detached HEAD (needs a branch name) or no saved identity → hand off to the
    // full commit dialog, carrying the typed message/version so they aren't lost.
    const prefs = loadUserPrefs();
    if (state.isDetached || !prefs?.name || !prefs?.email) {
      state.pendingCommit = { message, tag };
      state.openPanel(PANELS.COMMIT);
      return;
    }

    this._committing = true;
    Promise.resolve(this.handlers.onCommit({ author: prefs.name, email: prefs.email, message, tag }))
      .catch(err => console.warn('[commit-log] commit failed:', err?.message))
      .finally(() => { this._committing = false; this._refreshCommitLog(); });
  }

  _updateDirty() {
    // Desktop: the commit pill structure changes fundamentally when dirty flips
    // (single button ↔ split button), so that path needs a full re-render.
    const hasSplitBtn = !!this.el.querySelector('#tb-commit-action');
    if (hasSplitBtn !== state.isDirty) {
      this.render();
    }
    // Keep the mobile commit-log pane's pending node in sync as edits land.
    this._refreshCommitLog();
  }

  // ---------------------------------------------------------------------------
  // Dropdown content
  // ---------------------------------------------------------------------------

  _renderDslMenuList() {
    const hasCommits = (state.vcs?.log()?.length ?? 0) > 0;
    const activeDslId = state.activeDslId ?? state.data?.dslType ?? 'markdown';
    const dslName = DSL_HELP[activeDslId]?.name ?? activeDslId;
    return `
      <ul class="tools-menu-list">
        <li class="tools-menu-item" id="tb-new-doc" title="Discard this document and start a new one">
          ${iconNewDoc()} New document…
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-dsl-help" title="Syntax reference for ${escHtml(dslName)}">
          ${iconHelp()} ${escHtml(dslName)} help…
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item${hasCommits ? '' : ' disabled'}" id="tb-blame"
          title="${hasCommits ? 'Blame view (Ctrl+Shift+B)' : 'Available after first commit'}">
          ${iconBlame()} Blame view
          <kbd>⌃⇧B</kbd>
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-save-data" title="Save the document + full history as a small .unifile.json text file">
          ${iconExport()} Save data file…
        </li>
        <li class="tools-menu-item" id="tb-open-data" title="Open a .unifile.json data file (replaces the current document)">
          ${iconImport()} Open data file…
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-export" title="Export document (Ctrl+Shift+E)">
          ${iconExport()} Export…
          <kbd>⌃⇧E</kbd>
        </li>
        <li class="tools-menu-item" id="tb-merge" title="Import & merge another unifile (Ctrl+Shift+M)">
          ${iconImport()} Import & merge…
          <kbd>⌃⇧M</kbd>
        </li>
        ${listDSLs().some(d => (d.extensionSlots?.length ?? 0) > 0) ? `
        <li class="tools-menu-item" id="tb-extensions" title="Configure DSL extensions">
          ${iconPlugin()} Extensions…
        </li>` : ''}
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-archived-comments" title="Browse archived comment threads">
          ${iconComment()} Archived comments…
        </li>
        <li class="tools-menu-sep" role="separator"></li>
        <li class="tools-menu-item" id="tb-settings-item" title="Settings (Ctrl+Shift+,)">
          ${iconGear()} Settings
          <kbd>⌃⇧,</kbd>
        </li>
      </ul>
    `;
  }

  _renderBranchList() {
    const vcs = state.vcs;
    if (!vcs) return '<p class="dd-empty">No branches yet.</p>';

    const branches = vcs.listBranches();
    const isDetached = state.isDetached;
    const detachedHash = vcs.detachedHead;

    return `
      ${isDetached ? `
        <div class="dd-detached-notice">
          <strong>Detached HEAD</strong> — viewing commit ${escHtml(shortHash(detachedHash))}.
          Select a branch to reattach, or commit to create a new branch automatically.
        </div>
      ` : ''}
      <div class="dd-section-label">Branches</div>
      <ul class="dd-branch-list">
        ${branches.map(b => `
          <li class="dd-branch-item${b.isCurrent && !isDetached ? ' current' : ''}" data-branch="${escHtml(b.name)}">
            <span class="dd-branch-icon">${b.isCurrent && !isDetached ? '●' : '○'}</span>
            <span class="dd-branch-name">${escHtml(b.name)}</span>
            <span class="dd-branch-hash">${shortHash(b.head)}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  _renderCommitList() {
    const vcs = state.vcs;
    if (!vcs) return '<p class="dd-empty">No commits yet.</p>';

    const log = vcs.log();
    const isDetached = state.isDetached;
    const detachedHash = vcs.detachedHead;
    const currentHash = isDetached ? detachedHash : state.headHash;

    // Export marker: whichever commit was last written OUT to a .unifile.json is
    // the user's durable save point. We badge it so "committed" (in-app history)
    // is visibly distinct from "exported" (a permanent copy off the device).
    const mark = loadBackupMark(state.docId ?? location.href);
    const exportedHash = mark?.headHash ?? null;
    const exportedWhen = mark?.at ? formatRelative(mark.at) : '';

    // While a diff is open, mark the commit currently selected as its RIGHT
    // (source) side so the commit-log pane shows what's being compared/merged.
    const selectedHash = state.diff?.right && state.diff.right !== 'WORKING' ? state.diff.right : null;

    return `
      <div class="dd-section-label">
        Commits <span class="dd-branch-ctx">on ${escHtml(state.currentBranch)}</span>
      </div>
      <ul class="dd-commit-list">
        ${log.map(c => `
          <li class="dd-commit-item${c.hash === currentHash ? ' current' : ''}${c.hash === exportedHash ? ' exported' : ''}${c.hash === selectedHash ? ' selected' : ''}"
            data-hash="${c.hash}">
            <div class="dd-commit-meta">
              <span class="dd-commit-hash">${shortHash(c.hash)}</span>
              ${c.tag ? `<span class="dd-commit-tag">${escHtml(c.tag)}</span>` : ''}
              ${c.hash === exportedHash
                ? `<span class="dd-commit-exported" title="Exported to a file${exportedWhen ? ' ' + escHtml(exportedWhen) : ''} — you have a permanent copy of this state">${_iconExported()} exported</span>`
                : ''}
              <span class="dd-commit-date">${formatRelative(c.timestamp)}</span>
            </div>
            <div class="dd-commit-msg">${c.message ? escHtml(c.message) : '<span class="dd-commit-nomsg">(no message)</span>'}</div>
            <div class="dd-commit-author">${escHtml(c.author)}</div>
          </li>
        `).join('')}
        ${log.length === 0 ? '<li class="dd-empty">No commits yet.</li>' : ''}
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

    // Commit action — primary part of the split pill when dirty
    const commitActionBtn = this.el.querySelector('#tb-commit-action');
    if (commitActionBtn) {
      commitActionBtn.addEventListener('click', () => state.openPanel(PANELS.COMMIT));
    }

    // DSL menu toggle (far-left icon button)
    const dslMenuBtn = this.el.querySelector('#tb-dsl-menu-toggle');
    if (dslMenuBtn) {
      dslMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._dslMenuOpen = !this._dslMenuOpen;
        if (this._dslMenuOpen) { this._branchOpen = false; this._commitOpen = false; }
        this._syncDropdowns();
      });
    }

    // Branch pill toggle
    const branchBtn = this.el.querySelector('#tb-branch-toggle');
    if (branchBtn) {
      branchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._branchOpen = !this._branchOpen;
        if (this._branchOpen) { this._commitOpen = false; this._dslMenuOpen = false; }
        this._syncDropdowns();
      });
    }

    // Commit pill toggle (caret / history dropdown)
    const commitPillBtn = this.el.querySelector('#tb-commit-toggle');
    if (commitPillBtn) {
      commitPillBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._commitOpen = !this._commitOpen;
        if (this._commitOpen) { this._branchOpen = false; this._dslMenuOpen = false; }
        this._syncDropdowns();
      });
    }

    // Close all dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!this.el.contains(e.target)) {
        this._branchOpen = false;
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
    // Branch dropdown
    const branchDd = this.el.querySelector('#tb-branch-dd');
    if (branchDd) {
      branchDd.classList.toggle('open', this._branchOpen);
      if (this._branchOpen) branchDd.innerHTML = this._renderBranchList();
    }
    // Commit dropdown
    const commitDd = this.el.querySelector('#tb-commit-dd');
    if (commitDd) {
      commitDd.classList.toggle('open', this._commitOpen);
      if (this._commitOpen) commitDd.innerHTML = this._renderCommitList();
    }
    // Sync the DSL menu button active state
    const dslMenuBtn = this.el.querySelector('#tb-dsl-menu-toggle');
    if (dslMenuBtn) dslMenuBtn.classList.toggle('active', this._dslMenuOpen);

    this._bindDropdownEvents();
  }

  _bindDropdownEvents() {
    // New document — confirmation modal (with backup/commit prompts) then reset.
    this.el.querySelector('#tb-new-doc')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showNewDocumentModal(this.handlers);
    });

    // DSL help modal — uses active section DSL or document default
    this.el.querySelector('#tb-dsl-help')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showDslHelpModal(state.activeDslId ?? state.data?.dslType ?? 'markdown');
    });

    // DSL menu items
    this.el.querySelector('#tb-blame')?.addEventListener('click', () => {
      if (!this.el.querySelector('#tb-blame')?.classList.contains('disabled')) {
        this._dslMenuOpen = false;
        this._syncDropdowns();
        if (state.activePanel === PANELS.BLAME) state.closePanel();
        else state.openPanel(PANELS.BLAME);
      }
    });
    this.el.querySelector('#tb-save-data')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      state.emit('save-data-file');
    });
    this.el.querySelector('#tb-open-data')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      state.emit('open-data-file');
    });
    this.el.querySelector('#tb-export')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.EXPORT) state.closePanel();
      else state.openPanel(PANELS.EXPORT);
    });
    this.el.querySelector('#tb-merge')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.MERGE) state.closePanel();
      else state.openPanel(PANELS.MERGE);
    });
    this.el.querySelector('#tb-extensions')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showExtensionsModal();
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

    // Checkout a commit
    this.el.querySelectorAll('.dd-commit-item').forEach(item => {
      item.addEventListener('click', () => {
        const hash = item.dataset.hash;
        if (hash) this._onCommitClick(hash);
      });
    });

    // Switch to a branch
    this.el.querySelectorAll('.dd-branch-item').forEach(item => {
      item.addEventListener('click', () => {
        const branch = item.dataset.branch;
        const isCurrentAndAttached = item.classList.contains('current');
        if (branch && !isCurrentAndAttached) {
          this._onSwitchBranch(branch);
        } else if (branch && isCurrentAndAttached) {
          this._branchOpen = false;
          this._syncDropdowns();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // VCS navigation with auto-stash
  // ---------------------------------------------------------------------------

  _maybeStash() {
    if (state.isDirty) {
      state.stash = { content: state.currentContent, fromHash: state.headHash };
    }
  }

  _applyStash(hash, baseContent) {
    if (state.stash && state.stash.fromHash === hash) {
      const stashedContent = state.stash.content;
      state.stash = null;
      return stashedContent;
    }
    return baseContent;
  }

  /**
   * Clicking a commit opens the read-only diff (clicked commit vs working
   * state).  Clicking the current commit does nothing.  Actual checkout-to-edit
   * is the explicit `_onCheckout` path.
   */
  _onCommitClick(hash) {
    this._commitOpen = false;
    this._syncDropdowns?.();
    if (!hash) return;
    // Already diffing → the clicked commit becomes the RIGHT (source) side,
    // keeping the current LEFT (target) selection.
    if (state.diff) { state.openDiff(state.diff.left, hash); return; }
    // Nothing to compare if this commit's content IS the current working state
    // (e.g. clicking the head with no uncommitted changes).
    if (state.vcs?.getContentAt(hash) === state.currentContent) return;
    // Working state = LEFT (middle / merge target), clicked commit = RIGHT
    // (merge source). Merge is always right → left.
    state.openDiff('WORKING', hash);
  }

  _onCheckout(hash) {
    const vcs = state.vcs;
    if (!vcs) return;

    const currentHash = state.headHash;
    const isDetached = state.isDetached;
    const branchHead = vcs.branches?.[vcs.currentBranch]?.head ?? null;

    if (hash === currentHash && !isDetached) {
      this._commitOpen = false;
      this._syncDropdowns();
      return;
    }

    this._maybeStash();

    if (hash === branchHead && isDetached) {
      const baseContent = vcs.switchBranch(vcs.currentBranch);
      const newHash = vcs.headHash;
      const content = this._applyStash(newHash, baseContent);
      state.update({ currentContent: content, isDirty: content !== baseContent });
      state.emit('branch-switch', { name: vcs.currentBranch, content });
    } else {
      const { content: baseContent } = vcs.checkout(hash);
      const content = this._applyStash(hash, baseContent);
      state.update({ currentContent: content, isDirty: content !== baseContent });
      state.emit('checkout', { hash, content });
    }

    this._commitOpen = false;
    this.render();
  }

  _onSwitchBranch(name) {
    this._maybeStash();

    const baseContent = state.vcs.switchBranch(name);
    const newHash = state.vcs.headHash;
    const content = this._applyStash(newHash, baseContent);
    state.update({ currentContent: content, isDirty: content !== baseContent });
    state.emit('branch-switch', { name, content });

    this._branchOpen = false;
    this.render();
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

function iconBranch() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z"/>
  </svg>`;
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
// New-document confirmation modal
//
// Starting a new document replaces the ENTIRE current document — content,
// branches, commits and comments — so before the user commits to that we make
// it easy to keep the current work (commit any dirty changes, and/or export a
// durable .unifile.json copy) and require an explicit destructive confirm.
// ---------------------------------------------------------------------------

export function showNewDocumentModal(handlers) {
  const overlay = document.createElement('div');
  overlay.className = 'dsl-help-overlay';

  const commitCount = state.vcs?.log?.().length ?? 0;
  const dirty = state.isDirty;
  const historyNote = commitCount === 0
    ? 'The current document has no commits yet.'
    : `This discards the current document and its entire history — ${commitCount} commit${commitCount === 1 ? '' : 's'}.`;

  overlay.innerHTML = `
    <div class="dsl-help-modal newdoc-modal" role="dialog" aria-modal="true" aria-label="Start a new document" tabindex="-1">
      <div class="dsl-help-header">
        <div class="dsl-help-title">Start a new document</div>
        <button class="dsl-help-close" aria-label="Close">&times;</button>
      </div>
      <div class="dsl-help-body newdoc-body">
        <p class="newdoc-warn">${escHtml(historyNote)} <strong>This can’t be undone.</strong></p>
        ${dirty ? '<p class="newdoc-dirty">⚠ You have uncommitted changes that will be lost.</p>' : ''}
        <p class="newdoc-hint">Keep this work first — commit it and/or save a copy — then start fresh.</p>
        <div class="newdoc-actions">
          ${dirty ? '<button class="newdoc-btn" id="newdoc-commit">Commit…</button>' : ''}
          <button class="newdoc-btn" id="newdoc-save">Save data file…</button>
        </div>
        <p class="newdoc-status" id="newdoc-status" aria-live="polite"></p>
      </div>
      <div class="dsl-help-footer newdoc-footer">
        <button class="newdoc-btn newdoc-cancel" id="newdoc-cancel">Cancel</button>
        <button class="newdoc-btn newdoc-danger" id="newdoc-confirm">Discard &amp; start new</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const setStatus = (msg, ok = false) => {
    const s = overlay.querySelector('#newdoc-status');
    if (s) { s.textContent = msg; s.classList.toggle('ok', ok); }
  };

  overlay.querySelector('.dsl-help-close')?.addEventListener('click', close);
  overlay.querySelector('#newdoc-cancel')?.addEventListener('click', close);

  // Commit path: hand off to the full commit UI (the new-doc modal steps aside).
  overlay.querySelector('#newdoc-commit')?.addEventListener('click', () => {
    close();
    state.openPanel(PANELS.COMMIT);
  });

  // Backup path: export a .unifile.json and report the outcome; the modal stays
  // open so the user can then discard with confidence.
  overlay.querySelector('#newdoc-save')?.addEventListener('click', async () => {
    setStatus('Saving…');
    try {
      const result = await (handlers.onSaveDataFile?.() ?? Promise.resolve('downloaded'));
      if (result === 'cancelled') setStatus('Save cancelled — nothing was exported.');
      else setStatus('✓ Saved. Safe to start a new document.', true);
    } catch (e) {
      setStatus('Save failed: ' + (e?.message ?? e));
    }
  });

  // Destructive confirm: the user has accepted the loss of unbacked-up work.
  overlay.querySelector('#newdoc-confirm')?.addEventListener('click', () => {
    close();
    handlers.onNewDocument?.();
  });

  overlay.querySelector('.newdoc-modal')?.focus?.();
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
### Heading 3</code></pre>`
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
|--------|-----|
| Alice  | 30  |
| Bob    | 25  |</code></pre>
<p class="help-note">Alignment: <code>:---</code> left, <code>:---:</code> center, <code>---:</code> right</p>`
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
model: flow
model2: grid
title: My Document
subtitle: A subtitle
author: Jane Smith
date: 2026-01-01
---</code></pre>
<p class="help-note"><code>model</code> sets the document's primary coordinate model (flow / grid / spatial / timeline / graph). <code>model2</code> sets an optional secondary model. <code>title</code>, <code>subtitle</code>, <code>author</code>, <code>date</code> render as a title block.</p>`
      },
      {
        title: 'Page Breaks',
        content: `<pre><code>Content on page 1.

---

Content on page 2.</code></pre>
<p class="help-note"><code>---</code> (horizontal rule) inserts a page break in PDF and DOCX exports.</p>`
      }
    ]
  },

  mermaid: {
    name: 'Mermaid',
    docsUrl: 'https://mermaid.js.org/intro/',
    docsLabel: 'Mermaid Docs',
    sections: [
      {
        title: 'Flowchart',
        content: `<pre><code>flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do thing]
    B -->|No| D[Skip]
    C --> E[End]</code></pre>
<p class="help-note">Directions: <code>TD</code> top-down, <code>LR</code> left-right, <code>BT</code>, <code>RL</code>. Node shapes: <code>[rect]</code> <code>(rounded)</code> <code>{diamond}</code> <code>((circle))</code> <code>[/parallelogram/]</code></p>`
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
        content: `<p class="help-note">Playback uses a built-in, fully-offline acoustic piano. Use the transport bar (play / scrubber / time) at the bottom, the floating play button on mobile, or press <code>Space</code>-like controls in the app. Put the cursor in a note to play from there; select a range to play just that range.</p>
<p class="help-note">A custom soundfont URL can be set under <strong>Settings → Extensions</strong> (<code>soundfont-url</code>).</p>`
      },
      {
        group: 'Playback (unifile)',
        title: 'Mute / Solo Voices',
        content: `<p class="help-note">Click the <strong>gutter rail</strong> next to any <code>V:</code> line and choose <strong>Mute</strong> or <strong>Solo</strong>. Muted voices don't sound or highlight and are dimmed in the editor and score (marked <code>M</code>); Solo isolates a voice (marked <code>S</code>) and mutes the rest. It's a live, per-session setting — not saved with the document.</p>`
      },
      {
        group: 'Playback (unifile)',
        title: 'External MIDI Output',
        content: `<p class="help-note">Under <strong>Settings → Audio output</strong> you can route playback to an external MIDI port (e.g. macOS IAC → a DAW/sampler) instead of the internal piano. This is where <code>midi.map</code> keyswitches, per-voice channels, volume and pan take effect. Web MIDI is Chromium-only.</p>`
      }
    ]
  },

  marp: {
    name: 'MARP Slides',
    docsUrl: 'https://marpit.marp.app/',
    docsLabel: 'Marpit / MARP Docs',
    sections: [
      {
        title: 'Document Front Matter',
        content: `<pre><code>---
marp: true
theme: default
paginate: true
---</code></pre>
<p class="help-note">The opening YAML block configures global slide settings. <code>marp: true</code> enables MARP mode.</p>`
      },
      {
        title: 'Slides',
        content: `<pre><code># Slide 1

Content for slide 1.

---

# Slide 2

Content for slide 2.</code></pre>
<p class="help-note"><code>---</code> on its own line separates slides. Regular Markdown is used within each slide.</p>`
      },
      {
        title: 'Themes',
        content: `<pre><code>---
theme: default   % Clean light theme
---
---
theme: gaia      % Dark hero theme
---
---
theme: uncover   % Minimal light theme
---</code></pre>`
      },
      {
        title: 'Pagination & Header/Footer',
        content: `<pre><code>---
paginate: true
header: My Presentation
footer: © 2026 My Company
---</code></pre>`
      },
      {
        title: 'Per-Slide Directives',
        content: `<pre><code>&lt;!-- _class: lead --&gt;

# Big Hero Slide

&lt;!-- _backgroundColor: #1a1a2e --&gt;
&lt;!-- _color: #ffffff --&gt;

Custom coloured slide.</code></pre>
<p class="help-note">HTML comments with <code>_</code> prefix apply to the current slide only. Without <code>_</code> they apply globally from that point on.</p>`
      },
      {
        title: 'Background Images',
        content: `<pre><code>![bg](image.jpg)
![bg left](image.jpg)
![bg right:40%](image.jpg)
![bg cover](image.jpg)
![bg contain](image.jpg)</code></pre>`
      },
      {
        title: 'Two-Column Layout',
        content: `<pre><code>&lt;!-- _class: split --&gt;

# Title

Left column content.

---

Right column content.</code></pre>
<p class="help-note">Use the <code>split</code> class (available in gaia/uncover themes) or create a custom CSS class.</p>`
      },
      {
        title: 'Math (KaTeX)',
        content: `<pre><code>Inline: $E = mc^2$

Display:
$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$</code></pre>`
      },
      {
        title: 'Custom CSS',
        content: `<pre><code>&lt;style&gt;
section {
  font-size: 28px;
}
h1 {
  color: #3498db;
}
&lt;/style&gt;</code></pre>
<p class="help-note">Inline <code>&lt;style&gt;</code> blocks let you override theme styles for the whole deck or individual slides.</p>`
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

/** Bump the patch of a `major.minor.patch` string (mirrors commit-bar). */
function _incPatch(semver) {
  const m = String(semver).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return '';
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
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
