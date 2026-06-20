/**
 * Update check — compares the build's baked version (UNIFILE_VERSION, stamped
 * from the latest git tag at build time) against the published /version.json on
 * the site.  If a newer release exists, shows a small banner with an "Update"
 * button.  For an installed PWA / hosted page the button reloads to apply the new
 * service worker; for a file:// download we skip (cross-origin fetch is blocked).
 */

import { state } from './state.js';
import { loadUserPrefs, IS_QUINE } from '../core/storage.js';

// Stamped by esbuild `define` in build.mjs; guard for any non-built context.
const VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';

/** Parse `1.2.3-rc.4` → { core:[1,2,3], pre:['rc','4'] | null } (leading v stripped). */
function _parse(v) {
  const [core, pre] = String(v).trim().replace(/^v/, '').split('-');
  const n = core.split('.').map(x => parseInt(x, 10) || 0);
  return { core: [n[0] || 0, n[1] || 0, n[2] || 0], pre: pre ? pre.split('.') : null };
}

/**
 * SemVer 2.0 precedence compare → +1 if a > b, -1 if a < b, 0 if equal.
 * Crucially: a release outranks its pre-releases (1.0.0 > 1.0.0-rc.2), and
 * pre-release identifiers compare per spec (rc.2 > rc.1; numeric < alphanumeric).
 */
function _cmp(a, b) {
  const A = _parse(a), B = _parse(b);
  for (let i = 0; i < 3; i++) if (A.core[i] !== B.core[i]) return A.core[i] > B.core[i] ? 1 : -1;
  if (!A.pre && !B.pre) return 0;
  if (!A.pre) return 1;          // a is the final release → newer than any pre-release
  if (!B.pre) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;   // shorter pre-release set has lower precedence
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x > +y ? 1 : -1; }
    else if (xn !== yn) return xn ? -1 : 1;   // numeric identifiers rank below alphanumeric
    else if (x !== y) return x > y ? 1 : -1;   // ASCII order
  }
  return 0;
}

/** Is `remote` a newer version than `local`? */
function isNewer(remote, local) { return _cmp(remote, local) > 0; }

/** True if the user has opted into the release-candidate channel (Settings). */
export function isRcChannel() {
  return loadUserPrefs().updateChannel === 'rc';
}

/**
 * Pick the version to compare against, honouring the user's channel:
 *   • stable channel → the latest stable (no pre-release)
 *   • rc channel     → the latest overall (may be a pre-release)
 * Falls back to the legacy single `version` field for older version.json files.
 */
function _target(data) {
  const stable = data.stable ?? data.version;
  const latest = data.latest ?? data.version;
  return isRcChannel() ? (latest ?? stable) : stable;
}

/**
 * Check the published version.json and, if a newer build exists on the user's
 * channel, show the update banner.
 *
 * @param {{force?: boolean}} [opts]  force = manual check (Settings button).
 * @returns {Promise<{status:'update'|'current'|'file'|'error', current:string, remote?:string}>}
 */
export async function checkForUpdate({ force } = {}) {
  // Opened from disk: a cross-origin fetch to the site would be CORS-blocked.
  if (location.protocol === 'file:') return { status: 'file', current: VERSION };
  try {
    // Cache-bust so an intermediary/CDN edge cache can't hand us a stale file —
    // the usual reason a fresh release "isn't detected".
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return { status: 'error', current: VERSION };
    const data = await res.json();
    const remote = _target(data);
    if (remote && isNewer(remote, VERSION)) {
      _showBanner(VERSION, remote);
      return { status: 'update', current: VERSION, remote };
    }
    return { status: 'current', current: VERSION, remote };
  } catch {
    return { status: 'error', current: VERSION };
  }
}

function _showBanner(local, remote) {
  if (document.getElementById('uf-update-banner')) return;
  const el = document.createElement('div');
  el.id = 'uf-update-banner';
  el.className = 'draft-banner update-banner';
  el.innerHTML = `
    <span class="draft-banner-msg">Update available — v${_esc(local)} → <strong>v${_esc(remote)}</strong></span>
    <button class="draft-banner-btn update-apply" type="button">Update</button>
    <button class="draft-banner-btn draft-banner-close" type="button" aria-label="Dismiss">×</button>`;

  el.querySelector('.draft-banner-close').addEventListener('click', () => el.remove());
  el.querySelector('.update-apply').addEventListener('click', () => _applyUpdate());

  const main = document.getElementById('uf-main');
  main?.parentElement?.insertBefore(el, main);
  state.emit?.('update-available', { local, remote });
}

/** Apply the update: for a PWA, swap the service worker then reload; else reload. */
async function _applyUpdate() {
  if (!IS_QUINE && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();                       // fetch the new sw.js if any
        reg.waiting?.postMessage?.('skipWaiting'); // harmless if SW self-skips
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!reloaded) { reloaded = true; location.reload(); }
        });
        setTimeout(() => { if (!reloaded) location.reload(); }, 1200);
        return;
      }
    } catch { /* fall through to plain reload */ }
  }
  location.reload();
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
