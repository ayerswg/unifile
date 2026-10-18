/**
 * Update check + self-updating PWA (standard shell).
 *
 * Compares the running build (src/core/build-info.js: version + commit +
 * channel, stamped by build.mjs) against the published /version.json and, when
 * a newer build exists, shows a small banner.  What "newer" means depends on
 * the channel the build was made from:
 *
 *   stable (main)  a higher VERSION.  The banner has an "Update" button; the
 *                  user applies it.
 *   dev            a LATER COMMIT — every push to `dev` deploys dev.unifile.app
 *                  with no tag bump, so the commit hash + time is the version
 *                  there.  The update is applied AUTOMATICALLY: the banner
 *                  reports "Updating to <hash>…" while the new service worker
 *                  installs, and the page reloads once it takes control.
 *
 * Independently of version.json, `initServiceWorker()` keeps the service
 * worker itself fresh the way uPub does (`_bindServiceWorker` in upub/app.js):
 * register with `updateViaCache:'none'`, `reg.update()` at launch and on every
 * return to the foreground, and — on the dev channel — reload once a new
 * worker claims the page (after flushing the draft).  Installed PWAs can
 * otherwise go a long time between the browser's own update checks.
 *
 * For a file:// download we skip everything (cross-origin fetch is blocked).
 */

import { state } from './state.js';
import { IS_QUINE } from '../core/storage.js';
import { BUILD, isDevChannel, newerBuild, remoteBuild, formatBuild } from '../core/build-info.js';

export { BUILD };

/** How often a foreground return may re-check version.json (ms). */
const RECHECK_MIN_INTERVAL = 60 * 1000;
let _lastCheckAt = 0;
let _checking = null;

/**
 * Check the published version.json and, if a newer build exists for this
 * build's channel, show the update banner (and on dev, start applying it).
 *
 * @param {{force?: boolean}} [opts]  force = manual check (Settings button).
 * @returns {Promise<{status:'update'|'current'|'file'|'error', local:object, remote?:object, reason?:string}>}
 */
export async function checkForUpdate({ force } = {}) {
  // Opened from disk: a cross-origin fetch to the site would be CORS-blocked.
  if (location.protocol === 'file:') return { status: 'file', local: BUILD };
  if (_checking && !force) return _checking;
  _lastCheckAt = Date.now();
  _checking = (async () => {
    try {
      // Cache-bust so an intermediary/CDN edge cache can't hand us a stale file —
      // the usual reason a fresh release "isn't detected".
      const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return { status: 'error', local: BUILD };
      const remote = remoteBuild(await res.json());
      const reason = newerBuild(remote, BUILD);
      if (reason) {
        _showBanner(remote, reason);
        return { status: 'update', local: BUILD, remote, reason };
      }
      // Up to date — a previously requested update (if any) has landed, so the
      // auto-reload flag must not survive to fire on some future background swap.
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
      return { status: 'current', local: BUILD, remote };
    } catch {
      return { status: 'error', local: BUILD };
    } finally {
      _checking = null;
    }
  })();
  return _checking;
}

/** Foreground re-check, throttled — called from the visibilitychange hook below. */
function _recheck() {
  if (Date.now() - _lastCheckAt < RECHECK_MIN_INTERVAL) return;
  if (document.getElementById('uf-update-banner')) return;   // already offering one
  checkForUpdate();
}

/** Banner label for a build: dev shows the commit (the identity there), stable the version. */
function _label(b) {
  return isDevChannel() ? formatBuild(b, { commit: true }) : `v${b.version}`;
}

function _showBanner(remote, reason) {
  if (document.getElementById('uf-update-banner')) return;
  const el = document.createElement('div');
  el.id = 'uf-update-banner';
  el.className = 'draft-banner update-banner';
  const dev = isDevChannel();
  const what = dev && reason === 'commit' ? 'New build' : 'Update available';
  el.innerHTML = `
    <span class="draft-banner-msg">${_esc(what)} — ${_esc(_label(BUILD))} → <strong>${_esc(_label(remote))}</strong></span>
    <button class="draft-banner-btn update-apply" type="button">Update</button>
    <button class="draft-banner-btn draft-banner-close" type="button" aria-label="Dismiss">×</button>`;

  el.querySelector('.draft-banner-close').addEventListener('click', () => el.remove());
  el.querySelector('.update-apply').addEventListener('click', () => _applyUpdate());

  const main = document.getElementById('uf-main');
  main?.parentElement?.insertBefore(el, main);
  state.emit?.('update-available', { local: BUILD, remote, reason });

  // Dev channel: don't wait to be asked — the whole point of the channel is
  // running the latest push.  The banner shows the progress; the button stays
  // as a manual retry should the install stall.
  if (dev) _applyUpdate();
}

