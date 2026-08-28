/* Install walkthrough modal.
 *
 * Any element with [data-install] opens a step-by-step, per-device guide for
 * installing one app as a PWA.  The trigger carries the app identity:
 *   data-app="Markdown"  data-pwa="/pwa-md/"  data-dl="/dl/unifile.md.html"
 *
 * The modal is built once, lazily, and re-filled per app.  Device tabs
 * (iPhone/iPad · Android · Desktop) default to the visitor's own platform.
 *
 * NOTE: a PWA can only be installed FROM its own page (the manifest lives
 * in each pwa-<abbrev> directory), so step 1 is always "open the app" — and the app itself
 * shows a matching pre-install banner (templates/pwa.html) that picks up
 * where this walkthrough leaves off.
 */
(function () {
  var ua = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(ua);
  var defaultTab = isIOS ? "ios" : isAndroid ? "android" : "desktop";

  var overlay = null;

  function stepsFor(tab, app, pwa, dl) {
    var open = '<a href="' + pwa + '">Open ' + app + "</a>";
    if (tab === "ios") {
      return (
        "<ol>" +
        "<li>" + open + " in <b>Safari</b>. (Installing doesn’t work from inside other apps — if you’re in one, tap its share/open-in-browser option first.)</li>" +
        "<li>Tap the <b>Share</b> button <kbd>&#x2B06;&#xFE0E;</kbd> at the bottom of the screen.</li>" +
        "<li>Scroll down and tap <b>Add to Home Screen</b>.</li>" +
        "<li>Tap <b>Add</b>.</li>" +
        "</ol>" +
        "<p class='im-note'>The app appears on your home screen like any other app and works fully offline.</p>"
      );
    }
    if (tab === "android") {
      return (
        "<ol>" +
        "<li>" + open + " in <b>Chrome</b>.</li>" +
        "<li>Tap the <b>&#8942;</b> menu in the top-right corner.</li>" +
        "<li>Tap <b>Install app</b> (on some phones: <b>Add to Home screen</b>).</li>" +
        "<li>Confirm with <b>Install</b>.</li>" +
        "</ol>" +
        "<p class='im-note'>The app appears on your home screen like any other app and works fully offline.</p>"
      );
    }
    return (
      "<ol>" +
      "<li>" + open + " in <b>Chrome</b> or <b>Edge</b>.</li>" +
      "<li>Click the <b>install icon</b> at the right end of the address bar (a small screen with a down arrow) — or open the browser menu and choose <b>Install…</b></li>" +
      "<li>Click <b>Install</b>. The app opens in its own window and works fully offline.</li>" +
      "</ol>" +
      "<p class='im-note'><b>Safari</b> (macOS): open the app, then <b>File → Add to Dock</b>.<br>" +
      "<b>Firefox</b> doesn’t support installing web apps — " +
      '<a href="' + dl + '" download="' + dl.split("/").pop() + '">download the single .html file</a> instead; it’s the same app in one file.</p>'
    );
  }

  function build() {
    overlay = document.createElement("div");
    overlay.id = "install-modal";
    overlay.innerHTML =
      '<div class="im-box" role="dialog" aria-modal="true" aria-labelledby="im-title">' +
      '<div class="im-head"><span id="im-title">INSTALL</span>' +
      '<button class="im-x" aria-label="Close">&#x2715;</button></div>' +
      '<div class="im-tabs">' +
      '<button data-tab="ios">iPhone / iPad</button>' +
      '<button data-tab="android">Android</button>' +
      '<button data-tab="desktop">Desktop</button>' +
      "</div>" +
      '<div class="im-body"></div>' +
      '<div class="im-foot">Fully offline once installed — no account, no sync, nothing leaves your device.</div>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hide();
    });
    overlay.querySelector(".im-x").addEventListener("click", hide);
    overlay.querySelectorAll(".im-tabs button").forEach(function (b) {
      b.addEventListener("click", function () { select(b.dataset.tab); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hide();
    });
  }

  var current = { app: "", pwa: "", dl: "" };

  function select(tab) {
    overlay.querySelectorAll(".im-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    overlay.querySelector(".im-body").innerHTML =
      stepsFor(tab, current.app, current.pwa, current.dl);
  }

  function show(app, pwa, dl) {
    if (!overlay) build();
    current = { app: app, pwa: pwa, dl: dl };
    overlay.querySelector("#im-title").textContent = "INSTALL — " + app.toUpperCase();
    select(defaultTab);
    overlay.classList.add("open");
  }

  function hide() {
    if (overlay) overlay.classList.remove("open");
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-install]");
    if (!t) return;
    e.preventDefault();
    show(t.dataset.app, t.dataset.pwa, t.dataset.dl);
  });
})();
