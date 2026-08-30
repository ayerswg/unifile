# Unifile

A single-file, fully-offline document editor with built-in version history. A
document is plain text; its sections declare their own format via `#!shebang`
lines. unifile ships as a **dedicated app per content type** — **Markdown**
(uDoc), **Mermaid** (uDraw), **ABC music notation** (uNote), the **uPub**
writing app, and the **uDraft** blueprint drafting app — each bundling just what
it needs. There is no universal multi-format build and no runtime plugins. Everything runs in the browser — **no server, no account, no
network**. Your data never leaves the device.

Each type ships in two shapes:

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
                (core/udraft/ = the uDraft parser/layout/SVG engine, Node-tested)
  dsl/          One module per format (markdown, abcjs, mermaid, fountain…)
  model/ layout/  Document models + renderers
  ui/           App shell, editor, preview, topbar, transport, settings
  upub/         uPub's own shell (custom line editor — no CodeMirror)
  udraft/       uDraft's own shell (reuses uPub's editor with its own syntax)
  assets/       Generated piano soundfont (committed)
build/          esbuild pipeline + site tooling
templates/      quine.html, pwa.html, sw.js, manifest.json
docs/           The website (Cloudflare Pages; rendered by build/render-site.mjs) + committed artifacts
dist/           Build output (gitignored)
```

## Building

Requires Node. Install deps once: `npm install`.

| Command | Output |
|---|---|
| `npm run build` | Every dedicated variant (markdown, mermaid, abcjs, upub, udraft): quine + PWA each |
| `npm run build:abcjs` | Just the ABC build `dist/unifile.abc.html` + PWA (offline piano) |
| `node build/build.mjs --dsl=<id>` | Just one `DSL_META` variant (markdown, mermaid, abcjs, upub, udraft) |
| `npm test` | Node unit tests (the uDraft parser/layout/SVG core) |
| `npm run build:dev` | Unminified + inline source maps |
| `npm run build:site` | Build all apps + copy into `docs/` + write `docs/version.json` (release step) |
| `npm run site:preview` | Render `docs/` → `docs/_site` (the no-Ruby renderer Cloudflare Pages runs) |

Every output is self-contained and works 100% offline — esbuild bundles all
libraries, no runtime CDN fetches. **Always build the specific variant you're
testing.** The bundled acoustic piano is committed; refresh it with
`npm run gen:soundfont` (the only step that touches the network).

## Releasing

Version comes from the latest **git tag**, baked into every build and published to
`docs/version.json` for the in-app upgrade banner. Because Cloudflare Pages builds
from a checkout **without tags**, the version falls back to `package.json` there —
so bump `package.json` to match each release too, or the deployed version is stale.

```bash
npm version 0.1.3 --no-git-tag-version   # bump package.json (the tag-less fallback)
git tag v0.1.3                            # semver; `v` optional. RCs: v0.1.3-rc.1
npm run build:site                        # rebuild all apps + write version.json
git add -A && git commit -m "Release v0.1.3"
git push origin main v0.1.3
```

Within a minute Cloudflare Pages rebuilds from the push; installed PWAs / hosted copies on an older
version show an **"Update available"** banner. Two channels — **stable** (default)
and **release candidates** (opt in via Settings → Updates). `-rc.N` tags only
prompt RC users; the final release supersedes its RCs. Downloaded `file://` copies
can't auto-check — re-download from the hub pages (`/abc/`, `/get/`).

See [CLAUDE.md](CLAUDE.md#versioning--releases) for the mechanics (SemVer
precedence, the two-channel `version.json`, how the version is stamped in).

## The website (`docs/`)

Hosted on **Cloudflare Pages** (custom domain `unifile.app`), which auto-builds on
every push to `main` — `npm run build:site && npm run site:preview`, publishing
`docs/_site`. The site is rendered by `build/render-site.mjs`, a no-Ruby Node
renderer (not Jekyll). Navigation is a **command bar** — type to jump to any page
or app. Per-type front doors (`/get/`, `/mermaid/`, `/abc/`) detect the device and
offer the right install path.

Preview locally the same way Cloudflare does: `npm run site:preview` then serve
`docs/_site`. `render-site.mjs` understands only a small Liquid subset, so update
it when you change layouts/includes.