// ---------------------------------------------------------------------------
// Service worker lifecycle
// ---------------------------------------------------------------------------

const PENDING_KEY = 'uf_update_pending';

/** Called before any update-driven reload (the app flushes its draft here). */
let _beforeReload = null;
let _reloadedGlobal = false;

async function _reloadForUpdate() {
  if (_reloadedGlobal) return;
  _reloadedGlobal = true;
  try { await _beforeReload?.(); } catch { /* best effort */ }
  location.reload();
}

/**
 * Register the service worker and keep it fresh.
 *
 *   • `updateViaCache:'none'` — the HTTP cache must never pin an old sw.js.
 *   • `reg.update()` at launch and whenever the app returns to the foreground
 *     (an installed PWA can otherwise sit on the browser's ~24 h schedule).
 *     The foreground return also re-checks version.json (throttled).
 *   • controllerchange: a NEW worker took over an already-controlled page, so
 *     the running page is by definition the stale build.  On the dev channel
 *     reload right away (after `beforeReload`, which flushes the draft).  On
 *     stable, reload only when the user asked for the update (PENDING_KEY) —
 *     background swaps the user never requested must not surprise-reload;
 *     they simply run on the next launch.  The very first install (page was
 *     uncontrolled) never reloads: it already came fresh from the network.
 *
 * @param {{beforeReload?: () => (void|Promise<void>)}} [opts]
 */
export function initServiceWorker({ beforeReload } = {}) {
  if (IS_QUINE || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  _beforeReload = beforeReload ?? null;

  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(console.warn);

  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    let pending = null;
    try { pending = sessionStorage.getItem(PENDING_KEY); } catch { /* private mode */ }
    if (pending || isDevChannel()) _reloadForUpdate();
  });

  const poke = () => navigator.serviceWorker.getRegistration()
    .then(reg => reg?.update()).catch(() => {});
  poke();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    poke();
    _recheck();
  });
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
//   • The controllerchange listener in initServiceWorker, gated by a
//     sessionStorage flag, is the safety net: even if the install outlives
//     this page — user reloads manually, install finishes minutes later — the
//     moment the new worker claims the page we reload once onto the new
//     version.  The flag is cleared when a version check comes back current,
//     and guards against surprise reloads from background updates the user
//     never asked for (stable channel only; dev always follows the worker).
// ---------------------------------------------------------------------------

/** Apply the update: for a PWA, swap the service worker then reload; else reload. */
async function _applyUpdate() {
  if (!IS_QUINE && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) return _applySwUpdate(reg);
    } catch { /* fall through to plain reload */ }
  }
  _reloadForUpdate();
}

async function _applySwUpdate(reg) {
  const btn = document.querySelector('#uf-update-banner .update-apply');
  const msg = document.querySelector('#uf-update-banner .draft-banner-msg');
  const keep = msg?.innerHTML ?? '';
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try { sessionStorage.setItem(PENDING_KEY, '1'); } catch { /* private mode */ }

  let reloaded = false;
  const reloadOnce = () => { if (!reloaded) { reloaded = true; _reloadForUpdate(); } };
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
      if (w.state === 'redundant') fail('— install failed; will retry on next launch.');
    });
  };
  const fail = (text) => {
    if (reloaded) return;
    if (btn) { btn.disabled = false; btn.textContent = 'Update'; }
    if (msg && text) msg.innerHTML = keep ? `${keep} <em>${_esc(text)}</em>` : _esc(text);
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
  // user — the controllerchange net still applies it whenever it lands.
  setTimeout(() => {
    if (!reloaded && (reg.installing || reg.waiting)) {
      fail('— still downloading; it applies automatically when ready.');
    }
  }, 45000);
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
