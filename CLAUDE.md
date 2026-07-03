# CLAUDE.md — unifile architecture & working notes

Context for anyone (human or AI) continuing this project. Read this before making
changes. It captures the *why* behind decisions and the landmines that cost real
time to find. Keep it up to date as the design evolves.

---

## What unifile is

A **single-file, fully-offline** document editor with **built-in git-style version
history**. A document is plain text; its sections declare their own format
(Markdown, ABC music notation, Mermaid, Fountain…) via `#!shebang` lines.
Everything runs client-side — **no server, no account, no network at runtime**.

Two shipping shapes per content "type":
- **Quine** — one standalone `.html` file that embeds the whole app *and* the
  document data. Saving regenerates the file. Opens from disk (`file://`) or hosted.
- **PWA** — an installable, offline Progressive Web App (data in IndexedDB).

### Non-negotiable principles
1. **Offline & self-contained.** Every library is bundled by esbuild. No runtime
   CDN fetches. The only network call is the update check (`GET /version.json`).
2. **Privacy: nothing leaves the device.** unifile.app is static GitHub Pages —
   it stores nothing. No telemetry, no analytics. Keep it that way.
3. **Plain-text, portable data.** The VCS (branches, commits-as-diffs) is plain
   JSON. A document + full history round-trips through a tiny `.unifile.json`.
4. **Strict same-origin CSP.** See `templates/pwa.html` / `quine.html`. Adding a
   third-party origin is a big deal — we removed Google Drive sync partly to keep
   the CSP locked down.

---

## Repository layout

```
src/
  main.js            Dev entry (imports all DSLs). The build generates a slimmer entry per variant.
  core/              Framework-agnostic logic (no DOM where avoidable)
    vcs.js           Git-like VCS: branches, commits (stored as line diffs), detached HEAD
    diff.js          LCS line diff: computePatch/applyPatch, lineDiff (side-by-side), unifiedDiff, blame
    storage.js       Quine capture/generate, IndexedDB, File System Access, drafts, user prefs, IS_QUINE
    front-matter.js  Nested-YAML-subset parser/serializer for the leading `---`…`---` block
    doc-sections.js  Parses `#!dslId@ver+ext` shebang sections
    hash.js, crypto.js
    (assets/piano-soundfont.js — committed FluidR3 acoustic grand, ~2.5MB, note→dataURI)
  dsl/               One module per format; self-registers via registry.js
    markdown.js, abcjs.js, mermaid.js, marp.js, fountain.js
    registry.js      registerDSL / getDSL / listDSLs
    abcjs-piano-loader.js  CommonJS drop-in for abcjs's ./load-note (offline soundfont)
  model/registry.js  Document "models" (flow | grid | spatial | timeline | graph) — chosen via front-matter `model:`
  layout/            Renderers for models + flow layouts (webpage/document/slides)
  ui/                App shell + everything DOM
    app.js           App singleton: shell, mounting, init, save, mobile panes, data file load/save
    state.js         AppState (EventBus): state.update/emit/on, VIEW_MODES, PANELS, diff, pendingCommit
    editor.js        CodeMirror 6 setup: gutter, per-section highlighting, comments, front-matter tint
    preview.js       Renders the active model/DSL to the preview pane
    topbar.js        Title, DSL menu, VCS pills (desktop), mobile branch/status chip
    commit-bar.js    Mobile commit composer (bottom bar, commit pane)
    commit-dialog.js Full commit dialog (identity + message + tag)
    diff-view.js     DiffView overlay + DiffBar (read-only commit diff)
    dsl-footer.js    ABC transport (play/scrub/time)
    settings-panel.js  Identity, theme, updates (RC opt-in), audio output (MIDI)
    blame-view.js, merge-dialog.js, export-dialog.js, comments.js, site-nav.js,
    theme.js, editor-theme.js, plugin-extensions.js, update-check.js
  styles/app.css     All app CSS (single file; mobile rules in @media(max-width:640px))
build/
  build.mjs          esbuild pipeline (one quine + PWA per dedicated DSL variant)
  sync-site.mjs      Builds variants + copies into docs/ + writes docs/version.json
  render-site.mjs    No-Ruby local mirror of the Jekyll site
  gen-soundfont.mjs  One-off: fetch FluidR3 piano → src/assets/piano-soundfont.js (network!)
