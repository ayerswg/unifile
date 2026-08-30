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
