# uDraft — plan (DSL-first)

A new dedicated unifile variant: **uDraft**, for drafting architectural diagrams as
blueprints — primarily floor plans for homes and buildings. This document is the
design plan, written before any implementation. The bulk of it is the DSL design,
because that's the make-or-break decision; the app shell, build, and rendering all
follow established unifile patterns.

---

## 1. What uDraft is

Plain text in, blueprint out. You describe a building the way you'd describe it to
another person — "the kitchen is 12 by 10, off the east side of the living room,
with a window over the sink" — and uDraft draws a proper architectural floor plan:
wall poché, door swings, window symbols, dimension strings, room labels with areas,
a title block on export.

Everything else is standard unifile: git-style history, quine + PWA, offline,
line-level comments, and (the payoff for a *text* CAD format) meaningful diffs —
"moved the bathroom door 2'" is a one-line change you can read in the commit log.

**Non-goals (v1):** 3D, structural engineering, curved walls, site plans,
elevations, DXF/IFC interchange. This is a *drafting* tool for plan-view
blueprints, not a BIM system.

---

## 2. The DSL — design rationale

### 2.1 The core problem: geometry in text

There are three ways a text language can describe a floor plan, and the choice
determines whether the format is readable or write-only:

**A. Absolute coordinates** (SVG/DXF style: `wall (0,0) to (240,0)`).
Precise, trivial to render — and unreadable, unwritable, and un-diffable. Moving
one wall means editing every number downstream. This is what we're *escaping
from*; it survives only as a last-resort override.

**B. Wall-walk / turtle** (`E 20' N 14' W 20' close` — compass headings and
distances, the way surveyors describe a plat). Natural for tracing one irregular
outline, but describing a whole multi-room plan as walks is error-prone (every
loop must close, rooms are implicit, one edit shifts everything after it).

**C. Room-first declarative** (`room kitchen 12' x 10' east of living`).
Rooms are the nouns people actually think in. Each room is one line; relations
("east of", "align north") place it against rooms already declared. A change to
one room is a one-line diff. Requires a small layout pass — but a deterministic,
single-pass one, not a constraint solver.

**Decision: C is the spine, B is the escape hatch for irregular shapes, A is the
last resort.** A document is a list of room declarations, each anchored to a
previously declared room, plus openings (doors/windows) attached to walls, plus
annotations. Irregular rooms swap their `W x H` for an `outline` walk. A bare
`at x, y` placement exists for the rare case relations can't express.

This also fits unifile's mechanics: the format is strictly **one statement per
line**, which makes line diffs, line comments, the gutter, and click-to-source
mapping all trivially correct — the same property that makes ABC work well here.

### 2.2 Deterministic layout, not constraint solving

The layout pass places rooms **in declaration order**. Each room's anchor must
name a room already declared above it — forward references are errors. This
keeps layout one-pass, deterministic, and (crucially) *debuggable*: when
something lands in the wrong place, the answer is always on or above that line.
No solver, no "why did everything shift", no non-determinism between renders.

Overlaps, unclosed outlines, and unresolvable anchors are **lint diagnostics**
mapped to the offending line (mermaid-style), never silent best-effort guesses.

### 2.3 Dimensions are interior; walls are implicit

`room kitchen 12' x 10'` means twelve by ten **clear interior** — the number a
homeowner knows. Walls are generated *between and around* rooms by the layout
pass, with thickness defaults from front matter (`exterior: 6"`, `interior: 4.5"`
by default). Two adjacent rooms **share one wall**; the layout pass merges
coincident wall segments into a single wall entity, which is what makes
`door kitchen/living` (an opening in the shared wall) expressible.

This is the single most important semantic decision: it means the author never
draws a wall in the common case. Rooms imply walls; openings punch holes in them.

### 2.4 Orientation: compass, north = up

Walls and directions use **compass names** (`north/south/east/west`, abbreviable
`n/s/e/w`), with north as up. This is the architectural convention, it reads
naturally in relations (`east of living`), and it stays unambiguous if plan
rotation ever arrives (unlike `left/right`). Outline walks use the same compass
letters.

### 2.5 Units

