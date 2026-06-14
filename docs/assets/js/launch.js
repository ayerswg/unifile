/* Device-aware launcher for a unifile type hub page.
 * Fills #launch with the right call-to-action for the visitor's device:
 *   iOS/iPadOS → open the app + Add-to-Home-Screen hint (no install prompt API)
 *   Android    → install prompt (beforeinstallprompt) or open
 *   desktop    → install (PWA) + download the standalone .html + open
 *   installed  → just open
 * pwa/download URLs come from the include's data attributes (already baseurl-resolved).
 */
(function () {
  const el = document.getElementById("launch");
  if (!el) return;

  const pwa   = el.dataset.pwa;
  const dl    = el.dataset.download;
  const title = el.dataset.title || "the app";

  const ua = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
  const isAndroid = /Android/.test(ua);
  const standalone = matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    render(); // a real install prompt is available → reflect it
  });

  function render() {
    let html;
    if (standalone) {
      html = `<a class="launch-btn primary" href="${pwa}">Open ${title}</a>`;
    } else if (isIOS) {
      html =
        `<a class="launch-btn primary" href="${pwa}">Open the app</a>` +
        `<p class="launch-hint">Install for offline use: open in Safari, tap ` +
        `<b>Share</b> → <b>Add to Home Screen</b>.</p>`;
    } else if (isAndroid) {
      html =
        `<button class="launch-btn primary" id="launch-install">Install app</button>` +
        `<a class="launch-btn ghost" href="${pwa}">Open in browser</a>`;
    } else {
      html =
        `<button class="launch-btn primary" id="launch-install">Install app</button>` +
        `<a class="launch-btn" href="${dl}" download>Download single .html</a>` +
        `<a class="launch-btn ghost" href="${pwa}">Open in browser</a>`;
    }
    el.innerHTML = html;

    const installBtn = document.getElementById("launch-install");
    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
        } else {
          // No install prompt API (e.g. desktop Safari/Firefox) → open the PWA
          // page, where the browser's own install affordance lives.
          window.location.href = pwa;
        }
      });
    }
  }

  render();
})();