templates/           quine.html, pwa.html, sw.js, manifest.json
docs/                The website (Jekyll on GitHub Pages) + committed build artifacts
dist/                Build output (gitignored)
```

---

## Build system (`build/build.mjs`)

esbuild, IIFE bundle, compile-time `define`s. Key flags/modes:

- **Every content type is its own dedicated single-DSL build** (one DSL bundled in, no runtime plugins). There is no "universal" multi-DSL app and no drag-drop plugin system — both were removed.
- `node build/build.mjs` (no flags) → builds **every** variant in `DSL_META`: `markdown`(md), `mermaid`(mer), `abcjs`(abc). Output per variant: `dist/unifile.<abbrev>.html` (quine) + `dist/pwa-<abbrev>/` (PWA).
- `--dsl=<variant>` → build just that one variant.
- `--dev` → unminified + inline sourcemaps. `--no-pwa` → skip the PWA (fast iteration).
- Note: each variant still bundles `markdown` as a base alongside its DSL (so prose sections + `#!shebang` DSL sections work within that one app); this is not the old multi-DSL "universal" model.

**Compile-time defines** (esbuild `define`, referenced as globals; guard with `typeof … !== 'undefined'`):
- `UNIFILE_MODE` = `"quine"` | `"pwa"` → `IS_QUINE` in storage.js.
- `UNIFILE_VERSION` = the git tag (see Versioning).

**Two build targets per variant:** `buildQuine()` embeds the JS **gzip+base64** into the HTML template's `<script id="unifile-data">` region (so plain-text grep won't find code strings in a quine — grep the PWA's `app.js` instead). `buildPWA()` writes plain files + a service worker whose cache name is namespaced per type (`unifile-abc`, etc.) with a content hash so updates supersede cleanly.

**Direction (2026-07):** dedicated per-content-type builds only — the universal multi-DSL app and the runtime drag-drop plugin system were removed. `npm run build:abcjs` is the flagship (ships the offline piano).

---

## Runtime architecture

**Entry:** `main.js` → `new App().init()`. In quine mode the app is on `window.__unifile`. The build also exposes `globalThis.__uf = { state }` for tests/preview automation.

**State (`state.js`)** is a tiny EventBus singleton (`state`). Mutate via `state.update(patch)` (broadcasts `change`) or `state.emit(event, payload)`; subscribe with `state.on(event, fn)`. Key fields: `data` (the full serialized doc), `vcs`, `currentContent`, `isDirty`, `viewMode`, `activePanel`, `diff`, `pendingCommit`, `user`. Getters: `headHash`, `currentBranch`, `isDetached`.

**Data model (`state.data`)** is the JSON embedded in the quine / stored in IDB:
`{ branches, commits, currentBranch, detachedHead, currentContent, dslType, title, comments/commentThreads, version, password, … }`. `vcs.serialize()` returns the branch/commit fields; after a commit the app does `state.update({ data: { ...state.data, ...vcs.serialize() } })` to keep them in sync.

**VCS (`core/vcs.js`)** — git-inspired, all JSON. Commits store a **line diff (patch)** against their parent; the root stores `fullContent`. `getContentAt(hash)` reconstructs by walking ancestors + applying patches. Branches, tags (SemVer), detached HEAD. `checkout(hash)` enters detached HEAD.

**Sections & DSLs (`doc-sections.js` + `dsl/registry.js`)** — `#!dslId@version+ext1+ext2` lines split a document into sections, each rendered by its DSL. No shebang → whole doc uses the build's `defaultDslType`. A DSL module calls `registerDSL({ id, getEditorExtensions, render, exporters, … })`.

**Models & layouts** — front-matter `model:` (flow|grid|spatial|timeline|graph) picks a renderer (`model/registry.js` + `layout/`). `flow` is default; its `layout:` (webpage|document|slides) controls presentation. Preview.js dispatches to the right renderer.

**Editor (`editor.js`)** — CodeMirror 6. Custom **single gutter** (`commentLineNumbersExt`) that shows line numbers (desktop) / a thin rail (mobile), tints comment lines yellow and YAML front-matter lines grey. **Per-section syntax highlighting** (`sectionSyntaxField`) runs each section's DSL parser through the catppuccin highlight; the front-matter block is highlighted as YAML instead of the DSL. **Comments are line-level only** (see below). Line wrapping is intentionally OFF (DSL scrolls horizontally).

**Preview (`preview.js`)** renders the active model/DSL. Clicking a rendered ABC note highlights the source (`abc-play-cursor`/`dsl-select`) without flipping panes on mobile.

**Comments (`comments.js`)** — threads in `data.commentThreads`, each with `from/to` char offsets + messages. **As of v0.0.6 comments are LINE-LEVEL only**: clicking the gutter opens the existing thread or a new-comment form anchored at the line start (`from===to`). The old range/selection comment path was removed. Old range comments still open (matched by start line).

**Diff view (`diff-view.js`)** — clicking a non-current commit opens a read-only side-by-side diff (clicked commit vs working state) via `state.openDiff(left,right)` (`'WORKING'` sentinel = live content). `state.on('diff-change')` toggles `#unifile-app[data-diff]` → CSS swaps the panes for `#uf-diff` + the bottom picker bar.

