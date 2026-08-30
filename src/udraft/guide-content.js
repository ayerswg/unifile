/**
 * uDraft user guide — the single source (rendered in the app's Guide sheet
 * and emitted as /udraft/guide/ by build/render-site.mjs).
 * Keep it current when changing uDraft behaviour.
 */

export const GUIDE_MD = `
uDraft turns a plain-text description of a building into an architectural
blueprint. You write statements — one per line — and the plan draws itself:
walls, door swings, window symbols, dimension strings, room labels with areas.

Tap the **eye** to see the drawing. Type \`/\` for the insertion menu.

On the drawing:

- **Scroll or pinch to zoom, drag to pan** (the −/⛶/+ buttons do the same;
  ⛶ fits the whole floor).
- **Tap a room** to step into it — the view zooms to the room and its name
  moves up into the context bar.
- **Tap an object** — a door, a sink, a stair, a dimension — to select it:
  it highlights and the bar shows its specifics (size, wall, position,
  swing…). Tap empty space (or ‹) to step back out.
- **Long-press anything** (or tap **‹/›** in the bar) to jump to the DSL
  line that defines it.

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
  washer, dryer, water-heater, counter, bed, table. Width is optional
  (each type has a standard size); \`at 4'\` positions along the wall.
- **label** renames a room on the plan (the default is its id, title-cased);
  **note** adds a small parenthetical under the label.
- **dim** adds an explicit dimension line on one side of a room. Overall
  building dimensions are automatic (\`dims: off\` in front matter disables).
- \`#\` starts a comment (at a line start or after a space).

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
(\`up\` or \`down\` labels the arrow). uDraft checks that flights stack: an
\`up\` with no stairs over the same spot on the floor above gets a warning
in the issue strip.

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
true scale** (put a scale ruler on it), plus the data file (text + full
history) and, in single-file mode, a copy of the whole app.

## History

uDraft keeps git-style version history on your device — commit from the
History sheet, restore any version. Everything is offline; nothing leaves
your device.
`;
