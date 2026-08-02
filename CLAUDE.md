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
2. **Privacy: nothing leaves the device.** unifile.app is a static site (Cloudflare
   Pages) — it stores nothing. No telemetry, no analytics. Keep it that way.
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
    abc-voices.js    Parses ABC `V:` voice lines (voiceIdOfLine / buildVoiceMap) — shared by the gutter + abcjs.js for mute/solo
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
    editor-sections.js  Collapsible front-matter / ABC-header section bars (default-collapsed on load)
    preview.js       Renders the active model/DSL to the preview pane
    topbar.js        Title, DSL menu, VCS pills (desktop); mobile top bar = menu + centred title + dirty dot; commit-log pane (pending node + export marker). Also `showDslHelpModal` = the per-DSL syntax reference (grouped, navigable sidebar; `DSL_HELP[dsl].sections[]` with optional `group`)
    commit-bar.js    Mobile commit-pane bottom bar = branch selector (drop-up). Commit composing moved into the log's pending node.
    commit-dialog.js Full commit dialog (identity + message + tag)
    diff-view.js     DiffView overlay + DiffBar (read-only commit diff)
    dsl-footer.js    ABC transport (play/scrub/time)
    settings-panel.js  Identity, theme, updates (check button), audio output (MIDI)
    blame-view.js, merge-dialog.js, export-dialog.js, comments.js, site-nav.js,
    theme.js, editor-theme.js, plugin-extensions.js, update-check.js
  styles/app.css     All app CSS (single file; mobile rules in @media(max-width:640px))
build/
  build.mjs          esbuild pipeline (one quine + PWA per dedicated DSL variant)
  sync-site.mjs      Builds variants + copies into docs/ + writes docs/version.json
  render-site.mjs    No-Ruby site renderer (docs/ → docs/_site); Cloudflare's production build
  gen-soundfont.mjs  One-off: fetch FluidR3 piano → src/assets/piano-soundfont.js (network!)
templates/           quine.html, pwa.html, sw.js, manifest.json
docs/                The website (Cloudflare Pages; rendered by render-site.mjs) + committed build artifacts
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

**Editor (`editor.js`)** — CodeMirror 6. Custom **single gutter** (`commentLineNumbersExt`) — a thin rail (desktop + mobile; line numbers are hidden via CSS) that tints comment lines yellow, the active line accent, and shows a per-voice **M**/**S** mute/solo mark. Clicking the rail opens a line-options menu (see below). **Per-section syntax highlighting** (`sectionSyntaxField`) runs each section's DSL parser through the catppuccin highlight; the front-matter block is highlighted as YAML instead of the DSL. **Comments are line-level only** (see below). Line wrapping is intentionally OFF (DSL scrolls horizontally). **Vertical (column) selection** via CM's `rectangularSelection()` + `crosshairCursor()` (Alt+drag, the VS Code/Sublime convention; multiple selections were already enabled). The updateListener also emits **`editor-type` `{pos, ch}`** for single-character `input.type` insertions (multi-char inserts = paste-like, deliberately silent) — consumed by the abcjs note audition (below).

**Collapsible sections (`editor-sections.js`)** — the document is split into labelled, collapsible bars (styled like the blame view's commit-group headers): the **front matter** (`---`…`---`, recognised once the closing fence exists) and, for abcjs docs, the **tune header** (up to and including the required `K:` line) and the **music** (the measures after `K:`, when non-empty). Bars appear **only when the document splits into more than one section** — a lone section (e.g. front matter by itself) shows nothing. Each section renders a bar — expanded = a thin bar above it (block widget, `side:-1`); collapsed = a block-`replace` bar showing the label + line count. **Block `replace` must end at a line END, not the next line's start** — ending on the next line's start collides with the following section's expanded header widget (anchored there, `side:-1`) and CM drops it, so the collapse backs up over the section's trailing newline. **On load everything is collapsed except the last section** — normally the music (`defaultCollapsed` collapses all but the last in the list); `resetCollapseEffect` (dispatched from `Editor.setValue`) re-applies this on checkout/branch-switch/open. A section that becomes valid *while typing* is NOT auto-collapsed (it's not in the collapsed set) so it appears expanded as you write it. Collapse state is a per-editor `Set` of section ids toggled by clicking a bar. **Section bars are suppressed entirely in landscape phone** (`landscapePhoneMql` — no vertical room); `detectSections` returns `[]` there while the collapse `Set` is preserved, and `refreshSectionsEffect` (dispatched on the mql `change`) rebuilds so rotating back to portrait restores the previous state. This is deliberately NOT the old generic `@codemirror/language` fold (removed as "too confusing", see Mobile section) — it's a purpose-built, labelled, default-collapsed section model.

**Preview (`preview.js`)** renders the active model/DSL. Clicking a rendered ABC note highlights the source (`abc-play-cursor`/`dsl-select`) without flipping panes on mobile.

**Gutter click = a line-options menu (`_showGutterMenu` in `editor.js`).** Clicking/tapping the rail opens a small floating menu instead of jumping straight to a comment. Every line offers **Comment** (add / view — the old line-level comment behaviour). Any line **belonging to an ABC voice** — a `V:` declaration line, an inline-`[V:id]`-prefixed music line, or a music/lyrics line under a `V:` line — additionally offers **Mute** and **Solo**, labelled with the voice id (see below). The rail is 14px so it can hold a single **M**/**S** mark character. The old YAML front-matter grey gutter tint (`cm-fm-line`) was removed — the collapsible section bars now delineate the front matter.