---

## Front matter (`core/front-matter.js`)

The leading `---`…`---` block. **Custom minimal YAML-subset parser** (not a real YAML lib):
- Indentation-based **nested maps** + **inline flow maps** (`{ cc: 32, value: 6 }`). Values stay strings; consumers coerce.
- **Inline `#` comments are stripped** but only when the `#` is preceded by whitespace (so note names like `C#3`/`F#-1` survive). This was a real bug — a commented value silently failed to parse.
- The serializer round-trips nested maps as indented blocks. **Critical:** the model picker re-serializes the *whole* meta, so anything the serializer can't handle gets clobbered — keep parse/serialize symmetric.

---

## ABC + MIDI subsystem (`dsl/abcjs.js`)

The most complex DSL. Ships an **offline acoustic piano** (FluidR3 soundfont committed to `src/assets/piano-soundfont.js`; `abcjs-piano-loader.js` is a **CommonJS** drop-in for abcjs's internal `./load-note` — must stay CJS or abcjs's `require()` interop breaks).

- **Transport** (`dsl-footer.js` + abcjs.js): play/pause, seekable scrubber, current/total time. Persistent bottom bar.
- **Web MIDI output** (Chromium-only): route playback to an external instrument (e.g. Kontakt via IAC) *instead of* the internal piano. Picker is in **Settings → Audio output**. `_startMidiPlayback` builds a time-sorted note queue pumped with look-ahead timestamps; panic (all-notes-off) on stop.
- **iOS audio**: reuse ONE persistent AudioContext (never `close()` it), unlock with a silent buffer in the user gesture, and set `navigator.audioSession.type = 'playback'` so the hardware mute switch doesn't silence it.
- **Unified `midi.map`** (front matter): maps any abcjs marking (dynamics `ff`/`pp`, accents `>`, articulations `legato`/`pizzicato`, custom names) to a MIDI action combining `note` (keyswitch), `cc`, `program`, and a `velocity` effect. `velocity: 112`=absolute level (sticky), `0.8`=scale, `+30`=per-note bump (accents). Per-voice overrides under `midi.voices.<n>` (channel/volume(CC7)/pan(CC10)/velocity scale/map). `midi.octave` = the octave middle-C (60) is called (`c3` default = Kontakt). See README/inline docs for the full schema.
- **abcjs quirk:** it *drops* unknown `!name!` decorations, so we scan the rendered source (`_lastAbcSource`) ourselves for markings; and abcjs reports a note's `startChar` inconsistently vs its own leading decoration, so we match tokens to notes by walking events in source order with an `index < endChar` pointer, not `≤ startChar`.

---

## Mobile / iOS (hard-won — read before touching layout)

The app is a `100dvh`-ish flex column: (site-nav) · top bar · pane rail · `#uf-main` · `#uf-bottom`. On phones (`@media max-width:640px`) `#uf-main` is a **horizontal scroll-snap strip** of three panes: **commit-log · editor · render**. `App._setupMobilePanes()` tracks the centred pane into `#unifile-app[data-mobile-pane]` and drives per-pane UI.

Institutional knowledge — **do not silently "simplify" these; each fixed a real device bug:**

