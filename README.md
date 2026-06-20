# Unifile

A single-file, fully-offline document editor with built-in version history. Each
document is plain text whose sections declare their own format (Markdown, ABC
music notation, Mermaid, Fountain…) via `#!shebang` lines. Everything runs in the
browser — no server, no account, no network.

It ships in two shapes per type:

- **Standalone HTML** — one `.html` file you save and open anywhere (a "quine").
- **PWA** — an installable, offline Progressive Web App.

Live site: **https://unifile.app**

---

## Repository layout

```
src/            App source (CodeMirror editor, DSLs, UI, version control)
  dsl/          One module per format (markdown, abcjs, mermaid, fountain…)
  ui/           App shell, editor, preview, topbar, transport footer, site-nav
  assets/       Generated piano soundfont (committed)
build/          Build scripts (esbuild pipeline + site tooling)
templates/      quine.html, pwa.html, sw.js, manifest.json
docs/           The website (Jekyll, served by GitHub Pages) — see below
dist/           Build output (gitignored)
```

## Building the app

Requires Node (for esbuild). Install deps once: `npm install`.

| Command | Output |
|---|---|
| `npm run build` | Universal `dist/unifile.html` + PWA (`dist/pwa/`) + drag-drop plugins |
| `npm run build:abcjs` | Dedicated ABC build `dist/unifile.abc.html` + `dist/pwa-abc/` (offline piano) |
| `node build/build.mjs --dsl=<id>` | A dedicated build for any type in `DSL_META` (markdown, mermaid, abcjs, universal) |
| `npm run build:dev` | Unminified + inline source maps |

Every output is self-contained and works 100% offline (all libraries are bundled
by esbuild — no runtime CDN fetches).

The bundled acoustic piano is generated once and committed; refresh it with
`npm run gen:soundfont` (the only step that touches the network).

## The website (`docs/`)

`docs/` is a Jekyll site published by **GitHub Pages** (Settings → Pages → Deploy
from a branch → `main` / `/docs`), served at the custom domain in `docs/CNAME`.

- **Navigation is a command bar** — start typing to jump to any page, post,
  download, or app. The index is `docs/search.json` (built from pages, posts, and
  `docs/_data/apps.yml`).
- **Per-type front-door pages** — `/abc/`, `/get/` (universal). Each detects the
  device and offers the right path (install PWA on mobile; install PWA *or*
  download the `.html` on desktop) with an overview of that type. Driven by
  `docs/_data/types.yml` + `docs/_includes/launcher.html` + `docs/assets/js/launch.js`.
- **Artifacts live under `docs/`** — `npm run build:site` builds the apps and
  copies them in (`docs/dl/*.html`, `docs/pwa/`, `docs/pwa-abc/`). These are
  committed so GitHub Pages serves them.

### Previewing the site locally

The site builds with real Jekyll on GitHub, but local Jekyll may not run on older
Ruby. Use the no-Ruby renderer instead:

```
npm run site:preview                              # renders docs/ -> docs/_site/
python3 -m http.server 8780 --directory docs/_site
```

Keep `search.json` and templates to **core Liquid only** (no `where_exp`, no
custom plugins) so the classic GitHub Pages builder (Jekyll 3.x) can build them.

---

## Releasing a new version

Versioning is **semantic and driven entirely by git tags**. The latest tag is
baked into every build (the app knows its own version), published to
`docs/version.json`, and used by the in-app upgrade prompt.

To cut a release:

```bash
git tag v0.0.2            # 1. bump the version (semver; the `v` is optional)
npm run build:site        # 2. rebuild all apps with that version + write docs/version.json
git add -A && git commit -m "Release v0.0.2"
git push origin main      # 3. publish — GitHub Pages rebuilds the site
```

That's it. Within a minute or two:

- New visitors get the new build.
- **Installed PWAs and hosted copies** on an older version show a non-intrusive
  **"Update available v0.0.1 → v0.0.2"** banner; the button reloads to apply the
  new service worker.
- **Downloaded `.html` files opened from disk** (`file://`) can't auto-check for
  updates (browsers block the cross-origin request) — users re-download the
  latest from the hub page (`/abc/`, `/get/`).

### Release candidates

Pre-release builds use the conventional SemVer `-rc.N` suffix so you can tell
which candidate an installed copy is. The flow is identical — just tag the RC:

```bash
git tag v0.8.0-rc.1   # then bump to -rc.2, -rc.3, … as you iterate
npm run build:site
git add -A && git commit -m "Release v0.8.0-rc.1" && git push origin main v0.8.0-rc.1
```

Then cut the final release by tagging the bare version (`v0.8.0`) and rebuilding.

**Two channels.** `version.json` publishes both `stable` (highest non-pre-release
tag) and `latest` (highest tag overall, which may be an RC). The update check
honours the user's channel:

- **Stable (default)** — only stable releases are offered. Tagging an RC does
  **not** prompt regular users.
- **Release candidates** — opt in via **Settings → Updates → "Receive release
  candidates"**; the user is then offered `latest` (RCs included).

Either way the comparison uses full SemVer 2.0 precedence, so `rc.2` is offered
over `rc.1`, and the **final `v0.8.0` supersedes every `v0.8.0-rc.N`** (a release
outranks its pre-releases) — RC testers are pulled forward to the real release.

Settings → Updates also has a **"Check for updates"** button (cache-busts
`version.json` to defeat CDN/edge caching), and **Settings → About** shows the
running `UNIFILE_VERSION`, so an installed PWA self-identifies its exact build.

### How versioning works under the hood

- `build/build.mjs` `detectVersion()` runs `git describe --tags --abbrev=0`
  (falls back to `package.json`). The result is stamped into the bundle via the
  esbuild define `UNIFILE_VERSION` and into each document's initial data.
- `build/sync-site.mjs` writes `docs/version.json` = `{ version, released }`.
- `src/ui/update-check.js` fetches `/version.json` on load, compares it to the
  baked `UNIFILE_VERSION`, and shows the upgrade banner when a newer version exists.

> Tip: bump `package.json` `version` too if you want it to match — it's only the
> fallback when no git tag is present.
