/**
 * Update check — compares the build's baked version (UNIFILE_VERSION, stamped
 * from the latest git tag at build time) against the published /version.json on
 * the site.  If a newer release exists, shows a small banner with an "Update"
 * button.  For an installed PWA / hosted page the button reloads to apply the new
 * service worker; for a file:// download we skip (cross-origin fetch is blocked).
 */

import { state } from './state.js';
import { IS_QUINE } from '../core/storage.js';

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

/**
 * The version to compare against: the latest published build.  There is no
 * stable/RC channel split anymore — every push deploys one version and everyone
 * is offered it.  (`latest`/`stable`/`version` are kept in version.json for
 * backward-compat with older clients; here we just take the newest available.)
 */
function _target(data) {
  return data.latest ?? data.stable ?? data.version;
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
    // Up to date — a previously requested update (if any) has landed, so the
    // auto-reload flag must not survive to fire on some future background swap.
    try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
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

// ---------------------------------------------------------------------------
// Applying an update (PWA)
//
// The precache is big (the abc build's app.js is ~5 MB — the offline piano), so
// installing a new service worker takes SECONDS on a normal connection.  The
// old flow reloaded on a blind 2 s timer, which reliably lost that race: the
// page came back through the OLD worker (old version, banner again) and the
// new worker's eventual activation went unnoticed.  Rules now:
//
//   • NEVER reload on a timer while an install is in flight — reload only when
//     the new worker actually takes control (controllerchange / activated).
//   • Show progress on the banner ("Updating…") instead of pretending the
//     2-second reload did something.
//   • Arm a GLOBAL controllerchange listener (below, module init) with a
//     sessionStorage flag, so even if the install outlives this page — user
//     reloads manually, install finishes minutes later — the moment the new
//     worker claims the page we reload once onto the new version.  The flag is
//     cleared when a version check comes back current, and guards against
//     surprise reloads from background updates the user never asked for.
// ---------------------------------------------------------------------------

const PENDING_KEY = 'uf_update_pending';

// Global safety net: when a NEW worker takes over this page and an update was
// requested, reload once so the user is actually on the new version.  Guarded
// against the very first install (no previous controller — the page already
// came fresh from the network).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  let reloadedGlobal = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    let pending = null;
    try { pending = sessionStorage.getItem(PENDING_KEY); } catch { /* private mode */ }
    if (pending && !reloadedGlobal) { reloadedGlobal = true; location.reload(); }
  });
}

/** Apply the update: for a PWA, swap the service worker then reload; else reload. */
async function _applyUpdate() {
  if (!IS_QUINE && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) return _applySwUpdate(reg);
    } catch { /* fall through to plain reload */ }
  }
  location.reload();
}

async function _applySwUpdate(reg) {
  const btn = document.querySelector('#uf-update-banner .update-apply');
  const msg = document.querySelector('#uf-update-banner .draft-banner-msg');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try { sessionStorage.setItem(PENDING_KEY, '1'); } catch { /* private mode */ }

  let reloaded = false;
  const reloadOnce = () => { if (!reloaded) { reloaded = true; location.reload(); } };
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);

  // Drive whichever worker exists (now or after update()) to activation, and
  // reload the moment it gets there.  'activated' is a belt-and-braces
  // companion to controllerchange (claim timing varies across browsers).
  const nudge = (w) => { try { w?.postMessage?.('skipWaiting'); } catch { /* gone */ } };
  const track = (w) => {
    if (!w) return;
    if (w.state === 'installed') nudge(w);
    w.addEventListener?.('statechange', () => {
      if (w.state === 'installed') nudge(w);
      if (w.state === 'activated') reloadOnce();
      if (w.state === 'redundant') fail('Update failed to install — will retry on next launch.');
    });
  };
  const fail = (text) => {
    if (reloaded) return;
    if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
    if (msg && text) msg.textContent = text;
  };

  track(reg.waiting);
  track(reg.installing);
  reg.addEventListener?.('updatefound', () => track(reg.installing));

  try { await reg.update(); } catch { /* offline — any already-fetched worker still applies */ }
  track(reg.installing);
  track(reg.waiting);

  // No new worker anywhere → either a previous install already activated in the
  // background (this page just predates it) or there is nothing to fetch.  One
  // reload picks up whatever the active worker serves — never on a race timer.
  if (!reg.installing && !reg.waiting) { setTimeout(reloadOnce, 300); return; }

  // Big download on a slow line: after 45 s stop pretending and level with the
  // user — the global controllerchange net still applies it whenever it lands.
  setTimeout(() => {
    if (!reloaded && (reg.installing || reg.waiting)) {
      fail('Still downloading the update — it will apply automatically when ready.');
    }
  }, 45000);
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