- Imperial architectural: `20'`, `12'6"`, `6"` — and, because the inch mark
  collides with string quoting, the lexer treats `"` as an inch mark **only
  immediately after a digit in a number token**; labels/strings are the only
  other double-quote context. (`12'6` with the inch mark omitted also parses.)
- Metric: `3.6m`, `450cm`, `450mm`.
- Front matter `units: imperial | metric` sets how **bare numbers** are read
  (`12 x 10` → feet or meters) and the dimension-string display format. Both
  unit families are always accepted explicitly regardless of the setting.
- Internally everything normalizes to millimeters (integers — no float drift in
  wall-merge comparisons).

### 2.6 The statement set (v1 grammar)

Comments: `#` to end of line (whitespace-preceded, same rule as front matter —
though nothing like `C#3` exists here, symmetry is free). Blank lines ignored.
Identifiers: `[a-z][a-z0-9_-]*`. Display strings: double-quoted.

```
#!udraft@1

floor 1 "First Floor"                      # starts a floor block (see 2.8)

# --- rooms: the spine ---------------------------------------------------
room living   20' x 14'                    # first room = origin
room kitchen  12' x 10'   east of living, align north
room dining   12' x 11'   south of kitchen, align east
room hall      4' x 10'   south of living, align west
room bath      6' x  8'   east of hall
room porch    outline E 8' S 6' W 8' close   south of living, align west

#   room <id> <W> x <H> [<relation>]
#   room <id> outline <walk> [<relation>]
#   relation  := (north|south|east|west) of <room> [, align (north|south|east|west)] [, offset <len>]
#              | at <x>, <y>                        # absolute escape hatch
#   walk      := (N|S|E|W <len>)+ close             # 90° legs, v1; must close

# --- openings: doors, windows, plain openings ---------------------------
door    living/kitchen  2'8"  at 2' from north, swing kitchen north
door    living south    3'    centered, swing in west        # exterior: front door
door    hall/bath       2'6"  centered, swing bath south
opening living/dining   6'    centered                       # cased opening, no leaf
window  living west     4'    at 3'
window  living west     4'    at 10'
window  kitchen north   3'    centered

#   (door|window|opening) <roomA>/<roomB> <width> <position> [<swing>]
#   (door|window|opening) <room> <side>   <width> <position> [<swing>]   # exterior wall
#   position := centered | at <len> [from <side>]     # along the wall, default from
#                                                     # the west/north end
#   swing    := swing <into-room|in|out> <hinge-side>

# --- vertical circulation & fixtures ------------------------------------
stairs  hall  3' x 9'  up, along east      # tread lines + arrow + "UP"
fixture kitchen sink   30" on north at 4'
fixture kitchen range  30" on north at 8'
fixture kitchen fridge 36" on east
fixture bath   toilet      on south at 1'
fixture bath   tub     60" on north

#   fixture <room> <type> [<width>] on <side> [at <len>] [facing <dir>]
#   v1 symbol library: sink, range, fridge, dishwasher, toilet, tub, shower,
#   washer, dryer, water-heater, counter, closet-rod

# --- annotation ----------------------------------------------------------
label living "Living Room"                 # default label = id, title-cased
dim   living south                         # explicit dimension line
note  porch "screened"                     # small text note in the room
```

Readability test — the thing this design optimizes for: a person who has never
seen uDraft can read that block aloud and sketch the house. That's the bar.

### 2.7 What each statement compiles to

1. **Parse** (per line, no cross-line state except `floor` blocks): AST of
   statements, each carrying its line's char range (`from`/`to`).
2. **Place**: rooms resolve to interior rectangles/polygons in declaration
   order. `east of living` = kitchen's west interior edge sits one shared-wall
   thickness east of living's east interior edge; `align north` = north interior
   edges flush. Overlap → diagnostic.
3. **Wall graph**: from placed rooms, derive wall segments (exterior vs interior
   by whether both sides face a room), merge coincident segments, then subtract
   openings (each opening resolves its wall by the `roomA/roomB` pair or
   `room side` and validates that width + position fit the segment).
4. **Scene**: a pure-data description (walls, openings, fixtures, labels, dims)
   with every entity keeping its source char range — this is the render input
   *and* the click-to-source map.

Steps 1–3 are pure functions in `src/core/` territory (no DOM), unit-testable
in Node — the geometry is where the bugs will live, so it must be testable
without a browser.

