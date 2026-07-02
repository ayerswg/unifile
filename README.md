# Unifile

A single-file, fully-offline document editor with built-in version history. Each
document is plain text whose sections declare their own format (Markdown, ABC
music notation, Mermaid, Fountain…) via `#!shebang` lines. Everything runs in the
browser — **no server, no account, no network**. Your data never leaves the device.

It ships in two shapes per type:

- **Standalone HTML** — one `.html` file you save and open anywhere (a "quine").
- **PWA** — an installable, offline Progressive Web App.

Live site: **https://unifile.app**

> **Building on this project?** Read [CLAUDE.md](CLAUDE.md) — it has the design,
> architecture, and hard-won gotchas (iOS PWA layout, the VCS/diff model, the ABC
> MIDI system, release mechanics). This README is just the quick tour.

---

## Repository layout

```
src/            App source
  core/         Framework-agnostic logic: VCS, diff, storage, front-matter, sections
  dsl/          One module per format (markdown, abcjs, mermaid, fountain…)
  model/ layout/  Document models + renderers
  ui/           App shell, editor, preview, topbar, transport, settings
  assets/       Generated piano soundfont (committed)
build/          esbuild pipeline + site tooling
templates/      quine.html, pwa.html, sw.js, manifest.json
docs/           The website (Jekyll on GitHub Pages) + committed build artifacts
dist/           Build output (gitignored)
```

## Building

Requires Node. Install deps once: `npm install`.

| Command | Output |
|---|---|
| `npm run build` | Universal `dist/unifile.html` + PWA + drag-drop plugins |
| `npm run build:abcjs` | Dedicated ABC build `dist/unifile.abc.html` + PWA (offline piano) |
| `node build/build.mjs --dsl=<id>` | Dedicated build for any `DSL_META` type (markdown, mermaid, abcjs, universal) |
| `npm run build:dev` | Unminified + inline source maps |
| `npm run build:site` | Build all apps + copy into `docs/` + write `docs/version.json` (release step) |

Every output is self-contained and works 100% offline — esbuild bundles all
libraries, no runtime CDN fetches. **Always build the specific variant you're
testing.** The bundled acoustic piano is committed; refresh it with
`npm run gen:soundfont` (the only step that touches the network).

## Releasing

Version is driven entirely by **git tags** — the latest tag is baked into every
build, published to `docs/version.json`, and used by the in-app upgrade banner.

```bash
git tag v0.0.7            # bump (semver; `v` optional). RCs: v0.0.7-rc.1
npm run build:site        # rebuild all apps + write version.json
git add -A && git commit -m "Release v0.0.7"
git push origin main v0.0.7
```

Within a minute GitHub Pages rebuilds; installed PWAs / hosted copies on an older
version show an **"Update available"** banner. Two channels — **stable** (default)
and **release candidates** (opt in via Settings → Updates). `-rc.N` tags only
prompt RC users; the final release supersedes its RCs. Downloaded `file://` copies
can't auto-check — re-download from the hub pages (`/abc/`, `/get/`).

See [CLAUDE.md](CLAUDE.md#versioning--releases) for the mechanics (SemVer
precedence, the two-channel `version.json`, how the version is stamped in).

## The website (`docs/`)

Jekyll on GitHub Pages (Deploy from `main` `/docs`, custom domain in `docs/CNAME`).
Navigation is a **command bar** — type to jump to any page or app. Per-type front
doors (`/abc/`, `/get/`) detect the device and offer the right install path. Build
artifacts are committed under `docs/` so Pages serves them.

Preview locally without Ruby: `npm run site:preview` then serve `docs/_site`. Keep
templates and `search.json` to **core Liquid only** (the classic Pages builder is
Jekyll 3.x).
