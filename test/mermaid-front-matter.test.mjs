import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mermaidFrontMatterLines, prepareMermaidSource } from '../src/core/mermaid-front-matter.js';

test('forwards config + displayMode blocks with their nested lines, nothing else', () => {
  const yaml = [
    'title: My diagram',
    'model: flow',
    'config:',
    '  look: handDrawn',
    '  theme: forest',
    '  flowchart:',
    '    curve: basis',
    '',
    'layout: webpage',
    'displayMode: compact',
    'author: me',
  ].join('\n');
  assert.deepEqual(mermaidFrontMatterLines(yaml), [
    'config:',
    '  look: handDrawn',
    '  theme: forest',
    '  flowchart:',
    '    curve: basis',
    'displayMode: compact',
  ]);
});

test('inline-map config and CRLF line endings', () => {
  assert.deepEqual(mermaidFrontMatterLines('title: x\r\nconfig: { layout: elk, look: neo }\r\n'),
    ['config: { layout: elk, look: neo }']);
});

test('a bare body with a document front matter gets a mermaid block in front', () => {
  const r = prepareMermaidSource('flowchart LR\n  A --> B', 'title: T\nconfig:\n  look: handDrawn');
  assert.equal(r.source, '---\nconfig:\n  look: handDrawn\n---\nflowchart LR\n  A --> B');
  assert.equal(r.body, 'flowchart LR\n  A --> B');
  assert.equal(r.prefixLines, 4);
});

test('no mermaid keys → the body is passed through untouched', () => {
  const r = prepareMermaidSource('pie\n  "a": 1', 'title: T\nmodel: flow');
  assert.deepEqual(r, { source: 'pie\n  "a": 1', body: 'pie\n  "a": 1', prefixLines: 0 });
  assert.deepEqual(prepareMermaidSource('graph TD', null), { source: 'graph TD', body: 'graph TD', prefixLines: 0 });
});

test('a full document (exports) has its own block stripped and forwarded; title never reaches mermaid', () => {
  const doc = '---\ntitle: Hand drawn\nconfig:\n  layout: elk\n---\nflowchart LR\n  A --> B\n';
  const r = prepareMermaidSource(doc, 'config:\n  look: classic');   // the doc arg is ignored
  assert.equal(r.source, '---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A --> B\n');
  assert.equal(r.body, 'flowchart LR\n  A --> B\n');
  assert.equal(r.prefixLines, 4);
  assert.ok(!r.source.includes('title'));
});
