import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNote, splitBlocks, maskCode, normKey, slugify, sectionRange, blockAt, newBlockId, resolveDateMention,
} from '../src/core/notes/parse.js';
import { buildIndex } from '../src/core/notes/index.js';
import { parseQuery, searchIndex, highlightRanges, fuzzyMatch, snippetAround, markText } from '../src/core/notes/search.js';
import { ForceSim, layout, seededRandom } from '../src/core/notes/graph.js';
import {
  renderNote, renderProperties, renderBacklinks, renderInline, toggleTaskAt, blockIdEdit, noteDocument,
} from '../src/core/notes/render.js';

const WORKSPACE = [
  { id: 'a', title: 'Project Alpha', apiName: 'alpha', updatedAt: 3000,
    text: '---\ntitle: Project Alpha\ntags: work, planning\nstatus: active\naliases: Alpha\n---\n# Goals\n\nShip the thing with [[Meeting Notes]] and [[Research#Findings]]. #work\n\n- [ ] write the spec ^spec\n- [x] pick a name\n\n> [!tip] Remember\n> Talk to [[Dana]].\n\n```\n[[Not A Link]] #nottag\n```\n\n## Timeline\n\nDue @2026-11-01.\n\n![[Research#^key]]\n' },
  { id: 'b', title: 'Meeting Notes', apiName: 'meetings', updatedAt: 2000,
    text: 'Weekly sync about Project Alpha and [[Project Alpha|the project]].\n\nAlso [[Research]] came up. #work/meetings\n\nSee [[Research#^key]] for the key result.\n' },
  { id: 'c', title: 'Research', apiName: 'research', updatedAt: 1000,
    text: '# Findings\n\nThe key result: 42. ^key\n\nMore prose about project alpha in lower case.\n\n# Method\n\nWe read [[Alpha]] carefully. [[Nowhere]] is missing.\n' },
];

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

test('parse: links, aliases, headings, blocks, tags, dates — not inside code', () => {
  const n = parseNote(WORKSPACE[0].text);
  assert.equal(n.title, 'Project Alpha');
  assert.deepEqual(n.aliases, ['Alpha']);
  assert.deepEqual(n.properties.map(([k]) => k), ['tags', 'status']);
  assert.deepEqual(n.links.map(l => [l.target, l.heading, l.block, l.embed]), [
    ['Meeting Notes', null, null, false], ['Research', 'Findings', null, false], ['Dana', null, null, false], ['Research', null, 'key', true],
  ]);
  // the link in the code fence is not a link, the tag in it not a tag
  assert.ok(!n.links.some(l => l.target === 'Not A Link'));
  const tags = n.tags.map(t => t.tag);
  assert.deepEqual(tags, ['work', 'planning', 'work']);     // two from the property, one inline
  assert.equal(n.tags[2].property, undefined);
  assert.equal(WORKSPACE[0].text.slice(n.tags[2].from, n.tags[2].to), '#work');
  assert.deepEqual(n.headings.map(h => [h.text, h.slug, h.level]), [['Goals', 'goals', 1], ['Timeline', 'timeline', 2]]);
  assert.equal(n.blockIds.spec, 2);
  assert.equal(n.blocks[2].type, 'list');
  assert.equal(n.blocks[2].text, '- [ ] write the spec ^spec');
  assert.equal(n.blocks[3].text, '- [x] pick a name');
  assert.deepEqual(n.dates.map(d => d.value), ['2026-11-01']);
  // every link offset points at its text
  for (const l of n.links) assert.equal(WORKSPACE[0].text.slice(l.from, l.to), l.text);
});

test('parse: block splitting — fences, quotes, lists, tables, embeds, rules', () => {
  const src = '```js\n\na\n```\n> q1\n> q2\n\n| a | b |\n|---|---|\n\n![[X#^y]]\n\n---\n\npara one\npara one cont ^p1\n1. one\n   more\n2. two\n';
  const b = splitBlocks(src);
  assert.deepEqual(b.map(x => x.type), ['code', 'quote', 'table', 'embed', 'rule', 'paragraph', 'list', 'list']);
  assert.equal(b[5].id, 'p1');
  assert.equal(b[6].text, '1. one\n   more');
  for (const x of b) assert.equal(src.slice(x.from, x.to), x.text);
});