- **Viewport height = JS-measured, not CSS units.** `App._trackViewportHeight()` writes `visualViewport.height`→`--app-height` and `visualViewport.offsetTop`→`--app-vv-top`; `#unifile-app` is `position:fixed; top:var(--app-vv-top); height:var(--app-height)`. Reason: `100vh` includes Safari chrome, `100dvh` hits an iOS 26 regression (gap at bottom), `-webkit-fill-available` resolves short. Using `visualViewport.height` also shrinks the shell above the soft keyboard so the caret stays visible.
- **The "chin gap" was `apple-mobile-web-app-status-bar-style: black-translucent` + `height:100%`.** That meta is REMOVED from `pwa.html`; `html,body` use `100vh`. Don't re-add black-translucent.
- **Document must never scroll.** `App._lockWindowScroll()` snaps `window`/`scrollingElement` back to (0,0); `overscroll-behavior` contains inner scrollers. iOS otherwise scrolls the whole doc when the keyboard is up and shifts the bars.
- **Bottom bar (`#uf-bottom`) is an in-flow flex child**, not `position:fixed` + JS pinning (that pushed it off-screen). It sits flush because the column is exactly the visible height.
- **Top bar owns the safe-area-inset-top**; the pane rail sits below it and is **tappable** (tap left/middle/right third → commit/editor/render).
- **Mobile gutter is one thin rail** (no line numbers, no fold column): current line = accent segment, commented line = yellow, front-matter lines = grey. Buffer between rail and code lives on `.cm-line` padding-left (not `.cm-content`) so the active-line highlight covers it (no dark sliver).
- **Zoom fix:** viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover`; `.cm-content`/inputs forced to `font-size:16px` to stop Safari focus-zoom.

iOS-specific behavior can't be verified in the local Chromium preview — verify mechanism/geometry there, then test on-device (and remove+re-add the PWA to drop the cached service worker).

---

## Versioning & releases

Version is the **latest git tag** (`git describe --tags --abbrev=0`, strip `v`), stamped into the bundle (`UNIFILE_VERSION`) and `docs/version.json`. **When git tags aren't available at build time — which is the case on Cloudflare Pages (its checkout has no tags) — `detectVersion` falls back to `package.json`'s `version`.** So `package.json` MUST be bumped to match each release, or the deployed `version.json`/`UNIFILE_VERSION` will be stale (and the in-app update prompt won't fire).

**Release flow:** `npm version X.Y.Z --no-git-tag-version` (bump package.json) → `git tag vX.Y.Z` → `npm run build:site` → commit → `git push origin main vX.Y.Z`. The site is served by **Cloudflare Pages** (project `unifile`, `unifile-8yt.pages.dev`), which auto-builds on push with `npm run build:site && npm run site:preview` → `docs/_site`.
**Release candidates:** tag `vX.Y.Z-rc.N` per candidate, cut the bare `vX.Y.Z` when ready. (RC channel precedence needs the git tag list, which Cloudflare lacks — RCs are exercised locally / on GitHub where tags exist.)

`sync-site.mjs` writes `version.json = { version(=stable), stable, latest, released }` (stable = highest non-pre-release tag; latest = highest overall). `update-check.js` compares with full **SemVer 2.0 precedence** (`_parse`/`_cmp`): `rc.2 > rc.1`, and a release outranks its pre-releases (`1.0.0 > 1.0.0-rc.2`). Users on the **stable** channel are only offered `stable`; opt into RCs in **Settings → Updates**. The check cache-busts `version.json` (`?_=ts`) to beat CDN staleness. **Settings → About** shows the running version.

`git commit` messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## The website (`docs/`)

Jekyll on GitHub Pages (Deploy from `main` `/docs`, custom domain in `docs/CNAME`). Navigation is a **command-bar** (type to jump; index = `docs/search.json`). Per-type front doors (`/get/`=Markdown, `/mermaid/`, `/abc/`) device-detect and route (install PWA on mobile; PWA or `.html` on desktop). `npm run build:site` builds every variant and copies artifacts into `docs/dl/unifile.<abbrev>.html` + `docs/pwa-<abbrev>/` (committed so Pages serves them); it also deletes any stale universal artifacts.

**Keep templates + `search.json` to core Liquid only** (no `where_exp`, no plugins) — the classic Pages builder is Jekyll 3.x and chokes otherwise. Local preview without Ruby: `npm run site:preview` then serve `docs/_site`.

---

## Conventions & workflows

- **Adding a DSL:** create `src/dsl/<id>.js` that `registerDSL(...)`; add an entry to `DSL_META` in `build.mjs` to give it a dedicated build; import it in `main.js` for dev; add a hub page + `types.yml`/`apps.yml` entries to surface it on the site.
- **Verifying UI changes:** use the preview tools against a build (`node build/build.mjs --dsl=abcjs --no-pwa`, serve `dist/` — see `.claude/launch.json`, port 8765). Resize to 375px for mobile. **Always build the variant you're testing.**
- **When testing something users will run, remember to `build:site`** — source-only commits leave the deployed `docs/` artifacts stale (this has bitten us: a feature "didn't work" because the deployed build didn't have it).
- **Deploying:** commit + push are done only when asked; branch off `main` if not already the intent.

---

## Gotchas / landmines (things that cost real debugging time)

- **`state.on(...)` must be called directly**, not `this._unsub?.push?.(state.on(...))` — the optional-chaining short-circuit skips evaluating the `state.on` argument, so the listener never registers. App is a forever-singleton and doesn't track unsubscribers.
- **`RangeSetBuilder` requires ranges added in sorted `from` order** — e.g. in front-matter highlighting, add the key mark before the trailing-comment mark.
- **abcjs drops `!name!` decorations** and reports note `startChar` inconsistently (see ABC section).
- **Front-matter values with inline `# comments`** must be stripped (whitespace-preceded `#` only, to preserve `C#3`).
- **iOS**: none of the mobile viewport hacks are optional (see Mobile section). The `.unifile.json`/quine data must round-trip; the model picker re-serializes the whole front matter.
- **Quine grep:** code strings are gzip+base64'd inside `.html` quines — grep the PWA `app.js` to confirm a build contains something.
- **CSP:** strict same-origin. Any external origin (fonts, APIs) is a deliberate, reviewed change.
