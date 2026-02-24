/**
 * Settings panel
 *
 * Opens when the user clicks the ⚙ gear icon.
 * Lets the user update their display name, email, and colour theme.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { applyTheme } from './theme.js';

export class SettingsPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.el = container;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.SETTINGS) this.show();
      else this.hide();
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const prefs = loadUserPrefs();
    const theme = prefs.theme ?? 'auto';

    this.el.innerHTML = `
      <div class="dialog-overlay" id="settings-overlay">
        <div class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div class="dialog-header">
            <h2 class="dialog-title" id="settings-title">Settings</h2>
            <button class="dialog-close" id="settings-close" aria-label="Close">&times;</button>
          </div>

          <div class="dialog-body">
            <!-- ── Identity ───────────────────────────────────────────── -->
            <p class="settings-intro">
              Your identity is used as the commit author. Cached locally in this
              browser and never shared.
            </p>

            <div class="form-row">
              <label class="form-label" for="settings-name">
                Display name <span class="required">*</span>
              </label>
              <input class="form-input" id="settings-name" type="text"
                value="${escHtml(prefs.name ?? '')}"
                placeholder="Your Name" autocomplete="name">
            </div>

            <div class="form-row">
              <label class="form-label" for="settings-email">
                Email <span class="required">*</span>
              </label>
              <input class="form-input" id="settings-email" type="email"
                value="${escHtml(prefs.email ?? '')}"
                placeholder="you@example.com" autocomplete="email">
            </div>

            <!-- ── Appearance ─────────────────────────────────────────── -->
            <div class="settings-section-label">Appearance</div>

            <div class="form-row">
              <label class="form-label">Colour theme</label>
              <div class="theme-toggle-group" role="group" aria-label="Colour theme">
                <button class="theme-toggle-btn${theme === 'dark'  ? ' active' : ''}"
                  data-theme-pref="dark"  title="Always dark (Catppuccin Mocha)">
                  🌙 Dark
                </button>
                <button class="theme-toggle-btn${theme === 'auto'  ? ' active' : ''}"
                  data-theme-pref="auto"  title="Follow operating system setting">
                  🖥 Auto
                </button>
                <button class="theme-toggle-btn${theme === 'light' ? ' active' : ''}"
                  data-theme-pref="light" title="Always light (Catppuccin Latte)">
                  ☀️ Light
                </button>
              </div>
            </div>

            <p id="settings-error" class="form-error" hidden></p>
            <p id="settings-saved" class="form-success" hidden>Settings saved.</p>
          </div>

          <div class="dialog-footer">
            <button class="btn btn-ghost" id="settings-cancel">Cancel</button>
            <button class="btn btn-primary" id="settings-save">Save</button>
          </div>
        </div>
      </div>
    `;

    this.el.style.display = '';
    setTimeout(() => this.el.querySelector('#settings-name')?.focus(), 50);
    this._bindEvents();
  }

  hide() {
    this.el.innerHTML = '';
    this.el.style.display = 'none';
  }

  _bindEvents() {
    const overlay   = this.el.querySelector('#settings-overlay');
    const closeBtn  = this.el.querySelector('#settings-close');
    const cancelBtn = this.el.querySelector('#settings-cancel');
    const saveBtn   = this.el.querySelector('#settings-save');

    closeBtn?.addEventListener('click',  () => state.closePanel());
    cancelBtn?.addEventListener('click', () => state.closePanel());
    overlay?.addEventListener('click',   (e) => { if (e.target === overlay) state.closePanel(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') state.closePanel();
    }, { once: true });

    saveBtn?.addEventListener('click', () => this._save());
    this.el.querySelector('#settings-email')
      ?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._save(); });

    // Theme toggle — live preview (applies immediately, no Save needed)
    this.el.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pref = btn.dataset.themePref;
        applyTheme(pref);
        this.el.querySelectorAll('.theme-toggle-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.themePref === pref);
        });
      });
    });
  }

  _save() {
    const name  = this.el.querySelector('#settings-name')?.value.trim();
    const email = this.el.querySelector('#settings-email')?.value.trim();
    const errEl   = this.el.querySelector('#settings-error');
    const savedEl = this.el.querySelector('#settings-saved');

    errEl.hidden   = true;
    savedEl.hidden = true;

    if (!name) {
      errEl.textContent = 'Display name is required.';
      errEl.hidden = false; return;
    }
    if (!email || !email.includes('@')) {
      errEl.textContent = 'A valid email is required.';
      errEl.hidden = false; return;
    }

    saveUserPrefs({ name, email });
    state.update({ user: { name, email } });

    savedEl.hidden = false;
    setTimeout(() => state.closePanel(), 800);
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