### 2.8 Floors

`floor <n> ["Title"]` starts a block; all statements until the next `floor`
belong to it. Floors share the origin (so stacked plans align) but lay out
independently. The preview shows one floor at a time with tabs (phones: the
same tabs, horizontally scrollable); exports emit one sheet per floor. A
`stairs … up|down` is v1's only cross-floor semantic (it just draws the arrow
and label; no cross-floor validation yet). A document with no `floor` line is a
single unnamed floor — the common small-plan case stays zero-ceremony.

### 2.9 Front matter (uDraft keys)

```
---
title: Lakeside Cottage
units: imperial            # imperial | metric — bare-number unit + dim format
scale: 1/4in               # print scale: 1/4in (=1/4":1'-0"), 1/8in, 1:50, 1:100
walls:
  exterior: 6"
  interior: 4.5"
dims: auto                 # auto | off — exterior dimension strings
sheet:                     # title block on export
  size: letter             # letter | a4 | a3 | tabloid
  author: W. Ayers
  number: A-1
---
```

All keys have defaults; an empty front matter (or none) renders fine. The keys
go through the existing `fm-schema.js` machinery for completion + lint, like
mermaid's.

### 2.10 Explicitly deferred (with their future syntax sketched now)

Sketched now so v1 doesn't paint them out:

- **Angled walls**: outline legs with bearings — `NE 6'` (45°) or surveyor-style
  `N30E 8'`. The walk grammar has room for it; the wall-merge pass is the hard
  part, which is why it waits.
- **Curved walls / arcs**: an `arc` leg. Deferred indefinitely.
- **Wall-level overrides**: `wall living east 8"` (thickness), load-bearing
  marking, fireplace inserts.
- **Furniture layer**: same `fixture` grammar, `layer: furniture` toggle.
- **Electrical/plumbing symbols**: a classic blueprint layer; same attachment
  grammar (`symbol kitchen outlet on north at 2'`).
- **A "draft view" direct-manipulation canvas** that rewrites the text — the
  piano-roll pattern (edits go out as `'dsl-edit'` CM6 changes so undo/history
  just work). The one-statement-per-line property is what will make this
  tractable; it's the long-term reason to hold that invariant.

---

## 3. Rendering

**SVG, drawn with `currentColor`** (the abc2svg lesson: `color: var(--fg)` on
the wrapper *is* the whole dark theme — no invert filters). Scene → SVG is a
straightforward emitter; no third-party library. That makes uDraft the
**lightest variant in the family** (mermaid ships a ~1MB parser zoo, abc ships a
5MB piano; uDraft ships geometry and taste).

Blueprint vocabulary, v1:

- **Walls**: double-line poché, solid fill (theme-aware; classic diagonal hatch
  as a later `style` option). Exterior walls visibly thicker.
- **Doors**: gap + leaf + quarter-circle swing arc, honoring hinge side and
  swing direction. Openings: gap + dashed header lines.
- **Windows**: the thin triple-line symbol in the wall gap.
- **Stairs**: tread lines at ~10" intervals, direction arrow, UP/DN text, break
  line.
- **Fixtures**: a small hand-drawn symbol library (plan-view glyphs as path
  data, parameterized by width).
- **Dimension strings**: auto per exterior side (overall + opening centers) when
  `dims: auto` — architectural tick marks, text above the line, `12'-6"` format.
  Explicit `dim` statements add interior runs.
- **Room labels**: name + computed area (`KITCHEN · 120 SF`), centered, sized to
  fit.
- **Sheet furniture (export only)**: border, title block (title/scale/sheet
  number/author/date), scale bar, north arrow.

**Interactivity** — the mermaid pattern, but easier because *we* emit the SVG:
every entity's group carries `data-doc-from`/`data-doc-to` from its statement's
char range. Click a door → its line highlights in the editor (`dsl-select`);
cursor on a line → that entity highlights in the plan (`.uf-hl` equivalent).
No anno-rect archaeology, no glyph-mapping heuristics — we own both ends.

**Optional `style: blueprint`** front-matter value: white lines on blueprint
blue, for the romance. Default stays theme-following.

---

## 4. Editor intelligence

Same stack as mermaid, one module each:

- **Highlighting**: `StreamLanguage` — keywords (`room`, `door`, …), lengths
  (`12'6"` as numbers — the lexer rule from 2.5), compass words, room ids
  (name), strings, comments.
- **Completion**: statement keywords at line start; after `of`/`/`-references,
  **the declared room ids** (the parse is cheap enough to re-run for the
  completion source); fixture types after `fixture <room> `.
- **Lint**: the real parser + layout pass (it's fast and pure), surfacing parse
  errors, forward references, non-closing outlines, overlaps, and
  openings that don't fit their wall — each on its own line.
- **Hover docs** for keywords and fixture types.
- **DSL_HELP** entry (`topbar.js`): the grouped syntax reference — Rooms /
  Openings / Fixtures / Annotation / Front matter.
- Collapsible section bars: front matter + per-`floor` bars fit the existing
  `editor-sections.js` model naturally (multi-floor docs collapse to the floor
  you're working on). Nice-to-have, not v1-blocking.

---

## 5. Integration & build

- `src/dsl/udraft.js` (plugin entry: register, render, editor extensions,
  exporters) + `src/core/udraft/` for the pure parts (`parse.js`, `layout.js`,
  `scene.js`) + `src/dsl/udraft-symbols.js`, `udraft-svg.js`. Pure core in
  `core/` per the repo's no-DOM convention, tested in Node.
- `DSL_META.udraft = { abbrev: 'dft', plugins: ['markdown', 'udraft'],
  defaultDslType: 'udraft', label: 'uDraft' }` → `dist/unifile.dft.html` +
  `dist/pwa-dft/`. Standard shell (CodeMirror), unlike uPub.
- Icons: add `udraft → uDraft` to `build/icons.mjs`'s u-codename map, design
  the glyph (proposal: a door-swing arc — the most recognizable plan symbol),
  `npm run gen:icons`.
- Site: `docs/udraft.md` front door + `types.yml`/`apps.yml` rows so the
  ISPF menu gets its uDraft line.
- **Exporters**: SVG (scene → standalone SVG, no interactivity attributes);
  **PDF via the print-window pattern from abcjs** (`@page` size from
  `sheet.size`, margins zeroed, body padding as margins) — with the twist that
  the plan is emitted **at true scale** (`scale: 1/4in` → 1 SVG user unit sized
  so 1/4 inch of paper = 1 foot), because a blueprint you can put a scale ruler
  on is the whole point; PNG (canvas rasterize, mermaid's exporter pattern).
- Doc round-trip: standard `.unifile.json`; quine data model unchanged.

---

## 6. Milestones

1. **Core**: lexer/parser + layout + wall graph + scene, with Node unit tests
   (golden-scene tests for the example house; every diagnostic case covered).
   *This milestone is where the DSL gets proven — grammar tweaks are cheap
   here and expensive after.*
2. **Render**: scene → SVG (walls, doors, windows, labels), click-to-source
   both directions, theme-aware. Verify in the preview at 375px too.
3. **Blueprint completeness**: dimension strings, stairs, fixture library,
   floors/tabs, sheet furniture.
4. **Editor**: highlighting, lint, completion, hover, DSL_HELP.
5. **Ship**: DSL_META + icon + site pages + exporters (SVG/PDF-at-scale/PNG);
   `node build/build.mjs --dsl=udraft --no-pwa` in the loop throughout.

Each milestone lands as its own PR-sized commit series; CLAUDE.md gets a uDraft
section when the dust settles (per the repo rule: keep it current).

---

## 7. Open questions (defaults chosen, flag disagreement)

1. **Abbrev `dft`** (→ `unifile.dft.html`, `pwa-dft/`) — or `ud`/`draft`?
2. **Compass-only directions** (2.4) — comfortable? `left/right/top/bottom`
   aliases are possible but two vocabularies for one concept usually reads
   worse, so the plan says compass only.
3. **Interior dimensions** (2.3) is the chosen convention; builders sometimes
   think in exterior/framing dims. A `dims-basis:` front-matter key could
   switch later, but v1 commits to interior-clear.
4. **Relation phrasing**: `east of living` (spaced, reads like English) vs
   `east-of living` (one token, simpler lexer). Plan says spaced — the parser
   is line-scoped and can afford the two-word lookahead.