**ABC voice mute / solo (state + `editor.js` + `abcjs.js`, keyed by voice id via `core/abc-voices.js`).** `state.abcMutedVoices` / `abcSoloVoices` are `Set`s of voice ids; `state.isVoiceMuted(id)` = explicitly muted OR (any solo active AND not soloed). **Mute and solo are mutually exclusive modes**: soloing clears all mutes and replaces any previous solo (`abcSoloVoices` holds at most one id; toggling the soloed voice clears it), and muting clears any solo (mutes are per-voice opt-ins, several can be active). Toggled from the gutter menu → `state.toggleVoiceMute/Solo` → emits `'abc-voices-change'`. `buildVoiceMap` recognises BOTH standalone `V:` lines AND inline `[V:id]` fields (char-accurate, so a mid-line `[V:x]` switches voice mid-line — this is also what makes `_isMutedAtChar` correct for interleaved `[V:id]`-per-line scores). A muted / non-soloed voice: (1) shows **M** (muted, red) / **S** (soloed, green) in the rail on EVERY line of that voice (`_voiceMarkForLine`, via the per-doc-cached voice map; blank/`%` lines are exempt from marks + fade); (2) is dimmed in the editor (`voiceFadeField` line decoration `cm-voice-muted`) and the score — in abc2svg, `setVoiceFade` fades **whole staves**: a staff whose every voice is muted is covered by ONE compound `.uf-staff-veil` `<path>` per system (overlapping subpaths fill once — nonzero winding — so nothing double-fades; per-glyph fading leaked chord tops/stems/beams), while a staff that still has an active voice keeps its furniture crisp and only the muted voice's notes/rests get per-symbol `.uf-muted` veils. The path unions: a full-width band per run of consecutive faded staves (extent from the CLEF annos — the only per-staff-accurate box bracketing the lines + key/meter; unioning note extents dragged the band over the title/tempo, and 'bar'/'key'/'meter' annos lie about their staff — all real bugs), each sounding sym's own anno box (ledger-line outliers), beam/tuplet `rect.abcd` geometry rects (SKIP_ANNO types get non-interactive annos now), and slur/tie arcs matched geometrically (they get NO anno callback; they're unclassed cubic `M…c…` paths — assigned to the nearest staff core via getBBox **mapped through getScreenCTM to root svg coords**: abc2svg nests some arcs in `<g transform=…>`, and the untransformed local bbox put the veil box off-target so the arc showed through "dashed" — real bug; skipped in hidden panes). Staff grouping is **per system svg** (abc2svg hides tacet staves and renumbers); (3) does not sound — the synth path drops it via abcjs's `voicesOff` (score-order voice index from `_mutedVoiceIndices`), the oscillator + Web-MIDI paths skip per-note by `_isMutedAtChar(p.startChar)`; (4) does not highlight during playback — `_highlightEvent` filters each voice by `_isMutedAtChar` (`elements[i]` parallels `startCharArray[i]`, one entry per sounding voice). Char→voice uses section-relative offsets (matching abcjs note startChars); the editor fade builds its own doc-relative map. Selections are cleared on `checkout` / `branch-switch` so stale voice ids don't silence a different tune. **Not persisted** — mute/solo is transient session state.

**Comments (`comments.js`)** — threads in `data.commentThreads`, each with `from/to` char offsets + messages. **As of v0.0.6 comments are LINE-LEVEL only**: the gutter menu's Comment item opens the existing thread or a new-comment form anchored at the line start (`from===to`). The old range/selection comment path was removed. Old range comments still open (matched by start line).

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

## Piano roll (`src/ui/piano-roll.js` + `core/abc-pitch.js` + `core/voice-colors.js`)

A DAW-style second input surface for ABC docs (v0.3 feature). **Desktop:** the transport bar's
piano-roll button expands it bottom-up as an in-flow flex child (via `#uf-bottom`'s
`display:contents`) and it REPLACES the transport while open (`#unifile-app[data-piano-roll]`
hides `#uf-transport`; the roll carries its own play/pause + time + scrub ruler). **Landscape
phones:** a `.ps-roll` dock button toggles it as a fixed bottom overlay. **Portrait phones:** unavailable.

- **Data**: `abcjs.js _emitRollData()` publishes `state.abcRollData` (+ `'abc-roll-data'`) each
  render: per-pitch `{ms,durMs,durWhole,midi,startChar,endChar,voiceId}` notes (chord pitches share a
  startChar), rests (timing moments with no sounding pitch — the add-note targets), voices, meter,
  msPerMeasure/msPerWhole, sectionOffset, source. Char offsets are section-relative (same space as
  noteTimings).
- **Canvas roll**: keyboard column + beat/measure ruler (click/drag scrubs via `abc-seek-preview`/`abc-seek`),
  notes colored per voice, non-active voices ghosted, muted voices near-invisible, playhead with
  auto-follow, wheel scroll / ctrl+wheel time-zoom. **Fit-to-tune runs ONCE per document**
  (`_maybeFit`, reset on checkout/branch-switch) — never on edit re-renders, which must not move the
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

## Mobile / iOS (hard-won — read before touching layout)

The app is a `100dvh`-ish flex column. On phones (`@media max-width:640px`) **the top bar is hidden entirely** (`#uf-topbar { display:none }`) — the **pane switcher (`#uf-pane-switch`) is the sole top chrome**, sitting directly below the site-nav (if present) under the safe-area inset (which lives on `#unifile-app` padding-top). Only the active one of three panes (**commit-log · editor · render**) is displayed; `App._setupMobilePanes()` tracks the pane into `#unifile-app[data-mobile-pane]`.

**The pane switcher is a component (`src/ui/pane-switch.js`, `PaneSwitch`)** — each of the three segments does three jobs: (1) **switch pane** when not active; (2) **show context** — commit segment = orange dirty dot (far-left, `--pending`) · branch icon · branch name; code segment = the document title (ellipsised); render segment = the DSL render icon; (3) **become a dropdown menu** when it IS the active pane (a caret appears): commit → branch picker (switch / new branch), code → the old hamburger items (new doc, help, blame, save/open data file, import & merge, extensions, archived comments, settings), render → rendered exports (SVG/PDF/MIDI) + export-as-app. So on mobile there is **no top bar, no hamburger, and no commit-pane bottom bar** — it all lives in the switcher. Desktop is unchanged (classic top bar + VCS pills; the switcher is `display:none`). The old `commit-bar.js` (branch selector bottom bar) was removed.

**Phones drop the transport bar** (`#uf-transport` is `display:none` on phones — it ate scarce vertical space, worst in landscape with the keyboard up). Playback is a **floating play/pause button** instead: a global `.uf-play-btn` FAB (bottom-right, over editor + render panes) in **portrait**, and inside the landscape dock in **landscape**. Both just `state.emit('abc-play')` and reflect `abc-play-state`. The align FAB stacks above the play FAB in the editor pane.

**Landscape = a collapsible dock.** In landscape (`(orientation: landscape) and (max-height: 500px) and (pointer: coarse)`) the pane switcher becomes a top-right **dock**: a grip (`.ps-handle`) that's **collapsed by default** (just the grip, no reserved gutter — it overlays the corner) and drops the controls down when tapped: the three pane tabs (icons only — the code tab uses `.ps-code-icon`), then play + align (`.ps-play`/`.ps-align`, ABC only, NOT `.ps-btn` so the portrait bar ignores them). Switching a pane re-collapses the dock so it stops covering text. `pointer: coarse` means this can't be seen in the desktop Chromium preview — verify geometry by temporarily dropping the pointer gate, then test on device.

Institutional knowledge — **do not silently "simplify" these; each fixed a real device bug:**

- **Viewport height = JS-measured, not CSS units.** `App._trackViewportHeight()` writes `visualViewport.height`→`--app-height` and `visualViewport.offsetTop`→`--app-vv-top`; `#unifile-app` is `position:fixed; top:var(--app-vv-top); height:var(--app-height)`. Reason: `100vh` includes Safari chrome, `100dvh` hits an iOS 26 regression (gap at bottom), `-webkit-fill-available` resolves short. Using `visualViewport.height` also shrinks the shell above the soft keyboard so the caret stays visible.
- **The "chin gap" was `apple-mobile-web-app-status-bar-style: black-translucent` + `height:100%`.** That meta is REMOVED from `pwa.html`; `html,body` use `100vh`. Don't re-add black-translucent.
- **Document must never scroll.** `App._lockWindowScroll()` snaps `window`/`scrollingElement` back to (0,0); `overscroll-behavior` contains inner scrollers. iOS otherwise scrolls the whole doc when the keyboard is up and shifts the bars.
- **Bottom bar (`#uf-bottom`) is an in-flow flex child**, not `position:fixed` + JS pinning (that pushed it off-screen). It sits flush because the column is exactly the visible height.
- **The pane switcher is the sole top chrome on mobile** (top bar hidden). Its dropdown menus (`.ps-menu`) open below the active segment; `#uf-pane-switch` needs `z-index` above `#uf-main` because it's DOM-first (paints under main otherwise). The **safe-area inset is on `#unifile-app` itself** (`padding-top: env(safe-area-inset-top)` + `background:var(--bg-alt)`, border-box keeps `--app-height`), so the switcher sits below the notch. Rail is **compact 38px**. (Historical: an earlier iteration had an auto-hiding title bar collapsing above a pinned switcher — superseded by folding everything into the switcher.)
- **VCS UX (mobile), redesigned:** the old draft/commit/back-up **banners are gone** — replaced by passive markers. Uncommitted work → the dirty dot + a **pending node** at the top of the commit log (dashed hollow node with an inline, optional message + version + Commit, so a commit is composed where it lands). Durability → an **"exported" marker** on the commit matching `loadBackupMark(scope)` (the last state written out to a `.unifile.json`), so committed-but-in-sandbox is visibly distinct from durably-saved. **Commit messages are optional** (dialog + pending node). The commit pane's bottom bar (`commit-bar.js`) is now a **branch selector** (drop-up: switch/create branch), not a composer.
- **Document title is the single source of truth.** The centred top-bar title edits `data.title`; ABC derives its `T:` from it (a DOM heading in the live preview so char-positions still map 1:1; `_withDerivedTitle` string-injects for exports). An explicit `T:` in the source overrides. Preview re-renders on rename (`preview.js` tracks `_lastTitle`).
- **Mobile gutter is one thin rail** (no line numbers, no fold column): current line = accent segment, commented line = yellow, front-matter lines = grey. Buffer between rail and code lives on `.cm-line` padding-left (not `.cm-content`) so the active-line highlight covers it (no dark sliver).
- **Zoom fix:** viewport `maximum-scale=1, user-scalable=no, viewport-fit=cover`; `.cm-content`/inputs forced to `font-size:16px` to stop Safari focus-zoom.

iOS-specific behavior can't be verified in the local Chromium preview — verify mechanism/geometry there, then test on-device (and remove+re-add the PWA to drop the cached service worker).

---

## Versioning & releases

Version is the **latest git tag** (`git describe --tags --abbrev=0`, strip `v`), stamped into the bundle (`UNIFILE_VERSION`) and `docs/version.json`. **When git tags aren't available at build time — which is the case on Cloudflare Pages (its checkout has no tags) — `detectVersion` falls back to `package.json`'s `version`.** So `package.json` MUST be bumped to match each release, or the deployed `version.json`/`UNIFILE_VERSION` will be stale (and the in-app update prompt won't fire).

**Release flow:** `npm version X.Y.Z --no-git-tag-version` (bump package.json) → `git tag vX.Y.Z` → `npm run build:site` → commit → `git push origin main vX.Y.Z`. The site is served by **Cloudflare Pages** (project `unifile`, `unifile-8yt.pages.dev`), which auto-builds on push with `npm run build:site && npm run site:preview` → `docs/_site`.
**Release candidates:** tag `vX.Y.Z-rc.N` per candidate, cut the bare `vX.Y.Z` when ready. (RC channel precedence needs the git tag list, which Cloudflare lacks — RCs are exercised locally / on GitHub where tags exist.)

`sync-site.mjs` writes `version.json = { version(=stable), stable, latest, released }` (stable = highest non-pre-release tag; latest = highest overall). `update-check.js` compares with full **SemVer 2.0 precedence** (`_parse`/`_cmp`): `rc.2 > rc.1`, and a release outranks its pre-releases (`1.0.0 > 1.0.0-rc.2`). **There is no stable/RC channel split** — `_target()` offers the newest published version (`latest ?? stable ?? version`) to everyone (the old "Receive release candidates" opt-in was removed; on Cloudflare, which has no git tags, `stable`/`latest` both fall back to `package.json` anyway, so the split was inert in production). The check cache-busts `version.json` (`?_=ts`) to beat CDN staleness. **Settings → About** shows the running version.

**PWA update apply (`update-check.js` `_applyUpdate`/`_applySwUpdate` + `templates/sw.js`):** the "Update" button `reg.update()`s, drives the installing/waiting worker to activation (`'skipWaiting'` message), and reloads on `controllerchange`/`activated`. **NEVER reload on a short timer while the install is in flight** — the abc precache is ~5 MB (offline piano), install takes seconds, and the old blind 2 s fallback reliably reloaded through the OLD worker (old version, banner back — "clicking Update doesn't take", the v0.3.1→v0.3.2 bug). The button shows "Updating…" instead; the only timed reload is the no-new-worker path (a previous install already activated in the background). A **module-level `controllerchange` listener + `sessionStorage.uf_update_pending` flag** is the safety net: if the install outlives the page (manual reload, slow line), the moment the new worker claims the page it reloads once onto the new version; the flag is cleared when a check returns 'current' so background swaps the user never requested don't surprise-reload. **The SW precaches the shell with `cache: 'reload'`** — critical: without it a new worker would re-cache the STALE `app.js` the browser/CDN still held, so the "update" reloaded without bumping the version (the earlier incarnation of this same symptom). The SW also self-`skipWaiting()`s on install and handles a `'skipWaiting'` message.

`git commit` messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## The website (`docs/`)

**Hosted on Cloudflare Pages** (as of 2026-07; migrated off GitHub Pages, which was flaky/queue-stuck). Project `unifile` → `unifile-8yt.pages.dev`, custom domain **`unifile.app`**. Cloudflare **auto-builds on every push to `main`** with build command `npm run build:site && npm run site:preview` and output dir **`docs/_site`**. No queue, no Ruby. GitHub Pages is unpublished; `docs/CNAME` was removed (Cloudflare manages the custom domain via a proxied `CNAME` record in its own DNS — the domain's DNS lives on Cloudflare, registrar stays Namecheap).

**The site is rendered by `build/render-site.mjs`** (`npm run site:preview`) — a **no-Ruby Node renderer** (uses `marked`) that reads `docs/` (top-level `*.md` pages, `_posts`, `_data/{apps,types}.yml`, the `launcher` include), writes rendered HTML + `search.json` into `docs/_site`, and copies through `assets/`, `dl/`, `pwa-{md,mer,abc}/`, `version.json`. It was formerly just a local preview mirror; **it is now the production build**, so if you change layouts/includes you must update `render-site.mjs` (it only understands a small hand-rolled Liquid subset — the post/app-list loops + the launcher include — not full Jekyll). `docs/_site/` is a build output (gitignored). Note: `npm run build:site` still regenerates + commits `docs/dl/*` and `docs/pwa-*/`, but Cloudflare rebuilds them from source anyway, so committing them is now redundant (candidate cleanup).

Navigation is a **command-bar** (type to jump; index = `docs/search.json`). Per-type front doors (`/get/`=Markdown, `/mermaid/`, `/abc/`) device-detect and route via `launcher.html` + `assets/js/launch.js` (install PWA on mobile; PWA or `.html` on desktop).

**Cloudflare clean-URL gotcha:** Pages 308-redirects `/foo.html` → `/foo`, which would strip the `.html` off a downloaded quine. The download links therefore set an explicit `download="unifile.<abbrev>.html"` (in `launch.js` + both no-JS launcher fallbacks) so the saved filename is preserved.

---

## Conventions & workflows

- **Adding a DSL:** create `src/dsl/<id>.js` that `registerDSL(...)`; add an entry to `DSL_META` in `build.mjs` to give it a dedicated build; import it in `main.js` for dev; add a hub page + `types.yml`/`apps.yml` entries to surface it on the site.
- **Verifying UI changes:** use the preview tools against a build (`node build/build.mjs --dsl=abcjs --no-pwa`, serve `dist/` — see `.claude/launch.json`, port 8765). Resize to 375px for mobile. **Always build the variant you're testing.**
- **Deploying is automatic on push:** Cloudflare Pages rebuilds from source (`build:site && site:preview`) on every push to `main`, so a source-only commit deploys correctly — no need to pre-run `build:site` for the deployed site to be current (that old footgun is gone). You still build the specific variant locally to *test* UI changes in the preview.
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
