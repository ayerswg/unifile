/**
 * uDraft user guide — the single source (rendered in the app's Guide sheet
 * and emitted as /udraft/guide/ by build/render-site.mjs).
 * Keep it current when changing uDraft behaviour.
 */

export const GUIDE_MD = `
{draft} (formerly uDraft) turns a plain-text description of a building into an architectural
blueprint. You write statements — one per line — and the plan draws itself:
walls, door swings, window symbols, dimension strings, room labels with areas.

Tap the **eye** to see the drawing. Type \`/\` for the insertion menu.
**Example plan** in the ⋯ menu loads a complete three-floor cottage —
stacked stairwell, kitchen island, a \`define\`d baby grand placed on two
floors, an L-shaped desk — plus a **site plan** of its lakeside lot, to
explore and pull apart.

The drawing is navigated hierarchically — floor › room › object:

- **Tap a room** to step into it: the room is drawn **in isolation** — just
  its walls, openings and fixtures, its dimensions written outside the
  walls, and labelled **arrows to the adjoining rooms** (tap an arrow to
  walk into that room).
- **Inside a room, tap an object** — a door, a sink, a stair — to select
  it: the view zooms to it and its own measurements (width, position,
  depth) draw beside it.
- **The breadcrumbs** across the top (Main Floor › KITCHEN › SINK) are
  buttons — tap any level to go back up. Tapping empty space or ‹ steps up
  one level.
- **Long-press a room or object to edit it**: a syntax-highlighted pane
  opens at the bottom with the DSL statements for that scope — the whole
  room's lines, or the one object's — and **every keystroke redraws the
  plan live**. The collapsed chip at the bottom reopens it; Esc or ⌄
  closes it.
- **Scroll or pinch to zoom, drag to pan** anytime (−/⛶/+ do the same;
  ⛶ re-fits the current scope).

## Rooms — the spine

Rooms are declared with their **interior clear dimensions** (the usable
inside space — walls are added for you), and each room is placed against a
room declared **above it**:

\`\`\`
room living   20' x 14'
room kitchen  12' x 10'   east of living, align north
room hall      4' x 10'   south of living, align west
\`\`\`

- The first room needs no placement — it is the origin.
- \`east of living\` puts the room across a shared interior wall.
  Directions are compass only: **north** is up.
- \`align north\` / \`align south\` (for east/west placements) and
  \`align east\` / \`align west\` (for north/south placements) pick which
  edges line up; add \`offset 2'\` to slide along the wall.
- \`at 10', 5'\` places a room absolutely (x east, y south) — the escape
  hatch when relations can't express a layout.

Lengths: \`20'\`, \`12'6"\`, \`4.5"\`, \`3.6m\`, \`450mm\`. A bare number is
feet (or meters with \`units: metric\` in the front matter).

### Irregular shapes

Trace the interior outline clockwise with compass legs; \`close\` finishes
the walk back to the start:

\`\`\`
room porch outline E 8' S 6' W 8' close   south of living, align west
\`\`\`

## Openings

Doors, windows and cased openings punch through walls. A wall between two
rooms is named \`roomA/roomB\`; an exterior wall is named \`room side\`:

\`\`\`
door   living/kitchen 2'8"  at 2' from north, swing kitchen north
door   living south   3'    centered, swing in west
window kitchen north  3'    centered
opening living/hall   4'    centered
\`\`\`

- Position: \`centered\`, or \`at 2'\` from the north/west end
  (\`at 2' from south\` measures from the other end).
- Door swing: the room it opens **into** (or \`in\`/\`out\` on an exterior
  wall) plus the **hinge side** (\`north\`/\`south\` on a north–south wall,
  \`east\`/\`west\` on an east–west wall).

## Everything else

\`\`\`
stairs  hall 3' x 9' up, along east
fixture kitchen sink 30" on north at 4'
label   living "Living Room"
note    porch "screened"
dim     living south
floor 2 "Second Floor"
\`\`\`

- **stairs**: width × run, \`up\` or \`down\`, flush \`along\` a side.
- **fixture** types: sink, range, fridge, dishwasher, toilet, tub, shower,
  washer, dryer, water-heater, counter, island, bed, table, grand-piano,
  upright-piano, sofa, chair. Size is optional
  (each type has a standard footprint) — override it with \`30"\` (width) or
  \`6' x 3'\` (width × depth); \`at 4'\` positions along the wall.
- **label** renames a room on the plan (the default is its id, title-cased);
  **note** adds a small parenthetical under the label.
- **dim** adds an explicit dimension line on one side of a room. Overall
  building dimensions are automatic (\`dims: off\` in front matter disables).
- \`#\` starts a comment (at a line start or after a space).

## Islands & free-standing objects

A fixture doesn't have to sit on a wall — drop \`on <side>\` and place it
freely inside the room. That's how a kitchen island stands:

\`\`\`
fixture kitchen island 6' x 3'  centered
fixture kitchen island 6' x 3'  at 2'6", 4'6"
fixture living  piano  at 9', 6" facing west
\`\`\`

- \`centered\` puts it in the middle of the room; \`at x, y\` measures from
  the room's **north-west interior corner** (x east, y south).
- \`facing\` turns the object so its front faces that side (south when
  omitted). Wherever it lands, it must fit inside the room — an object
  poking into a wall is an error.

## Custom objects — define once, place anywhere

\`define\` teaches the document a new object type — its footprint and a
label — and \`fixture\` then places it like any built-in, **on any floor**,
without repeating the dimensions:

\`\`\`
define piano 5' x 6'6" "Baby Grand"

floor 1 "Main Floor"
…
fixture living piano at 9', 6" facing west

floor 0 "Basement"
…
fixture rec piano centered
\`\`\`

Define an object above its first use — the top of the document, before the
first \`floor\`, is the natural spot. Custom objects work \`on\` walls and
free-standing alike. By default one draws as a plain box with its label
centered — three clauses give it a real shape:

- **\`shape <name>\`** borrows a built-in symbol, scaled to the object's
  footprint: any fixture type (\`grand-piano\`, \`upright-piano\`, \`sofa\`,
  \`chair\`, \`tub\`, …) plus \`round\` (an ellipse filling the box) and
  \`box\`. So \`define piano 5' x 6'6" "Baby Grand" shape grand-piano\`
  draws a baby grand — keyboard along the front, curved tail behind.
- **\`outline <walk> close\`** replaces the \`w x d\` with the same
  compass walk rooms use, for orthogonal silhouettes — an L-shaped desk, a
  sectional. The footprint is the walk's bounding box:
  \`define desk outline E 6' S 2' W 3'6" S 2'6" W 2'6" close "Desk"\`.
- **\`path …\`** draws anything, SVG-style, in the object's own coordinates
  (from its north-west corner, x east and y south, the **front** along
  y = depth). Commands are absolute: \`M\` move, \`L\` line, \`H\`/\`V\`
  horizontal/vertical line, \`C\` cubic and \`Q\` quadratic curves, \`Z\`
  close. Several subpaths are fine (start each with \`M\`):
  \`define bath 5' x 2'6" path M 0 0 H 5' V 2'6" H 0 Z M 6" 4" H 4'6" V 2'2" H 6" Z\`.

Whatever the shape, \`facing\` turns the whole drawing (a \`grand-piano\`
facing west has its keyboard to the west), and a size on the \`fixture\`
line stretches it to that footprint.

## Floors & stairs

\`floor <number> "Title"\` starts a storey; everything after it belongs to
that floor (use \`0\` or a negative number for a basement). The preview shows
one floor at a time — the tabs are ordered by floor number. Room names are
per-floor, so every storey can have its own \`bath\`.

**All floors share one origin**, so the same relative placements stack rooms
exactly on top of each other — the easiest way to align a stair shaft:

\`\`\`
floor 1 "Main Floor"
room living 16' x 13'
room hall   5' x 9'   south of living, align west
stairs hall 3' x 9' up, along west

floor 2 "Second Floor"
room bedroom 16' x 13'
room landing 5' x 9'  south of bedroom, align west   # lands over the hall
stairs landing 3' x 9' down, along west              # same shaft
\`\`\`

Each floor's \`stairs\` statement draws the flight you see on that floor
(\`up\` or \`down\` labels the arrow). {draft} checks that flights stack: an
\`up\` with no stairs over the same spot on the floor above gets a warning
in the issue strip.

## Site plans — the lot, the land, the house on it

A \`site\` sheet draws everything **outside** the walls: the surveyed lot,
setbacks, ground contours, the house footprint, the driveway, wells,
septic, trees. It appears as its own tab beside the floors. Start one with
\`site\`, then read the lot straight off the plat — one course per line,
clockwise from the point of beginning:

\`\`\`
site "Lot 7, Loon Lake" scale 1"=20' north up
lot "LOT 7" S 77°30'00" E 150' "IPF"
course S 12°30'00" W 120' "IPF"
course S 45°00'00" W 60'
course N 82°03'44" W 118.14'
course N 12°30'00" E 180' "IPF"
setback 30'
setback 50' course 1
\`\`\`

- **\`site\`** takes a title, a **scale** (\`1"=30'\`, \`1:500\`, or just
  \`30\`; the default is 1" = 20') and **\`north\`** — \`up\`, \`left\`,
  \`right\`, \`down\` or degrees — to turn the drawing the way the plat is
  drawn. Bearings are always true; only the sheet rotates.
- **\`lot\`** + **\`course\`**: surveyor's bearings and distances —
  \`N 87°35'24" E 210.48'\` (also \`N 87-35-24 E\`, \`N 87.59 E\`, plain
  \`NE\`/\`S\`, or \`az 92.5\`). Courses may follow the \`lot\` line
  inline or on \`course\` lines below it. The figure closes itself back to
  the start; if the courses miss by more than half a foot the issue strip
  says by how much. A quoted string after a course labels the monument at
  its end (\`"IRF"\`, \`"IPF"\`); one after \`lot\` labels the parcel.
  The area is computed and written at the centre.
- **\`setback 25'\`** draws the building line inside every course;
  \`setback 50' course 1\` overrides one side (the front). A building that
  crosses it — or leaves the lot — gets a warning.
- **Coordinates** on a site are \`x, y\` from the point of beginning
  (x east, y south), the same convention as \`at\` inside a room.

\`\`\`
road "Loon Lake Road" along course 1 width 50' "State Route 12"
building from floor 1 at 50', 75' "Cottage"
building shed 12' x 10' at 120', 40'
driveway 10' from 76', -10' to 66', 50' to 60', 72'
well at 25', 60' "Well"
septic at 95', 95'
drainfield 40' x 24' at 90', 110'
tree 30" "oak" at 118', 60'
line "Loon Lake" smooth -60,196 0,204 60,210 120,204
contour 1010 index -20,40 40,45 100,42 160,48
contour 1008 -30,75 40,78 100,74 160,80
note at 10', 10' "Zoned R-1"
\`\`\`

- **\`building from floor 1\`** stamps that floor's **actual walls** onto
  the lot (the north-west corner of its walls at \`at\`; \`rotate 10\`
  turns it clockwise). \`building <w> x <d> at …\` draws a plain footprint.
- **\`road\`** draws the right-of-way beyond one course (edge line, dashed
  centre line, name); **\`driveway\`** is a smoothed band of the given
  width through its points.
- **Features**: \`well\`, \`septic\`, \`tank\`, \`drainfield\`, \`pad\`,
  \`deck\`, \`patio\`, \`pool\`, \`shed\`, \`garage\`, \`barn\`, \`pin\`,
  \`pole\`, \`hydrant\`, \`manhole\` — each works as its own statement
  (\`well at …\`) or as \`feature <type> …\`, with an optional
  \`<w> x <d>\`, \`rotate <deg>\` and a \`"Label"\`. Point symbols
  (wells, pins) draw at paper size; areas at true size. A \`define\`d
  object can be placed with \`feature <id> at …\`.
- **\`tree\`**: caliper, species and position; the canopy is a foot of
  spread per inch of trunk unless you give \`canopy 30'\`.
- **\`contour\`**: an elevation followed by the points the line passes
  through (smoothed); \`index\` makes it a heavy line. **\`line\`** draws
  any other polyline — a shoreline (\`smooth\`), a fence (\`dashed\`).
- **\`note at x, y "text"\`** places free text.

Every site element is tappable (long-press edits its line; a lot opens with
all its courses and setbacks). Exports print the site sheet **at its own
scale**, with a north arrow and a graphic scale bar.

## Front matter

\`\`\`
---
title: Lakeside Cottage
units: imperial        # imperial | metric
scale: 1/4in           # print scale: 1/4in, 1/8in, 1:50, 1:100
dims: auto             # auto | off
walls:
  exterior: 6"
  interior: 4.5"
---
\`\`\`

## Exports

From the ⋯ menu: **SVG** (vector drawing), **PNG**, **PDF** — printed **at
true scale** (put a scale ruler on it) and, in single-file mode, a copy of
the whole app. The plan itself (text + full history) is kept by **Save to
device** — see History.

## Comments

Select a statement (or a few words of it) and **long-press the selection**
(right-click on a desktop) → **Comment**. A card opens under it; the
commented text keeps a soft highlight — tap it to read the thread, reply or
**Resolve**. **⋯ menu → Comments…** lists every open and resolved comment
(tap one to jump to it). Comments follow the text as you edit and are saved
with the document.

## Documents and history

The **‹** button at the top left lists every plan you have drafted in
{draft}, each one exactly as you left it — tap to open, **+ New** to start
another, **⋯** on a row to rename, duplicate or delete. What you type is
remembered on the device as you type it, so switching plans never loses
anything.

The list's **search bar** searches plan names *and* their text, showing
the matching lines under each plan — tap one to open the plan on that line.

**Save** (⋯ menu → Save, or from the **History** sheet, where a note is
optional) writes the plan's text to your device as a file — just the DSL
text — and keeps the same snapshot in the plan's history. Every save is a
new file: \`name-A00.uni\`, \`name-A01.uni\`… The **name** is asked for
once, when the plan is created, and never changes (the title at the top is
separate); the version counts up by itself, and **Save as new major** turns
\`A07\` into \`B00\`. On desktop Chrome and Edge you pick the folder once
and later versions land in it silently; on iPhone and iPad the share sheet
offers Files; elsewhere the file downloads. Tap any version in History to
**restore** it — the old text comes back as the current, unsaved state.
**Open from device** brings a \`.uni\` back (name and version from the
file name). Everything is offline; nothing leaves your device.
`;
