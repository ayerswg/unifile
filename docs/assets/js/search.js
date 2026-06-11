/* Unifile site search — shared between home prompt and nav bar */

(function () {
  // ── Theme ──────────────────────────────────────────────────────

  const THEME_KEY = "uf-theme";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const icon = theme === "dark" ? "○" : "●";
    document.querySelectorAll("#theme-toggle, #home-theme-toggle")
      .forEach(btn => btn.textContent = icon);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  const saved = localStorage.getItem(THEME_KEY)
    || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(saved);

  document.querySelectorAll("#theme-toggle, #home-theme-toggle")
    .forEach(btn => btn.addEventListener("click", toggleTheme));

  // ── Search index ───────────────────────────────────────────────

  let index = null;

  async function loadIndex() {
    if (index) return index;
    const res = await fetch("/search.json");
    index = await res.json();
    return index;
  }

  function score(item, q) {
    const t = item.title.toLowerCase();
    const u = item.url.toLowerCase();
    const query = q.toLowerCase();
    if (t === query) return 100;
    if (t.startsWith(query)) return 80;
    if (t.split(/\s+/).some(w => w.startsWith(query))) return 60;
    if (t.includes(query)) return 50;
    if (u.includes(query)) return 40;
    return 0;
  }

  function search(q) {
    if (!q || !index) return { results: [], pinned: [] };

    const pinned = index
      .filter(item => item.pinned)
      .slice(0, 3);

    const pinnedUrls = new Set(pinned.map(p => p.url));

    const results = index
      .filter(item => !item.pinned)
      .map(item => ({ item, s: score(item, q) }))
      .filter(r => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8)
      .map(r => r.item);

    // also score pinned items — if query matches a pinned item include it
    // in both sections would be confusing, so just flag it visually
    return { results, pinned };
  }

  function buildDropdown(q, input) {
    const wrap = input.closest("#home-search-wrap, .nav-search-wrap");
    const drop = wrap?.querySelector(".search-dropdown");
    if (!drop) return;

    const { results, pinned } = search(q);

    if (!results.length && !pinned.length) {
      drop.innerHTML = `<div class="no-results">no matches</div>`;
      drop.classList.add("open");
      return;
    }

    const ul = document.createElement("ul");

    results.forEach(item => ul.appendChild(makeItem(item, input)));

    if (pinned.length && results.length) {
      const sep = document.createElement("li");
      sep.className = "pinned-separator";
      ul.appendChild(sep);
    }

    pinned.forEach(item => ul.appendChild(makeItem(item, input, true)));

    drop.innerHTML = "";
    drop.appendChild(ul);
    drop.classList.add("open");
  }

  function makeItem(item, input, isPinned = false) {
    const li = document.createElement("li");
    li.dataset.url = item.url;
    const badge = isPinned
      ? `<span class="item-badge pinned">pinned</span>`
      : item.type === "post" ? `<span class="item-badge">post</span>` : "";
    li.innerHTML = `
      <span class="item-title">${item.title}</span>
      <span class="item-url">${item.url}</span>
      ${badge}
    `;
    li.addEventListener("mousedown", e => {
      e.preventDefault();
      navigateTo(item, input);
    });
    return li;
  }

  function closeDropdown(input) {
    const wrap = input.closest("#home-search-wrap, .nav-search-wrap");
    wrap?.querySelector(".search-dropdown")?.classList.remove("open");
  }

  function navigateTo(item, input) {
    input.value = item.title;
    closeDropdown(input);
    window.location.href = item.url;
  }

  function getActiveItem(input) {
    const wrap = input.closest("#home-search-wrap, .nav-search-wrap");
    return wrap?.querySelector(".search-dropdown li.active") ?? null;
  }

  function moveActive(input, dir) {
    const wrap = input.closest("#home-search-wrap, .nav-search-wrap");
    const drop = wrap?.querySelector(".search-dropdown");
    if (!drop) return;
    const items = [...drop.querySelectorAll("li:not(.pinned-separator)")];
    if (!items.length) return;
    const cur = items.findIndex(li => li.classList.contains("active"));
    let next = cur + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items.forEach(li => li.classList.remove("active"));
    items[next].classList.add("active");
    input.value = items[next].querySelector(".item-title")?.textContent ?? input.value;
  }

  function attachSearch(input) {
    let debounce = null;

    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) { closeDropdown(input); return; }
      debounce = setTimeout(async () => {
        await loadIndex();
        buildDropdown(q, input);
      }, 80);
    });

    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") { e.preventDefault(); moveActive(input, 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(input, -1); }
      else if (e.key === "Enter") {
        const active = getActiveItem(input);
        if (active) {
          input.value = active.querySelector(".item-title")?.textContent ?? "";
          closeDropdown(input);
          window.location.href = active.dataset.url;
        }
      } else if (e.key === "Escape") {
        closeDropdown(input);
        input.blur();
      }
    });

    input.addEventListener("blur", () => setTimeout(() => closeDropdown(input), 150));

    input.addEventListener("focus", () => {
      if (input.value.trim()) {
        loadIndex().then(() => buildDropdown(input.value.trim(), input));
      }
    });
  }

  // ── Home page ──────────────────────────────────────────────────

  const homeInput = document.getElementById("home-search-input");
  if (homeInput) {
    const hint = document.getElementById("home-hint");
    let hintTimer = null;

    homeInput.addEventListener("input", () => {
      clearTimeout(hintTimer);
      if (homeInput.value.trim()) {
        hint?.classList.add("visible");
      } else {
        hintTimer = setTimeout(() => hint?.classList.remove("visible"), 300);
      }
    });

    const drop = document.createElement("div");
    drop.className = "search-dropdown";
    document.getElementById("home-search-wrap").appendChild(drop);

    attachSearch(homeInput);
    homeInput.focus();
  }

  // ── Nav bar ────────────────────────────────────────────────────

  const navInput = document.getElementById("nav-search-input");
  if (navInput) {
    const drop = document.createElement("div");
    drop.className = "search-dropdown";
    navInput.closest(".nav-search-wrap").appendChild(drop);
    attachSearch(navInput);

    const display = document.getElementById("nav-display");
    if (display) {
      display.addEventListener("click", () => {
        display.style.display = "none";
        navInput.style.display = "";
        navInput.value = window.location.pathname;
        navInput.focus();
        navInput.select();
      });
      navInput.addEventListener("blur", () => {
        setTimeout(() => {
          navInput.style.display = "none";
          display.style.display = "";
        }, 160);
      });
    }
  }
})();
