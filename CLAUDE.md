# CLAUDE.md — unifile architecture & working notes

Context for anyone (human or AI) continuing this project. Read this before making
changes. It captures the *why* behind decisions and the landmines that cost real
time to find. Keep it up to date as the design evolves.

---

## What unifile is

**The brand is `{…}` — curly braces in a monospaced font.** Every app has two
spellings, both from the single source `src/core/brand.js` (`APPS`, `appName()`,
`appMark()`): a *name* in braces (`{document}`, `{diagram}`, `{compose}`,
`{write}`, `{draft}`, `{slides}`, `{spreadsheet}`) and a *mark* — one UTF-8 TEXT glyph (never an emoji) in
braces (`{¶}`, `{◇}`, `{♪}`, `{✎}`, `{⌂}`, `{▭}`, `{▦}`). The mark IS the app icon
(`build/icons.mjs` renders it as SVG text; `gen-icons.mjs` rasterizes the PNGs),
heads the phone title bar, and sits beside the name on the site. Build ids stay
`markdown` / `mermaid` / `abcjs` / `upub` / `udraft` / `slides` / `spreadsheet`; "uPub"/"uDraft"/"uDoc"/
"uDraw"/"uNote" in older comments and plans are the retired u-codenames of the
same apps. Glyphs were picked for having no emoji presentation; action glyphs
that do (▶ ⏸ ⚙) get U+FE0E appended (`actions.js`).

A **single-file, fully-offline** document editor with **built-in version history**
(git-style snapshots under the hood, one linear line of versions in the UI). A document is plain text; its sections declare their own format
(Markdown, ABC music notation, Mermaid, Fountain…) via `#!shebang` lines.
Everything runs client-side — **no server, no account, no network at runtime**.

Two shipping shapes per content "type":
- **Quine** — one standalone `.html` file that embeds the whole app *and* the
  document data. Opens from disk (`file://`) or hosted; "Export as app" regenerates it.
- **PWA** — an installable, offline Progressive Web App. Its documents live in the
  **library** (IndexedDB, many documents per app, each remembered as it was left — see
  "The document library"); **Save** writes `<name>-<version>.uni` (the text only) out of the sandbox.

### Non-negotiable principles
1. **Offline & self-contained.** Every library is bundled by esbuild. No runtime
   CDN fetches. The only network call is the update check (`GET /version.json`).
2. **Privacy: nothing leaves the device.** unifile.app is a static site (Cloudflare
   Pages) — it stores nothing. No telemetry, no analytics. Keep it that way.
3. **Plain-text, portable data.** The history (versions stored as line diffs) is plain
   JSON inside the app's store / the quine. What leaves the app is the TEXT ITSELF: a
   save writes `<name>-<version>.uni`, nothing but the DSL, and **Open from device**
   reads such a file back (older `.unifile.json` text+history files still open).
4. **Strict same-origin CSP.** See `templates/pwa.html` / `quine.html`. Adding a
   third-party origin is a big deal — we removed Google Drive sync partly to keep
   the CSP locked down.

---

## Repository layout

