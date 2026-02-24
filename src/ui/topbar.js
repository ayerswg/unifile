/**
 * Top bar component
 *
 * Layout (left → right):
 *   [editable title]  [DSL type label]  [↑commit]  [branch ▾][hash ▾]  [⋯]  [⚙]
 *
 * The view-mode toggle (Editor / Split / Preview) has been moved to the
 * pane divider bar — click it to cycle through modes.
 *
 * Two independent VCS dropdowns:
 *   - Branch pill  → lists all branches; click to switch
 *   - Commit pill  → lists commits on current branch; click to checkout
 *
 * The commit trigger (↑) is a small icon button to the left of the pill group.
 * It is invisible when no changes exist and lights up in accent colour when dirty.
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
    this._toolsOpen = false;
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
        <span class="dsl-icon" title="Document type: ${escHtml(dslType)}" aria-label="${escHtml(dslType)}">
          ${iconForDsl(dslType)}
        </span>
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
          <!-- Subtle commit trigger — invisible when clean, accent when dirty -->
          <button class="topbar-btn commit-btn${isDirty ? ' dirty' : ''}" id="tb-commit"
            title="Commit changes (Ctrl+S)" ${isDirty ? '' : 'disabled'}>
            ${iconCommit()}
          </button>

          <div class="vcs-pill-group">
            <button class="vcs-pill branch-pill${isDetached ? ' detached' : ''}" id="tb-branch-toggle"
              title="${isDetached ? 'Detached HEAD — click to manage branches' : `Branch: ${escHtml(branch)}`}">
              ${iconBranch()}
              <span class="vcs-pill-text">${isDetached ? '⚠ detached' : escHtml(branch)}</span>
              <span class="vcs-pill-caret">▾</span>
            </button>
            <button class="vcs-pill commit-pill${isDirty ? ' dirty' : ''}" id="tb-commit-toggle"
              title="Commit: ${escHtml(hash)}${isDirty ? ' (uncommitted changes)' : ''}">
              <span class="vcs-pill-text vcs-pill-mono">${escHtml(hash)}</span>
              ${isDirty ? '<span class="dirty-dot" title="Uncommitted changes">●</span>' : ''}
              <span class="vcs-pill-caret">▾</span>
            </button>
          </div>

          <button class="topbar-btn topbar-btn--icon${this._toolsOpen ? ' active' : ''}"
            id="tb-tools-toggle" title="Tools">
            ${iconEllipsis()}
          </button>

          <button class="topbar-btn topbar-btn--icon" id="tb-settings" title="Settings (Ctrl+Shift+,)">
            ${iconGear()}
          </button>
        </div>
      </div>

      <div class="vcs-dropdown tools-dropdown${this._toolsOpen ? ' open' : ''}" id="tb-tools-dd">
        ${this._renderToolsList()}
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
    const pill = this.el.querySelector('#tb-commit-toggle');
    const btn  = this.el.querySelector('#tb-commit');

    if (pill) {
      pill.classList.toggle('dirty', state.isDirty);
      const dot = pill.querySelector('.dirty-dot');
      if (state.isDirty && !dot) {
        const pillText = pill.querySelector('.vcs-pill-mono');
        if (pillText) {
          pillText.insertAdjacentHTML('afterend', '<span class="dirty-dot" title="Uncommitted changes">●</span>');
        }
      } else if (!state.isDirty && dot) {
        dot.remove();
      }
    }
    if (btn) {
      btn.disabled = !state.isDirty;
      btn.classList.toggle('dirty', state.isDirty);
    }
  }

  // ---------------------------------------------------------------------------
  // Dropdown content
  // ---------------------------------------------------------------------------

  _renderToolsList() {
    const hasCommits = (state.vcs?.log()?.length ?? 0) > 0;
    return `
      <ul class="tools-menu-list">
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

    // Commit button
    const commitBtn = this.el.querySelector('#tb-commit');
    if (commitBtn) {
      commitBtn.addEventListener('click', () => state.openPanel(PANELS.COMMIT));
    }

    // Settings gear
    const settingsBtn = this.el.querySelector('#tb-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        if (state.activePanel === PANELS.SETTINGS) state.closePanel();
        else state.openPanel(PANELS.SETTINGS);
      });
    }

    // Tools ⋯ toggle
    const toolsBtn = this.el.querySelector('#tb-tools-toggle');
    if (toolsBtn) {
      toolsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toolsOpen = !this._toolsOpen;
        if (this._toolsOpen) { this._branchOpen = false; this._commitOpen = false; }
        this._syncDropdowns();
      });
    }

    // Branch pill toggle
    const branchBtn = this.el.querySelector('#tb-branch-toggle');
    if (branchBtn) {
      branchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._branchOpen = !this._branchOpen;
        if (this._branchOpen) { this._commitOpen = false; this._toolsOpen = false; }
        this._syncDropdowns();
      });
    }

    // Commit pill toggle
    const commitPillBtn = this.el.querySelector('#tb-commit-toggle');
    if (commitPillBtn) {
      commitPillBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._commitOpen = !this._commitOpen;
        if (this._commitOpen) { this._branchOpen = false; this._toolsOpen = false; }
        this._syncDropdowns();
      });
    }

    // Close all dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!this.el.contains(e.target)) {
        this._branchOpen = false;
        this._commitOpen = false;
        this._toolsOpen = false;
        this._syncDropdowns();
      }
    });

    this._bindDropdownEvents();
  }

  _syncDropdowns() {
    // Tools dropdown
    const toolsDd = this.el.querySelector('#tb-tools-dd');
    if (toolsDd) {
      toolsDd.classList.toggle('open', this._toolsOpen);
      if (this._toolsOpen) toolsDd.innerHTML = this._renderToolsList();
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
    // Sync the ⋯ button active state
    const toolsBtn = this.el.querySelector('#tb-tools-toggle');
    if (toolsBtn) toolsBtn.classList.toggle('active', this._toolsOpen);

    this._bindDropdownEvents();
  }

  _bindDropdownEvents() {
    // Tools menu items
    this.el.querySelector('#tb-blame')?.addEventListener('click', () => {
      if (!this.el.querySelector('#tb-blame')?.classList.contains('disabled')) {
        this._toolsOpen = false;
        this._syncDropdowns();
        if (state.activePanel === PANELS.BLAME) state.closePanel();
        else state.openPanel(PANELS.BLAME);
      }
    });
    this.el.querySelector('#tb-export')?.addEventListener('click', () => {
      this._toolsOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.EXPORT) state.closePanel();
      else state.openPanel(PANELS.EXPORT);
    });
    this.el.querySelector('#tb-merge')?.addEventListener('click', () => {
      this._toolsOpen = false;
      this._syncDropdowns();
      if (state.activePanel === PANELS.MERGE) state.closePanel();
      else state.openPanel(PANELS.MERGE);
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
    <path d="M6.5 1h3l.4 1.6a5 5 0 011 .6l1.5-.7 2.1 2.1-.7 1.5a5 5 0 01.6 1L16 7.5v3l-1.6.4a5 5 0 01-.6 1l.7 1.5-2.1 2.1-1.5-.7a5 5 0 01-1 .6L9.5 17h-3l-.4-1.6a5 5 0 01-1-.6l-1.5.7L1.5 13.4l.7-1.5a5 5 0 01-.6-1L0 10.5v-3l1.6-.4a5 5 0 01.6-1l-.7-1.5L3.6 2.5l1.5.7a5 5 0 011-.6L6.5 1zM8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
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

/**
 * Small muted icon representing the document's DSL type.
 * Shown at the far left of the topbar, before the title.
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
