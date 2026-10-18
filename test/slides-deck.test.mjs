import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  preprocess, slideIndexAt, resolveAssets, referencedAssets, unreferencedAssets, pruneAssets,
  assetNameFor, uniqueAssetName, assetDataUri, parseDataUri, renderDeck, deckDocument, deckPrintDocument,
  THEME_NAMES,
} from '../src/core/slides/deck.js';

const PNG = { type: 'image/png', data: 'iVBORw0KGgo=' };
const SVG = { type: 'image/svg+xml', data: 'PHN2Zy8+' };

test('preprocess: --- and === separate slides, blank line inserted, fences + front matter untouched', () => {
  const src = '---\ntitle: T\ntheme: gaia\n---\n# One\ntext\n---\n# Two\n```\n---\n===\n```\n===\n# Three';
  const { text, slides } = preprocess(src);
  assert.equal(slides.length, 3);
  // A blank line now precedes the separator so `text\n---` is not a setext h2.
  assert.match(text, /text\n\n---\n# Two/);
  // Fenced separators are left alone; the === outside became ---.
  assert.match(text, /```\n---\n===\n```\n\n---\n# Three/);
  // Front matter is intact.
  assert.ok(text.startsWith('---\ntitle: T\ntheme: gaia\n---\n'));
  // Ranges cover the source contiguously; the front matter belongs to slide 0.
  assert.equal(slides[0].from, 0);
  assert.equal(src.slice(slides[1].from, slides[1].to), '# Two\n```\n---\n===\n```\n');
  assert.equal(src.slice(slides[2].from), '# Three');
  assert.equal(slideIndexAt(slides, 2), 0);
  assert.equal(slideIndexAt(slides, slides[1].from + 1), 1);
  assert.equal(slideIndexAt(slides, src.length + 50), 2);
});

test('preprocess: a deck with no separators is one slide; empty source is one empty slide', () => {
  assert.equal(preprocess('# Only').slides.length, 1);
  assert.deepEqual(preprocess('').slides, [{ from: 0, to: 0 }]);
});

test('asset names: sanitised, extension from MIME, unique', () => {
  assert.equal(assetNameFor('My Photo (1).PNG', 'image/png'), 'my-photo-1.png');
  assert.equal(assetNameFor('', 'image/jpeg'), 'image.jpg');
  assert.equal(assetNameFor('blob', 'image/svg+xml'), 'blob.svg');
  assert.equal(uniqueAssetName('a.png', { 'a.png': PNG }), 'a-2.png');
  assert.equal(uniqueAssetName('a.png', { 'a.png': PNG, 'a-2.png': PNG }), 'a-3.png');
  assert.deepEqual(parseDataUri(assetDataUri(SVG)), SVG);
});

test('resolveAssets: only stored names are substituted; bg / size options and titles survive', () => {
  const md = '![bg left:40%](cover.png)\n![w:200 "A title"](logo.svg) ![](https://x/y.png) ![](missing.png)';
  const out = resolveAssets(md, { 'cover.png': PNG, 'logo.svg': SVG });
  assert.match(out, /!\[bg left:40%\]\(data:image\/png;base64,iVBORw0KGgo=\)/);
  assert.match(out, /!\[w:200 "A title"\]\(data:image\/svg\+xml;base64,PHN2Zy8\+\)/);
  assert.match(out, /\(https:\/\/x\/y\.png\)/);
  assert.match(out, /\(missing\.png\)/);
  assert.deepEqual([...referencedAssets(md)].sort(), ['cover.png', 'https://x/y.png', 'logo.svg', 'missing.png']);
});

test('unreferencedAssets / pruneAssets keep anything any text (history included) mentions', () => {
  const assets = { 'a.png': PNG, 'b.png': PNG, 'c.svg': SVG };
  assert.deepEqual(unreferencedAssets(assets, ['![](a.png)', '{"patch":"+![](b.png)"}']), ['c.svg']);
  const kept = pruneAssets(assets, ['![](a.png)']);
  assert.deepEqual(Object.keys(kept), ['a.png']);
  assert.equal(pruneAssets(assets, ['a.png b.png c.svg']), assets);   // same object when nothing drops
});

test('renderDeck: one svg per slide, data-URI backgrounds, themes, directives, raw HTML escaped', () => {
  const src = `---
title: Hello
theme: gaia
paginate: true
---

<!-- _class: lead -->
# Title

![bg right](cover.png)

---

Second ![w:200](logo.svg) <b>raw</b>

===

# Third`;
  const { html, css, slides } = renderDeck(src, { assets: { 'cover.png': PNG, 'logo.svg': SVG } });
  assert.equal(slides.length, 3);
  assert.equal((html.match(/<svg data-marpit-svg/g) || []).length, 3);
  assert.match(html, /class="lead"/);
  assert.match(html, /background-image:url\(&quot;data:image\/png;base64,iVBORw0KGgo=&quot;\)/);
  assert.match(html, /<img src="data:image\/svg\+xml;base64,PHN2Zy8\+" alt="" style="width:200px;">/);
  assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);          // html: false
  assert.match(html, /data-marpit-pagination-total="3"/);
  assert.match(css, /@page/);
  assert.match(css, /Gaia theme/);
  assert.ok(!/@import\s+url\(https?:/.test(css), 'no web-font import (offline)');
});

test('themes: the three vendored Marp themes are registered', () => {
  assert.deepEqual(THEME_NAMES, ['default', 'gaia', 'uncover']);
  for (const theme of THEME_NAMES) {
    const { css } = renderDeck(`---\ntheme: ${theme}\n---\n# Hi`);
    assert.ok(css.length > 1000, theme);
  }
});

test('deckDocument / deckPrintDocument: standalone pages carry the css, the slides and the title', () => {
  const deck = renderDeck('# A\n\n---\n\n# B');
  const page = deckDocument({ ...deck, title: 'My <deck>' });
  assert.match(page, /<title>My &lt;deck&gt;<\/title>/);
  assert.match(page, /body\.present/);
  assert.match(page, /<script>/);
  assert.equal((page.match(/<svg data-marpit-svg/g) || []).length, 2);
  const print = deckPrintDocument({ ...deck, title: 'P' });
  assert.match(print, /break-after: page/);
  assert.ok(!/<script>/.test(print));
});