```
src/
  main.js            Dev entry (imports all DSLs). The build generates a slimmer entry per variant.
  core/              Framework-agnostic logic (no DOM where avoidable)
    vcs.js           Git-like VCS (branches, commits-as-diffs, detached HEAD) — the FILE FORMAT; the UI uses it as ONE
                     linear line of saves on `main` (no branch/merge/detached UI since 2026-10)
    diff.js          LCS line diff: computePatch/applyPatch, lineDiff (side-by-side), unifiedDiff, blame
    storage.js       Quine capture/generate, IndexedDB (`library` store + legacy `documents`), the device pickers
                     (File System Access folder/file pickers / share sheet / download), drafts (quine only), user prefs, IS_QUINE
    library.js       THE DOCUMENT LIBRARY (pure, Node-tested): records, migration, `Library` class over a store adapter,
                     NAMES + VERSIONS (`A00`…`Z99`, `nextVersion`, `versionFileName`) and `searchRecords` (the list's search)
    device-file.js   Save (one version file per save) / Open from device — the one implementation every shell calls
                     (`test/device-file.test.mjs`)
    front-matter.js  Nested-YAML-subset parser/serializer for the leading `---`…`---` block
    doc-sections.js  Parses `#!dslId@ver+ext` shebang sections
    abc-voices.js    Parses ABC `V:` voice lines (voiceIdOfLine / buildVoiceMap) — shared by the gutter + abcjs.js for mute/solo
    assets.js        Document ASSETS (`data.assets`, images by name, base64, outside the text): naming, `![…](name)`
                     resolution, save-time pruning — Marpit-free so app.js can import it in every build
    slides/          The {slides} deck engine (pure, Node-tested): deck.js (Marpit render, `---`/`===` split, exports'
                     standalone documents), themes.js (GENERATED — the three Marp themes as offline CSS)
    tables/          {document} TABLE FORMULAS engine (pure, Node-tested `test/tables.test.mjs`): grid.js (Markdown
                     tables → sheets, `||`/`^^` merges, A1 addresses, `alignTables`), formula.js (Excel grammar +
                     ~70 functions, `evaluateWorkbook`), render.js (the grid HTML, CSV, a real .xlsx, HTML/print)
    sheet/           THE {spreadsheet} ENGINE (pure, Node-tested `test/sheet.test.mjs`): parse.js (the DSL → sheets with
                     rows/cells/grid + directives), style.js (props, conditions, number formats, per-cell resolution),
                     book.js (computed workbook + the sort/filter VIEW), edit.js (every grid gesture as text → text, the
                     canonical serializer), render.js (static table, CSV, HTML/print), xlsx.js (styled .xlsx + notes)
    zip.js           Stored-only ZIP writer (EPUB, the .xlsx, the multi-sheet CSV export)
    hash.js, crypto.js
    brand.js         `{name}` / `{glyph}` per app — THE naming source (site, manifests, icons, title bar)
    build-info.js    The running build's identity (version · commit · channel from the defines) + the
                     "is that build newer?" rule shared by every shell's update check (Node-tested)
    (assets/piano-soundfont.js — committed FluidR3 acoustic grand, ~2.5MB, note→dataURI)
  dsl/               One module per format; self-registers via registry.js
    markdown.js, abcjs.js, mermaid.js, slides.js, spreadsheet.js, fountain.js
    markdown-tables.js  Tables with formulas inside {document}: the marked block extension, DOCX/XLSX, editor pieces
    registry.js      registerDSL / getDSL / listDSLs
    abcjs-piano-loader.js  CommonJS drop-in for abcjs's ./load-note (offline soundfont)
  upub/              The uPub variant's own shell (no CodeMirror — see "uPub")
    main.js, app.js, editor.js, syntax.js, epub.js, preview.js, guide-content.js
    comments.js      Inline comments for the custom editor (overlay highlights + card) — uDraft reuses it
    library.js       `ShellLibrary`: the library for the uPub-style shells (boot/persist/sheet/save/open verbs) — uDraft reuses it
    (editor.js = the SHARED custom line editor: `syntax:` option plugs in a
     classifier/renderer; uDraft reuses it — see "uDraft")
  udraft/            The uDraft variant's own shell (see "uDraft")
    main.js, app.js, syntax.js, guide-content.js
  core/udraft/       uDraft's pure engine (Node-tested, no DOM): parse.js, layout.js, svg.js
  model/registry.js  Document "models" (flow | grid | spatial | timeline | graph) — chosen via front-matter `model:`
  layout/            Renderers for models + flow layouts (webpage/document/slides)
  ui/                App shell + everything DOM
    app.js           App singleton: shell, mounting, init, save, mobile panes, data file load/save
    state.js         AppState (EventBus): state.update/emit/on, VIEW_MODES, PANELS, diff, pendingCommit
    editor.js        CodeMirror 6 setup: per-section highlighting, inline-comment gestures, no gutter, ONE plain
                     text surface (the collapsible front-matter bar / section bars were removed 2026-10)
    preview.js       Renders the active model/DSL to the preview pane
    topbar.js        Desktop top bar: ‹ library toggle, menu, title, Save pill (shows the NEXT version) / version pill; the
                     history list (pending node = note + major switch + Save, the versions, the "on device" marker; mounted
                     in the pill's dropdown AND as the phone's history pane — class-scoped, never ids).
                     Also `showDslHelpModal` = the per-DSL syntax reference (grouped, navigable sidebar; `DSL_HELP[dsl].sections[]` with optional `group`)
    pane-switch.js   PHONE top bar: (‹ back-arrow circle → the library) {mark} Title ● ⌄ (eye circle) + the one dropdown (see Mobile)
    actions.js       The phone actions: listMenuActions (title dropdown, file level) + listBubbleActions (bubble, per view:
                     editor · render · history = Save (next version) · library = New)
    action-fab.js    The draggable `{glyph}` action bubble, contextual per pane: tap = primary · hold = grid · drag = snap to a corner
    library-pane.js  The document list (phone pane `library` / desktop SIDEBAR `[data-library]`): search bar (names + text,
                     contextual hits), flat list, + New (asks the name), ⋯ rename title/duplicate/delete
    sheet-grid.js    {spreadsheet}'s GRID — the render pane as a spreadsheet editor (selection, in-cell editing, formula
                     bar, toolbar, popovers, context menu, clipboard, sheet tabs; every gesture → core/sheet/edit.js → `dsl-edit`)
    diff-view.js     DiffView overlay + DiffBar (read-only commit diff)
    dsl-footer.js    ABC transport (play/scrub/time)
    settings-panel.js  Identity, theme, updates (check button), audio output (MIDI)
    comments.js      Inline comments: persistent range highlights + the thread card (a CM tooltip)
    blame-view.js, export-dialog.js, site-nav.js,
    theme.js, editor-theme.js (CM theme on the app's CSS tokens), plugin-extensions.js, update-check.js
  styles/app.css     All app CSS (single file; mobile rules in @media(max-width:640px))
build/
  build.mjs          esbuild pipeline (one quine + PWA per dedicated DSL variant)
  build-id.mjs       detectCommit() / detectChannel() — the non-semver half of a build's identity
                     (shared by build.mjs's defines and sync-site's version.json)
  sync-site.mjs      Builds variants + copies into docs/ + writes docs/version.json
  render-site.mjs    No-Ruby site renderer (docs/ → docs/_site); Cloudflare's production build
  icons.mjs          App icons = the `{glyph}` mark as SVG <text> on a dark tile (re-exports
                     src/core/brand.js; also the site favicon `{}`)
  gen-icons.mjs      One-off: rasterize icons.mjs → templates/icons/<abbrev>/*.png via
                     headless Chromium (committed, like the soundfont — CI never needs a browser;
                     resolves the mono stack to DejaVu Sans Mono, which covers every glyph)
  gen-soundfont.mjs  One-off: fetch FluidR3 piano → src/assets/piano-soundfont.js (network!)
  gen-slides-themes.mjs  One-off: vendor marp-core's default/gaia/uncover themes → src/core/slides/themes.js
                     (`npm i --no-save @marp-team/marp-core` first; web-font @imports stripped)
templates/           quine.html, pwa.html, sw.js, manifest.json, icons/<abbrev>/*.png
docs/                The website (Cloudflare Pages; rendered by render-site.mjs) + committed build artifacts
dist/                Build output (gitignored)
```

---

## Build system (`build/build.mjs`)

esbuild, IIFE bundle, compile-time `define`s. Key flags/modes:

- **Every content type is its own dedicated single-DSL build** (one DSL bundled in, no runtime plugins). There is no "universal" multi-DSL app and no drag-drop plugin system — both were removed.
- `node build/build.mjs` (no flags) → builds **every** variant in `DSL_META`: `markdown`(md), `mermaid`(mer), `abcjs`(abc), `upub`(upub), `udraft`(dft), `slides`(sld), `spreadsheet`(sht). Output per variant: `dist/unifile.<abbrev>.html` (quine) + `dist/pwa-<abbrev>/` (PWA).
- A variant can ship its **own shell** instead of the standard `ui/app.js` one: `DSL_META.<id>.entry` (module relative to `src/`) replaces the generated entry, `DSL_META.<id>.css` replaces `styles/app.css`. The `upub` and `udraft` variants use this (see below) — no CodeMirror, no DSL registry, their own CSS.
- `npm test` → `node --test test/**` — pure Node, no browser: the uDraft core, the library (`test/library.test.mjs`), page config, emoji, etc.
- `--dsl=<variant>` → build just that one variant.
- `--dev` → unminified + inline sourcemaps. `--no-pwa` → skip the PWA (fast iteration).
- Note: each variant still bundles `markdown` as a base alongside its DSL (so prose sections + `#!shebang` DSL sections work within that one app); this is not the old multi-DSL "universal" model. The exceptions are `slides`, whose deck IS Markdown (Marpit) — it bundles only `slides.js` (no marked/docx) — and `spreadsheet`, which bundles only `spreadsheet.js`.

**Compile-time defines** (esbuild `define`, referenced as globals; guard with `typeof … !== 'undefined'`):
- `UNIFILE_MODE` = `"quine"` | `"pwa"` → `IS_QUINE` in storage.js.
- `UNIFILE_VERSION` = the git tag (see Versioning); `UNIFILE_BUILT`, `UNIFILE_COMMIT`, `UNIFILE_COMMIT_AT`, `UNIFILE_CHANNEL` = the rest of the build identity — read them through `src/core/build-info.js` (`BUILD`), not directly.

**Two build targets per variant:** `buildQuine()` embeds the JS **gzip+base64** into the HTML template's `<script id="unifile-data">` region (so plain-text grep won't find code strings in a quine — grep the PWA's `app.js` instead). `buildPWA()` writes plain files + a service worker whose cache name is namespaced per type (`unifile-abc`, etc.) with a content hash so updates supersede cleanly. Each PWA also gets its **per-variant `{glyph}` icons** (copied from `templates/icons/<abbrev>/`, stamped into the manifest + `<link rel="apple-touch-icon">`; the manifest `name`/`short_name`/`<title>`/apple title are the `{name}` — `DSL_META.label = appName(id)`; regenerate icons with `npm run gen:icons` after editing `build/icons.mjs` or `src/core/brand.js`), and `templates/pwa.html` carries a self-contained **pre-install banner** (shows only outside `display-mode: standalone`, per-device install walkthrough, `beforeinstallprompt` when available, dismissal persisted per path in localStorage — template-level so it covers the standard shell AND uPub).

**Direction (2026-07):** dedicated per-content-type builds only — the universal multi-DSL app and the runtime drag-drop plugin system were removed. `npm run build:abcjs` is the flagship (ships the offline piano).

---

## Runtime architecture

**Entry:** `main.js` → `new App().init()`. In quine mode the app is on `window.__unifile`. The build also exposes `globalThis.__uf = { state }` for tests/preview automation.

**State (`state.js`)** is a tiny EventBus singleton (`state`). Mutate via `state.update(patch)` (broadcasts `change`) or `state.emit(event, payload)`; subscribe with `state.on(event, fn)`. Key fields: `data` (the full serialized doc), `vcs`, `currentContent`, `isDirty` (text ≠ head snapshot), `viewMode`, `activePanel`, `diff`, `user`, and the library trio `library` (a `Library`, null in a quine) · `docId` (the open record) · `deviceFile` (`{fileName, savedAt, savedHead, saved, linked, version}` mirrored from the record; `device-change` fires when it moves). Getters: `headHash`, `currentBranch`, **`needsSave`** (dirty OR never saved OR the device copy is behind — THE one condition behind the dirty dot, the Save pill and the pending node), `nextSaveVersion` / `nextMajorVersion`; `isDetached` is always false now.

**Data model (`state.data`)** is the JSON embedded in the quine / stored in IDB:
`{ branches, commits, currentBranch, detachedHead(always null), currentContent, dslType, title, apiName, savedVersion, comments/commentThreads, assets, version, password, … }` (`apiName` = the document's fixed name, `savedVersion` = the last version written to the device; `version` is the BUILD's version, unrelated). `vcs.serialize()` returns the branch/commit fields; after a save the app does `state.update({ data: { ...state.data, ...vcs.serialize() } })` to keep them in sync. `_currentDataObject()` is the canonical builder (it also prunes unreferenced assets).

**VCS (`core/vcs.js`)** — git-inspired, all JSON, kept whole for the file format. Commits (= saved versions, `tag` = the version `A03`) store a **line diff (patch)** against their parent; the root stores `fullContent`. `getContentAt(hash)` reconstructs by walking ancestors + applying patches. **The UI uses ONE linear line (2026-10):** every save lands on `currentBranch` (`main`), a diff is "a version vs the working text", **Restore** copies an old version's text into the editor as an unsaved change (no `checkout`, no detached head, no stash, no branch switching, no merge — all of that UI was removed; `detachedHead` is forced null on every load so old files reattach with their working text intact, and extra branches in old files are carried along untouched).

**Sections & DSLs (`doc-sections.js` + `dsl/registry.js`)** — `#!dslId@version+ext1+ext2` lines split a document into sections, each rendered by its DSL. No shebang → whole doc uses the build's `defaultDslType`. A DSL module calls `registerDSL({ id, getEditorExtensions, render, exporters, … })`.

**Models & layouts** — front-matter `model:` (flow|grid|spatial|timeline|graph) picks a renderer (`model/registry.js` + `layout/`). `flow` is default; its `layout:` (webpage|document|slides) controls presentation. Preview.js dispatches to the right renderer.

**Editor (`editor.js`)** — CodeMirror 6, styled as **the iA Writer surface (2026-10)**: ONE monospaced size (16px desktop / 17px phone, line-height 1.7, `--editor-font-size` / `--editor-pad-x` in app.css), a tall 2px caret in the accent (`.cm-cursor` padding on a content-box extends CM's glyph-high caret by the half-leading), **NO gutter and no active-line tint** (the v0.2–v0.4 comment rail with its M/S marks is gone; `highlightActiveLineGutter` too), the text starting at a plain 24px margin with a 40vh bottom pad so the last line scrolls up to eye level. Headings are bold in the text colour and the Markdown marks (`#`, `**`, `-`, `>`) recede to grey — `--hl-heading: var(--text)`, `--hl-meta` muted; code DSLs keep a quiet palette. `editor-theme.js` is entirely `var(--…)` tokens (no per-theme hex, no `!important` forced overrides — dark/light/auto all come from app.css). **Per-section syntax highlighting** (`sectionSyntaxField`) runs each section's DSL parser through `editorHighlight`; the front-matter block is highlighted as YAML instead of the DSL. **Comments are inline range comments** (see below). **Line wrapping is a per-DSL choice**: abcjs turns it on in its `getEditorExtensions()` (`EditorView.lineWrapping` — music wraps, no horizontal scroll, 2026-09); the other DSLs still scroll horizontally. **Vertical (column) selection** via CM's `rectangularSelection()` + `crosshairCursor()` (Alt+drag, the VS Code/Sublime convention; multiple selections were already enabled). The updateListener also emits **`editor-type` `{pos, ch}`** for single-character `input.type` insertions (multi-char inserts = paste-like, deliberately silent) — consumed by the abcjs note audition (below).

**No section bars (2026-10).** The editor is ONE plain text surface: the collapsible front-matter bar (`editor-sections.js`, block widgets that folded the `---`…`---` block on load) was removed as noise — the front matter is just the first lines of the text, highlighted as YAML. `Editor.setValue` only closes the comment card now. Do not re-add folding of any kind (the generic `@codemirror/language` fold went for the same reason, see Mobile section).

**ABC "one measure per line" formatter (`dsl/abc-align.js`, `alignSource` on the abcjs DSL; Alt-Shift-F, the mobile FAB `.uf-align-btn`, the landscape dock `.ps-align`)** — reflows every music line so each measure sits on its own source line (2026-09; it replaced the column-padding voice aligner, which drifted once lines wrap). **Staff-line breaks are preserved** with the ABC ` \` line continuation: every measure except the last of its original line ends in ` \`, and both engines honour it (abc2svg joins continued lines; abcjs rewrites `\`+newline in place, so `startChar` offsets stay stable and a following `w:` lyric line still binds to the joined line). Idempotent. Fields/comments/`#!`/front matter pass through; the `buildVoiceMap` char→voice lookup is unaffected because a continuation line inherits the last `[V:]`/`V:` boundary before it. Unit-tested in `test/abc-align.test.mjs`.

**Preview (`preview.js`)** renders the active model/DSL. Clicking a rendered ABC note highlights the source (`abc-play-cursor`/`dsl-select`) without flipping panes on mobile.

**The text's context menu (`_showEditorMenu` in `editor.js`, `.uf-ctx-menu`).** **Right-click** anywhere in the text (Android long-press fires contextmenu too) replaces the native menu with ours: **Comment** (on the selection, else the word under the pointer — the caret moves there first, like the native menu), **Copy / Cut** (when there is a selection), **Paste** (only where `navigator.clipboard.readText` exists — Chromium; Firefox gets no Paste item), and on any line **belonging to an ABC voice** — a `V:` declaration line, an inline-`[V:id]`-prefixed music line, or a music/lyrics line under a `V:` line — **Mute voice / Solo voice**, labelled with the voice id (see below); the piano roll's voice chips carry M/S buttons too. **Long-press on SELECTED text** (a pointer timer, 480 ms / 8 px — iOS fires no contextmenu) opens the same menu; a long-press anywhere else is left to the OS (it is iOS's own select-text gesture), and the phone bubble's **Comment** action + `Mod-Alt-M` are the always-available ways in. The menu's buttons `preventDefault` mousedown so the selection survives the click.

**ABC voice mute / solo (state + `editor.js` + `abcjs.js`, keyed by voice id via `core/abc-voices.js`).** `state.abcMutedVoices` / `abcSoloVoices` are `Set`s of voice ids; `state.isVoiceMuted(id)` = explicitly muted OR (any solo active AND not soloed). **Mute and solo are mutually exclusive modes**: soloing clears all mutes and replaces any previous solo (`abcSoloVoices` holds at most one id; toggling the soloed voice clears it), and muting clears any solo (mutes are per-voice opt-ins, several can be active). Toggled from the text's context menu → `state.toggleVoiceMute/Solo` → emits `'abc-voices-change'`. `buildVoiceMap` recognises BOTH standalone `V:` lines AND inline `[V:id]` fields (char-accurate, so a mid-line `[V:x]` switches voice mid-line — this is also what makes `_isMutedAtChar` correct for interleaved `[V:id]`-per-line scores). A muted / non-soloed voice: (1) shows **M** (muted, red) / **S** (soloed, green) in the left margin of EVERY line of that voice — `voiceFadeField` adds `cm-voice-M` / `cm-voice-S` line classes and CSS draws the letter as an absolutely-positioned `::before` (no DOM text, so CM's content reading never sees it; blank/`%` lines are exempt from marks + fade); (2) is dimmed in the editor (`voiceFadeField` line decoration `cm-voice-muted`) and the score — in abc2svg, `setVoiceFade` fades **whole staves**: a staff whose every voice is muted is covered by ONE compound `.uf-staff-veil` `<path>` per system (overlapping subpaths fill once — nonzero winding — so nothing double-fades; per-glyph fading leaked chord tops/stems/beams), while a staff that still has an active voice keeps its furniture crisp and only the muted voice's notes/rests get per-symbol `.uf-muted` veils. The path unions: a full-width band per run of consecutive faded staves (extent from the CLEF annos — the only per-staff-accurate box bracketing the lines + key/meter; unioning note extents dragged the band over the title/tempo, and 'bar'/'key'/'meter' annos lie about their staff — all real bugs), each sounding sym's own anno box (ledger-line outliers), beam/tuplet `rect.abcd` geometry rects (SKIP_ANNO types get non-interactive annos now), and slur/tie arcs matched geometrically (they get NO anno callback; they're unclassed cubic `M…c…` paths — assigned to the nearest staff core via getBBox **mapped through getScreenCTM to root svg coords**: abc2svg nests some arcs in `<g transform=…>`, and the untransformed local bbox put the veil box off-target so the arc showed through "dashed" — real bug; skipped in hidden panes). Staff grouping is **per system svg** (abc2svg hides tacet staves and renumbers); (3) does not sound — the synth path drops it via abcjs's `voicesOff` (score-order voice index from `_mutedVoiceIndices`), the oscillator + Web-MIDI paths skip per-note by `_isMutedAtChar(p.startChar)`; (4) does not highlight during playback — `_highlightEvent` filters each voice by `_isMutedAtChar` (`elements[i]` parallels `startCharArray[i]`, one entry per sounding voice). Char→voice uses section-relative offsets (matching abcjs note startChars); the editor fade builds its own doc-relative map. Selections are cleared on `checkout` / `branch-switch` so stale voice ids don't silence a different tune. **Not persisted** — mute/solo is transient session state.

**Comments (`comments.js`, redesigned 2026-10 — inline, range-anchored, the word-processor way).** Threads in `data.commentThreads`, each with `from/to` char offsets + messages (`archived` = "Resolved" in the UI). **Every open thread's text carries a persistent highlight** (`commentHighlightField`, `.cm-comment-range` / `-active`, amber `--comment-*` tokens per theme; a pre-2026-10 line comment with `from===to` shows as a small `.cm-comment-point` marker). **Adding**: select → right-click / long-press → Comment (or `Mod-Alt-M`, the ⋯ menu's "Comment on selection", the phone bubble's Comment — all `commentOnSelection`, which emits/handles `'comment-selection'`); with no selection it targets the word at the caret, else the trimmed line; a caret inside an existing thread opens that thread instead. **The card is a CodeMirror tooltip** (`commentCardField` provides `showTooltip`: `pos`=from, `end`=to, below the range, flips above when there's no room, rides with the text while scrolling, `width: min(380px, 100vw − 24px)`): the composer for a new range, else the thread with messages + reply box + **Resolve**. LANDMINE: CM matches tooltips by their `create` FUNCTION identity, so `_createCard` is one module-level function — a new tooltip object (other thread, bumped version) reuses the card DOM and calls its `update()`, which is what keeps the composer's focus while typing and re-renders a reply in place; a fresh `create` per tooltip would rebuild (and blur) the card on every transaction. The card element IS the `.cm-tooltip`, so its CSS is prefixed `#uf-editor-wrap` to out-rank CM's injected `.cm-tooltip` theme. Only the composer auto-focuses (opening a thread by tapping its highlight must not pop the phone keyboard). **Closing**: Esc, a mousedown in the text outside the card, or any document change (`tr.docChanged` in the field). **Opening**: a plain `click` on a highlight (not mousedown — the caret still lands and a drag-select that ends on a highlight is not a tap). **Position mapping** (`mapThreadPositions`, from the updateListener BEFORE `state.setContent`): `from` maps with assoc +1 and `to` with −1 (typing at either edge stays outside the comment); a change that replaces EXACTLY a thread's text re-anchors it onto the replacement (iOS autocorrect); a thread whose text is deleted entirely resolves itself; the highlight field maps its own decorations in the transaction and a micro-task `refreshCommentsEffect` rebuilds them from the mapped offsets before paint. **A whole-document swap** (`Editor.setValue` — checkout / branch switch / open — tagged `docReplaceAnnotation`) CLAMPS thread offsets instead of mapping them: mapping a full replacement collapsed every range and auto-resolved every comment on each branch switch (real bug, pre-2026-10). The Resolved comments modal (`showArchivedCommentsModal`) is read-only. Mutations emit `'comments-change'` → the editor dispatches `refreshCommentsEffect`.

**Desktop split layout (`state.splitOrientation`, 2026-09)** — SPLIT view is either **side by side** (`'vertical'`, the default: editor left, preview right, a vertical divider) or **stacked** (`'horizontal'`: preview ON TOP, text BELOW, a horizontal divider). Toggled from the divider's orientation button (`.divider-orient`, split mode only, shows the *other* layout), Settings → Appearance → Split layout, or `state.toggleSplitOrientation()`; persisted in user prefs (`splitOrientation`). It's ONE attribute — `#unifile-app[data-split-orientation="horizontal"]` — and CSS does the rest: `#uf-main` goes `flex-direction: column`, `order` puts the preview before the divider before the editor (DOM order is unchanged), and every divider rule is re-aimed onto the other axis (bar, hit area, buttons, chevron rotations). `_initDivider` drags along Y in stacked mode and resizes the *first* pane, which is the preview there (`panes()`/`axisPos()`). The `1 1 50%` inline flexes that `_updateVisibility` sets work on either axis. Phones never split (their single-pane rules are `!important`), so the attribute is harmless there and the Settings row is hidden.

**Theme (app.css tokens, 2026-10 — the iA Writer palette).** Catppuccin is gone. Dark = neutral near-black (`--bg #181818`, `--text #dedede`, `--accent #3d9bff` = the caret blue), light = white (`--bg #ffffff`, `--text #1a1a1a`, `--accent #1a8cf5`); every surface, the CM editor (`editor-theme.js`), the piano roll's canvas fallbacks, `templates/pwa.html` `theme-color` + `manifest.json` colours use the same values, and **uPub/uDraft (`upub.css`) carry the identical palette** so all six apps match. The four token blocks (`:root`, auto-light `@media`, forced `[data-theme=light]`, forced `[data-theme=dark]`) must stay in sync — a token added to one goes in all four. Print/slide layouts keep their own light values.

**Diff view (`diff-view.js`)** — clicking a non-current commit opens a read-only side-by-side diff (clicked commit vs working state) via `state.openDiff(left,right)` (`'WORKING'` sentinel = live content). `state.on('diff-change')` toggles `#unifile-app[data-diff]` → CSS swaps the panes for `#uf-diff` + the bottom picker bar.

---

## The document library & saving (2026-10 — the iA Writer model, ONE save verb)

**Many documents per app, a back arrow to the list, no branches, and ONE SAVE: to the
device.** `src/core/library.js` (pure; `test/library.test.mjs`) + `src/core/device-file.js`
(the device verbs; `test/device-file.test.mjs`) are shared by all three shells; the UI lives in
`ui/library-pane.js` (standard) and `upub/library.js` (`ShellLibrary`, {write} + {draft}).

- **One IndexedDB record per document** (`library` store, DB version 2; index `app`). A record =
  `{ id 'd_…', app (dslType — every PWA on the origin shares the DB, each lists its own), title,
  apiName, version, excerpt, data (the WHOLE data object incl. `currentContent` = the unsaved
  working text, comments, assets), createdAt, updatedAt, savedAt, savedKey, handle, fileName }`.
  The last-opened id is `localStorage unifile_lib_current:<app>`.
- **Two layers, all on the device, nothing online.** (1) **Remembered** — every edit persists
  the record (1 s debounce; flushed on `visibilitychange`/`pagehide`; quines keep the old
  localStorage draft instead). This is the app remembering, NOT a save the user performs — there
  is no "save into history" verb any more (the separate snapshot-only Save made people save
  twice; it was removed 2026-10). (2) **SAVE** (Ctrl+S / the Save pill / the phone bubble in the
  history view / the pending node's Save / ⋯ → Save) = `App.saveDocument({message, major})`,
  `ShellLibrary.save(...)`: writes the TEXT — just the DSL, nothing else — out of the sandbox as
  **`<apiName>-<version>.uni`**, one NEW file per save, then records the same snapshot in history
  tagged with the version (`vcs.commit({tag})`). ORDER MATTERS: the device write comes first, so a
  cancelled picker / share sheet burns no version and leaves no snapshot (`saveVersionToDevice`
  takes `mark: false`; the app marks the record itself after the commit + persist).
- **Versions are `<major letter><minor 2 digits>`: `A00`, `A01` … `A99`, `B00` … `Z99`** — always
  three characters, a hard ceiling at `Z99` (`nextVersion` returns null → the app says so).
  Save = next minor; **Save as new major** (Ctrl+Shift+S, Shift-click the pill, the pending
  node's "major" switch, the menu) = next letter at `00`. A major bump is only offered once a
  version exists (`state.nextMajorVersion`). `data.savedVersion` / `rec.version` = the last one
  written; the Save pill shows the NEXT one, the version pill the saved one.
- **The name (`apiName`) is fixed at genesis.** `+ New` prompts for it (`_promptApiName`:
  `[A-Za-z0-9][A-Za-z0-9_.]*` with single `-` separators, ≤ 64, unique per app — names are file
  names; cancel = no document). It lives in the file names only (`<apiName>-<version>.uni`; the
  `.uni` is pure text) and, as the app's cache, on `data.apiName` / `rec.apiName`;
  `Library.save` refuses to move it once set. A document created before names existed
  (migration, first launch) is asked at its FIRST save; an "Untitled" document takes the name as
  its title too. The title stays separately editable. A duplicate starts unnamed/unversioned.
- **Where the file goes, by capability (`device-file.js`):** Chromium = `showDirectoryPicker`
  ONCE per document — the FOLDER handle is stored on the record (structured-clone keeps it) and
  later versions land in it silently after `ensureHandleWritable` (the permission prompt only
  works inside a user gesture, which a save always is — autosave never touches the device); if
  the folder picker refuses, a per-file `showSaveFilePicker`; iOS = the share sheet (→ Files);
  else a download. `savedKey` = `stateKey(data)` (head + text + title fingerprint) →
  `isSavedToDevice(rec)` is one compare; the "on device" marker in history sits on `savedHead`.
  **`state.needsSave`** (dirty OR no `savedVersion` OR device behind) is the ONE condition for
  the dirty dot / Save pill / pending node ("Changed since A03" · "Never saved to the device").
- **Open from device** (Ctrl+Shift+O) reads a `.uni` (or `.txt`, or an older `.unifile.json`
  with its history): `describePickedFile` takes the name + version off the file name,
  `dataFromPickedFile` makes it one snapshot tagged with that version (so history continues from
  it), `adoptDeviceDocument` reopens the identical name+version+text record instead of
  duplicating and starts a NEW record unnamed when the name is already taken. In a quine it
  replaces the document.
- **Migration:** on the first library launch with no records, the pre-library single document
  (`documents` store id `default` / `upub` / `udraft`) becomes the first record — for the
  standard shell the localStorage draft's text wins (that PWA never reloaded IndexedDB; the
  draft was its only persistence of unsaved text, and commits were silently lost on reload —
  real bug, fixed by the library).
- **The list (desktop = a COLLAPSIBLE SIDEBAR, phone = the `library` pane; flat, no nesting):**
  `‹` / Ctrl+Shift+L toggles `#unifile-app[data-library]`; the sidebar is `position:absolute`
  inside `#uf-main` with `padding-left` on `#uf-main` (so both split orientations keep their
  layout), it STAYS open while you work (no outside-click close; remembered in
  `localStorage uf_library_open`), `:not([data-mobile-pane])` keeps it off phones. **The search
  bar searches names AND contents** (`searchRecords`: name/title/file-name matches rank first,
  then up to 3 hits per document — the line around each match trimmed to 40 chars a side with the
  match marked — and a hit carries `{from, to}`): tapping a hit opens the document ON that text
  (`App._openRecord(id, hit)` → `Editor.goTo`; `ShellLibrary.open(id, hit)` →
  `editor.setSelection`). The pane's skeleton is built ONCE and only the list re-renders, so the
  search field keeps focus + text across refreshes. Rows: title, `name-A03.uni` (green = the
  device holds it, amber = changed since, grey "not saved yet"), excerpt (hidden while hits
  show), ago · N versions. Phone `data-mobile-pane` values: `library · history · editor · render`.
  Quines have no library: `state.library` is null, the entry points hide, the left circle becomes
  a history clock. Events: `save-document` (`{message, major}` optional), `save-major`,
  `open-from-device`, `new-document`, `restore-version`, `open-library`/`close-library`,
  `document-change`, `device-change`, `saved` (`{version, fileName, result}`).
- **The history dropdown anchors to `#uf-topbar` (`position: relative`)** — the pre-install
  banner above the bar otherwise pushed the bar under the dropdown so the pending node
  intercepted the pill (real bug, found by the Playwright run).
- **Pickers in headless Chromium hang/refuse**: `saveVersionToDevice`/`pickDocumentFromDevice`
  catch a refused picker and fall through to share/download/`<input type=file>`; the Playwright
  checks mock `showDirectoryPicker` (methods on a prototype, so the stored "handle" clones to
  `{name, kind}` and every save re-picks — the silent folder reuse is covered in Node,
  `test/device-file.test.mjs`) or delete it to exercise the download path. `prompt` is mocked
  for the name.

---

## Front matter (`core/front-matter.js`)

The leading `---`…`---` block. **Custom minimal YAML-subset parser** (not a real YAML lib):
- Indentation-based **nested maps** + **inline flow maps** (`{ cc: 32, value: 6 }`). Values stay strings; consumers coerce.
- **Inline `#` comments are stripped** but only when the `#` is preceded by whitespace (so note names like `C#3`/`F#-1` survive). This was a real bug — a commented value silently failed to parse.
- The serializer round-trips nested maps as indented blocks. **Critical:** the model picker re-serializes the *whole* meta, so anything the serializer can't handle gets clobbered — keep parse/serialize symmetric.

---

## ABC + MIDI subsystem (`dsl/abcjs.js`)

The most complex DSL. Ships an **offline acoustic piano** (FluidR3 soundfont committed to `src/assets/piano-soundfont.js`; `abcjs-piano-loader.js` is a **CommonJS** drop-in for abcjs's internal `./load-note` — must stay CJS or abcjs's `require()` interop breaks).

### Dual-engine engraving: abc2svg draws, abcjs plays (2026-07)

**abc2svg** (Moine's JS successor to abcm2ps; `dsl/abc2svg-render.js`) is the **default score renderer** — visibly better beams/slurs/optical spacing than abcjs. **abcjs still parses the same source for everything audible**: `render()` runs `abcjs.renderAbc` into a *hidden* `.abc-preview-wrap` (keeping engraver/TimingCallbacks/synth/noteTimings alive), then abc2svg engraves the visible `.abc2svg-wrap`. If abc2svg fails on some content, the abcjs render is shown instead. Escape hatch: `localStorage.uf_engraver='abcjs'` (no rebuild).

- **Bundling**: abc2svg is a `<script>`-tag lib (global `abc2svg`, no exports); `abc2svgExportPlugin` in build.mjs appends `export default abc2svg;` to `abc2svg-1.js` at load time. ~200 KB gzipped bundle growth.
- **Interactivity = annotation rects** (the pattern abc2svg's own `edit-1.js` uses): a `user.anno_stop` callback per engraved symbol emits an invisible `<rect class="abcr _<istart>_">` via `abc.out_svg`/`out_sxsy`/`sh` (these handle staff-coord scaling — don't hand-roll). The rects drive click→source, selection highlight (`.uf-hl`), playback highlight (`.uf-play`), range band (`.uf-range`), muted-voice dim (`.uf-muted`), and the cursor bar (`.uf-a2s-cursor`, an absolutely-positioned div). **Pair rects↔annos by the istart in the class name, NOT emission order** — abc2svg buffers SVG per staff and joins at flush, reordering rects.
- **Red/green note colouring (abcjs-look) = per-glyph mapping, NOT `<g>` wrapping.** Do NOT emit `<g>…</g>` around symbols from `anno_start`/`anno_stop` — the per-staff buffering interleaves symbol output, the tags mis-nest, and one group swallows its neighbours (cost real debugging). Also: abc2svg batches a whole line's music glyphs into ONE `<text>` with per-char x/y lists (SMuFL codepoints), so individual notes aren't elements — `explodeGlyphTexts` splits them into per-char `<tspan>`s (rendering identical), then `ensureGlyphMap` assigns glyphs to symbols by screen-space containment (element centre in the smallest anno box; >3×-wide elements skipped as staff/bar lines). The map is LAZY and only latches once it actually assigns glyphs — at render time the music font may not be loaded yet, every tspan measures 0×0, and latching then would freeze an empty map (also a real bug). `.uf-hl`/`.uf-play`/`.uf-muted` land on the mapped glyphs (red / green / opacity-fade; `fill:…!important` + `color:…` covers filled heads AND currentColor stems); symbols with no mapped glyphs fall back to a rect tint/veil.
- **Char offsets line up**: abc2svg `istart`/`iend` and abcjs `startChar`/`endChar` index the same section-relative source string, so `_a2sScore` calls take the same offsets the abcjs paths used. `abcjs.js` routes through `_a2sScore` (mirrors `_engraver`'s lifecycle, re-established on click) in `_rangeHighlightNow`, `_highlightEvent`, `_applyVoiceFade`, `_updateScoreCursor/Range`, `stopPlayback`.
- **Theming**: abc2svg draws with `currentColor` → `.abc2svg-wrap { color: var(--fg) }` is the whole dark theme (no invert-filter, unlike the abcjs path). Its fixed-size `<svg>`s get a viewBox + `width:100%` for responsiveness (`makeResponsive`).
- **Exports**: SVG (nested `<svg y=…>` per system composed into one file) and PDF print body also use abc2svg (`abc2svgExportSvg`/`abc2svgExportPrintBody`) — engraved **without** annotation rects (an unstyled `.abcr` rect renders opaque black in an export). MIDI export stays abcjs. Falls back to abcjs per-export on failure. **Both exports MUST engrave with `%%fullsvg`** (prefixed via `withDefaultDirective`): in-app the music font's `@font-face` (a data-URI ttf baked into abc2svg-1.js) lives in a document-level stylesheet abc2svg injects (`abc2svg.sheet`), which does NOT travel with serialized SVG — without fullsvg every notehead/clef/rest in an export is a tofu box (real bug, v0.2.4). fullsvg embeds a `<style>` per svg (~31 KB font each; class names get the directive's value as suffix, `f0x…`). **Export engraves must pass `preserveSheet: true` to `engrave()`**: every Abc instance's first style insertion WIPES the shared document stylesheet (`abc2svg.sheet`) and refills it with its own class names — an export refills it with `f0x…` rules while the live in-app svg still references `f0/f1`, turning every glyph IN THE APP to tofu right after print/SVG export (real bug, v0.2.9). `engrave` snapshots the sheet's rules and restores them in a `finally`. The PDF path is a print window (`exportPDF` in abcjs.js): `@page { size: letter; margin: 0 }` + body padding as margins, `%%pagewidth 7.5in`, one responsive `<div><svg></div>` per system with `break-inside: avoid`, and the window `<title>` = the document title (it becomes the browser's suggested PDF filename).
- **Tablature — two directives, two engines.** `%%tablature`/`%%tab` (the abcjs pragma, ADDS a tab staff below the notation) keeps the **abcjs renderer** — render + both exports guard on `parseTabDirectives` so those docs are pixel-identical to before. abc2svg-native `%%strtab <strings>` (strtab-1.js, bundled; CONVERTS the voice into a tab staff) works in abc2svg mode — strings are listed **highest first** (`%%strtab E4 B3 G3 D3 A2 E2` = guitar). The build plugin prepends `import abc2svg…; var user = {};` to strtab-1.js (it assumes the frontends' script-tag globals, and ESM strict mode would throw on the bare `user`). Fret digits get a hardcoded white `feFlood` halo — themed via `.abc2svg-wrap feFlood { flood-color: var(--bg) }`.
- **Verifying in the preview tools**: rAF is suspended in a hidden/unfronted browser tab — rAF-coalesced paths (reverse highlight) silently don't run, and `getBoundingClientRect` is all-zeros (cursorAt hides the bar on zero geometry rather than mispositioning). Front the tab (screenshot) before asserting on highlight state. `globalThis.__ufAbcDebug()` reports engraver/score/sym-count/offset state; `__ufAbcDebug.exportSvg/exportPrintBody` expose the export paths.

- **Transport** (`dsl-footer.js` + abcjs.js): play/pause, seekable scrubber, current/total time. Persistent bottom bar.
- **Note audition** (abcjs.js "Note audition" section): a single note/chord sounds when **written** (a note letter / octave mark typed → `editor-type` sets `_pendingTypeAudition`, consumed at the end of `render()` once the fresh timing table can resolve its pitch — the AudioContext is acquired/unlocked *inside the keystroke* because the deferred audition runs outside the gesture and would otherwise hit the autoplay policy on first use) or **selected** (collapsed editor cursor on a note via `editor-select`, debounced 80 ms + deduped per note token; preview note click via `dsl-select`, forced so re-clicks replay). The audited note gets the **playback-style green flash** (`_auditionFlash`: score `setPlaying` / `.abcjs-note_playing` + editor `abc-play-cursor`) for roughly its sounding length, cleared on a timer that stands down if real playback started meanwhile. Strictly *covering* char match — no nearest-note fallback (a half-typed accidental must not audition the next note); rests and muted/non-soloed voices stay silent; never during playback. Output follows playback routing: external MIDI port (single on/off, default channel) or `abcjs.synth.playEvent` (`registerAudioContext(_audioContext)` first so it uses the persistent context; no soundFontUrl → the bundled offline piano). Multi-char insertions (paste) deliberately don't audition.
- **Web MIDI output** (Chromium-only): route playback to an external instrument (e.g. Kontakt via IAC) *instead of* the internal piano. Picker is in **Settings → Audio output**. `_startMidiPlayback` builds a time-sorted note queue pumped with look-ahead timestamps; panic (all-notes-off) on stop.
- **iOS audio**: reuse ONE persistent AudioContext (never `close()` it), unlock with a silent buffer in the user gesture, and set `navigator.audioSession.type = 'playback'` so the hardware mute switch doesn't silence it.
- **Unified `midi.map`** (front matter): maps any abcjs marking (dynamics `ff`/`pp`, accents `>`, articulations `legato`/`pizzicato`, custom names) to a MIDI action combining `note` (keyswitch), `cc`, `program`, and a `velocity` effect. `velocity: 112`=absolute level (sticky), `0.8`=scale, `+30`=per-note bump (accents). Per-voice overrides under `midi.voices.<n>` (channel/volume(CC7)/pan(CC10)/velocity scale/map). `midi.octave` = the octave middle-C (60) is called (`c3` default = Kontakt). See README/inline docs for the full schema.
- **abcjs quirk:** it *drops* unknown `!name!` decorations, so we scan the rendered source (`_lastAbcSource`) ourselves for markings; and abcjs reports a note's `startChar` inconsistently vs its own leading decoration, so we match tokens to notes by walking events in source order with an `index < endChar` pointer, not `≤ startChar`.

---

## {document} (`src/dsl/markdown.js`, 2026-10 additions)

The standard-shell Markdown app (marked + DOMPurify, CodeMirror, VCS, HTML/PDF/DOCX/text exports).
Three things landed in 2026-10 — all offline, nothing fetched:

- **PDF export is a self-paginating print window (`src/dsl/markdown-print.js`).** The old
  exporter printed a plain page, so the browser stamped its own header/footer (page title, URL,
  date, "1/3") — "web page info". Now `@page { margin: 0 }` kills that chrome and the margins are
  ours: the document is rendered once as a measuring **tape** at the usable width, cut on block
  boundaries by `core/paginate.js findPageBreaks` (extracted from `layout/flow-document.js`, which
  now imports it — `===`/`.page-break` forces a break, `li` refines long lists), and each page is a
  fixed `pageW×pageH` box with a clipped clone of the tape (`top: -breakStart`) plus header/footer
  slots and the page number. **The tape AND the clones are `display: flow-root`** — a first
  child's top margin (the title page's push-down) collapsed through the tape, so it was measured
  at y=0 but drawn 242px lower in the clone: blank first page, title on page 2 (real bug).
  Window `<title>` = document title (the suggested PDF filename); the window closes itself after
  `afterprint`. Verified with Playwright: `.pg` boxes map 1:1 onto PDF pages (`page.pdf` on the
  dumped HTML — `popup.pdf` on the about:blank popup fails in headless Chromium, not a bug).
- **One front matter drives the PDF and the `layout: document` preview** — `src/core/page-config.js`
  (`parsePageConfig`, pure, `test/page-config.test.mjs`): `page` (letter/a4/a5/legal/`WxH`),
  `margin` (CSS shorthand in px/in/cm/mm/pt), `font` (serif/sans/mono/family), `font-size`,
  `line-height`, `header`/`footer` (CENTRE slot) + `header-left/right`, `footer-left/right`,
  `page-numbers` (`on` = bottom-center, `off`, or a position; merged into its slot with ` · `
  when that slot has text), `title-page: true` (title block alone on an unnumbered first page;
  `{total}` excludes it), `date: today`. Tokens `{page} {total} {title} {subtitle} {author} {date}`
  (`fillTokens`, escaped). **Defaults (2026-10, shared by the PDF and the preview — the preview is
  the PDF's preview): `margin: 0.75in` all round and page numbers ON, bottom-centre**, so a bare
  document prints with nothing in its margins but a page number; `page-numbers: off` removes it.
  (The first cut defaulted numbers off and `72px 80px` margins; the preview's old `bottom-right`
  override is gone — a caller that wants none passes `{ pageNumbers: null }` explicitly.)
  **Blank trailing page (fixed 2026-10):** `findPageBreaks` ended the tape at `scrollHeight`,
  which includes the last block's bottom MARGIN — a paragraph whose 1em crossed the page edge
  while the text fit opened an empty last page (reproduced: 11 lorem paragraphs → 2 pages).
  It now ends at the lowest block border-box bottom and drops any page that would start at or
  past it (a trailing `===` too). The print CSS also neutralises every `break-*` rule inside
  the page clones — the `.pg` boxes ARE the pagination — and keeps `@page size` in the boxes'
  exact px (a named `a4` is half a pixel short of the 794×1123 boxes). `markdownFrontMatterSchema` (in
  markdown.js, includes the grid/spatial/timeline model keys so they don't lint as unknown) feeds
  the shared `fm-schema.js` autocomplete + lint; markdown.js's own mini front-matter parser was
  replaced by `core/front-matter.js parseGlobalFrontMatter` so every consumer reads the same keys.
- **`{.center}` / `{.right}` / `{.left}` at the end of a heading or paragraph** (`core/md-align.js`,
  `test/md-align.test.mjs`): marked 11 renderers get the inlined text, and the marker survives
  inline parsing as literal text, so the `heading`/`paragraph` renderer overrides strip it off the
  END of the text and emit `class="md-align-*"` (app.css for the preview, `EXPORT_CSS` for
  HTML/PDF); DOCX strips it from the last inline `text` token (`splitAlignTokens`) and sets
  `alignment`. The editor dims the marker (`alignMarkerPlugin`, `.cm-md-align-marker`).
- **Emoji: `:` + letters opens a completion menu; a complete `:shortcode:` converts on the closing
  colon.** Data = GitHub's gemoji list committed as `src/core/emoji-data.js` (ONE tab-separated
  string, ~59 KB; regenerate with `node build/gen-emoji.mjs` — network, one-off like the
  soundfont); `src/core/emoji.js` (`searchEmoji` ranks shortcode-prefix › word/tag › description,
  ties in gemoji order, `test/emoji.test.mjs`). The source is the language's `data.of({autocomplete})`
  (shared with the FM schema completions: `markdownComplete`); options use `filter: false` so CM
  keeps our ranking, and the glyph is drawn by a second `autocompletion({ addToOptions })` — safe
  because `addToOptions` is the one config key CM concatenates. The `:` must not be glued to a
  word (`10:30`, `http://`, `key:value` never trigger) and nothing fires inside code
  (`FencedCode/CodeBlock/InlineCode/HTMLBlock/URL/Autolink` via `syntaxTree`). The closing-colon
  conversion is an `EditorView.inputHandler`. Rendering is untouched — the editor inserts the real
  Unicode glyph, so `:rocket:` typed elsewhere stays literal text.
- `exp.export(content, { title })` — the export dialog now passes the document title (window title
  / HTML `<title>`); other DSL exporters ignore the second argument.

## {diagram} — Mermaid 12 (`src/dsl/mermaid.js`, upgraded 2026-10)

The {diagram} app bundles **mermaid 12** whole (was 10.9 — the `@{ shape: … }` node syntax
arrived in 11.3 and simply didn't parse). Everything mermaid ships works offline: every diagram
type (flowchart, sequence, class, state, ER, gantt, pie, journey, gitGraph, mindmap, timeline,
quadrant, requirement, C4, kanban, architecture-beta, packet-beta, xychart-beta, sankey-beta,
radar-beta, treemap-beta, block-beta, …), `look: handDrawn` (roughjs), and BOTH layout engines.

- **ELK is bundled now — do not re-add the elkjs stub.** mermaid 12 made `layout: elk` the
  DEFAULT for flowcharts/class/state/ER (elkjs ships inside mermaid itself, no separate
  `@mermaid-js/layout-elk`), so the old esbuild plugin that stubbed `elkjs/` out of the bundle
  turned EVERY flowchart into "ELK layout is not included in this build" (the stub was worth
  ~1.4 MB unminified; the quine went 1.6 → 2.8 MB with the whole upgrade). `layout: dagre` still
  selects dagre per document.
- **Mermaid's own front matter (`config:` / `displayMode:`) is forwarded from the DOCUMENT's
  front matter** (`src/core/mermaid-front-matter.js`, pure, `test/mermaid-front-matter.test.mjs`).
  Since mermaid 11 `look`, `layout`, `theme` and per-diagram config are set ONLY in a YAML
  front matter — which in unifile is the document's block and is stripped by the layout before
  the body reaches `render()`. `prepareMermaidSource(text, docFrontMatterYaml)` re-prepends the
  RAW `config:`/`displayMode:` lines as a mermaid front matter block (raw, so mermaid's YAML
  parser types numbers/booleans itself); `title:` is deliberately NOT forwarded (it is the
  document title and would be drawn into every diagram). The live preview reads the document
  from `state.currentContent` (`_docFrontMatterYaml`); exports receive the full document and
  strip+forward the same way, so preview = export. The linter parses the same forwarded source
  and maps line numbers back (`prefixLines`); a bad `config:` lands on the front matter's
  `config:` line (js-yaml's `(line:col)` message). `%%{init: …}%%` directives still work.
- **Node ids changed**: mermaid 12 svg node groups are `mermaid-<n>-flowchart-<id>-<k>` (the
  svg id first, then the diagram type) and `look: handDrawn` draws them as `g.rough-node`, not
  `g.node` — `_annotateFlowNodes` handles both (click-back → source line); its node-id word
  boundary accepts `@` (`A@{…}`), `:` (`A:::class`) and `&`.
- **The preview's spinner timer must not wipe a render in progress** (`preview.js
  _armSpinner`). Layout renderers clear the pane and append parts synchronously, then await each
  DSL render IN PLACE; the old 300 ms `innerHTML = spinner` detached the part the first mermaid
  12 render (ELK warm-up, >300 ms minified) was still drawing into — the svg landed in a
  disconnected element and the pane kept the spinner (real bug, found on upgrade). The timer now
  snapshots `content.firstElementChild` and stands down when the renderer has already replaced it.
- **Editor intelligence**: `@{` + attribute names are highlighted (`MERMAID_NODE_ATTRS`);
  inside `@{ … }` the completion offers the attribute keys and, after `shape:`, every shape
  short name + alias (`MERMAID_SHAPES`, scraped from mermaid's shape table — regenerate the list
  when upgrading); diagram-type completion/hover covers the 12.x types; `detect()` too. The DSL
  help modal (`topbar.js DSL_HELP.mermaid`) has "Node shapes @{ }", "Look, layout & theme" and the
  newer diagram types.
- **Icons are the one gap**: `@{ icon: … }` / architecture `(logos:…)` need an iconify pack via
  `mermaid.registerIconPacks` (mermaid fetches nothing itself). No pack is bundled — only the
  architecture built-ins (cloud/database/disk/internet/server) draw. Bundling a pack is a size
  decision, not a code one.
- mermaid 12 leaves its scratch container `#d<id>` in `<body>` after a parse error — `render()`'s
  catch removes `#<id>` AND `#d<id>`.
- esbuild's IIFE build inlines mermaid's lazy `import()` chunks (no warnings); `npm test` is pure
  Node and never loads mermaid. Verify with Playwright against the built quine
  (`__unifile._components.editor.setValue(src)`, then wait for a NEW `.preview-pane svg` id —
  renders are debounced, a stale svg is still there).

## Mermaid zoom & pan (`src/dsl/mermaid-zoom.js`, 2026-09)

Every live-preview Mermaid diagram is wrapped in a `.uf-mmd-stage` that zooms and pans **by rewriting the svg `viewBox`** (crisp at any depth; a CSS transform rasterizes and blurs — uDraft's plan trick). Print layouts (`.uf-slide-frame`/`.uf-doc-page`) keep the plain svg; exports are untouched.

- **Opens fitted** (never enlarged past 1:1 — small diagrams stay natural, big ones shrink). Wheel / trackpad pinch zooms at the cursor, one pointer pans, two pinch, double-click zooms in, `− % + ⛶` buttons (`.uf-mmd-zoomctl`) cover discoverability; ⛶ = fit.
- **Sole vs in-prose.** A `{diagram}` doc is rendered by the default *webpage* layout, so the svg lives in `.uf-webpage > .uf-webpage-section > .uf-web-part` — sole-ness is the CSS `:only-child` chain (`SOLE_SEL`), re-read live because layout parts render sequentially (part 2 landing collapses part 1's `:only-child` height → ResizeObserver → `sync()`). **Sole = the stage fills the preview pane** (`.is-sole`: `100cqh - 48px` tall — `.preview-pane` is now `container-type: size`, safe because the pane is flex-sized, never content-sized — and broken out of the 800px prose column like the ABC score) and plain wheel zooms, `touch-action: none`. **In prose** (a Markdown doc with a `#!mermaid` section) the stage is diagram-sized (inline height, ≤70vh), plain wheel scrolls the page, only ctrl/⌘+wheel (= trackpad pinch) zooms, `touch-action: pan-y`.
- **The view survives re-renders while typing**: the preview replaces the whole svg each render, so views are memoised per preview root + diagram index (`_views` WeakMap); a remembered view whose centre is nowhere near the new diagram is dropped (`_plausible`). ⛶ resets.
- **A drag is never a click**: pointer capture only once a drag latches (capturing on pointerdown retargets the trailing click away from diagram nodes — the uDraft bug), and the click after a >6px drag is stopped at the stage so `preview.js`'s click-back doesn't jump to source; a real tap on a node still does.
- Phones: controls sit top-left (the action bubble and its first-use caption own the bottom).
- **Theme follows the app, live (2026-10).** Mermaid bakes its theme into each svg's `<style>`, so `mermaid.js` re-`initialize`s before EVERY render with `_resolveTheme()` (`data-theme` on `<html>` else `prefers-color-scheme`; `'default'` = mermaid's light theme) — never a hard-coded `'dark'` (the module-load init used to be, and a diagram drawn dark stayed dark after Settings → light or the OS flipping in auto mode — real bug). The DSL declares `themeAware: true` and `preview.js` re-renders on `'theme-change'` when the document uses such a DSL (`_usesThemeAwareDsl`: the build's `dslType` or any `#!` section), scroll kept, zoom view memoised across the swap. Source overrides still win — a `%%{init: {'theme': …}}%%` directive or `classDef`/`style` is layered by mermaid over the site config per render. Print layouts stay `'default'` (white pages); SVG export = the resolved theme, PNG export = `'default'` (it is flattened onto white).

## Piano roll (`src/ui/piano-roll.js` + `core/abc-pitch.js` + `core/voice-colors.js`)

A DAW-style second input surface for ABC docs (v0.3 feature). **Desktop:** the transport bar's
piano-roll button expands it bottom-up as an in-flow flex child (via `#uf-bottom`'s
`display:contents`) and it REPLACES the transport while open (`#unifile-app[data-piano-roll]`
hides `#uf-transport`; the roll carries its own play/pause + time + scrub ruler). The pane is
**vertically resizable** via the `.pr-grip` top edge (sets `--uf-roll-h`, CSS min/max clamps,
persisted in `localStorage.uf_roll_h`). **Landscape phones:** a `.ps-roll` dock button toggles it
**FULL SCREEN** (`height: var(--app-height)`, grip hidden — the roll is the app while open).
**Portrait phones:** unavailable. The header's **pencil (draw) tool** (`.pr-pencil`) is the
touch-first editing mode: single tap on empty = add, single tap on an active-voice note = delete
(no double-anything); pencil off = tap selects, drag transposes, edge-drag resizes.

- **Data**: `abcjs.js _emitRollData()` publishes `state.abcRollData` (+ `'abc-roll-data'`) each
  render: per-pitch `{ms,durMs,durWhole,midi,startChar,endChar,voiceId}` notes (chord pitches share a
  startChar), rests (timing moments with no sounding pitch — the add-note targets), voices, meter,
  msPerMeasure/msPerWhole, sectionOffset, source. Char offsets are section-relative (same space as
  noteTimings).
- **Canvas roll**: keyboard column + beat/measure ruler (click/drag scrubs via `abc-seek-preview`/`abc-seek`),
  notes colored per voice, non-active voices ghosted, muted voices near-invisible, playhead with
  auto-follow, wheel scroll / ctrl+wheel time-zoom. **Fit-to-tune runs ONCE per document**
  (`_maybeFit`, reset on `checkout` = document open / restore) — never on edit re-renders, which must not move the
  user's view; it's also deferred until the canvas has nonzero width (the pane can open in a hidden tab).
- **Voice identity**: `--voice-0…7` CSS vars (Catppuccin accents, themed) assigned by score order
  (`core/voice-colors.js`). Header chips = the DAW track list: click selects the edit-target voice
  (`state.abcActiveVoice`/`setActiveVoice`), per-chip M/S buttons reuse `toggleVoiceMute/Solo`.
  Clicking a ghost note switches to its voice.
- **Editing = ABC text rewrites only** (no onset drags — in ABC, time is token position). Click →
  select + `dsl-select` (source highlight + audition); vertical drag → transpose; right-edge drag →
  length (quantized vs `L:`); dbl-click note → delete (token→rest, or chord-pitch removal);
  dbl-click space → add over a rest (splitting it) / chord-stack at an onset / append at voice end;
  Delete/arrows on the selected note. Edits go out as `'dsl-edit'` `{changes, selection}` (full-doc
  coords) which editor.js dispatches through CM6 → undo history + normal content-change flow.
- **Pitch spelling** (`core/abc-pitch.js`): key-sig-aware (`parseKeySig`, sharps in sharp keys, flats
  in flat keys), omits the accidental when the key signature already sounds it, forces an explicit
  one when an earlier in-measure accidental would interfere, and `accidentalRepairs()` pins later
  same-letter notes in the measure whose inheritance the edit changes — ONLY when the old token had
  or the new token gains an explicit accidental (unconditional repairs spray harmless-but-noisy `=`).
- **Raw-pitch audition**: `'abc-audition-pitch'` in abcjs.js (drag/keyboard feedback; no source token
  yet) — routed like all audition: external MIDI port else the bundled piano.
- **Landscape phone**: the overlay lives inside `#uf-bottom`, which the phone CSS blanks
  (`display:none`) — a fixed child of a hidden parent doesn't render, so
  `#unifile-app[data-piano-roll] #uf-bottom` reopens it as a zero-height shell (real bug). Height
  tracks `--app-height` (not bare vh). Touch: double-tap is SYNTHESIZED from pointerups in
  `_onPointerUp` (native dblclick on touch is flaky; `_suppressDblUntil` swallows the native one
  that may follow), the resize grab zone widens to 10px on `pointer: coarse`, and the canvas sets
  `touch-action:none` + user-select/callout none + contextmenu-preventDefault.
- **Landmines**: `setPointerCapture` throws for stale/synthetic pointer ids — it's wrapped in
  try/catch (do not remove). Rows scrolled under the ruler are intentionally not clickable
  (`y < RULER_H` = scrub zone). In preview automation the tab must be FRONTED before dispatching
  synthetic pointer events (unfronted tab → all rects 0×0 → clicks land in the "ruler" and scrub),
  and setTimeout is throttled to ~1 s ticks — dispatch double-taps synchronously or the 350 ms
  pair window can't be hit.

## uPub (`src/upub/` + `src/styles/upub.css`)

A dedicated **writing** variant (abbrev `upub`; formerly "Unifile Writer", abbrev `wr` — renamed 2026-08, old `/writer/` URLs + `pwa-wr` installs deliberately not preserved) — a minimal, distraction-free writing app; mobile/iOS-first, EPUB export. It deliberately does **NOT** use CodeMirror or the standard `ui/` shell: `DSL_META.upub` points the build at `src/upub/main.js` + `styles/upub.css` (see Build system). It reuses `core/` (storage, vcs, diff, hash, front-matter) so its data object round-trips as a normal `.unifile.json`. PWA docId is `'upub'` (the shared per-origin IDB). Internal DOM ids / CSS classes keep the historical `wr-` prefix on purpose (pure namespacing — renaming them buys nothing).

- **Editor (`upub/editor.js` + `upub/syntax.js`)** — a custom contenteditable, one `<div class="wr-line">` per source line. The reason it exists: **hanging indent on wrapped list/quote lines** (`--hang: Nch` + `padding-left/text-indent`), exact because the editor font is monospaced. `syntax.js` classifies lines (stateful: fences + leading front matter) and renders inline spans; its hard invariant is **textContent(rendered line) === source line** — rendering may only wrap text, never change it. Editing model: character-level input runs **natively** (intercepting breaks iOS autocorrect/dictation) and is *reconciled* afterwards (extract DOM text → diff → re-render changed lines → restore caret by absolute offset); structural input (Enter, paste, Cmd+B/I, undo) is intercepted in `beforeinput`. **Never touch the DOM during composition** (`isComposing`) — reconcile on `compositionend`. Undo is a custom snapshot stack (`historyUndo`/`historyRedo` intercepted — that's also iOS shake-to-undo). NBSPs from contenteditable are normalised back to spaces on extraction. **Swipe indent (`_bindSwipe`)** — the iOS-Notes gesture: a one-finger horizontal drag on a bullet/ordered/task/quote line (gated on `infos[].type`, so listy text in fences/front matter never triggers) indents right / outdents left via `indentLines()`, which is deliberately selection-free — `_setSelOffsets` on an unfocused contenteditable would focus it and pop the iOS keyboard mid-swipe (caret rides along only when already focused). Latched once |dx|>16px, clearly horizontal (dx ≥ 2·dy; vertical-first = scroll, cancels) AND within 300 ms of touchstart (slower = iOS long-press/loupe — abandoned). The gesture yields to the iOS text system: it never arms on a touch near the caret (caret drag) or near a selection's endpoints (handle drags; the middle of a selection still block-swipes), an unlatched gesture dies on any `selectionchange`, and a model replacement mid-gesture (autocorrect commit — `this.lines` identity check) cancels rather than indenting shifted line indexes. The drag then SNAPS between 2ch detents (one per 48px — the indent grid itself, so `translateX(2ch·level)` is exactly where the re-indented text renders; `.wr-line`'s 0.16s transform transition animates each snap), clamped so an impossible outdent never previews. Nothing is edited mid-drag: the whole preview lands as one edit on release (multi-level coalesced into ONE undo snapshot via `{coalesce}`), transform cleared transition-less in the same frame so the swap is pixel-identical. A multi-line selection containing the touched line swipes as a block. `/indent` + `/outdent` slash items are the discoverable fallback; hardware Tab/⇧Tab unchanged.
- **Inline comments (`upub/comments.js`, shared with uDraft, 2026-10)** — same data (`data.commentThreads`, absolute offsets) and manners as the standard shell's `ui/comments.js`, so a `.unifile.json` carries its comments between {write}/{draft} and the CodeMirror apps. The editor's invariant (textContent(line div) === source line) forbids spans in the text, so **highlights are rects in an overlay layer** (`.wr-comment-layer`, first child of `#wr-sheet`, which is `position:relative`; `.wr-editor` sits above it) measured with `editor.domRange(from,to).getClientRects()` and redrawn (rAF-coalesced `refresh()`) on every edit, a ResizeObserver on the editor root and window resize — exactly how a browser draws its own selection. The **card** (`.wr-comment-card`) is positioned in the sheet under the range's last rect, so it scrolls with the text. **Gestures**: `contextmenu` only when there is a non-empty selection (with a collapsed caret the NATIVE menu stays — it carries the spell-check suggestions a writer needs); long-press (480 ms) inside the selection's rects; a click that leaves a collapsed caret inside a thread opens it (rAF after the click so the selection has settled), elsewhere closes the card; `Mod-Alt-M`. **Position mapping**: `UPubEditor` takes `onEdit({from,to,insertLen})` — ONE replaced span per model change found by common prefix/suffix (`_emitEdit`, called from `_applyEdit`, `_reconcile`, `_history`, `indentLines`; NOT `setValue`, a different document) — and `mapEdit` moves threads like CM does (from sticks right, to sticks left, exact-replacement re-anchors, fully deleted → resolved); `setContent` calls `clamp()` (keep offsets, clamp to length). **⋯ menu → Comments…** is a sheet listing open (tap → jump + open) and resolved threads. `_newDocument` seeds `commentThreads: {}`.
- **EPUB (`upub/epub.js` + `upub/zip.js`)** — EPUB 3 + NCX fallback, built in-browser: chapters split on `#` h1s (outside fences), marked(GFM) → DOMPurify → DOM transforms (task-checkbox inputs → glyph spans; `data:` images extracted into archive files) → XMLSerializer for well-formed XHTML. `zip.js` is a hand-rolled stored-only ZIP (the `mimetype` entry must be FIRST and uncompressed). Metadata from the leading front matter (`title/author/language/description/identifier`).
- **Shell (`upub/app.js` + `upub/slash-menu.js`)** — title bar (word count + preview + ⋯; auto-hides while editing on touch devices — `data-editing`, driven by editor focus + a visual-viewport keyboard heuristic; the header returns when the keyboard is dismissed via iOS's own accessory-bar ✓ — a floating dismiss button and a custom keyboard toolbar were both tried and scrapped as redundant with that native bar, which a web app cannot hide; the bar ALSO slides away IN STEP with scrolling down and back in with scrolling up, Safari-toolbar-style — `_bindScrollChrome` drives `--wr-hide` (0…1; the header's margin-top/opacity are calc()'d from it) from clamped scroll deltas on `#wr-scroll`/`#wr-preview`, suppresses the transition while a scroll is live (`data-scroll-tracking`) so it tracks 1:1, and snaps a partial bar to the nearer edge when scrolling idles (near the top the snap always shows; progress is also capped at scrollTop/47 so the top of the doc reveals the whole bar). `data-scroll-hidden` now only marks the fully-hidden state (pointer-events). Independent of `data-editing`, whose rule out-specifies the calc(). LANDMINE: the hide GROWS the scroller — flex column — so hiding while at the bottom clamps scrollTop and fires fake "scroll up" events that made the header bounce; an upward delta landing AT the bottom edge is the clamp's exact signature and is dropped — a real up-scroll always lands above the edge) + editor + bottom sheets (menu/history/export/settings/guide/about). **There is no toolbar**: formatting/insertion is the `/` slash menu — the editor reports a slash context (`slashContext()`: `/` at line start or after whitespace, never in code/fence/front-matter, collapsed caret; trailing word = filter query) after every edit/caret move, and the app opens `SlashMenu` at the caret (block items only when the `/` starts its line; picking removes the `/query` then runs the action; menu taps preventDefault so the iOS keyboard stays up). History UI is linear (commit + restore on `main`); branching/merge stays in the full apps. Copies the load-bearing iOS viewport handling from `ui/app.js` (`--app-height` via visualViewport, window-scroll lock — see Mobile section). **Tap-to-focus scroll guard (`_guardFocusScroll`)** — iOS/WebKit's focus-time "reveal the focused element" scroll (plus a keyboard-open scroll-anchoring bug) targets the contenteditable's TOP rect, and uPub's editor is one contenteditable spanning the whole document — so tapping to edit yanked `#wr-scroll` to the first line while the caret stayed where tapped (real bug). The guard records the scroller position at `pointerdown` and, for ~900 ms after the editor gains focus, restores it whenever a scroll leaves the caret outside the pane; a scroll that keeps the caret visible (iOS's legit lift above the keyboard) is never touched, and `touchmove`/`wheel` cancel the guard so the user's own flick wins. Exports go through the share sheet on iOS (`shareOrDownloadFile`, plus a binary Blob variant in app.js for `.epub`).
- **Self-updating PWA (`_bindServiceWorker` in upub/app.js)** — the app registers its SW with `updateViaCache:'none'` and calls `reg.update()` at launch + on every return to foreground; since templates/sw.js self-skipWaiting()s and claims, a new build takes control as soon as it's seen, and the app's `controllerchange` listener then flushes the document to IDB and reloads ONCE (first-install claim doesn't reload). A launch-time version.json check additionally shows a tappable update toast. The manual path stays in About (version + `UNIFILE_BUILT` build stamp + Check for updates → `_applyUpdate`, which never blind-reloads on a timer).
- **Docs** — the full user guide lives ONCE in `upub/guide-content.js` (plain-string ESM): the app renders it in the Guide sheet, and `build/render-site.mjs` imports it and emits `/upub/guide/`. Keep it current when changing uPub behaviour. Site front door: `docs/upub.md` (+ `types.yml`/`apps.yml` entries).

## uDraft (`src/udraft/` + `src/core/udraft/` + `src/styles/udraft.css`)

A dedicated **architectural drafting** variant (abbrev `dft`): floor plans for
homes/buildings from a plain-text DSL — rooms in, blueprint out. Full design
rationale in `plans/udraft-dsl.md`; user-facing reference in
`src/udraft/guide-content.js` (rendered in-app AND emitted as `/udraft/guide/`
— keep it current). Like uPub it ships its own shell (`DSL_META.udraft.entry`
= `udraft/main.js`, css = `styles/udraft.css`) and reuses `core/` for
storage/VCS; legacy PWA docId `'udraft'` (migrated into the library), `dslType: 'udraft'`.

- **The DSL is strictly one statement per line** (that property is what makes
  line diffs, click-to-source, and a future direct-manipulation canvas work —
  hold it). Room-first declarative: `room kitchen 12' x 10' east of living,
  align north` — compass-only directions, **interior-clear dimensions**
  (walls are implicit: derived between/around rooms), `outline E 8' S 6' …
  close` walks for irregular shapes, `at x, y` as the absolute escape hatch.
  Openings reference walls as `roomA/roomB` (shared) or `room side`
  (exterior). Layout is a **deterministic single pass** in declaration order —
  forward references are errors, never solved; diagnostics are line-mapped.
  `fixture` places symbols on a wall (`on north at 2'`) or **free-standing**
  (`centered`, or `at x, y` from the room's NW interior corner; `facing`
  turns it, front south by default — that's how a kitchen `island` stands;
  `w x d` overrides any type's footprint). `define <id> <w> x <d> ["Label"]`
  declares a **document-global reusable object type** (a piano defined once
  places on every floor) — handled at document level like `floor` (never
  opens an implicit floor), define-before-use enforced at parse exactly like
  room refs, and the scene carries `defines` (autocomplete + the scope
  editor, which pulls a custom object's define line in beside its placement).
  **Custom shapes** on `define` (2026-09): `shape <name>` borrows any built-in
  symbol (`grand-piano`, `upright-piano`, `sofa`, `chair`, `tub`, … — the
  `SHAPE_NAMES` list, plus `round`/`box`); `outline <walk> close` replaces
  `w x d` with the room walk grammar (footprint = the walk's bbox); `path M/L/H/V/C/Q/Z …`
  is the SVG-style escape hatch in the object's own lengths. All three end
  up as a `def.path` command list (or `def.shape` name) NORMALIZED to the
  unit box, so a `fixture` size override scales the drawing — the furniture
  built-ins are `UNIT_SHAPES` in svg.js drawn the same way (`scalePath`),
  which is what lets `shape` reuse them. Fixture label text counter-rotates
  by the group angle so it reads upright (a south-wall REF, a west-facing
  piano). Room labels dodge the room's fixture rects when a clear band fits
  the text block (a `centered` island sits exactly where the label goes).
- **Everything geometric is integer µm** (1" = 25400) — shared-wall detection
  is exact equality of face distances (a face pair exactly `walls.interior`
  apart with overlapping intervals = ONE shared wall), so no float epsilons.
  LEXER LANDMINE: `"` immediately after a digit is the inch mark (`12'6"`),
  not a string quote — label strings are the only other double-quote context.
- **`core/udraft/` is pure** (parse.js → layout.js → svg.js, no DOM) and unit
  tested (`npm test`, `test/udraft-core.test.mjs`). Wall rendering = ONE
  nonzero-winding path over all wall band rects + per-corner squares (the
  abc2svg staff-veil union trick — overlaps fill once); opening gaps are
  paper-coloured rects punched on top, symbols draw over them. Every entity
  carries `data-doc-from/to` (absolute char offsets of its source line) —
  we emit the SVG ourselves, so no anno-rect archaeology.
- **The editor is uPub's, shared not forked**: `upub/editor.js` takes a
  `syntax:` option ({classifyDoc, renderLineHtml, lineClass}, defaulting to
  uPub's Markdown module) + an `onCaret` callback. uDraft's `syntax.js` holds
  the same invariant — `textContent(rendered line) === source line` — and the
  Markdown-specific commands/swipe-indent are gated on line types uDraft never
  emits, so they're inert. Deliberately NO parse-error underlines in the
  editor (half-typed lines are always "wrong"); diagnostics live in the
  preview's issue strip + the header stats button.
- **Floors**: `floor <n> "Title"` blocks; **room ids are scoped per floor**
  (each storey can have its own `bath`; openings resolve within their floor).
  All floors share one origin, so identical relative placements stack rooms —
  that's how stair shafts align. Preview tabs sort by floor number (basement
  `0`/negative left). `crossFloorStairsCheck` warns when an `up`/`down`
  flight has no stairs overlapping its footprint on the adjacent floor.
- **The eye toggles the blueprint** (uPub's preview pattern): floor tabs when
  multiple `floor` blocks exist, issue strip (tap → source line). Plan
  interaction is STRICTLY HIERARCHICAL (`_bindPlanNav`, one setter
  `_setScope(roomId, from)`): at floor level every tap resolves to a ROOM
  (tapping a door first enters the room it belongs to — `_roomOfRec`).
  Entering a room renders it in ISOLATION (`opts.isolate` in
  `renderFloorSvg`): only that room's walls (wallRects carry `rooms:` owner
  ids for the filter), openings and fixtures — no labels, no floor dims —
  its interior dims drawn OUTSIDE the walls (`annotationMarkup`), plus
  labelled NEIGHBOUR ARROWS (`neighborMarkup`, placed at the connecting
  opening when one exists) that are themselves room tap targets, so rooms
  chain. Inside a room, tapping its objects selects them: zoom to
  `scopeExtent` + the object's width/position/depth annotated beside it
  (`ud-anno`, accent, never in exports). The top bar `#ud-ctxbar` is
  BREADCRUMBS ONLY (Floor › ROOM › OBJECT — upper levels are buttons back
  up); dimensions are drawn, not written in the bar. **LONG-PRESS (550 ms,
  <8 px) = EDIT**: it focuses the pressed thing and opens the SCOPE EDITOR
  `#ud-edit` — a SECOND UPubEditor instance (multi-line, uDraft syntax
  highlighting) holding the scope's statements (object → its line; room →
  its `room` line + every statement referencing the room). Each keystroke
  reconciles pane rows back into the doc by prefix/suffix diff
  (`_paneChanged` — rows are anchored to doc line indexes, so scattered
  source lines edit in place; Enter inserts a doc line after its pane
  predecessor, joins delete); undo coalesces as typing, and scope state is
  NOT dropped while the pane has focus, so a half-typed statement doesn't
  collapse the view. There is deliberately no jump-to-full-DSL from the
  plan (the issue strip still jumps). State survives live re-renders via
  `_entIndex` (records keyed by statement offset).
  **Every entity is a real tap target** — thin strokes are hopeless taps, so
  interactive renders add invisible `ud-hit` rects per entity (transparent
  fill still hit-tests); exports carry none of it. **LAYERING IS LOAD-BEARING**:
  room interior hit paths render just above the walls and label groups render
  LAST — rendering room hits late shadowed every object inside the room (real
  bug; a label group targets its `label` statement when one exists, else the
  `room` line). **Do NOT setPointerCapture on pointerdown** — capture
  retargets the compatibility `click` to the captured element, so taps never
  reach entity groups (real bug; capture only once a drag latches).
  **Zoom/pan rewrites the svg VIEWBOX, not a CSS transform**
  (transform-scaled svg rasterizes at layout size and blurs; a narrowed
  viewBox stays vector-crisp): wheel zooms at the cursor, one pointer pans,
  two pinch, −/⛶/+ buttons (`_bindZoom`; `this._view` survives live
  re-renders while typing, resets on floor switch, ⛶ = fit). A drag sets
  `_planDragged` so the trailing click doesn't jump to source.
  **Autocomplete is a second `SlashMenu`
  instance** (`#ud-auto`) fed context-aware candidates (keywords at line
  start; declared room ids after `of`/`/`/`swing` and as first argument of
  door/window/…; sides after `align/from/on/along/facing`; fixture types) —
  same touch/keyboard machinery, the autocomplete menu gets keydown routing
  priority over the slash menu. Slash items insert statement templates with
  the first placeholder pre-selected.
- **Exports**: SVG (concrete-colour `<style>` embedded — `exportStyles`), PNG
  (canvas rasterize), and **PDF at true drawing scale** — `renderPrintBody`
  sizes each floor's svg in real inches from `scale:` front matter (default
  `1/4in` = 1/4":1'-0"), print window `@page { margin: 0 }` + body padding.
  In-app the plan themes via CSS vars (`udraft.css` mirrors
  `svg.js baseStyles` — keep the `ud-*` class lists in sync).
- **Site plans (2026-09) — `site` sheets** beside the floors (same `floors[]`
  array, `kind:'site'`; every floor consumer sees empty `rooms/walls/…` and
  stays oblivious). Parsed like `floor` blocks (`site ["Title"] [scale 1"=30' |
  1:500 | 30] [north up|left|right|down|<deg>]`); a site statement outside a
  site opens an implicit site, a floor statement inside one opens an implicit
  floor. Statements: `lot [id] ["Label"] [at x,y | from <lot> corner n] [courses…]`
  + `course <bearing> <dist> ["monument"]` (metes and bounds, clockwise from
  the point of beginning = the site origin, x east / y south), `setback <d>
  [course n]`, `contour <elev> [index] <pts…>`, `line ["Label"] [dashed]
  [smooth] <pts…>`, `building [id] (<w> x <d> | from floor [n|"Title"]) at x,y
  [rotate deg] ["Label"]`, `road "Name" along course n [width d] ["sub"]`,
  `driveway <w> from x,y to x,y…`, `feature <type|define-id> [w x d] at x,y
  [rotate] ["Label"]` (every `SITE_FEATURES` type — well, septic, drainfield,
  shed… — also works as a bare keyword: `well at …`), `tree [caliper] ["sp"]
  at x,y [canopy d]`, `note at x,y "text"`. **Bearing tokens** (`N 87°35'24" E`,
  `N87-35-24E`, `N 87d35m24s E`, `N 87.59 E`) lex ONLY on `lot`/`course` lines
  (`tokenizeLine(line, {bearings:true})`; syntax.js does the same by `info.kw`)
  — elsewhere `N 8 E 6` must stay an outline walk. `layoutSite` is FLOAT
  geometry rounded to integer µm per construction (courses run at any angle;
  nothing needs the walls' exact-equality tests): the figure always closes
  visually on the origin, a closure miss > 0.5' is a WARNING with the
  distance; setbacks = `offsetPolygon` (per-edge inward offset, consecutive
  offset lines intersected); a building whose rotated corners leave the lot or
  cross the setback polygon warns (`pointInPoly`). **Floors lay out first,
  sites after** so `building from floor N` can stamp the laid-out floor's
  `wallRects` + room polys onto the lot (translate NW wall corner → `at`,
  rotate about it). Rendering (`renderSiteSvg`): the sheet has ITS OWN SCALE
  (`floor.ratio`, model mm per paper mm; default 1"=20'), so every pen weight /
  text size is a PAPER-mm spec × ratio emitted as SVG ATTRIBUTES — the
  stylesheet's `ud-s-*` rules only colour (a CSS stroke-width would override
  the attribute; keep it that way). The whole drawing sits in
  `<g class="ud-site" transform="rotate(θ)">`; `stext()` handles orientation:
  upright text counter-rotates, along-line text (bearings, contours) is
  normalised so it never reads upside down after the rotation, and offsets are
  SCREEN-space (`down()` / `lift`) — a model +y offset becomes a sideways shift
  once the sheet rotates (real bug). Contours are Catmull-Rom smoothed and
  labelled at both ends; driveways = a wide fg stroke under a paper-coloured
  stroke (two edge lines on any curve; the lot line draws after them so it
  survives the crossing). North arrow + graphic scale bar are drawn in screen
  space outside the rotated group. `scopeExtent` returns SCREEN-space boxes for
  site records (`rotatedBox`); `annotationMarkup` is empty for sites. App: site
  sheets are FLAT (no room level — `_tapEnt`/long-press select the record
  outright); `_entIndex` = `siteRecords()` (courses first so a lot with inline
  courses on the same line wins); the scope editor for a lot = its line + every
  course/setback line. Print/PDF sizes a site sheet by its own ratio
  (`siteScaleLabel`). **Headless-Chromium screenshot landmine:** the viewport
  is ~90 px shorter than `--window-size`, so the bottom of a tall sheet (the
  scale bar) is cut off in screenshots — it is not a rendering bug.
- **`styles/udraft.css` `@import`s `upub.css`** (esbuild bundles it): the
  wr-* shell rules ARE the shared shell — uPub shell changes intentionally
  flow into uDraft. Theme attribute stays `data-wr-theme` for that reason
  (prefs key is `udTheme`). **Desktop editor (≥700px, uDraft only)**: the
  70ch prose measure is lifted (`#wr-sheet { max-width:none }`) and a line
  number gutter appears — CSS counters in `.wr-line::before` (NOT DOM text,
  so the editor's textContent invariant, copy/paste and caret placement are
  untouched), scoped to `#wr-scroll` so the scope editor's scattered rows
  stay unnumbered. Phones keep uPub's plain surface.

## {slides} (`src/dsl/slides.js` + `src/core/slides/` + `src/core/assets.js`, 2026-09)

A dedicated **Marp-style slide deck** variant (abbrev `sld`, dslType `slides`) on the
STANDARD shell (CodeMirror, VCS, quine/PWA, phone chrome) — not its own shell like
uPub/uDraft. **Bare Marpit (`@marp-team/marpit`), deliberately not marp-core**: marp-core's
extras (twemoji, KaTeX, highlight.js) fetch from CDNs and add ~1 MB; Marpit is markdown-it +
postcss and makes no network call. The old `src/dsl/marp.js` (marp-core + pptxgenjs PPTX
export) is gone; PPTX is not a goal. `layout/flow-slides.js` (the {document} app's `===`
slides layout) is untouched and unrelated.

- **The deck is the whole document.** The DSL sets `wholeDocument: true` and `preview.js`
  (`_wholeDocumentDsl`, branch 0 of `_renderInner`, renderer key `dsl:slides`) hands it the
  FULL source — front matter included, Marpit reads its global directives (`theme`,
  `paginate`, `size`, `headingDivider`, `header/footer`, …) from it — bypassing the model /
  layout machinery and its `===` section splitting entirely (splitting per slide would lose
  the directives + pagination). `dsl.print` (= the PDF export) replaces `window.print()` there.
  No `#!shebang` DSL sections inside slides by design (Unicode or an SVG asset instead).
- **Engine (`core/slides/deck.js`, pure, `test/slides-deck.test.mjs`)**: `preprocess` turns
  every `---` OR `===` outside the front matter / code fences into a `---` preceded by a
  blank line (so `text\n---` is never a setext heading — a real Marp footgun) and returns
  each slide's ORIGINAL source range; `renderDeck` = Marpit `inlineSVG` render (one
  `<svg data-marpit-svg viewBox="0 0 1280 720"><foreignObject><section>` per slide + one
  CSS string incl. `@page`). Markdown-it runs with **`html: false`** — comment directives
  (`<!-- _class: lead -->`) and `<style>` tweaks still work (Marpit parses those itself),
  raw HTML is shown as text, and nothing needs DOMPurify afterwards (which would gut
  `foreignObject` anyway — it is in DOMPurify's forbidden list). `breaks: true` like Marp.
  A single shared Marpit instance registers the vendored themes (`themes.js`: marp-core's
  default/gaia/uncover CSS, MIT, web-font `@import`s stripped; regenerate with
  `npm run gen:slides-themes`). `slides[i]` ranges land on each `<svg>` as
  `data-doc-from/to` (preview click-back → cursor to the slide's source) and
  `data-page-content-from/to` (the existing cursor→page scroll sync).
- **Images are DOCUMENT ASSETS, never base64 in the text** (the user's explicit call —
  contrast the {document} app, which inlines data URLs and collapses them with a pill
  widget). `data.assets = { 'photo.jpg': { type, data(base64) } }` lives beside
  `commentThreads` in the data object (quine JSON / IDB / `.unifile.json` round-trip for
  free); the text references an asset by bare name — plain Markdown `![alt](photo.jpg)`, so
  every Marp image keyword (`![bg left:40%]`, `![w:300]`, filters) keeps working.
  `resolveAssets` substitutes the data URI into the SOURCE before markdown-it sees it (the
  only way to reach every place Marpit puts a URL: `<img src>`, background `<figure
  style>`, split layouts). **markdown-it's `validateLink` refuses `data:image/svg+xml`** by
  default (only gif/png/jpeg/webp) — the shared instance overrides it to allow every
  `data:image/*`, keeping vbscript/javascript/file blocked. Paste / drop in the editor
  (`imageDropPaste`), or **Insert image…** (`dsl.actions` → the ⋯ tools menu on desktop and
  the phone bubble + title menu — a generic hook, `actions.js dslActions()`; on phones the
  file input opens the photo library) → `addImageFiles`: rasters over `MAX_EDGE` (2560 px
  long side) are downscaled through a canvas (PNG stays PNG, else JPEG; SVG/GIF verbatim),
  identical content dedupes onto its existing name, names are sanitised + uniqued
  (`assetNameFor`/`uniqueAssetName`), then — ORDER MATTERS — assets go into state, the
  reference is inserted (`'editor-insert-block'`, editor.js: on its own line, blank lines
  kept around it, undoable), and only then `'assets-change'` fires so the save that follows
  sees the reference. **Editor thumbnails**: a line that is nothing but `![…](name)` gets a
  block widget under it (`imageWidgetField` — a StateField, because CM6 forbids block
  decorations from ViewPlugins) showing the image, or "no image named X" for a missing
  asset name (bare names only — URLs/paths are left alone); `assetsWatcher` re-dispatches
  on `'assets-change'`. **Assets are NOT versioned**: `app.js _currentDataObject` prunes
  (`core/assets.js pruneAssets`) any asset that neither the working text nor the
  serialized history mentions at save/commit time — so an image an old commit still shows
  survives, and a reference deleted then re-typed after a commit is a broken image.
- **Exports**: PDF = the print-window pattern (one slide per page at Marpit's own `@page`
  size, window title = document title = suggested filename); HTML = ONE self-contained file
  (`deckDocument`: stacked slides + a dependency-free presenter — click a slide / `F` to
  present, arrows, `Esc`, `#n` deep links — and it prints one slide per page too). Images
  travel inside both as data URIs. The quine's static preview is `renderToString`.
- **Safari**: WebKit mis-scales `<foreignObject>` inside a scaled svg; Marpit's own
  `@marp-team/marpit-svg-polyfill` (`observe()` once from `render`) self-detects Safari and
  fixes the sections up by CSS transform — a no-op elsewhere. Not verifiable in Chromium.
- **CSS** (`app.css` "{slides}"): the deck breaks out of the 800px prose column like the ABC
  score (`clamp(100%, 100cqw - 64px, 1100px)`); the svg is `width:100%; height:auto` (+ an
  inline `aspect-ratio` from its viewBox). Marpit's CSS goes in a `<style>` inside the
  `.uf-deck` wrapper — it is scoped to `div.marpit`, but its `@page` rule is global, which
  is right for the app's own print.
- **Front matter**: the standard collapsible YAML bar; `slidesFrontMatterSchema` feeds the
  shared `fm-schema.js` autocomplete/lint (theme enum = the vendored theme names).
  `marp: true` is accepted and ignored (pasted Marp decks).

## {document} tables with formulas (`src/dsl/markdown-tables.js` + `src/core/tables/`, 2026-10)

**Every `| … |` table in a {document} is a small spreadsheet** — it started as a separate
{sheet} app and was folded into {document} the same day (the user's call: it is a table syntax,
not an app). Every extension is an existing Markdown convention, so a GitHub table pastes in
unchanged:

- **Formulas**: a cell starting with `=` (Excel grammar: `=B2*C2`, `=SUM(D2:D9)`,
  `=IF(B2>10,"big","small")`, `=SUM(B:B)`; `+ - * / ^ &`, comparisons, `%`). **A bare column
  letter is the cell in THIS row** (`=B*C`) — the one non-Excel addition, so a column formula
  is written once per row with no renumbering; `formulaForExcel` expands it (`B5*C5`) for the
  .xlsx. `'=…` (apostrophe) forces text. **Across tables**: the heading right above a table
  names it (`=Budget!D4`, `='Q1 Sales'!A1`; no heading → `Sheet1`, `Sheet2`…).
- **Merges = the MultiMarkdown conventions**: `||` with NOTHING between the pipes extends the
  previous cell across one more column (`| |` with a space is an empty cell); `^^` as a cell's
  whole content merges it into the cell above. Both survive into the .docx and .xlsx exports.
- **Addresses are Excel's**: columns A…Z, AA…; rows count pipe rows from 1 — the `|---|`
  separator is NOT a row, so the header row is row 1 (as in Excel). Rows above the separator
  are header rows; no separator → no header. `:--`/`--:`/`:-:` align; default numbers right,
  text left. Literal cells show what was typed; their VALUE is what they read as (`1,200`,
  `$3.50`, `12%` → 0.12, `(5)` → −5, `TRUE`). Formula results show General (10 significant
  digits, `formatNumber`) or `decimals: N` from the front matter; `TEXT(x, fmt)` covers
  `0.00` / `#,##0` / `0%` / `$#,##0.00`.
- **The text is the source of truth** — results are never written back, so diffs are what you
  typed. `evaluateWorkbook` is memoised per cell, dependency-driven, cycle-safe (`#CIRC!`);
  errors are Excel's (`#DIV/0! #NAME? #VALUE! #REF! #N/A #NUM!`) and propagate through ranges.
  Coercion follows Excel: empty = 0 / "", numeric text counts in arithmetic but SUM/AVERAGE/
  COUNT over a RANGE skip text and booleans, `IF`/`IFERROR` branches are lazy.
- **Engine (`core/tables/`, pure, `test/tables.test.mjs`)**: `grid.js` (`parseWorkbook` → sheets
  with `grid[r][c]` → the anchor cell, `cells[]` with `from/to` = the trimmed content and
  `rawFrom/rawTo` = pipe to pipe, `blocks[]` in document order — `prose` / `name` / `sheet`;
  `alignTables` pads every column, idempotent; `tsvToTable` for a pasted spreadsheet block),
  `formula.js` (tokenizer → Pratt parser → AST → `evaluate`; `FUNCTIONS` ~70 Excel names,
  `FUNCTION_NAMES` feeds the completion), `render.js` (`renderSheetHtml` = the grid, with the
  Excel-style rulers — corner, column letters, row numbers — only when `headings` is asked,
  colspan/rowspan, `data-addr`, `data-doc-from/to` on every cell for click-back; CSV; the
  **.xlsx writer** — inline strings, `<f>` + cached `<v>` so Excel/Numbers/Sheets show values at
  once and recalc on edit, `<mergeCells>`, bold header style, sheet names clipped to Excel's 31
  chars). `src/core/zip.js` (moved from `upub/`) is the stored-only ZIP both EPUB and XLSX use.
- **The glue (`dsl/markdown-tables.js`)**: `workbookFor(text)` caches parse+eval per document
  text. **marked**: `markedTablesExtension` is a BLOCK extension that claims every table whose
  rows all have leading + trailing pipes (anything else falls through to marked's own GFM
  table) and renders it via `renderSheetHtml` — rulers only on a table that holds a formula
  (`hasFormula`), so a plain table keeps the document look. **Values come from the WHOLE
  document**: markdown.js calls `setTableContext(fullText)` before every parse
  (`state.currentContent` in `render()` — layouts parse the document in SLICES and a slice
  cannot compute `=Budget!D4` — the export's content in `renderToString`/`exportDocx`), and the
  renderer matches a token to its sheet by raw text, identical tables in document order; an
  unmatched table is computed on its own. `_annotateClickback` still sees one block element
  per token (the `.uf-sheet-block` wrapper); the cells inside carry ABSOLUTE offsets (DOMPurify
  keeps `data-*`). The caret's cell is outlined live (`_markActiveCell` on `'editor-select'`,
  and after a content change on a short delay — no re-render). **DOCX**: `case 'ufTable'` →
  `tableTokenToDocx` (docx `columnSpan` / `verticalMerge` restart+continue, computed values,
  bold header). **Exporters**: `xlsx` ("Tables as Excel") added to {document}'s list.
  **Editor** (spread into `getEditorExtensions`): `Prec.high` Tab / Shift-Tab = next /
  previous CELL (selects the content; returns false outside a table row so Tab still
  indents; past the last cell inserts a new row of the same width; the separator row is
  skipped), a ViewPlugin tinting `=`/refs/functions/strings and the `||`/`^^` spans
  (`cm-sheet-*` classes), hover = the computed value, formula errors merged into
  `markdownLint`, `tableComplete` (function names with one-line details, after `=`, or
  Ctrl-Space right after `=`) ahead of the emoji completion in `markdownComplete`, a `paste`
  handler turning TSV into a table. `alignSource: alignTables` (Alt-Shift-F) and
  `actions` = Insert table · Align table columns (⋯ menu + phone bubble). `decimals` lives in
  `markdownFrontMatterSchema` via `tablesFrontMatterSchema`. Help: the "Tables" section +
  the "Table formulas" group in `DSL_HELP.markdown`. CSS: `.uf-sheet*` in app.css (the
  rulers' look is gated on `.has-rulers`), `TABLE_EXPORT_CSS` appended to markdown's
  `EXPORT_CSS` for HTML/PDF.
- **Not done / ideas**: no date functions, no number-format row (use `TEXT()` or `decimals:`),
  no CSV import, no charts.

## {spreadsheet} (`src/dsl/spreadsheet.js` + `src/core/sheet/` + `src/ui/sheet-grid.js`, 2026-10)

A dedicated **spreadsheet** app (abbrev `sht`, dslType `spreadsheet`, mark `{▦}`) on the STANDARD
shell, `wholeDocument: true` like {slides}. It is NOT the {document} table feature (`core/tables/`,
which stays as it is — a table syntax inside prose); it REUSES that engine's formula evaluator
(`core/tables/formula.js`: Excel grammar, ~70 functions, bare-column refs `=B*C`) and row splitting
(`grid.js splitRow/parseSeparator/literalValue`). **The render pane is the editor**: the user mostly
works in the grid; the text is a compact readable file that every gesture rewrites.

- **The DSL (`core/sheet/parse.js`).** `# Heading` starts a sheet (none → `Sheet1`; duplicate names get
  ` 2`). Inside a sheet a line is a ROW (`| a | b |`, `\|` escapes; one optional `|---|` line = the rows
  above are HEADER rows: bold, frozen, exempt from sort/filter; its `:--:` colons are column aligns), a
  DIRECTIVE (`width A:B 12` · `height 3 40` · `freeze rows:1 cols:1` · `merge A5:C5` · `style <range>
  <props>` · `if <range> <cond> then <props>` · `scale <range> <c1> <c2> [c3]` · `comment B3 "…"` ·
  `sort B desc[, C asc]` · `filter B > 0` / `filter =D>C` · `hide C:D` / `hide 3:5`), or a NOTE (any
  other line — free text, rendered under the sheet). Rows count pipe rows from 1 (the separator is not a
  row); addresses are Excel's (`parseRange`: `A1`, `A1:C3`, `A`, `A:C`, `3`, `3:5` — open ends are
  `Infinity`). The inline `||`/`^^` spans of {document} tables are parsed too (a pasted table keeps its
  merges) but the canonical form is `merge`. Directive args are tokenised by `tokenizeArgs` (quoted
  strings with `\"` are one token, `format:"$#,##0 kg"` included). Problems are collected, never thrown
  (`sheet.problems` → the editor's lint).
- **Styles (`style.js`).** Flags `bold italic underline strike wrap` (`bold:off` clears), keyed
  `color bg size font align valign format border` (`key:none` clears; `border` alone = all sides).
  `format` = a pattern subset (`0.00`, `#,##0`, `0%`, `$#,##0.00`, any prefix/suffix, `0.00E+00`, `@`
  = text) or a name (`general number integer percent currency text`). Conditions: `cmp` (`> 100`,
  the right side is ANY formula expression), `between a and b`, `contains/starts/ends "x"`, `blank`,
  `filled`, `error`, `duplicate`, `unique`, `top n`, `bottom n`, `=formula` (evaluated per cell with the
  row's bare-column refs — `compileCondition` builds the predicate on formula.js's `evaluate`).
  `styleResolver` layers per cell: `style` lines in order (later wins per key) → `if` rules whose
  condition holds → `scale` (bg); `{ conditional: false }` gives the static style alone (what the .xlsx
  writes as cell styles — the rules go out as real conditional formats, NEVER baked in).
- **Computed workbook (`book.js`).** `computeWorkbook(text)` = parse + `evaluateWorkbook` + resolvers;
  `display(cell)` = the typed text (a literal with a `format` and a numeric value shows the formatted
  number), a formula result through its format / `decimals:` / General. **`sort` and `filter` are a
  VIEW** (`viewRows`: header rows first, body filtered, stably sorted, blanks last, hidden rows removed —
  the text's rows never move; addresses never change — Excel's autofilter). The toolbar's A↓/Z↓ are a
  DATA sort (`edit.js sortRows`: reorders the row lines below the header; comments, heights, hidden
  flags and single-row styles ride along; formulas are not rewritten, same as Excel — bare-column
  formulas survive, `=SUM(D2:D3)` can end up self-referencing, also same as Excel).
- **Edits (`edit.js`) are text → text.** Every op: parse → `toModel(sheet)` (cell texts + directives as
  plain data) → mutate → `serializeModel` (canonical: pipes aligned per column, numbers right-padded
  below row 1, the separator, then directives in a FIXED order width·height·freeze·merge·style·if·scale·
  comment·sort·filter·hide, then notes; trailing empty rows/cols trimmed) → replace exactly that sheet's
  block. A canonical file re-serializes byte-identically (= Alt-Shift-F `alignSpreadsheet`), so one cell
  edit is a one-row diff; a hand-written file is normalised by its first grid edit. `insertRows/Cols`,
  `deleteRows/Cols` shift every directive range (`shiftRange`) AND every formula reference to the sheet,
  in THIS sheet (unqualified refs) and in OTHER sheets (`Sheet!A1` refs) — `shiftFormula` rewrites via
  the formula tokenizer; a reference entirely deleted becomes `#REF!`, a partly deleted range clips.
  `setStyle` keeps the directive list tidy (strips the keys from lines inside the range, merges into a
  same-range line, writes `bold:off`/`color:none` only against a wider line that still sets it).
  `addSheet` names the unnamed first sheet; `renameSheet` rewrites the other sheets' `Name!` refs;
  `deleteSheet` keeps ≥ 1 sheet. An empty document's first edit creates `# Sheet1`. Changes come back
  in ORIGINAL coordinates for CM (`{ text, changes }`), dispatched through `dsl-edit` so they land in the
  editor's undo history — **the grid has no history of its own** (`editor-undo`/`editor-redo` events).
- **The grid (`ui/sheet-grid.js`).** ONE instance per preview host (WeakMap), `update(book)` re-renders
  the table from `render.js renderSheetHtml` (same markup as the HTML export + the quine's static
  preview, + `extraRows/extraCols` blank room to grow) and keeps only VIEW state: active sheet,
  selection (`{r1,c1,r2,c2, anchor, head, mode: cells|rows|cols|all}`), scroll, an edit in progress.
  Every op reads `state.currentContent` fresh (never a cached model — the preview's 300 ms debounce
  would make a cached one stale between quick commits) and redraws immediately from the result; the
  preview's own render follows and finds the same text. Gestures: type = replace, Enter/Tab move,
  F2/dbl-click edit in place, Delete clears, Shift+arrows/click extend, Ctrl+arrows jump, letters/numbers
  = whole col/row, corner = all, right-click / touch long-press = context menu, drag a column edge =
  `width`, dbl-click the edge = default, copy/cut/paste = TSV of the cells' TEXT (formulas travel as
  formulas; the `copy/cut/paste` DOM events, so no clipboard permission), Ctrl+B/I/U, Ctrl+Z/Y → the
  editor. Popovers (`.uf-ss-pop`, one element): format list + custom, colour swatches + `<input
  type=color>`, borders, filter form, comment, conditional-format rules (list + delete + new rule),
  colour scale, the ⋯ menu (freeze, header rows, view sort, hide/unhide, widths/heights, sheets, tidy).
  Sheet tabs: click / dbl-click rename / right-click / `+`. **Editor ↔ grid sync**: selecting a cell
  emits `dsl-select` with `focus: false` (editor.js: the editor mirrors the selection WITHOUT taking
  focus — the grid keeps the keyboard); the editor caret moving (`editor-select`) selects that cell in
  the grid silently. The grid root `stopPropagation`s clicks so preview.js's generic click-back never
  fires. Frozen rows/cols = `position: sticky` with offsets measured after render (`_applyFrozen`;
  header rows count as frozen). Phones: the grid fills the render pane, the bubble's render-view verbs
  come from `dsl.renderActions` (`actions.js` hook, `sheet-grid-action` event: undo/redo/bold/insert/
  delete/merge/comment/clear), tap = `undo` by default.
- **CSS**: `.uf-ss*` in app.css; the grid breaks out of the prose column and fills the pane
  (`100cqw`/`100cqh` + negative margins against `.preview-content`'s padding). Rules, scales and
  `style` land as INLINE styles on the cells (user colours apply in either theme).
- **Editor (text side)**: a `StreamLanguage` tokenizer (rows: pipes recede, formulas tinted; directives:
  keyword / range / props / strings / colours); lint = `book.problems` + formula errors on their cells;
  completion = function names after `=`, directive keywords at line start, props after `style`/`then`,
  condition words after `if`/`filter`. `alignSource` = `alignSpreadsheet`.
- **Exports**: `.xlsx` (`xlsx.js`: a `StyleTable` of fonts/fills/borders/numFmts/alignment → one xf per
  distinct static style, `dxfs` for rules, `<conditionalFormatting>` cellIs/containsText/beginsWith/
  endsWith/containsBlanks/top10/duplicateValues/expression/colorScale, merges, widths, heights, hidden
  rows/cols, frozen panes, autoFilter, and cell NOTES as legacy VML `comments<n>.xml` +
  `vmlDrawing<n>.vml` — every reader shows them), CSV (the grid's active sheet), HTML (every sheet,
  static), PDF (print window, landscape). Tests in `test/sheet.test.mjs` cover parse, styles,
  conditions, formats, the computed view, every edit op (incl. reference shifting), rendering and the
  .xlsx parts.
- **Not done / ideas**: no dates/times (no serial numbers, no DATE functions), no data bars, no
  multi-line cells, no drag-fill handle, no column-letter-based move/reorder, no charts, no .xlsx IMPORT
  (Open from device reads `.uni` text only), virtualisation (a sheet of thousands of rows re-renders the
  whole table per edit).

## Mobile / iOS (hard-won — read before touching layout)

The app is a `100dvh`-ish flex column. On phones (`@media max-width:640px`, OR landscape `(orientation: landscape) and (max-height: 500px) and (pointer: coarse)`) **the desktop top bar is hidden entirely** (`#uf-topbar { display:none }`) and the **phone top bar (`#uf-pane-switch`, `src/ui/pane-switch.js`) is the sole top chrome**, sitting directly below the site-nav (if present) under the safe-area inset (which lives on `#unifile-app` padding-top). Only the active one of three panes (**commit-log · editor · render**) is displayed; `App._setupMobilePanes()` tracks the pane into `#unifile-app[data-mobile-pane]`.

**Phone top bar (2026-09 redesign): `( ⑂ )   {♪} Title ⌄   ( ◉ )`.** Three controls, portrait AND landscape (the old segmented slider + the landscape collapsible dock are gone):
- **Left circle = the back arrow.** Tap → the document LIBRARY pane (`library-pane.js`); the circle FILLS (accent) while that pane is up; tap again → back to the editor. In a quine (no library) it is a clock and opens the history pane. The history pane is reached from the title dropdown (File → History) or the Save-with-message flow.
- **Centre = `{mark}` + document title + the dirty dot + caret — ALWAYS the title, same menu in every view.** The mark is `appMark(data.dslType)` in mono. Tap → the ONE dropdown (`.ps-menu`) with the FILE-LEVEL options only, grouped: Document (New, Rename, Help, Blame), File (Save ‹next version›, Save as new major, History, Open from device, Documents), Export, More (settings) — **`src/ui/actions.js` `listMenuActions(ctx)`**. Editing verbs are deliberately NOT in it.
- **The bar blends into the page** (`background: var(--bg)`, no rule — iA-style) and is **`user-select:none`/`-webkit-touch-callout:none`**: a slightly held tap on the title/mark otherwise started an iOS text selection ("tapping the branch circle edits the top-left text" — real bug). The skeleton is **built once per mode and PATCHED** on state changes (`_build`/`render`) — rebuilding the buttons under a finger mid-tap (state changes land between touchstart and click) hands the tap to whatever is underneath.
- **Right circle = eye.** Tap → the rendered DSL pane; filled while showing; tap again → editor. Always the eye (not a per-DSL render icon).
- **Diff mode:** circles unchanged; the centre reads `L <hash> ↔ R <hash>` and its dropdown holds both side pickers.
- **Hidden while typing:** `App._bindEditingChrome()` sets `#unifile-app[data-editing]` (→ `#uf-pane-switch { display:none }`) when the editor has focus (`editor-focus` from CM's `focusChanged` + document focusin/out) AND the soft keyboard is genuinely up (`_kbOpen`: the visual viewport is >100px shorter than the tallest seen at this window width, tracked in `_trackViewportHeight`; focus alone where there's no visualViewport) AND `pointer: coarse`. Mirrors uPub's rule; iOS's own keyboard ✓ blurs the editor and brings the bar back. Can't be seen in desktop Chromium (no keyboard) — verify by setting the attribute by hand.

**Phones have NO transport bar and NO per-verb FABs.** Editing verbs live on the **action bubble (`src/ui/action-fab.js`, `.uf-fab`)** — one round `{glyph}` circle (mono, accent), `position:absolute` in `#unifile-app`, z-index 70, phone-only via CSS. **It is CONTEXTUAL to the pane showing** (`listBubbleActions(ctx, view)`, re-rendered by a MutationObserver on `data-mobile-pane`): **editor** = play · one measure per line · piano roll (ABC) + indent · outdent (`Editor.indent/outdent` = CM's `indentMore/indentLess` on the selected lines — a soft keyboard has no Tab) + undo · redo; **render** = play/pause (ABC) or zoom to fit · zoom in · zoom out (Mermaid — `mermaid-zoom.js zoomAll()` dispatches a `uf-mmd-zoom` document CustomEvent every mounted stage obeys; tap = fit by default); with no actions the bubble HIDES, e.g. Markdown render; **history** = the branch list (● current; tap = switch), New branch…, Commit… (`composeCommit` → scrolls the log to the pending node and focuses its message). File-level operations and settings are never on the bubble — they're the title dropdown.
- **Tap = the PRIMARY action** (default: `play` for ABC, `fit` in the Mermaid render view, `indent` in the Mermaid editor (the diagram DSL is indentation-shaped), `undo` in the other editors, `save` in the history view, `new` in the library view, else the grid itself — `defaultPrimary(dsl, view)`; persisted per DSL+view in `localStorage.uf_fab_primary:<dsl>:<view>`; `'menu'` = tap opens the grid). The bubble shows the primary's glyph in braces (`{▶}`, `{↶}`, `{◉}`), pulses a ring while playing.
- **Long-press (480 ms, <8 px) = the grid** (`.uf-fab-grid` + `.uf-fab-scrim`, `#unifile-app[data-fab-open]`): the view's actions alphabetical (sorted by the stable `key`, so Play/Pause doesn't jump; branches sort first by name), 4 columns portrait / 6 landscape, the primary ringed; tile tap = run; the tile's ☆ = make it the primary (`star:false` rows — branches — have none). A hint row explains tap/hold/drag and holds a 2×2 corner picker.
- **Drag = move**; on release it SNAPS to the nearest of the four corners (`data-corner` tl/tr/bl/br, persisted in `localStorage.uf_fab_corner`, default `br`). While dragging (`#unifile-app[data-fab-drag]`) four dashed ghost circles mark the corners and the nearest grows. Top corners sit under the top bar via `--uf-fab-top` (= `#uf-main.offsetTop`, re-measured on resize + a MutationObserver on `data-editing`, so it drops to 0 while typing). A one-time caption ("Hold for all actions · drag to a corner") shows until first use (`uf_fab_seen`).
- **Focus is preserved:** `pointerdown`/`mousedown` are `preventDefault()`ed on the button AND the grid tiles, so Undo/Redo/Play never blur the editor or drop the keyboard. `setPointerCapture` is try/caught (stale/synthetic ids throw). The button hides in diff mode; the piano roll (z 120) covers it in landscape and has its own close.
- The piano-roll toggle (landscape only) is the `roll` action in the editor grid; align = `align`; the landscape `.ps-roll/.ps-play/.ps-align` dock buttons are gone.

Institutional knowledge — **do not silently "simplify" these; each fixed a real device bug:**

- **Viewport height = JS-measured, not CSS units.** `App._trackViewportHeight()` writes `visualViewport.height`→`--app-height` and `visualViewport.offsetTop`→`--app-vv-top`; `#unifile-app` is `position:fixed; top:var(--app-vv-top); height:var(--app-height)`. Reason: `100vh` includes Safari chrome, `100dvh` hits an iOS 26 regression (gap at bottom), `-webkit-fill-available` resolves short. Using `visualViewport.height` also shrinks the shell above the soft keyboard so the caret stays visible.
- **The "chin gap" was `apple-mobile-web-app-status-bar-style: black-translucent` + `height:100%`.** That meta is REMOVED from `pwa.html`; `html,body` use `100vh`. Don't re-add black-translucent.
- **Document must never scroll.** `App._lockWindowScroll()` snaps `window`/`scrollingElement` back to (0,0); `overscroll-behavior` contains inner scrollers. iOS otherwise scrolls the whole doc when the keyboard is up and shifts the bars.
- **Bottom bar (`#uf-bottom`) is an in-flow flex child**, not `position:fixed` + JS pinning (that pushed it off-screen). It sits flush because the column is exactly the visible height.
- **The phone top bar is the sole top chrome on mobile** (desktop top bar hidden). Its dropdown (`.ps-menu`) opens centred under the title; `#uf-pane-switch` needs `z-index` above `#uf-main` because it's DOM-first (paints under main otherwise). The **safe-area inset is on `#unifile-app` itself** (`padding-top: env(safe-area-inset-top)` + `background:var(--bg)` — the SAME colour as the blended bar and the page, and `theme-color` in pwa.html matches; `--bg-alt` there drew a darker band around the island — real bug; border-box keeps `--app-height`), so the bar sits below the notch. Bar is **56px portrait / 46px landscape** and hides while typing (`data-editing`). (Historical: a segmented three-tab slider with per-segment menus, and before it an auto-hiding title bar — superseded by the circles + title dropdown.)
- **Save UX (mobile):** no banners — passive markers. The device behind (`state.needsSave`) → the dirty dot (after the title) + a **pending node** at the top of the history list (dashed hollow node: optional note + "Save as A04" with a "major" switch + Save, so a save is composed where it lands). The **"on device" marker** sits on the version the device file carries (`state.deviceFile.savedHead`). Saving lives on the action bubble in the history view (Save A04 · Save with a note… · Save as B00); the library view's bubble is New · Open from device. `commit-bar.js`, `commit-dialog.js` ("Save with message…"), the branch pill, the merge dialog and the New-document confirmation modal are gone.
- **Document title is the single source of truth.** The centred top-bar title edits `data.title`; ABC derives its `T:` from it (a DOM heading in the live preview so char-positions still map 1:1; `_withDerivedTitle` string-injects for exports). An explicit `T:` in the source overrides. Preview re-renders on rename (`preview.js` tracks `_lastTitle`).
- **No gutter at all (2026-10)** — no rail, no line numbers, no fold column, no active-line tint: the caret marks the line (iA Writer). Comments are highlights in the text (see Comments); the ABC M/S marks are `::before` pseudo-elements in the line's left margin. The side margin lives on `.cm-line` padding (not `.cm-content`) so selection/decoration backgrounds reach the edge.
- **Zoom fix:** viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover`; `.cm-content`/inputs forced to `font-size:16px` to stop Safari focus-zoom.

iOS-specific behavior can't be verified in the local Chromium preview — verify mechanism/geometry there, then test on-device (and remove+re-add the PWA to drop the cached service worker).

---

## Versioning & releases

Version is the **NEWER of the latest git tag and `package.json`'s `version`** (`detectVersion` in build.mjs; `sync-site.mjs` mirrors this for `version.json`'s channels), stamped into the bundle (`UNIFILE_VERSION`) and `docs/version.json`. This means the release-flow bump (`npm version X.Y.Z --no-git-tag-version`) takes effect immediately — builds stamp the bumped version even before the tag is cut, and on Cloudflare Pages (whose checkout has no tags) `package.json` is the only source anyway. So `package.json` MUST be bumped for each release, or the deployed `version.json`/`UNIFILE_VERSION` will be stale (and the in-app update prompt won't fire). Builds also stamp `UNIFILE_BUILT` (build timestamp) so two builds of the same version are distinguishable (shown in uPub's About), `UNIFILE_COMMIT`/`UNIFILE_COMMIT_AT` (7-char commit hash + commit time, from `CF_PAGES_COMMIT_SHA` on Cloudflare else `git rev-parse`) and `UNIFILE_CHANNEL` (`stable` when built from `main` or a detached release tag, else `dev`; from `CF_PAGES_BRANCH` else `git rev-parse --abbrev-ref HEAD`; `UNIFILE_CHANNEL=` env overrides) — all from `build/build-id.mjs`, shown in every About and published in `version.json` (`commit`/`commitAt`/`channel`). The hash exists for the **dev channel**: `dev.unifile.app` is a proxied CNAME to `dev.unifile-8yt.pages.dev`, the `dev` branch's Pages preview alias (the hostname had to be registered under the Pages project's Custom domains first, then the record's target edited to the branch alias — a bare CNAME 522s). Every push to `dev` deploys there with no version bump, so **on the dev channel the commit IS the version** (and since every feature PR targets `dev`, a merged PR is live on dev.unifile.app minutes later); PWAs installed from dev.unifile.app are origin-scoped (own SW, IDB, version.json) and thus subscribe to dev.

**Two update rules, by the RUNNING build's channel (`src/core/build-info.js` `newerBuild`, unit-tested in `test/build-info.test.mjs`; every shell — `ui/update-check.js`, `upub/app.js`, `udraft/app.js` — uses it):** *stable* → a build is newer only when its VERSION outranks ours (SemVer precedence), and the user applies it from the banner/toast. *dev* → a build is newer when its commit hash differs AND its commit time is later (the "later" guard stops a stale CDN edge or a rolled-back branch from bouncing the app backwards; a `version.json` without `commitAt` still counts a different hash), a version bump counts too, and **the update applies itself**: the banner/toast reads "New build <hash> (<time>) — updating…" while the new worker installs and the page reloads once it claims (the standard shell flushes the 2 s-debounced draft first via `initServiceWorker({beforeReload})`). Labels on dev lead with the commit (`formatBuild(b,{commit:true})` = `abc1234 (2026-09-28 10:12Z)`), stable with `vX.Y.Z`. Verified end-to-end with Playwright against a local server (poke → reload; relaunch → banner → auto-apply → reload; older commit published → no bounce).

**Release flow (on `dev`, then `dev` → `main` — the ONLY way anything reaches `main`):** `npm version X.Y.Z --no-git-tag-version` (bump package.json) → `git tag vX.Y.Z` → `npm run build:site` → commit on `dev` → merge `dev` into `main` → `git push origin main dev vX.Y.Z`. The site is served by **Cloudflare Pages** (project `unifile`, `unifile-8yt.pages.dev`), which auto-builds on push with `npm run build:site && npm run site:preview` → `docs/_site`.
**Release candidates:** tag `vX.Y.Z-rc.N` per candidate, cut the bare `vX.Y.Z` when ready. (RC channel precedence needs the git tag list, which Cloudflare lacks — RCs are exercised locally / on GitHub where tags exist.)

`sync-site.mjs` writes `version.json = { version(=stable), stable, latest, released, commit, commitAt, channel }`. `build-info.js` compares versions with full **SemVer 2.0 precedence** (`cmpSemver`): `rc.2 > rc.1`, and a release outranks its pre-releases (`1.0.0 > 1.0.0-rc.2`). **There is no stable/RC channel split** — `remoteBuild()` offers the newest published version (`latest ?? stable ?? version`) to everyone (the old "Receive release candidates" opt-in was removed; on Cloudflare, which has no git tags, `stable`/`latest` both fall back to `package.json` anyway, so the split was inert in production). The check cache-busts `version.json` (`?_=ts`) to beat CDN staleness, runs at launch and again on every return to the foreground (throttled to once a minute, and skipped while a banner is already up). **Settings → About** shows the running version · commit · time (+ "dev channel — every push updates" on dev); the site footer appends `(dev <hash>)` on a dev deploy.

**Service worker freshness (`update-check.js` `initServiceWorker`, the standard shell's counterpart to uPub's `_bindServiceWorker`):** register with `updateViaCache:'none'`, `reg.update()` at launch and on every `visibilitychange` → visible (installed PWAs otherwise sit on the browser's ~24 h schedule), and on `controllerchange` (a new worker took over an already-controlled page) reload — always on the dev channel (after `beforeReload` flushes the draft), and on stable only when `sessionStorage.uf_update_pending` says the user asked (a background swap on stable simply runs on the next launch). The first-install claim never reloads.

**PWA update apply (`update-check.js` `_applyUpdate`/`_applySwUpdate` + `templates/sw.js`):** the "Update" button (pressed automatically on dev) `reg.update()`s, drives the installing/waiting worker to activation (`'skipWaiting'` message), and reloads on `controllerchange`/`activated`. **NEVER reload on a short timer while the install is in flight** — the abc precache is ~5 MB (offline piano), install takes seconds, and the old blind 2 s fallback reliably reloaded through the OLD worker (old version, banner back — "clicking Update doesn't take", the v0.3.1→v0.3.2 bug). The button shows "Updating…" instead; the only timed reload is the no-new-worker path (a previous install already activated in the background). A **module-level `controllerchange` listener + `sessionStorage.uf_update_pending` flag** is the safety net: if the install outlives the page (manual reload, slow line), the moment the new worker claims the page it reloads once onto the new version; the flag is cleared when a check returns 'current' so background swaps the user never requested don't surprise-reload. **The SW precaches the shell with `cache: 'reload'`** — critical: without it a new worker would re-cache the STALE `app.js` the browser/CDN still held, so the "update" reloaded without bumping the version (the earlier incarnation of this same symptom). The SW also self-`skipWaiting()`s on install and handles a `'skipWaiting'` message.

`git commit` messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## The website (`docs/`)

**Hosted on Cloudflare Pages** (as of 2026-07; migrated off GitHub Pages, which was flaky/queue-stuck). Project `unifile` → `unifile-8yt.pages.dev`, custom domain **`unifile.app`**. Cloudflare **auto-builds on every push to `main`** with build command `npm run build:site && npm run site:preview` and output dir **`docs/_site`**. No queue, no Ruby. GitHub Pages is unpublished; `docs/CNAME` was removed (Cloudflare manages the custom domain via a proxied `CNAME` record in its own DNS — the domain's DNS lives on Cloudflare, registrar stays Namecheap).

**The site is rendered by `build/render-site.mjs`** (`npm run site:preview`) — a **no-Ruby Node renderer** (uses `marked`) that reads `docs/` (top-level `*.md` pages, `_posts`, `_data/{apps,types}.yml`; the `{% include launcher.html %}` token in hub pages is rendered by `renderLauncher()` — there is no include file), writes rendered HTML + `search.json` into `docs/_site`, and copies through `assets/`, `dl/`, `pwa-{md,mer,abc,upub}/`, `version.json`. **It is the production build** — all layouts live as template strings inside it (the Jekyll `_layouts`/`_includes`/`_config.yml`/`Gemfile` were deleted in the 2026-08 redesign). `docs/_site/` is a build output (gitignored). Note: `npm run build:site` still regenerates + commits `docs/dl/*` and `docs/pwa-*/`, but Cloudflare rebuilds them from source anyway, so committing them is now redundant (candidate cleanup).

**Design (2026-09 redesign): a plain white document shown as Markdown source** — the iA Writer "edit mode" look: white background, IBM Plex Mono, ONE font size for everything (headings are just bold), and the Markdown syntax marks left visible in light grey via CSS pseudo-elements (`h1::before` = `#` hanging in a `--gutter` to the left so text aligns; `strong` keeps `**`, `em` `*`, `code` its backticks, `pre` its fence lines, list items their `-`/`1.`, blockquotes `>`, tables their pipes). The one exception is **links: plain old-school blue underlined hyperlinks, no brackets**. No theme toggle, no dark mode; the apps keep their own theming. (The 2026-08 green-phosphor terminal look is gone.) Chrome = a one-line `nav` (unifile · apps · posts · about) and a `footer` (`---` rule, version, guide links). The **home page is the app listing**: one list item per type — its `{glyph}` mark and `{name}` as plain mono TEXT (`appMark()`/`appName()` from `src/core/brand.js`; `types.yml` titles are the `{name}`s, `APPS[id].edits` says what it edits) — and three actions — Install / Open / Download (a `button.link` + two links). **Install opens the per-device walkthrough modal** (`assets/js/install.js`, `[data-install]` triggers, tabs for iPhone/Android/Desktop defaulting to the visitor's platform; step 1 is always "open the app" because a PWA can only be installed from its own scope — the PWA's own pre-install banner takes over from there). `search.json` is still generated (the in-app site-nav fetches it); the committed Jekyll-era `docs/search.json` source file is gone. Per-type front doors (`/get/`=Markdown, `/mermaid/`, `/abc/`, `/upub/`, `/udraft/`) keep the device-aware `assets/js/launch.js` buttons (styled as links; `.launch-btn + .launch-btn::before` draws the `·` separators as an inline-block so the link underline doesn't run through them) and also link the walkthrough modal.

**Cloudflare clean-URL gotcha:** Pages 308-redirects `/foo.html` → `/foo`, which would strip the `.html` off a downloaded quine. The download links therefore set an explicit `download="unifile.<abbrev>.html"` (in `launch.js` + both no-JS launcher fallbacks) so the saved filename is preserved.

---

## Conventions & workflows

- **Adding a DSL:** create `src/dsl/<id>.js` that `registerDSL(...)`; add an entry to `DSL_META` in `build.mjs` to give it a dedicated build; import it in `main.js` for dev; add a hub page + `types.yml`/`apps.yml` entries to surface it on the site; add the app to `src/core/brand.js` + `npm run gen:icons` (commit only the new `templates/icons/<abbrev>/` — the run regenerates every app's PNGs byte-differently, `git checkout` the others); list the new `pwa-<abbrev>` in `sync-site.mjs` and `render-site.mjs` (`TYPE_TO_ICON` + the copy list); a help entry in `topbar.js DSL_HELP`. Before adding an app, ask whether it is really a FEATURE of an existing one — the table formulas (2026-10) were built as a {sheet} app first and folded into {document}; the later {spreadsheet} app (also 2026-10) is the user's explicit call for a grid-first editor and reuses that formula engine rather than duplicating it. A DSL whose render view is itself an editing surface puts the phone bubble's verbs on `renderActions: [{id,label,glyph,run}]`. A DSL that owns the whole document sets `wholeDocument: true` (see {slides}); `actions: [{id,label,glyph,run}]` puts verbs on the ⋯ menu and the phone bubble.
- **Verifying UI changes:** use the preview tools against a build (`node build/build.mjs --dsl=abcjs --no-pwa`, serve `dist/` — see `.claude/launch.json`, port 8765). Resize to 375px for mobile. **Always build the variant you're testing.** In the PWA build the app object is NOT on `window.__unifile` (quines only); drive it through `globalThis.__uf.state` (`state.emit('checkout', {content})` sets the editor text). Playwright lives in `/opt/node-tools/node_modules/playwright` (not a project dependency); the pre-install banner (`#uf-install-banner`) covers the phone title bar in a browser tab — remove it before tapping.
- **Deploying is automatic on push:** Cloudflare Pages rebuilds from source (`build:site && site:preview`) on every push to `main`, so a source-only commit deploys correctly — no need to pre-run `build:site` for the deployed site to be current (that old footgun is gone). You still build the specific variant locally to *test* UI changes in the preview.
- **Branches — `dev` is the working branch; `main` only ever receives `dev`.** Every change is
  a feature branch off `dev` (`claude/<topic>`), and its PR TARGETS `dev` — never `main`.
  `main` is the release branch: the only merges into it are from `dev` (the release flow
  below), so `main` is always a point `dev` has already been at. Sessions start on `dev`;
  the clone may not even have `main` checked out. Commit + push are done only when asked.

---

## Gotchas / landmines (things that cost real debugging time)

- **`state.on(...)` must be called directly**, not `this._unsub?.push?.(state.on(...))` — the optional-chaining short-circuit skips evaluating the `state.on` argument, so the listener never registers. App is a forever-singleton and doesn't track unsubscribers.
- **`RangeSetBuilder` requires ranges added in sorted `from` order** — e.g. in front-matter highlighting, add the key mark before the trailing-comment mark.
- **abcjs drops `!name!` decorations** and reports note `startChar` inconsistently (see ABC section).
- **Front-matter values with inline `# comments`** must be stripped (whitespace-preceded `#` only, to preserve `C#3`).
- **iOS**: none of the mobile viewport hacks are optional (see Mobile section). The `.unifile.json`/quine data must round-trip; the model picker re-serializes the whole front matter.
- **Quine grep:** code strings are gzip+base64'd inside `.html` quines — grep the PWA `app.js` to confirm a build contains something.
- **CSP:** strict same-origin. Any external origin (fonts, APIs) is a deliberate, reviewed change.
