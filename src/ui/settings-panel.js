/**
 * Settings panel
 *
 * Opens when the user clicks the ⚙ gear icon.
 * Lets the user update their display name, email, and colour theme.
 */

import { state, PANELS } from './state.js';
import { loadUserPrefs, saveUserPrefs } from '../core/storage.js';
import { applyTheme } from './theme.js';
import { checkForUpdate } from './update-check.js';
import { isDriveSupported, listAppFiles } from '../core/gdrive.js';

// Stamped by esbuild `define` in build.mjs (from the latest git tag); guard for
// any non-built context (e.g. raw ESM in tests).
const APP_VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';

export class SettingsPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.el = container;
    this._unsub = [];

    this._unsub.push(state.on('panel-change', (panel) => {
      if (panel === PANELS.SETTINGS) this.show();
      else this.hide();
    }));

    // Drive push/pull status (if the panel is open).
    this._unsub.push(state.on('drive-status', (s) => {
      const el = this.el.querySelector('#settings-drive-status');
      if (!el) return;
      el.textContent = s?.msg ?? '';
      el.className = 'settings-update-status' + (s?.error ? ' is-error' : s?.ok ? ' is-update' : '');
    }));
  }

  destroy() {
    this._unsub.forEach(fn => fn());
  }

  show() {
    const prefs = loadUserPrefs();
    const theme = prefs.theme ?? 'auto';
    const driveSupported = isDriveSupported();

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

            <!-- ── Updates ────────────────────────────────────────────── -->
            <div class="settings-section-label">Updates</div>
            <label class="settings-check">
              <input type="checkbox" id="settings-rc" ${prefs.updateChannel === 'rc' ? 'checked' : ''}>
              <span>Receive release candidates
                <small>Get pre-release (rc) builds early. Off = stable releases only.</small>
              </span>
            </label>
            <div class="settings-update-row">
              <button class="btn btn-ghost" id="settings-check-update" type="button">Check for updates</button>
              <span class="settings-update-status" id="settings-update-status" aria-live="polite"></span>
            </div>

            <!-- ── Sync (Google Drive) ────────────────────────────────── -->
            <div class="settings-section-label">Sync — Google Drive</div>
            <p class="settings-intro">
              Push/pull this document (+ full history) to one file in your own
              Google Drive. Data goes browser → your Drive directly; this site
              never sees it.${driveSupported ? '' : ' <strong>Requires the hosted app or installed PWA (not a downloaded file).</strong>'}
            </p>
            <div class="form-row">
              <label class="form-label" for="settings-gclient">Google OAuth client ID</label>
              <input class="form-input" id="settings-gclient" type="text"
                value="${escHtml(prefs.googleClientId ?? '')}"
                placeholder="…apps.googleusercontent.com" autocomplete="off" spellcheck="false">
            </div>
            <div class="settings-update-row">
              <button class="btn btn-ghost" id="settings-drive-push" type="button"${driveSupported ? '' : ' disabled'}>Push to Drive</button>
              <button class="btn btn-ghost" id="settings-drive-pull" type="button"${driveSupported ? '' : ' disabled'}>Pull from Drive</button>
              <button class="btn btn-ghost" id="settings-drive-choose" type="button"${driveSupported ? '' : ' disabled'}>Choose…</button>
              <span class="settings-update-status" id="settings-drive-status" aria-live="polite"></span>
            </div>
            <div class="settings-drive-files" id="settings-drive-files"></div>

            <!-- ── About ──────────────────────────────────────────────── -->
            <div class="settings-section-label">About</div>
            <p class="settings-about">
              Unifile <span class="settings-version">v${escHtml(APP_VERSION)}</span>
            </p>
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

    // Release-candidate opt-in — saved immediately, then re-check so opting in
    // can surface a pending RC right away.
    const rcToggle = this.el.querySelector('#settings-rc');
    rcToggle?.addEventListener('change', () => {
      saveUserPrefs({ updateChannel: rcToggle.checked ? 'rc' : 'stable' });
      this._checkUpdate();
    });

    // Manual "Check for updates" — forces a cache-busting check.
    this.el.querySelector('#settings-check-update')
      ?.addEventListener('click', () => this._checkUpdate());

    // Google Drive sync.
    const gclient = this.el.querySelector('#settings-gclient');
    const persistClient = () => saveUserPrefs({ googleClientId: gclient.value.trim() });
    gclient?.addEventListener('change', persistClient);
    this.el.querySelector('#settings-drive-push')?.addEventListener('click', () => { persistClient(); state.emit('drive-push'); });
    this.el.querySelector('#settings-drive-pull')?.addEventListener('click', () => { persistClient(); state.emit('drive-pull'); });
    this.el.querySelector('#settings-drive-choose')?.addEventListener('click', () => { persistClient(); this._driveChoose(); });
  }

  /** List the app's Drive files and let the user pick one to pull. */
  async _driveChoose() {
    const filesEl  = this.el.querySelector('#settings-drive-files');
    const statusEl = this.el.querySelector('#settings-drive-status');
    if (!filesEl) return;
    filesEl.innerHTML = '<div class="settings-drive-empty">Loading your Drive files…</div>';
    try {
      const files = await listAppFiles({ clientId: loadUserPrefs().googleClientId });
      if (!files.length) { filesEl.innerHTML = '<div class="settings-drive-empty">No unifile files found in your Drive.</div>'; return; }
      filesEl.innerHTML = files.map(f => `
        <button class="settings-drive-file" data-id="${escHtml(f.id)}" type="button">
          <span class="sdf-name">${escHtml(f.name)}</span>
          <span class="sdf-date">${escHtml(_fmtDate(f.modifiedTime))}</span>
        </button>`).join('');
      filesEl.querySelectorAll('.settings-drive-file').forEach(b =>
        b.addEventListener('click', () => { filesEl.innerHTML = ''; state.emit('drive-pull', { fileId: b.dataset.id }); }));
    } catch (e) {
      filesEl.innerHTML = '';
      if (statusEl) { statusEl.textContent = e?.message ?? String(e); statusEl.className = 'settings-update-status is-error'; }
    }
  }

  async _checkUpdate() {
    const statusEl = this.el.querySelector('#settings-update-status');
    const btn = this.el.querySelector('#settings-check-update');
    if (!statusEl) return;
    statusEl.textContent = 'Checking…';
    statusEl.className = 'settings-update-status';
    if (btn) btn.disabled = true;
    try {
      const r = await checkForUpdate({ force: true });
      switch (r.status) {
        case 'update':
          statusEl.textContent = `Update available: v${r.remote} — see the banner to apply.`;
          statusEl.classList.add('is-update');
          break;
        case 'current':
          statusEl.textContent = `You're on the latest (v${r.current}).`;
          break;
        case 'file':
          statusEl.textContent = "Can't check from a downloaded file — open the hosted app or PWA.";
          break;
        default:
          statusEl.textContent = "Couldn't reach the update server. Try again later.";
      }
    } finally {
      if (btn) btn.disabled = false;
    }
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

function _fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return ''; }
}
