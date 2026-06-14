/**
 * Update check — compares the build's baked version (UNIFILE_VERSION, stamped
 * from the latest git tag at build time) against the published /version.json on
 * the site.  If a newer release exists, shows a small banner with an "Update"
 * button.  For an installed PWA / hosted page the button reloads to apply the new
 * service worker; for a file:// download we skip (cross-origin fetch is blocked).
 */

import { state } from './state.js';

// Stamped by esbuild `define` in build.mjs; guard for any non-built context.
const VERSION = (typeof UNIFILE_VERSION !== 'undefined') ? UNIFILE_VERSION : '0.0.0';

/** Numeric-segment semver comparison: is `remote` newer than `local`? */
function isNewer(remote, local) {
  const r = String(remote).split('.').map(n => parseInt(n, 10) || 0);
  const l = String(local).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const a = r[i] || 0, b = l[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export async function checkForUpdate({ isQuine } = {}) {
  // Opened from disk: a cross-origin fetch to the site would be CORS-blocked.
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const remote = (await res.json())?.version;
    if (remote && isNewer(remote, VERSION)) _showBanner(VERSION, remote, isQuine);
  } catch { /* offline / not hosted alongside the site — ignore */ }
}

function _showBanner(local, remote, isQuine) {
  if (document.getElementById('uf-update-banner')) return;
  const el = document.createElement('div');
  el.id = 'uf-update-banner';
  el.className = 'draft-banner update-banner';
  el.innerHTML = `
    <span class="draft-banner-msg">Update available — v${_esc(local)} → <strong>v${_esc(remote)}</strong></span>
    <button class="draft-banner-btn update-apply" type="button">Update</button>
    <button class="draft-banner-btn draft-banner-close" type="button" aria-label="Dismiss">×</button>`;

  el.querySelector('.draft-banner-close').addEventListener('click', () => el.remove());
  el.querySelector('.update-apply').addEventListener('click', () => _applyUpdate(isQuine));

  const main = document.getElementById('uf-main');
  main?.parentElement?.insertBefore(el, main);
  state.emit?.('update-available', { local, remote });
}

/** Apply the update: for a PWA, swap the service worker then reload; else reload. */
async function _applyUpdate(isQuine) {
  if (!isQuine && 'serviceWorker' in navigator) {
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
