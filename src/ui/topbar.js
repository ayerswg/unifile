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

    // Play-state changes just update the play button icon/class without full re-render.
    this._unsub.push(state.on('abc-play-state', ({ playing }) => {
      const btn = this.el.querySelector('#tb-play');
      if (!btn) return;
      btn.classList.toggle('playing', playing);
      btn.title = playing ? 'Stop (Space)' : 'Play (Space)';
      btn.innerHTML = playing ? iconStop() : iconPlay();
    }));

    // Tune-ready state: toggle has-tune class on the play button.
    this._unsub.push(state.on('abc-tune-state', ({ hasTune }) => {
      const btn = this.el.querySelector('#tb-play');
      if (!btn) return;
      btn.classList.toggle('has-tune', hasTune);
    }));

    this.render();
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render() {
    const { data, isDirty } = state;
    const hash = state.shortHeadHash;
    const branch = state.currentBranch;
    const isDetached = state.isDetached;
    const dslType = data?.dslType ?? 'markdown';

    this.el.innerHTML = `
      <div class="topbar">
        <button class="dsl-icon-btn${this._dslMenuOpen ? ' active' : ''}" id="tb-dsl-menu-toggle"
          title="Menu" aria-label="Menu">
          ${iconForDsl(dslType)}
        </button>
        <span
          class="topbar-title"
          contenteditable="true"
          spellcheck="false"
          data-placeholder="Untitled"
          title="Click to edit title"
        >${escHtml(state.title)}</span>

        <!-- Centre section — format-specific actions (e.g. ABC play button) -->
        <div class="topbar-center">
          ${dslType === 'abcjs' ? `
            <button class="topbar-btn play-btn${state.abcPlaying ? ' playing' : ''}${state.abcHasTune ? ' has-tune' : ''}"
              id="tb-play"
              title="${state.abcPlaying ? 'Stop (Space)' : 'Play (Space)'}">
              ${state.abcPlaying ? iconStop() : iconPlay()}
            </button>
          ` : ''}
        </div>

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
  }

  _updateDirty() {
    // When dirty state changes, the commit pill structure changes fundamentally
    // (single button ↔ split button), so we need a full re-render.
    const hasSplitBtn = !!this.el.querySelector('#tb-commit-action');
    if (hasSplitBtn !== state.isDirty) {
      this.render();
    }
    // If the structure already matches the dirty state, nothing else to do —
    // the split/single structure already reflects the state correctly.
  }

  // ---------------------------------------------------------------------------
  // Dropdown content
  // ---------------------------------------------------------------------------

  _renderDslMenuList() {
    const hasCommits = (state.vcs?.log()?.length ?? 0) > 0;
    const dslType = state.data?.dslType ?? 'markdown';
    const dslName = DSL_HELP[dslType]?.name ?? dslType;
    return `
      <ul class="tools-menu-list">
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
        <li class="tools-menu-item" id="tb-export" title="Export document (Ctrl+Shift+E)">
          ${iconExport()} Export…
          <kbd>⌃⇧E</kbd>
        </li>
        <li class="tools-menu-item" id="tb-merge" title="Import & merge another unifile (Ctrl+Shift+M)">
          ${iconImport()} Import & merge…
          <kbd>⌃⇧M</kbd>
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

    return `
      <div class="dd-section-label">
        Commits <span class="dd-branch-ctx">on ${escHtml(state.currentBranch)}</span>
      </div>
      <ul class="dd-commit-list">
        ${log.map(c => `
          <li class="dd-commit-item${c.hash === currentHash ? ' current' : ''}"
            data-hash="${c.hash}">
            <div class="dd-commit-meta">
              <span class="dd-commit-hash">${shortHash(c.hash)}</span>
              ${c.tag ? `<span class="dd-commit-tag">${escHtml(c.tag)}</span>` : ''}
              <span class="dd-commit-date">${formatRelative(c.timestamp)}</span>
            </div>
            <div class="dd-commit-msg">${escHtml(c.message)}</div>
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

    // ABC play/stop button
    const playBtn = this.el.querySelector('#tb-play');
    if (playBtn) {
      playBtn.addEventListener('click', () => state.emit('abc-play'));
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
    // DSL help modal
    this.el.querySelector('#tb-dsl-help')?.addEventListener('click', () => {
      this._dslMenuOpen = false;
      this._syncDropdowns();
      showDslHelpModal(state.data?.dslType ?? 'markdown');
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
        if (hash) this._onCheckout(hash);
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

function iconPlay() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <polygon points="3,1 14,8 3,15"/>
  </svg>`;
}

function iconStop() {
  return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="12" height="12" rx="2"/>
  </svg>`;
}

function iconHelp() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
    <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/>
  </svg>`;
}

/**
 * Small muted icon representing the document's DSL type.
 * Shown at the far left of the topbar as a clickable menu button.
 */
function iconForDsl(dslType) {
  if (dslType === 'mermaid') {
    // Official mermaid.js logo (trident/mermaid-tail shape)
    return `<svg width="14" height="14" viewBox="0 0 491 491" fill="currentColor">
      <path d="M407.48,111.18C335.587,108.103 269.573,152.338 245.08,220C220.587,152.338 154.573,108.103 82.68,111.18C80.285,168.229 107.577,222.632 154.74,254.82C178.908,271.419 193.35,298.951 193.27,328.27L193.27,379.13L296.9,379.13L296.9,328.27C296.816,298.953 311.255,271.42 335.42,254.82C382.596,222.644 409.892,168.233 407.48,111.18Z"/>
    </svg>`;
  }
  if (dslType === 'abcjs') {
    // Lucide "music" icon — filled note head + stem + flag
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="8" cy="18" r="4"/>
      <path d="M12 18V2l7 4"/>
    </svg>`;
  }
  // Markdown — official markdown-mark (dcurtis/markdown-mark)
  return `<svg width="18" height="11" viewBox="0 0 208 128" fill="currentColor">
    <path d="M193 128H15a15 15 0 0 1-15-15V15A15 15 0 0 1 15 0h178a15 15 0 0 1 15 15v98a15 15 0 0 1-15 15zM50 98V59l20 25 20-25v39h20V30H90L70 55 50 30H30v68zm134-34h-20V30h-20v34h-20l30 35z"/>
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
title: My Document
subtitle: A subtitle
author: Jane Smith
date: 2026-01-01
---</code></pre>
<p class="help-note">YAML block at the top of the document. Renders as a title block above the content.</p>`
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
      {
        title: 'Header Fields',
        content: `<pre><code>X:1           % Reference number (required, must be first)
T:My Song     % Title
C:Composer    % Composer
M:4/4         % Meter (time signature)
L:1/8         % Default note length
Q:1/4=120     % Tempo (quarter note = 120 bpm)
R:reel        % Rhythm
K:G           % Key (must appear before body)</code></pre>
<p class="help-note">Headers go before the music body. <code>K:</code> is required and marks the start of the body.</p>`
      },
      {
        title: 'Notes & Rests',
        content: `<pre><code>C D E F G A B    % lower octave (middle C to B)
c d e f g a b    % upper octave
C, D,            % comma = one octave lower
c' d'            % apostrophe = one octave higher
^C _E =F         % ^sharp  _flat  =natural
z                % rest
Z                % full-bar rest</code></pre>`
      },
      {
        title: 'Note Lengths',
        content: `<pre><code>A     % default length (set by L:)
A2    % double length
A/2   % half length  (also A/)
A3/2  % dotted note (3/2 of default)
A>B   % A dotted, B halved  (A3/2 B/)
A<B   % A halved, B dotted</code></pre>`
      },
      {
        title: 'Barlines & Repeats',
        content: `<pre><code>|       % barline
||      % double barline (end of section)
|]      % thin-thick final barline
|:      % start repeat
:|      % end repeat
::      % end+start repeat
|1      % first ending
|2      % second ending</code></pre>`
      },
      {
        title: 'Chords & Slurs',
        content: `<pre><code>[CEG]   % chord (simultaneous notes)
"G"A    % guitar chord symbol above note
(ABC)   % slur
-       % tie to next note</code></pre>`
      },
      {
        title: 'Multiple Voices',
        content: `<pre><code>V:1 clef=treble
V:2 clef=bass
K:C
[V:1] e2fe d2ed | c2dc B4 |
[V:2] C,4 G,4   | C,8    |</code></pre>`
      },
      {
        title: 'Tablature',
        content: `<pre><code>%%tablature instrument=guitar capo=0 label=Tab
%%tablature instrument=mandolin</code></pre>
<p class="help-note">Instruments: <code>guitar</code>, <code>mandolin</code>, <code>violin</code>, <code>fiddle</code>, <code>fiveString</code>. Place <code>%%tablature</code> directives before <code>K:</code>.</p>`
      },
      {
        title: 'Minimal Example',
        content: `<pre><code>X:1
T:Ode to Joy
M:4/4
L:1/4
Q:100
K:C
E E F G | G F E D | C C D E | E3/2 D/ D2 |</code></pre>`
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

function showDslHelpModal(dslType) {
  const help = DSL_HELP[dslType] ?? DSL_HELP.markdown;

  // Build sections HTML
  const sectionsHtml = help.sections.map(s => `
    <div class="dsl-help-section">
      <h3 class="dsl-help-section-title">${escHtml(s.title)}</h3>
      <div class="dsl-help-section-body">${s.content}</div>
    </div>
  `).join('');

  const overlay = document.createElement('div');
  overlay.className = 'dsl-help-overlay';
  overlay.innerHTML = `
    <div class="dsl-help-modal" role="dialog" aria-modal="true" aria-label="${escHtml(help.name)} syntax reference">
      <div class="dsl-help-header">
        <div class="dsl-help-title">
          <span class="dsl-help-badge">${escHtml(help.name)}</span>
          Syntax Reference
        </div>
        <button class="dsl-help-close" aria-label="Close">&times;</button>
      </div>
      <div class="dsl-help-body">
        ${sectionsHtml}
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

  // Focus the modal for keyboard accessibility
  overlay.querySelector('.dsl-help-modal').focus?.();
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
