/**
 * Site navigation bar — shown at the very top of the app ONLY when it's being
 * viewed in a normal browser tab on the website (a hosted PWA page or the hosted
 * standalone .html).  It is hidden when:
 *   • the PWA is installed and launched (display-mode: standalone/minimal-ui/…)
 *   • the standalone .html is opened from disk (file: protocol)
 * …so an installed app or a downloaded file stays chrome-free, but a visitor
 * browsing the hosted artifacts can always get back to the rest of the site.
 *
 * It mirrors the site's command bar: type to filter destinations (title shown
 * prominently, sub-url muted) and Enter/click to navigate.  Data comes from the
 * same-origin /search.json the Jekyll site publishes; if it can't be fetched
 * (offline, or not hosted alongside the site) the bar degrades to a home link.
 */

/** Only show in a real browser tab on http(s), never when installed or file://. */
function shouldShow() {
  const standalone =
    ['standalone', 'fullscreen', 'minimal-ui'].some(m => matchMedia(`(display-mode: ${m})`).matches) ||
    window.navigator.standalone === true; // iOS Safari installed
  const http = location.protocol === 'http:' || location.protocol === 'https:';
  return http && !standalone;
}

let _index = null;
async function loadIndex() {
  if (_index) return _index;
  const res = await fetch('/search.json', { cache: 'no-cache' });
  _index = await res.json();
  return _index;
}

function score(item, q) {
  const t = (item.title || '').toLowerCase();
  const u = (item.url || '').toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/\s+/).some(w => w.startsWith(q))) return 60;
  if (t.includes(q)) return 50;
  if (u.includes(q)) return 40;
  return 0;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mountSiteNav(el) {
  if (!el) return;
  if (!shouldShow()) { el.remove(); return; }

  el.innerHTML = `
    <span class="usn-glyph">&gt;</span>
    <div class="usn-wrap">
      <input class="usn-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="unifile.app — type to navigate…" aria-label="Site navigation">
      <div class="usn-dropdown" role="listbox"></div>
    </div>
    <a class="usn-home" href="/" title="Back to unifile.app">unifile.app</a>
  `;

  const input = el.querySelector('.usn-input');
  const drop  = el.querySelector('.usn-dropdown');
  let active  = -1;
  let rows    = [];

  const close = () => { drop.classList.remove('open'); active = -1; };

  function paint(items) {
    rows = items;
    if (!items.length) { close(); return; }
    drop.innerHTML = items.map((it, i) => `
      <div class="usn-item${i === active ? ' active' : ''}" data-url="${_esc(it.url)}" role="option">
        <span class="usn-title">${_esc(it.title)}</span>
        <span class="usn-url">${_esc(it.url)}</span>
        ${it.type && it.type !== 'page' ? `<span class="usn-badge">${_esc(it.type)}</span>` : ''}
      </div>`).join('');
    drop.classList.add('open');
    drop.querySelectorAll('.usn-item').forEach(node => {
      node.addEventListener('mousedown', e => { e.preventDefault(); go(node.dataset.url); });
    });
  }

  function go(url) { if (url) location.href = url; }

  async function update() {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    let idx;
    try { idx = await loadIndex(); } catch { close(); return; }
    const pinned = idx.filter(i => i.pinned).slice(0, 3);
    const matched = idx
      .filter(i => !i.pinned)
      .map(i => ({ i, s: score(i, q) }))
      .filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(r => r.i);
    paint([...matched, ...pinned]);
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); paint(rows); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(rows); }
    else if (e.key === 'Enter') { if (active >= 0 && rows[active]) go(rows[active].url); }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}
