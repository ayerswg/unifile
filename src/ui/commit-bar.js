/**
 * Mobile commit-pane bottom bar — now a **branch selector**.
 *
 * Composing a commit moved up into the pending node at the top of the commit log
 * (message optional, commit right there).  The bottom bar's job is therefore just
 * branch context + switching/creating, so it stays reachable at the thumb while
 * the log scrolls above it.
 */

import { state } from './state.js';
import { shortHash } from '../core/hash.js';

export class CommitBar {
  /** @param {HTMLElement} el */
  constructor(el) {
    this.el = el;
    this._unsub = [];
    this._open = false;

    this._unsub.push(state.on('change',        () => this.render()));
    this._unsub.push(state.on('branch-switch', () => this.render()));
    this._unsub.push(state.on('checkout',      () => this.render()));
    this.render();

    // Close the drop-up on an outside tap.
    this._onDocClick = (e) => {
      if (this._open && !this.el.contains(e.target)) { this._open = false; this.render(); }
    };
    document.addEventListener('click', this._onDocClick);
  }

  destroy() {
    this._unsub.forEach(fn => fn());
    document.removeEventListener('click', this._onDocClick);
  }

  // ---------------------------------------------------------------------------

  render() {
    const vcs = state.vcs;
    const branch = state.currentBranch;
    const detached = state.isDetached;
    const branches = vcs?.listBranches?.() ?? [];

    this.el.innerHTML = `
      <div class="cbb">
        <button class="cbb-branch${detached ? ' detached' : ''}" id="cbb-toggle"
          aria-haspopup="listbox" aria-expanded="${this._open}"
          title="${detached ? 'Detached HEAD' : `Branch: ${_esc(branch)}`}">
          ${_iconBranch()}
          <span class="cbb-branch-name">${detached ? '⚠ detached' : _esc(branch)}</span>
          <span class="cbb-caret" aria-hidden="true">▾</span>
        </button>
        <div class="cbb-menu${this._open ? ' open' : ''}" role="listbox">
          <div class="cbb-menu-label">Switch branch</div>
          ${branches.map(b => `
            <button class="cbb-item${b.isCurrent && !detached ? ' current' : ''}"
              data-branch="${_esc(b.name)}" role="option">
              <span class="cbb-item-icon">${b.isCurrent && !detached ? '●' : '○'}</span>
              <span class="cbb-item-name">${_esc(b.name)}</span>
              <span class="cbb-item-hash">${_esc(shortHash(b.head))}</span>
            </button>`).join('')}
          <button class="cbb-item cbb-new" id="cbb-new">
            <span class="cbb-item-icon">＋</span>
            <span class="cbb-item-name">New branch…</span>
          </button>
        </div>
      </div>`;

    this.el.querySelector('#cbb-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._open = !this._open;
      this.render();
    });
    this.el.querySelectorAll('.cbb-item[data-branch]').forEach(it => {
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        this._open = false;
        this._switchBranch(it.dataset.branch);
      });
    });
    this.el.querySelector('#cbb-new')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._open = false;
      this._newBranch();
    });
  }

  /** Stash-aware branch switch (mirrors the topbar dropdown's behaviour). */
  _switchBranch(name) {
    if (!name || !state.vcs || name === state.currentBranch && !state.isDetached) { this.render(); return; }
    if (state.isDirty) state.stash = { content: state.currentContent, fromHash: state.headHash };
    const baseContent = state.vcs.switchBranch(name);
    const newHash = state.vcs.headHash;
    let content = baseContent;
    if (state.stash && state.stash.fromHash === newHash) { content = state.stash.content; state.stash = null; }
    state.update({ currentContent: content, isDirty: content !== baseContent });
    state.emit('branch-switch', { name, content });
  }

  _newBranch() {
    const name = (window.prompt('New branch name:') || '').trim();
    if (!name) return;
    if (!/^[A-Za-z0-9/_-]+$/.test(name)) { window.alert('Branch name may only contain letters, numbers, /, _ and -'); return; }
    try {
      state.vcs.createBranch(name, state.headHash);
    } catch (err) {
      window.alert(err?.message || 'Could not create branch.');
      return;
    }
    // Keep the serialized branch list in sync, then switch onto the new branch.
    state.update({ data: { ...state.data, ...state.vcs.serialize() } });
    this._switchBranch(name);
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _iconBranch() {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/>
    <path d="M4 5v6M4 9.5C4 7 12 9 12 7.5"/></svg>`;
}
