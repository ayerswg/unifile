/**
 * Mobile commit bar — the bottom bar shown when the commit (left) pane is
 * centred on a phone.  It makes the version-control state clear and actionable
 * without leaving the pane:
 *   • which branch you're on + a tap-to-switch menu
 *   • whether there are uncommitted changes
 *   • a message field (+ optional SemVer) to commit a new change
 *
 * Reuses the app's onCommit handler (same path as the desktop commit dialog) and
 * the cached identity from user prefs; if no identity is saved yet it falls back
 * to opening the full commit dialog so the user can enter name/email once.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs } from '../core/storage.js';

export class CommitBar {
  /** @param {HTMLElement} el  @param {{onCommit:Function}} handlers */
  constructor(el, handlers = {}) {
    this.el = el;
    this.onCommit = handlers.onCommit;
    this._unsub = [];
    this._branchOpen = false;
    this._busy = false;

    this._unsub.push(state.on('change',         () => this.render()));
    this._unsub.push(state.on('content-change', () => this._syncDirty()));
    this._unsub.push(state.on('branch-switch',  () => this.render()));
    this._unsub.push(state.on('checkout',       () => this.render()));
    this.render();
  }

  destroy() { this._unsub.forEach(fn => fn()); }

  // ---------------------------------------------------------------------------

  render() {
    const vcs = state.vcs;
    const dirty = state.isDirty;
    const head = vcs?.log?.()?.[0];
    const suggested = head?.tag ? _incPatch(head.tag) : '';

    // Branch + dirty state live in the top-bar chip now; this bar is just the
    // commit composer (message + optional version + Commit).
    this.el.innerHTML = `
      <div class="cb">
        <div class="cb-row cb-compose">
          <input class="cb-msg" id="cb-msg" type="text" autocomplete="off"
            placeholder="${dirty ? 'Describe your change…' : 'No changes to commit'}"
            ${dirty ? '' : 'disabled'}>
          <input class="cb-ver" id="cb-ver" type="text" autocomplete="off"
            placeholder="v ${suggested || '0.0.0'}" value="${_esc(suggested)}"
            ${dirty ? '' : 'disabled'} aria-label="Version (optional)">
          <button class="cb-commit" id="cb-commit" ${dirty && !this._busy ? '' : 'disabled'}>Commit</button>
        </div>
      </div>`;

    this.el.querySelector('#cb-commit')?.addEventListener('click', () => this._commit());
    // Enter in the message field commits.
    this.el.querySelector('#cb-msg')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._commit(); }
    });
  }

  _syncDirty() {
    // Cheap update: re-render only if the dirty flag flipped the disabled state.
    const enabled = !this.el.querySelector('#cb-commit')?.disabled;
    if (enabled !== !!state.isDirty) this.render();
  }

  async _commit() {
    if (this._busy || !state.isDirty || !this.onCommit) return;
    const msg = this.el.querySelector('#cb-msg')?.value.trim();
    if (!msg) { this.el.querySelector('#cb-msg')?.focus(); return; }
    const tag = this.el.querySelector('#cb-ver')?.value.trim() || undefined;
    const prefs = loadUserPrefs();
    if (!prefs?.name || !prefs?.email) {
      // No saved identity → open the full dialog to capture name/email, but
      // carry the message + version the user already typed so they aren't lost.
      state.pendingCommit = { message: msg, tag };
      state.openPanel(PANELS.COMMIT);
      return;
    }
    this._busy = true; this.render();
    try {
      await this.onCommit({ author: prefs.name, email: prefs.email, message: msg, tag });
    } catch (err) {
      console.warn('[commit-bar] commit failed:', err?.message);
    } finally {
      this._busy = false; this.render();
    }
  }
}

/** Bump the patch of a `major.minor.patch` string (mirrors commit-dialog). */
function _incPatch(semver) {
  const m = String(semver).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return '';
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _iconBranch() {
  return `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
    <circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/>
    <path d="M4 5v6M4 9.5C4 7 12 9 12 7.5"/></svg>`;
}
