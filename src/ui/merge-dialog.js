/**
 * Import & Merge dialog
 *
 * Workflow:
 *   1. User selects a .html unifile to import
 *   2. System loads the file, extracts its VCS data
 *   3. Finds the common ancestor between our HEAD and theirs
 *   4. Shows a three-way diff (ancestor | ours | theirs)
 *   5. User names the import branch, chooses which version wins per hunk
 *   6. On confirm → commits the merge result + imports all commits
 */

import { state, PANELS } from './state.js';
import { unifiedDiff } from '../core/diff.js';
import { VCS } from '../core/vcs.js';
import { shortHash } from '../core/hash.js';

export class MergeDialog {
  constructor(container, handlers = {}) {
    this.el = container;
    this.handlers = handlers;
    this._importedData = null;
    this._importedVcs = null;
    this._branchName = '';
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.MERGE) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    this.el.innerHTML = `
      <div class="dialog-overlay" id="merge-overlay">
        <div class="dialog dialog-wide" role="dialog" aria-modal="true">
          <div class="dialog-header">
            <h2 class="dialog-title">Import & Merge</h2>
            <button class="dialog-close" id="merge-close">&times;</button>
          </div>
          <div class="dialog-body" id="merge-body">
            <div class="merge-step" id="merge-step-1">
              <p class="merge-intro">
                Import another unifile copy. All its commits will be added as a new branch,
                and you can review and merge the differences.
              </p>
              <div class="form-row">
                <label class="form-label" for="merge-branch-name">Import branch name</label>
                <input class="form-input" id="merge-branch-name" type="text"
                  value="import/${Date.now()}" placeholder="import/from-alice">
              </div>
              <div class="merge-dropzone" id="merge-dropzone">
                <p>Drop a unifile .html here or</p>
                <label class="btn btn-primary">
                  Browse…
                  <input type="file" accept=".html,text/html" id="merge-file-input" hidden>
                </label>
              </div>
              <p id="merge-error" class="form-error" hidden></p>
            </div>

            <div class="merge-step" id="merge-step-2" hidden>
              <!-- Populated after file loaded -->
            </div>
          </div>
          <div class="dialog-footer">
            <button class="btn btn-ghost" id="merge-cancel">Cancel</button>
            <button class="btn btn-primary" id="merge-confirm" hidden>Merge</button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';
    this._bindEvents();
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
    this._importedData = null;
    this._importedVcs = null;
  }

  _bindEvents() {
    this.el.querySelector('#merge-close')?.addEventListener('click', () => state.closePanel());
    this.el.querySelector('#merge-cancel')?.addEventListener('click', () => state.closePanel());
    this.el.querySelector('#merge-overlay')?.addEventListener('click', e => {
      if (e.target.id === 'merge-overlay') state.closePanel();
    });

    // File input
    this.el.querySelector('#merge-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) await this._loadFile(file);
    });

    // Drag and drop
    const dz = this.el.querySelector('#merge-dropzone');
    dz?.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz?.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz?.addEventListener('drop', async e => {
      e.preventDefault();
      dz.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) await this._loadFile(file);
    });

    // Merge confirm
    this.el.querySelector('#merge-confirm')?.addEventListener('click', () => this._doMerge());
  }

  async _loadFile(file) {
    const errEl = this.el.querySelector('#merge-error');
    try {
      const html = await file.text();
      const match = html.match(/<script[^>]+id="unifile-data"[^>]*>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('This file is not a valid unifile quine.');

      this._importedData = JSON.parse(match[1]);
      this._importedVcs = new VCS(this._importedData);

      const branchInput = this.el.querySelector('#merge-branch-name');
      this._branchName = branchInput?.value.trim() ||
        `import/${file.name.replace(/\.html$/, '')}`;

      this._showDiff();
      errEl.hidden = true;
    } catch (e) {
      errEl.textContent = e.message;
      errEl.hidden = false;
    }
  }

  _showDiff() {
    const ourVcs = state.vcs;
    const theirVcs = this._importedVcs;

    const ourHead = ourVcs.headHash;
    const theirHead = theirVcs.headHash;

    // Find common ancestor (if we share any history)
    const ancestor = ourVcs.findCommonAncestor(ourHead, theirHead) ??
      // Check using combined commit pool
      this._findAncestorCombined(ourVcs, theirVcs, ourHead, theirHead);

    const ancestorContent = ancestor ? ourVcs.getContentAt(ancestor) : '';
    const ourContent = ourVcs.headContent;
    const theirContent = theirVcs.headContent;

    const step2 = this.el.querySelector('#merge-step-2');
    const confirmBtn = this.el.querySelector('#merge-confirm');

    step2.innerHTML = `
      <div class="merge-info">
        <div class="merge-info-row">
          <span class="merge-label">Common ancestor:</span>
          <span class="merge-val">${ancestor ? shortHash(ancestor) : '(none — no shared history)'}</span>
        </div>
        <div class="merge-info-row">
          <span class="merge-label">Their head:</span>
          <span class="merge-val">${shortHash(theirHead)} — ${escHtml(theirVcs.headCommit?.message ?? '')}</span>
        </div>
        <div class="merge-info-row">
          <span class="merge-label">Import branch name:</span>
          <span class="merge-val">${escHtml(this._branchName)}</span>
        </div>
      </div>

      <div class="merge-diff-cols">
        <div class="merge-col">
          <div class="merge-col-header ours">Ours (${shortHash(ourHead)})</div>
          <pre class="merge-diff-text">${escHtml(ourContent)}</pre>
        </div>
        <div class="merge-col">
          <div class="merge-col-header theirs">Theirs (${shortHash(theirHead)})</div>
          <pre class="merge-diff-text">${escHtml(theirContent)}</pre>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">On merge, keep:</label>
        <div class="merge-radio-group">
          <label class="merge-radio">
            <input type="radio" name="merge-strategy" value="ours" checked>
            Our version (current head)
          </label>
          <label class="merge-radio">
            <input type="radio" name="merge-strategy" value="theirs">
            Their version (import head)
          </label>
          <label class="merge-radio">
            <input type="radio" name="merge-strategy" value="import-only">
            Import branch only (no merge commit)
          </label>
        </div>
      </div>
    `;

    step2.hidden = false;
    this.el.querySelector('#merge-step-1').style.opacity = '0.5';
    confirmBtn.hidden = false;
  }

  _findAncestorCombined(ourVcs, theirVcs, ourHead, theirHead) {
    // Check if any of their commits are in our history
    const ourAncestors = new Set();
    let h = ourHead;
    while (h && ourVcs.commits[h]) {
      ourAncestors.add(h);
      h = ourVcs.commits[h].parent;
    }

    // Walk their chain
    h = theirHead;
    while (h) {
      const c = theirVcs.commits[h];
      if (!c) break;
      if (ourAncestors.has(h)) return h;
      h = c.parent;
    }
    return null;
  }

  async _doMerge() {
    const strategy = this.el.querySelector('input[name="merge-strategy"]:checked')?.value ?? 'ours';
    const confirmBtn = this.el.querySelector('#merge-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Merging…';

    try {
      await this.handlers.onMerge?.({
        importedData: this._importedData,
        branchName: this._branchName,
        strategy
      });
      state.closePanel();
    } catch (e) {
      const errEl = this.el.querySelector('#merge-error');
      errEl.textContent = `Merge failed: ${e.message}`;
      errEl.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Merge';
    }
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