test('parse: helpers', () => {
  assert.equal(normKey('  Project_Alpha  '), 'project alpha');
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(maskCode('a `[[x]]` b').includes('[['), false);
  const n = parseNote(WORKSPACE[2].text);
  const s = sectionRange(n, 'Findings');
  assert.equal(WORKSPACE[2].text.slice(s.from, s.to), '# Findings\n\nThe key result: 42. ^key\n\nMore prose about project alpha in lower case.');
  assert.equal(blockAt(n.blocks, s.from + 2), 0);
  assert.match(newBlockId(seededRandom(1)), /^[0-9a-z]{6}$/);
  assert.equal(resolveDateMention('tomorrow', new Date(2026, 9, 31)), '2026-11-01');
  assert.equal(resolveDateMention('2026-01-02'), '2026-01-02');
});

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('index: resolution by title, alias and name; backlinks per block; unlinked mentions skip links', () => {
  const idx = buildIndex(WORKSPACE);
  assert.equal(idx.resolve('project alpha').id, 'a');
  assert.equal(idx.resolve('Alpha').id, 'a');          // alias
  assert.equal(idx.resolve('meetings').id, 'b');       // apiName
  assert.equal(idx.resolve('Nowhere'), null);
  const back = idx.backlinks('a');
  assert.deepEqual(back.map(b => [b.page.id, b.block.text]), [
    ['b', 'Weekly sync about Project Alpha and [[Project Alpha|the project]].'],
    ['c', 'We read [[Alpha]] carefully. [[Nowhere]] is missing.'],
  ]);
  const ment = idx.unlinkedMentions('a');
  // "Project Alpha" in b's first block is also linked there: the plain mention counts, the link does not.
  assert.deepEqual(ment.map(m => [m.page.id, m.matches.length]), [['b', 1], ['c', 1]]);
  assert.equal(WORKSPACE[1].text.slice(ment[0].matches[0].from, ment[0].matches[0].to), 'Project Alpha');
  // refs: block, section, page
  const ref = idx.resolveRef({ target: 'Research', block: 'key' });
  assert.equal(ref.kind, 'block');
  assert.equal(WORKSPACE[2].text.slice(ref.from, ref.to), 'The key result: 42. ^key');
  assert.equal(idx.resolveRef({ target: 'Research', heading: 'Method' }).kind, 'section');
  assert.equal(idx.resolveRef({ target: 'Research', heading: 'Nope' }), null);
  assert.equal(idx.resolveRef({ target: 'Research' }).kind, 'page');
  // tags
  assert.deepEqual(idx.tagList().map(t => t.tag), ['work', 'planning', 'work/meetings']);   // uses, then name
  assert.deepEqual(idx.pagesWithTag('work').sort(), ['a', 'b']);
  assert.deepEqual(idx.outlinks('b').map(o => o.page?.id ?? null), ['a', 'c', 'c']);
});

