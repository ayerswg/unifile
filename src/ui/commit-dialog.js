/**
 * Commit dialog
 *
 * Fields:
 *   Author / Email  – only shown on FIRST USE (no cached prefs). After that
 *                     the cached identity is shown as read-only info text and
 *                     the user changes it via the ⚙ Settings panel instead.
 *   Message         – required
 *   SemVer tag      – optional
 *   Branch name     – required ONLY when in detached HEAD state; the new
 *                     branch is automatically created on commit.
 *
 * On submit → calls handler with commit data.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';

export class CommitDialog {
  /**
   * @param {HTMLElement} container – the panel/overlay container
   * @param {{ onCommit: (opts) => Promise<void> }} handlers
   */
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.COMMIT) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const prefs = loadUserPrefs();
    const hasCachedIdentity = !!(prefs.name && prefs.email);
    const isDetached = state.isDetached;
    const head = state.vcs?.headCommit;
    const suggestedTag = head?.tag ? incrementPatch(head.tag) : '';

    // ── Identity section ───────────────────────────────────────────────────
    const identitySection = hasCachedIdentity
      ? `<div class="commit-identity-row">
           <span class="commit-identity-avatar">${initials(prefs.name)}</span>
           <div class="commit-identity-info">
             <strong>${escHtml(prefs.name)}</strong>
             <span>${escHtml(prefs.email)}</span>
           </div>
         </div>`
      : `<div class="form-row">
           <label class="form-label" for="commit-author">
             Author name <span class="required">*</span>
           </label>
           <input class="form-input" id="commit-author" type="text"
             value="${escHtml(prefs.name ?? '')}"
             placeholder="Your Name" required autocomplete="name">
         </div>
         <div class="form-row">
           <label class="form-label" for="commit-email">
             Email <span class="required">*</span>
           </label>
           <input class="form-input" id="commit-email" type="email"
             value="${escHtml(prefs.email ?? '')}"
             placeholder="you@example.com" required autocomplete="email">
         </div>`;

    // ── Detached HEAD notice + branch name field ───────────────────────────
    const detachedSection = isDetached
      ? `<div class="detached-commit-notice">
           <span class="detached-commit-icon">⚠</span>
           <span>You're viewing a historical commit. This change will live on a new branch.</span>
         </div>
         <div class="form-row">
           <label class="form-label" for="commit-branch">
             New branch name <span class="required">*</span>
           </label>
           <input class="form-input" id="commit-branch" type="text"
             placeholder="feature/my-changes"
             required pattern="[A-Za-z0-9/_-]+" autocomplete="off">
         </div>`
      : '';

    this.el.innerHTML = `
      <div class="dialog-overlay" id="commit-overlay">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="commit-title">
          <div class="dialog-header">
            <h2 class="dialog-title" id="commit-title">Commit Changes</h2>
            <button class="dialog-close" id="commit-close" aria-label="Close">&times;</button>
          </div>

          <div class="dialog-body">
            <div class="diff-summary">
              ${this._renderDiffSummary()}
            </div>

            ${identitySection}
            ${detachedSection}

            <div class="form-row">
              <label class="form-label" for="commit-message">
                Commit message <span class="required">*</span>
              </label>
              <textarea class="form-input form-textarea" id="commit-message"
                placeholder="Describe your changes…" required rows="3"></textarea>
            </div>

            <div class="form-row">
              <label class="form-label" for="commit-tag">
                SemVer tag
                <span class="form-hint">(optional, e.g. 1.2.3)</span>
              </label>
              <input class="form-input" id="commit-tag" type="text"
                value="${escHtml(suggestedTag)}"
                placeholder="1.0.0" pattern="\\d+\\.\\d+\\.\\d+.*">
            </div>

            <p id="commit-error" class="form-error" hidden></p>
          </div>

          <div class="dialog-footer">
            <button class="btn btn-ghost" id="commit-cancel">Cancel</button>
            <button class="btn btn-primary" id="commit-submit">
              ${iconCommit()} Commit
            </button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';

    // Focus branch name field (if detached) else message field
    setTimeout(() => {
      const focus = isDetached
        ? this.el.querySelector('#commit-branch')
        : this.el.querySelector('#commit-message');
      if (focus) focus.focus();
    }, 50);

    this._bindEvents(hasCachedIdentity, isDetached);
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _renderDiffSummary() {
    const vcs = state.vcs;
    if (!vcs || !state.isDirty) return '<p class="diff-none">No staged changes.</p>';

    const oldContent = vcs.headContent;
    const newContent = state.currentContent;

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const added = Math.max(0, newLines.length - oldLines.length);
    const removed = Math.max(0, oldLines.length - newLines.length);

    return `
      <div class="diff-stats">
        <span class="diff-added">+${added} line${added !== 1 ? 's' : ''}</span>
        <span class="diff-removed">−${removed} line${removed !== 1 ? 's' : ''}</span>
        <span class="diff-from">from ${state.shortHeadHash || '(new)'}</span>
      </div>
    `;
  }

  _bindEvents(hasCachedIdentity, isDetached) {
    const closeBtn = this.el.querySelector('#commit-close');
    const cancelBtn = this.el.querySelector('#commit-cancel');
    const submitBtn = this.el.querySelector('#commit-submit');
    const overlay = this.el.querySelector('#commit-overlay');

    closeBtn?.addEventListener('click', () => state.closePanel());
    cancelBtn?.addEventListener('click', () => state.closePanel());

    // Close on overlay click
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) state.closePanel();
    });

    // ESC to close
    document.addEventListener('keydown', this._escHandler = (e) => {
      if (e.key === 'Escape') state.closePanel();
    }, { once: true });

    submitBtn?.addEventListener('click', () => this._submit(hasCachedIdentity, isDetached));

    // Ctrl/Cmd+Enter in message or branch field to submit
    ['#commit-message', '#commit-branch'].forEach(sel => {
      this.el.querySelector(sel)?.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          this._submit(hasCachedIdentity, isDetached);
        }
      });
    });
  }

  async _submit(hasCachedIdentity, isDetached) {
    const prefs = loadUserPrefs();
    const errEl = this.el.querySelector('#commit-error');

    const setError = (msg) => {
      errEl.textContent = msg;
      errEl.hidden = false;
    };

    // Identity
    let author, email;
    if (hasCachedIdentity) {
      author = prefs.name;
      email = prefs.email;
    } else {
      author = this.el.querySelector('#commit-author')?.value.trim();
      email = this.el.querySelector('#commit-email')?.value.trim();
      if (!author) { setError('Author name is required.'); return; }
      if (!email || !email.includes('@')) { setError('A valid email is required.'); return; }
    }

    // Branch name (detached only)
    const branchName = isDetached
      ? this.el.querySelector('#commit-branch')?.value.trim()
      : undefined;
    if (isDetached && !branchName) {
      setError('A branch name is required when committing from a historical commit.');
      return;
    }
    if (branchName && !/^[A-Za-z0-9/_-]+$/.test(branchName)) {
      setError('Branch name may only contain letters, numbers, /, _ and -');
      return;
    }

    const message = this.el.querySelector('#commit-message')?.value.trim();
    const tag = this.el.querySelector('#commit-tag')?.value.trim();

    if (!message) { setError('Commit message is required.'); return; }
    if (tag && !/^\d+\.\d+\.\d+/.test(tag)) {
      setError('Tag must be a valid SemVer string (e.g. 1.2.3).');
      return;
    }

    errEl.hidden = true;
    const submitBtn = this.el.querySelector('#commit-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Committing…';

    // Cache identity for next time (skip if already cached)
    if (!hasCachedIdentity) {
      saveUserPrefs({ name: author, email });
    }

    try {
      await this.handlers.onCommit?.({
        author,
        email,
        message,
        tag: tag || null,
        branchName: branchName || undefined
      });
      state.closePanel();
    } catch (err) {
      setError(`Commit failed: ${err.message}`);
      submitBtn.disabled = false;
      submitBtn.innerHTML = `${iconCommit()} Commit`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iconCommit() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
    <line x1="1" y1="8" x2="5" y2="8" stroke="currentColor" stroke-width="2"/>
    <line x1="11" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2"/>
  </svg>`;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function incrementPatch(semver) {
  const m = semver.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return '';
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
}

/** Generate 1-2 initials from a display name. */
function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}
