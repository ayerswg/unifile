/**
 * uDraft core tests — parser, layout, SVG renderer (all pure; no DOM).
 * Run: npm test   (node --test test/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLength, formatLength, parseDocument, tokenizeLine, parseScale,
  UM_PER_FOOT, UM_PER_INCH,
} from '../src/core/udraft/parse.js';
import { layoutDocument, polyToRects, defaultLabel } from '../src/core/udraft/layout.js';
import { renderFloorSvg, renderExportSvg, renderPrintBody } from '../src/core/udraft/svg.js';

const FT = UM_PER_FOOT;
const IN = UM_PER_INCH;

// ---------------------------------------------------------------------------
// Units / lexer
// ---------------------------------------------------------------------------

test('parseLength: imperial forms', () => {
  assert.equal(parseLength("12'"), 12 * FT);
  assert.equal(parseLength(`12'6"`), 12 * FT + 6 * IN);
  assert.equal(parseLength("12'6"), 12 * FT + 6 * IN);
  assert.equal(parseLength('6"'), 6 * IN);
  assert.equal(parseLength('4.5"'), Math.round(4.5 * IN));
  assert.equal(parseLength('12'), 12 * FT);                    // bare = feet
  assert.equal(parseLength('-2\''), -2 * FT);
});

test('parseLength: metric forms', () => {
  assert.equal(parseLength('3.6m'), 3600000);
  assert.equal(parseLength('450cm'), 4500000);
  assert.equal(parseLength('450mm'), 450000);
  assert.equal(parseLength('12', 'metric'), 12000000);         // bare = meters
});

test('formatLength', () => {
  assert.equal(formatLength(12 * FT + 6 * IN), `12'-6"`);
  assert.equal(formatLength(12 * FT), `12'-0"`);
  assert.equal(formatLength(3600000, 'metric'), '3.6 m');
});

test('lexer: inch mark after digits is not a string quote', () => {
  const toks = tokenizeLine(`door living south 2'8" centered`);
  assert.deepEqual(toks.map(t => t.t), ['word', 'word', 'word', 'len', 'word']);
  assert.equal(toks[3].v, `2'8"`);
});

test('lexer: comments and commas', () => {
  assert.equal(tokenizeLine('# a comment').length, 0);
  const toks = tokenizeLine(`room a 10' x 8'   # nice`);
  assert.deepEqual(toks.map(t => t.v), ['room', 'a', `10'`, 'x', `8'`]);
  const t2 = tokenizeLine(`east of living, align north`);
  assert.deepEqual(t2.map(t => t.v), ['east', 'of', 'living', 'align', 'north']);
});

test('parseScale', () => {
  assert.equal(parseScale('1/4in').ratio, 48);
  assert.equal(parseScale('1/8in').ratio, 96);
  assert.equal(parseScale('1:50').ratio, 50);
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const HOUSE = `---
title: Test House
units: imperial
---
floor 1 "First Floor"
room living   20' x 14'
room kitchen  12' x 10'   east of living, align north
room hall      4' x 10'   south of living, align west
door living/kitchen 2'8" at 2' from north, swing kitchen north
door living south 3' centered, swing in west
window kitchen north 3' centered
opening living/hall 4' centered
fixture kitchen sink 30" on north at 4'
stairs hall 3' x 9' up, along east
label living "Living Room"
dim living south
`;

test('parseDocument: statements land in floors with offsets', () => {
  const p = parseDocument(HOUSE);
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.floors.length, 1);
  assert.equal(p.floors[0].title, 'First Floor');
  const kinds = p.floors[0].statements.map(s => s.kind);
  assert.deepEqual(kinds, ['room', 'room', 'room', 'door', 'door', 'window',
    'opening', 'fixture', 'stairs', 'label', 'dim']);
  assert.deepEqual(p.roomIds, ['living', 'kitchen', 'hall']);
  // Char offsets point at the source line.
  const rm = p.floors[0].statements[0];
  assert.equal(HOUSE.slice(rm.from, rm.to), `room living   20' x 14'`);
  assert.equal(p.meta.title, 'Test House');
});

test('parseDocument: errors are line-mapped and parsing continues', () => {
  const p = parseDocument(`room a 10' x 8'\nbogus thing\nroom b 6' x 6' east of a\n`);
  assert.equal(p.issues.length, 1);
  assert.equal(p.issues[0].line, 1);
  assert.match(p.issues[0].message, /unknown statement "bogus"/);
  assert.equal(p.roomIds.length, 2);
});

test('parseDocument: duplicate room is an error', () => {
  const p = parseDocument(`room a 10' x 8'\nroom a 6' x 6' east of a\n`);
  assert.equal(p.issues.length, 1);
  assert.match(p.issues[0].message, /already declared/);
});

test('parseDocument: outline rooms', () => {
  const p = parseDocument(`room l outline e 12' s 8' w 4' s 4' w 8' close\n`);
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  assert.equal(p.floors[0].statements[0].outline.length, 5);
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('layout: relations place rooms exactly one interior wall apart', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  assert.equal(scene.issues.length, 0, JSON.stringify(scene.issues));
  const f = scene.floors[0];
  const [living, kitchen, hall] = f.rooms;
  const tInt = scene.meta.wallInt;
  assert.equal(kitchen.bbox.x, living.bbox.x + living.bbox.w + tInt);
  assert.equal(kitchen.bbox.y, living.bbox.y);                 // align north
  assert.equal(hall.bbox.y, living.bbox.y + living.bbox.h + tInt);
  assert.equal(hall.bbox.x, living.bbox.x);                    // default align west
});

test('layout: shared walls detected, exteriors fill the rest', () => {
  const f = layoutDocument(parseDocument(HOUSE)).floors[0];
  const shared = f.walls.filter(w => w.shared);
  // living|kitchen (vertical) and living|hall (horizontal).
  assert.equal(shared.length, 2);
  const lk = shared.find(w => w.axis === 'v');
  assert.equal(lk.loSideRoom, 'living');
  assert.equal(lk.hiSideRoom, 'kitchen');
  assert.equal(lk.hi - lk.lo, 10 * FT);                        // kitchen depth
  assert.ok(f.walls.filter(w => !w.shared).length >= 8);
});

test('layout: openings resolve onto their walls with swing defaults', () => {
  const f = layoutDocument(parseDocument(HOUSE)).floors[0];
  const [doorLK, doorFront, win, arch] = f.openings;
  assert.equal(doorLK.kind, 'door');
  assert.equal(doorLK.shared, true);
  assert.equal(doorLK.into, 'kitchen');
  assert.equal(doorLK.hingeEnd, 'lo');                         // hinge north
  assert.equal(doorLK.openDir, 'e');                           // opens east into kitchen
  assert.equal(doorLK.lo, 2 * FT);                             // 2' from the north end (y=0)
  assert.equal(doorFront.shared, false);
  assert.equal(doorFront.openDir, 'n');                        // swings in (north) off the south wall
  assert.equal(win.kind, 'window');
  assert.equal(arch.kind, 'opening');
});

test('layout: forward reference and overlap are errors', () => {
  const fwd = layoutDocument(parseDocument(`room a 10' x 8' east of b\nroom b 6' x 6'\n`));
  assert.ok(fwd.issues.some(i => /not declared above/.test(i.message)));
  const ovl = layoutDocument(parseDocument(`room a 10' x 8'\nroom b 6' x 6' at 2', 2'\n`));
  assert.ok(ovl.issues.some(i => /overlaps/.test(i.message)));
});

test('layout: door that misses the shared wall is an error', () => {
  const scene = layoutDocument(parseDocument(
    `room a 10' x 8'\nroom b 6' x 6' east of a\ndoor a/b 3' at 5' from north\n`));
  assert.ok(scene.issues.some(i => /does not fit the wall/.test(i.message)));
});

test('layout: rooms that share no wall reject openings', () => {
  const scene = layoutDocument(parseDocument(
    `room a 10' x 8'\nroom b 6' x 6' east of a\nroom c 6' x 6' south of a\ndoor b/c 3' centered\n`));
  assert.ok(scene.issues.some(i => /share no wall/.test(i.message)));
});

test('layout: outline room decomposes and pairs walls', () => {
  const scene = layoutDocument(parseDocument(
    `room l outline e 12' s 8' w 4' s 4' w 8' close\nroom side 6' x 8' east of l\n`));
  assert.equal(scene.issues.filter(i => i.severity === 'error').length, 0, JSON.stringify(scene.issues));
  const f = scene.floors[0];
  assert.equal(f.rooms[0].rects.length, 2);                    // L = two bands
  const shared = f.walls.filter(w => w.shared);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].hi - shared[0].lo, 8 * FT);           // full 8' upper leg
  // Area: 12×8 + 8×4 = 128 sqft.
  assert.equal(f.rooms[0].areaUm2, 128 * FT * FT);
});

test('layout: auto dims cover the outer envelope', () => {
  const f = layoutDocument(parseDocument(HOUSE)).floors[0];
  const auto = f.dims.filter(d => d.auto);
  assert.equal(auto.length, 2);
  const h = auto.find(d => d.axis === 'h');
  // Overall width = living 20' + wall + kitchen 12' + exterior walls both ends.
  const scene = layoutDocument(parseDocument(HOUSE));
  const expected = 20 * FT + scene.meta.wallInt + 12 * FT + 2 * scene.meta.wallExt;
  assert.equal(h.um, expected);
});

test('polyToRects / defaultLabel', () => {
  const rects = polyToRects([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.deepEqual(rects, [{ x: 0, y: 0, w: 10, h: 10 }]);
  assert.equal(defaultLabel('living-room'), 'Living Room');
});

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

test('svg: renders every entity class with doc offsets', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  const { svg } = renderFloorSvg(scene.floors[0], scene.meta, { interactive: true });
  assert.match(svg, /class="ud-walls"/);
  assert.match(svg, /ud-door/);
  assert.match(svg, /ud-window/);
  assert.match(svg, /ud-opening/);
  assert.match(svg, /ud-stairs/);
  assert.match(svg, /ud-fixture/);
  assert.match(svg, /LIVING ROOM/);
  assert.match(svg, /280 SF/);                                 // 20×14
  assert.match(svg, /data-doc-from/);
  assert.match(svg, /data-room="living"/);
  // Auto dim text present: 20' + 12' + 4.5" shared + 2×6" exterior.
  assert.match(svg, /33'-4\.5&quot;/);
});

test('svg: export document embeds styles and paper', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  const doc = renderExportSvg(scene, 0);
  assert.match(doc, /^<\?xml/);
  assert.match(doc, /<style>/);
  assert.match(doc, /ud-paper/);
  assert.doesNotMatch(doc, /data-doc-from/);
});

test('svg: print body is sized in real inches at scale', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  const body = renderPrintBody(scene, 'Test House');
  assert.match(body, /width="[\d.]+in"/);
  assert.match(body, /SCALE: 1\/4&quot; = 1'-0&quot;/);
  const w = parseFloat(/width="([\d.]+)in"/.exec(body)[1]);
  // ~33 ft wide building + margins at 1/4"/ft ≈ 9in sheet content — sanity band.
  assert.ok(w > 6 && w < 14, `got ${w}in`);
});

// ---------------------------------------------------------------------------
// Editor syntax module — THE invariant: textContent(rendered) === line
// ---------------------------------------------------------------------------

test('syntax: rendering only wraps, never changes text', async () => {
  const { classifyDoc, renderLineHtml } = await import('../src/udraft/syntax.js');
  const textContent = (html) => html.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const lines = [
    '---', 'title: A & B <test>', 'units: imperial', '---',
    '',
    '# a comment with "quotes" & <angles>',
    `room living   20' x 14'`,
    `room kitchen 12' x 10'  east of living, align north   # trailing`,
    `door living/kitchen 2'8" at 2' from north, swing kitchen north`,
    `window a b 3,, junk @@ "unterminated`,
    `label living "A & B"`,
    'not-a-keyword line with stuff',
    `fixture kitchen sink 30" on north at 4'`,
  ];
  const infos = classifyDoc(lines);
  for (let i = 0; i < lines.length; i++) {
    assert.equal(textContent(renderLineHtml(lines[i], infos[i])), lines[i],
      `line ${i}: ${JSON.stringify(lines[i])}`);
  }
  // Front matter classified; statements carry their keyword class.
  assert.equal(infos[0].type, 'fm-fence');
  assert.equal(infos[1].type, 'fm');
  assert.equal(infos[6].type, 'stmt');
  assert.equal(infos[6].kw, 'room');
  assert.equal(infos[11].type, 'text');
});

// ---------------------------------------------------------------------------
// Floors: per-floor room ids, stacked stair shafts, cross-floor warnings
// ---------------------------------------------------------------------------

const THREE_FLOORS = `floor 1 "Main"
room living 16' x 13'
room hall 5' x 9' south of living, align west
stairs hall 3' x 9' up, along west
floor 2 "Upper"
room bedroom 16' x 13'
room landing 5' x 9' south of bedroom, align west
stairs landing 3' x 9' down, along west
floor 0 "Basement"
room rec 16' x 13'
room stairwell 5' x 9' south of rec, align west
stairs stairwell 3' x 9' up, along west
`;

test('floors: room ids are scoped per floor', () => {
  const p = parseDocument(`floor 1\nroom bath 6' x 9'\nfloor 2\nroom bath 6' x 9'\n`);
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  const dup = parseDocument(`room bath 6' x 9'\nroom bath 5' x 5' east of bath\n`);
  assert.match(dup.issues[0].message, /already declared on this floor/);
});

test('floors: a stacked stair shaft lays out clean across three floors', () => {
  const scene = layoutDocument(parseDocument(THREE_FLOORS));
  assert.equal(scene.issues.length, 0, JSON.stringify(scene.issues));
  assert.equal(scene.floors.length, 3);
  // Shared origin + identical relative placements = identical stair rects.
  const rects = scene.floors.map(f => JSON.stringify(f.stairs[0].rect));
  assert.equal(rects[0], rects[1]);
  assert.equal(rects[1], rects[2]);
});

test('floors: an up flight with nothing above it warns', () => {
  const scene = layoutDocument(parseDocument(
    `floor 1\nroom a 10' x 10'\nstairs a 3' x 9' up, along west\n`
    + `floor 2\nroom b 10' x 10'\nstairs b 3' x 9' down, along east\n`));
  const warns = scene.issues.filter(i => /shaft should stack/.test(i.message));
  assert.equal(warns.length, 2);                               // both flights miss
  assert.ok(warns.every(w => w.severity === 'warning'));
});

// ---------------------------------------------------------------------------
// Free-standing fixtures (islands) + custom objects (define)
// ---------------------------------------------------------------------------

const OBJECTS = `define piano 5' x 6'6" "Baby Grand"
floor 1 "Main"
room kitchen 12' x 10'
room living 16' x 13' east of kitchen, align north
fixture kitchen island 6' x 3' at 2', 4'
fixture living piano at 9', 6" facing west
floor 0 "Basement"
room rec 16' x 13'
fixture rec piano centered
`;

test('parse: define is document-global and define-before-use', () => {
  const p = parseDocument(OBJECTS);
  assert.equal(p.issues.length, 0, JSON.stringify(p.issues));
  const def = p.defines.get('piano');
  assert.equal(def.w, 5 * FT);
  assert.equal(def.d, 6 * FT + 6 * IN);
  assert.equal(def.label, 'Baby Grand');
  // The define is document-level: it opens no implicit floor and belongs to none.
  assert.equal(p.floors.length, 2);
  assert.ok(p.floors.every(f => f.statements.every(s => s.kind !== 'define')));

  // Use before define errors like a room forward reference.
  const fwd = parseDocument(`room a 10' x 10'\nfixture a piano centered\ndefine piano 5' x 6'\n`);
  assert.ok(fwd.issues.some(i => /unknown fixture "piano".*define it above/.test(i.message)));
  // Duplicate + built-in-name defines are errors.
  const dup = parseDocument(`define piano 5' x 6'\ndefine piano 4' x 4'\n`);
  assert.ok(dup.issues.some(i => /already defined/.test(i.message)));
  const clash = parseDocument(`define sink 5' x 6'\n`);
  assert.ok(clash.issues.some(i => /built-in fixture type/.test(i.message)));
});

test('layout: free placement — at x,y, centered, and facing rotation', () => {
  const scene = layoutDocument(parseDocument(OBJECTS));
  assert.equal(scene.issues.length, 0, JSON.stringify(scene.issues));
  const [main, basement] = scene.floors;
  const kitchen = main.rooms[0];
  const island = main.fixtures.find(f => f.type === 'island');
  // at 2', 4' from the kitchen's NW interior corner, default facing south.
  assert.deepEqual(island.rect, {
    x: kitchen.bbox.x + 2 * FT, y: kitchen.bbox.y + 4 * FT, w: 6 * FT, h: 3 * FT,
  });
  assert.equal(island.free, true);
  assert.equal(island.side, 'n');                              // back opposite the facing
  // facing west turns the piano: depth runs east–west.
  const piano = main.fixtures.find(f => f.type === 'piano');
  assert.equal(piano.rect.w, 6 * FT + 6 * IN);
  assert.equal(piano.rect.h, 5 * FT);
  assert.equal(piano.side, 'e');
  assert.deepEqual(piano.def, { label: 'Baby Grand' });
  // centered in the basement rec room — the same define, no re-declaration.
  const rec = basement.rooms[0];
  const piano2 = basement.fixtures.find(f => f.type === 'piano');
  assert.equal(piano2.rect.x, rec.bbox.x + Math.round((rec.bbox.w - 5 * FT) / 2));
  assert.equal(piano2.rect.y, rec.bbox.y + Math.round((rec.bbox.h - (6 * FT + 6 * IN)) / 2));
});

test('layout: a free fixture must fit inside the room (L-shape notch counts)', () => {
  const out = layoutDocument(parseDocument(
    `room a 10' x 8'\nfixture a island 6' x 3' at 6', 6'\n`));
  assert.ok(out.issues.some(i => /island does not fit inside "a"/.test(i.message)));
  // Inside the bbox but over an L-shape's notch is still outside the room.
  const notch = layoutDocument(parseDocument(
    `room l outline e 12' s 8' w 4' s 4' w 8' close\nfixture l island 6' x 3' at 5', 9'\n`));
  assert.ok(notch.issues.some(i => /island does not fit inside "l"/.test(i.message)));
  const ok = layoutDocument(parseDocument(
    `room l outline e 12' s 8' w 4' s 4' w 8' close\nfixture l island 6' x 3' at 1', 2'\n`));
  assert.equal(ok.issues.length, 0, JSON.stringify(ok.issues));
});

test('layout: wall fixtures take a w x d size override', () => {
  const scene = layoutDocument(parseDocument(
    `room k 12' x 10'\nfixture k counter 8' x 30" on south\n`));
  assert.equal(scene.issues.length, 0, JSON.stringify(scene.issues));
  const c = scene.floors[0].fixtures[0];
  assert.equal(c.rect.w, 8 * FT);
  assert.equal(c.rect.h, 30 * IN);
});

test('svg: a room label dodges a centered free-standing object', () => {
  const scene = layoutDocument(parseDocument(OBJECTS));
  const basement = scene.floors[1];
  const piano = basement.fixtures[0];
  const { svg } = renderFloorSvg(basement, scene.meta, {});
  const m = /<text[^>]*y="([\d.]+)"[^>]*>REC<\/text>/.exec(svg);
  assert.ok(m, 'room label rendered');
  // The label re-centres in the clear band below the piano, never on top of it.
  assert.ok(parseFloat(m[1]) > (piano.rect.y + piano.rect.h) / 1000,
    `label y ${m[1]} should clear the piano bottom ${(piano.rect.y + piano.rect.h) / 1000}`);
});

test('svg: island and custom objects render (label centered, rotates with the group)', () => {
  const scene = layoutDocument(parseDocument(OBJECTS));
  const { svg } = renderFloorSvg(scene.floors[0], scene.meta, { interactive: true });
  assert.match(svg, /Baby Grand/);
  const fixtures = (svg.match(/ud-ent ud-fixture/g) || []).length;
  assert.equal(fixtures, 2);                                   // island + piano
  // The piano's fixture line is its click target.
  const m = new RegExp(`data-doc-from="(\\d+)"[^>]*>[^<]*<rect[^>]*rx=`).exec(svg);
  assert.ok(m, 'custom object draws a rounded outline');
});

// ---------------------------------------------------------------------------
// Click targets: every entity gets a hit area; labels jump to their statement
// ---------------------------------------------------------------------------

test('svg: entities carry hit rects; a labelled room label targets its label line', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  const { svg } = renderFloorSvg(scene.floors[0], scene.meta, { interactive: true });
  // Doors, windows, openings, stairs, fixtures, dims all get ud-hit rects.
  assert.ok((svg.match(/class="ud-hit"/g) || []).length >= 8, svg.match(/ud-hit/g)?.length);
  // The living room's label block is its own target, pointing at the `label` line.
  const label = /<g class="ud-ent ud-roomlabel"[^>]*data-doc-from="(\d+)" data-doc-to="(\d+)">/.exec(svg);
  assert.ok(label, 'labelled room has a ud-roomlabel target');
  assert.match(HOUSE.slice(+label[1], +label[2]), /^label living/);
  // Room interior hit paths render BEFORE entities (so objects win the tap)
  // and label groups render after.
  assert.ok(svg.indexOf('ud-room-hit') < svg.indexOf('ud-door'), 'room hits under entities');
  assert.ok(svg.indexOf('ud-roomlabel') > svg.indexOf('ud-fixture'), 'labels over entities');
  // Exports stay clean of hit machinery.
  const doc = renderExportSvg(scene, 0);
  assert.doesNotMatch(doc, /ud-hit/);
});

// ---------------------------------------------------------------------------
// Scope annotations + extents (the drill-down view)
// ---------------------------------------------------------------------------

test('scope: room annotations draw interior dims on the plan', async () => {
  const { annotationMarkup } = await import('../src/core/udraft/svg.js');
  const scene = layoutDocument(parseDocument(HOUSE));
  const floor = scene.floors[0];
  const anno = annotationMarkup(floor, scene.meta, { roomId: 'living' });
  assert.match(anno, /class="ud-anno"/);
  assert.match(anno, /20'-0&quot;/);                           // interior width
  assert.match(anno, /14'-0&quot;/);                           // interior depth
  assert.equal(annotationMarkup(floor, scene.meta, { roomId: 'nope' }), '');
});

test('scope: object annotations show width + position; extents include swing', async () => {
  const { annotationMarkup, scopeExtent } = await import('../src/core/udraft/svg.js');
  const scene = layoutDocument(parseDocument(HOUSE));
  const floor = scene.floors[0];
  const door = floor.openings[0];                              // living/kitchen at 2' from north
  const anno = annotationMarkup(floor, scene.meta, { entFrom: door.from });
  assert.match(anno, /2'-8&quot;/);                            // width
  assert.match(anno, /2'-0&quot;/);                            // offset from the north end
  const ext = scopeExtent(floor, { entFrom: door.from });
  // Door opens east: extent reaches into the kitchen by the leaf width.
  assert.ok(ext.w >= door.band[1] - door.band[0] + (door.hi - door.lo));
  // Room extent is its bbox.
  const rext = scopeExtent(floor, { roomId: 'living' });
  assert.deepEqual(rext, floor.rooms[0].bbox);
  // Scoped render embeds the annotations; exports never do.
  const { svg } = renderFloorSvg(floor, scene.meta, { interactive: true, scope: { roomId: 'living' } });
  assert.match(svg, /ud-anno/);
  assert.doesNotMatch(renderExportSvg(scene, 0), /ud-anno/);
});

test('scope: isolation renders one room + neighbour arrows, dims outside', () => {
  const scene = layoutDocument(parseDocument(HOUSE));
  const floor = scene.floors[0];
  const { svg } = renderFloorSvg(floor, scene.meta, {
    interactive: true, isolate: 'living', scope: { roomId: 'living' },
  });
  // Only the living room's furniture: the kitchen sink must NOT render.
  assert.doesNotMatch(svg, /ud-fixture/);
  // No room labels, no floor dims in isolation.
  assert.doesNotMatch(svg, /ud-roomlabel/);
  assert.doesNotMatch(svg, /class="ud-ent ud-dim"/);
  // Neighbour arrows to kitchen + hall, tappable as rooms.
  assert.match(svg, /ud-nbr[\s\S]*KITCHEN/);
  assert.match(svg, /ud-nbr[\s\S]*HALL/);
  assert.match(svg, /data-ent="room" data-room-id="kitchen"/);
  // Openings on the room's walls still draw (door to kitchen, front door, arch).
  assert.equal((svg.match(/ud-ent ud-door/g) || []).length, 2);
  // Exterior dims (scope annotations) are outside the north wall: the h-dim's
  // y must be less than the interior top (0).
  const dimLine = /<g class="ud-anno">.*?y1="(-[\d.]+)"/s.exec(svg);
  assert.ok(dimLine && parseFloat(dimLine[1]) < 0, 'room dims drawn outside');
});