test('index: graph — pages, tags, missing targets, local neighbourhood', () => {
  const idx = buildIndex(WORKSPACE);
  const g = idx.graph();
  const ids = g.nodes.map(n => n.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'missing:dana', 'missing:nowhere', 'tag:planning', 'tag:work', 'tag:work/meetings']);
  const edge = (x, y) => g.edges.some(e => (e.source === x && e.target === y) || (e.source === y && e.target === x));
  assert.ok(edge('a', 'b') && edge('a', 'c') && edge('b', 'c') && edge('a', 'missing:dana') && edge('a', 'tag:work'));
  assert.equal(g.edges.filter(e => e.source === 'b' && e.target === 'c').length, 1);   // deduped
  const local = idx.graph({ center: 'c', depth: 1, tags: false, missing: false });
  assert.deepEqual(local.nodes.map(n => n.id).sort(), ['a', 'b', 'c']);
  const plain = idx.graph({ tags: false, missing: false });
  assert.deepEqual(plain.nodes.map(n => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(plain.nodes.find(n => n.id === 'a').degree, 2);
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

test('search: query grammar, ranking, snippets, fuzzy titles, tags, recent', () => {
  const idx = buildIndex(WORKSPACE);
  assert.deepEqual(parseQuery('alpha "key result" #work title:notes'), {
    terms: ['alpha'], phrases: ['key result'], tags: ['work'], title: ['notes'], all: ['alpha', 'key result', 'notes'],
  });
  let r = searchIndex(idx, 'alpha');
  assert.equal(r[0].page.id, 'a');                       // title match ranks first
  assert.deepEqual(r[0].titleMarks, [[8, 13]]);
  assert.ok(r.some(x => x.page.id === 'c'));              // body match "project alpha"
  const c = r.find(x => x.page.id === 'c');
  assert.equal(c.hits[0].heading, 'Findings');
  assert.ok(c.hits[0].snippet.includes('project alpha'));
  assert.deepEqual(c.hits[0].marks.map(([a, b]) => c.hits[0].snippet.slice(a, b)), ['alpha']);

  r = searchIndex(idx, '"key result"');
  assert.deepEqual(r.map(x => x.page.id), ['b', 'c']);              // equal scores: newest first
  r = searchIndex(idx, '#work');
  assert.deepEqual(r.map(x => x.page.id).sort(), ['a', 'b']);
  r = searchIndex(idx, '#work alpha');
  assert.deepEqual(r.map(x => x.page.id), ['a', 'b']);
  r = searchIndex(idx, 'mtng');                          // fuzzy title
  assert.equal(r[0].page.id, 'b');
  assert.equal(r[0].titleMarks.reduce((n, [a, b]) => n + b - a, 0), 4);   // m·t·n·g (n,g merge)
  r = searchIndex(idx, '');
  assert.deepEqual(r.map(x => x.page.id), ['a', 'b', 'c']);    // recent
  assert.equal(r[0].reason, 'recent');
  r = searchIndex(idx, 'zzzz');
  assert.equal(r.length, 0);
  assert.deepEqual(highlightRanges('Alpha alpha ALPHA', ['alpha']), [[0, 5], [6, 11], [12, 17]]);
  assert.deepEqual(highlightRanges('abcabc', ['ab', 'bc']), [[0, 6]]);          // touching ranges merge
  assert.deepEqual(fuzzyMatch('nts', 'Notes'), [0, 2, 4]);
  const sn = snippetAround('one two three four five six seven eight nine ten eleven twelve', 24, 4, ['five'], 8);
  assert.ok(sn.snippet.startsWith('…') && sn.snippet.includes('five'));
  assert.equal(markText('a b a', [[0, 1], [4, 5]], s => s), '<mark>a</mark> b <mark>a</mark>');
});

// ---------------------------------------------------------------------------
// graph layout
// ---------------------------------------------------------------------------

test('graph: the force layout settles, is deterministic, keeps linked nodes closer', () => {
  const idx = buildIndex(WORKSPACE);
  const g = idx.graph();
  const s1 = layout(g, { width: 600, height: 400, seed: 3 });
  const s2 = layout(g, { width: 600, height: 400, seed: 3 });
  assert.ok(s1.settled);
  for (const n of s1.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  assert.deepEqual([...s1.positions()], [...s2.positions()]);
  const p = s1.positions();
  const d = (x, y) => Math.hypot(p.get(x).x - p.get(y).x, p.get(x).y - p.get(y).y);
  assert.ok(d('a', 'b') < d('tag:planning', 'missing:nowhere'));
  // no two nodes on the same point
  const nodes = s1.nodes;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) > 5);
  // remembered positions: a re-layout starts warm and ends near where it was
  const s3 = new ForceSim(g, { width: 600, height: 400, positions: p });
  assert.ok(s3.alpha <= 0.3);
  assert.equal(s3.nodeAt(p.get('a').x, p.get('a').y).id, 'a');
  assert.deepEqual([...s3.neighbours('c')].sort(), ['a', 'b', 'missing:nowhere']);
  const b = s1.bounds();
  assert.ok(b.w > 0 && b.h > 0);
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

test('render: blocks carry offsets; links, embeds, tags, dates, ids, callouts, tasks', () => {
  const idx = buildIndex(WORKSPACE);
  const page = idx.page('a');
  const { html, blocks } = renderNote(page.text, { index: idx, pageId: 'a', bodyFrom: page.note.bodyFrom, now: new Date(2026, 9, 24) });
  assert.equal(blocks.length, 8);                       // marked's list is ONE token
  for (const b of blocks) assert.equal(page.text.slice(b.from, b.to), page.text.slice(b.from, b.to).trimEnd());
  assert.match(html, /<h1 id="goals">Goals<\/h1>/);
  assert.match(html, /<a class="nb-link" href="#" title="Meeting Notes" data-target="Meeting Notes" data-page="b" data-from="\d+" data-to="\d+"><span class="nb-link-mark">⊛<\/span>Meeting Notes<\/a>/);
  assert.match(html, /data-target="Research" data-page="c" data-heading="Findings"[^>]*>(<span[^>]*>⊛<\/span>)Research › Findings</);
  assert.match(html, /class="nb-link is-missing"[^>]*data-target="Dana"/);
  assert.match(html, /<a class="nb-tag" href="#" data-tag="work">#work<\/a>/);
  assert.match(html, /<time class="nb-date" datetime="2026-11-01">Nov 1, 2026<\/time>/);
  assert.match(html, /<span class="nb-id" data-block-id="spec"/);
  assert.match(html, /<button type="button" class="nb-check" role="checkbox"/);
  assert.match(html, /<button type="button" class="nb-check is-checked"/);
  assert.match(html, /<div class="nb-callout nb-callout-tip"><div class="nb-callout-head"><span class="nb-callout-icon">✦<\/span><span class="nb-callout-title">Remember<\/span><\/div><div class="nb-callout-body"><p>Talk to <a class="nb-link is-missing"/);
  // the embed renders Research's block in place, with the source crumb
  assert.match(html, /<div class="nb-embed" data-page="c" data-from="\d+" data-to="\d+"><div class="nb-embed-head"><span class="nb-embed-crumb">Research › \^key<\/span>/);
  assert.match(html, /nb-embed-body"><p>The key result: 42\. <span class="nb-id" data-block-id="key"/);
  // the code fence is left alone
  assert.match(html, /<code>\[\[Not A Link\]\] #nottag\n<\/code>/);
  // the text of a code block is not a block id
  assert.doesNotMatch(html, /data-doc-from="0"/);
  // a block's data range round-trips to its source
  const m = /<div class="nb nb-heading" data-doc-from="(\d+)" data-doc-to="(\d+)">/.exec(html);
  assert.equal(page.text.slice(+m[1], +m[2]), '# Goals');
});

test('render: toggles, properties, backlinks, mentions, cycle guard, helpers', () => {
  const idx = buildIndex(WORKSPACE);
  const t = renderNote('> [!toggle] More\n> hidden text\n', { index: idx, pageId: 'a' });
  assert.match(t.html, /<details class="nb-toggle"><summary>More<\/summary><div class="nb-toggle-body"><p>hidden text<\/p>/);
  const props = renderProperties(idx.page('a').note, { index: idx, pageId: 'a' });
  assert.match(props, /<th>tags<\/th><td><a class="nb-tag" href="#" data-tag="work">#work<\/a> <a class="nb-tag" href="#" data-tag="planning">#planning<\/a><\/td>/);
  assert.match(props, /<th>status<\/th><td>active<\/td>/);
  const back = renderBacklinks(idx, 'a');
  assert.match(back, /2 linked references/);
  assert.match(back, /<a class="nb-ref-page" href="#" data-page="b">/);
  assert.match(back, /<div class="nb-ref" data-page="c" data-from="\d+" data-to="\d+" role="link" tabindex="0"><p>We read <a class="nb-link" href="#" title="Project Alpha" data-target="Alpha" data-page="a"/);
  assert.match(back, /<summary>2 unlinked mentions<\/summary>/);
  assert.match(back, /<mark class="nb-mention">Project Alpha<\/mark>/);
  assert.match(renderBacklinks(idx, 'c'), /4 linked references/);
  assert.match(renderBacklinks(buildIndex([{ id: 'x', title: 'Lone', text: 'alone' }]), 'x'), /No linked references/);
  // an embed of itself stops
  const cyc = buildIndex([{ id: 'p', title: 'P', text: 'text ^b\n\n![[P#^b]]\n\n![[P]]\n' }]);
  const r = renderNote(cyc.page('p').text, { index: cyc, pageId: 'p' });
  assert.match(r.html, /nb-embed-body"><p>text/);
  assert.match(r.html, /is-cycle/);
  assert.equal(renderInline('see [[P]]', { index: cyc, pageId: 'p' }).includes('data-page="p"'), true);
  // helpers
  const text = '- [ ] a\n- [x] b\n';
  assert.deepEqual(toggleTaskAt(text, 0, text.length, 0), { from: 3, to: 4, insert: 'x' });
  assert.deepEqual(toggleTaskAt(text, 0, text.length, 1), { from: 11, to: 12, insert: ' ' });
  assert.deepEqual(blockIdEdit('para\n\nsecond line', 8, 'abc123'), { from: 17, to: 17, insert: ' ^abc123', id: 'abc123' });
  assert.equal(blockIdEdit('para ^old', 1, 'x').id, 'old');
  assert.equal(blockIdEdit('```\ncode\n```', 5, 'x'), null);
  assert.match(noteDocument({ title: 'T <1>', bodyHtml: '<p>x</p>' }), /<title>T &lt;1&gt;<\/title>[\s\S]*<h1 class="nb-title">T &lt;1&gt;<\/h1><p>x<\/p>/);
});
