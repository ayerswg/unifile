import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Library, memoryStore, memoryPrefs, makeRecord, emptyData, normaliseData,
  excerptOf, stateKey, isSavedToDevice, isUnifileData, sortRecords, deviceFileName, newId,
} from '../src/core/library.js';

const tick = () => { let t = 1000; return () => (t += 1); };

function lib(app = 'markdown', initial = []) {
  return new Library(memoryStore(initial), { app, prefs: memoryPrefs(), now: tick() });
}

test('excerptOf skips front matter, blank lines and shebangs', () => {
  assert.equal(excerptOf('---\ntitle: x\n---\n\n#!abc\n\n# Hello\nworld'), '# Hello world');
  assert.equal(excerptOf(''), '');
  const long = 'a '.repeat(200);
  assert.ok(excerptOf(long).length <= 120);
  assert.ok(excerptOf(long).endsWith('…'));
});

test('stateKey changes with the text, the title and the head', () => {
  const d = emptyData('markdown');
  const k0 = stateKey(d);
  assert.notEqual(k0, stateKey({ ...d, currentContent: 'x' }));
  assert.notEqual(k0, stateKey({ ...d, title: 'Other' }));
  assert.notEqual(k0, stateKey({ ...d, branches: { main: { name: 'main', head: 'abc' } } }));
  assert.equal(k0, stateKey({ ...d }));
});

test('normaliseData reattaches a detached head and seeds missing fields', () => {
  const d = normaliseData({ detachedHead: 'h1', currentContent: 'kept' }, 'upub');
  assert.equal(d.detachedHead, null);
  assert.equal(d.currentContent, 'kept');
  assert.equal(d.currentBranch, 'main');
  assert.deepEqual(d.commits, {});
  assert.equal(d.dslType, 'upub');
  // an unknown currentBranch falls back to an existing one
  const e = normaliseData({ currentBranch: 'gone', branches: { dev: { name: 'dev', head: null } } });
  assert.equal(e.currentBranch, 'dev');
});

test('isUnifileData recognises data files only', () => {
  assert.ok(isUnifileData({ commits: {} }));
  assert.ok(isUnifileData({ currentContent: '' }));
  assert.ok(!isUnifileData({ foo: 1 }));
  assert.ok(!isUnifileData(null));
  assert.ok(!isUnifileData([1]));
});

test('makeRecord derives title + excerpt and starts unsaved', () => {
  const r = makeRecord('abcjs', { title: 'Tune', currentContent: 'X:1\nK:C\nCDEF|' }, { id: 'd_1', now: 5 });
  assert.equal(r.id, 'd_1');
  assert.equal(r.app, 'abcjs');
  assert.equal(r.title, 'Tune');
  assert.equal(r.excerpt, 'X:1 K:C CDEF|');
  assert.equal(r.createdAt, 5);
  assert.equal(r.savedAt, null);
  assert.ok(!isSavedToDevice(r));
});

test('create / list / get / save / remove, scoped per app', async () => {
  const L = lib('markdown');
  const a = await L.create(emptyData('markdown', { title: 'A' }));
  const b = await L.create(emptyData('markdown', { title: 'B' }));
  // another app's document in the same store is invisible here
  await L.store.put(makeRecord('upub', emptyData('upub', { title: 'W' })));
  const list = await L.list();
  assert.deepEqual(list.map(r => r.title), ['B', 'A']);   // newest first

  const saved = await L.save(a.id, { data: { ...a.data, title: 'A2', currentContent: 'hello\nworld' } });
  assert.equal(saved.title, 'A2');
  assert.equal(saved.excerpt, 'hello world');
  assert.ok(saved.updatedAt > b.updatedAt);
  assert.deepEqual((await L.list()).map(r => r.title), ['A2', 'B']);

  const renamed = await L.save(b.id, { title: 'B2' });
  assert.equal(renamed.data.title, 'B2');

  await L.remove(a.id);
  assert.equal(await L.get(a.id), null);
  assert.deepEqual((await L.list()).map(r => r.title), ['B2']);
  await assert.rejects(L.save('nope', { title: 'x' }));
});

test('markSaved records the device state without counting as an edit', async () => {
  const L = lib();
  const a = await L.create(emptyData('markdown', { title: 'A' }));
  const edited = await L.save(a.id, { data: { ...a.data, currentContent: 'v1' } });
  const m = await L.markSaved(a.id, { fileName: 'a.unifile.json' });
  assert.equal(m.fileName, 'a.unifile.json');
  assert.ok(m.savedAt);
  assert.equal(m.updatedAt, edited.updatedAt);
  assert.ok(isSavedToDevice(m));
  // any further edit makes it unsaved again
  const e2 = await L.save(a.id, { data: { ...m.data, currentContent: 'v2' } });
  assert.ok(!isSavedToDevice(e2));
});

test('currentId pointer + resolveCurrent fall back to the newest document', async () => {
  const L = lib();
  assert.equal(await L.resolveCurrent(), null);
  const a = await L.create(emptyData('markdown', { title: 'A' }));
  const b = await L.create(emptyData('markdown', { title: 'B' }));
  assert.equal((await L.resolveCurrent()).id, b.id);
  L.currentId = a.id;
  assert.equal((await L.resolveCurrent()).id, a.id);
  await L.remove(a.id);
  assert.equal(L.currentId, null);
  assert.equal((await L.resolveCurrent()).id, b.id);
});

test('duplicate copies the history under "<title> copy"', async () => {
  const L = lib();
  const a = await L.create({ ...emptyData('markdown', { title: 'A' }), commits: { h: { hash: 'h' } }, currentContent: 'txt' });
  const c = await L.duplicate(a.id);
  assert.equal(c.title, 'A copy');
  assert.deepEqual(c.data.commits, { h: { hash: 'h' } });
  assert.notEqual(c.id, a.id);
  c.data.commits.h.hash = 'changed';
  assert.equal((await L.get(a.id)).data.commits.h.hash, 'h');
});

test('migrateLegacy imports the old single document once, preferring a newer draft', async () => {
  const L = lib('markdown');
  const legacy = { title: 'Old', dslType: 'markdown', branches: { main: { name: 'main', head: null } }, commits: {}, currentContent: 'committed' };
  const r = await L.migrateLegacy({ data: legacy, draftContent: 'draft text' });
  assert.ok(r);
  assert.equal(r.data.currentContent, 'draft text');
  assert.equal(L.currentId, r.id);
  // second call is a no-op
  assert.equal(await L.migrateLegacy({ data: legacy }), null);
  assert.equal((await L.list()).length, 1);
  // garbage is ignored
  const M = lib('mermaid');
  assert.equal(await M.migrateLegacy({ data: { nope: 1 } }), null);
  assert.equal(await M.migrateLegacy({ data: null }), null);
});

test('sortRecords, deviceFileName and newId', () => {
  const s = sortRecords([{ id: 1, updatedAt: 1 }, { id: 2, updatedAt: 3 }, { id: 3 }]);
  assert.deepEqual(s.map(r => r.id), [2, 1, 3]);
  assert.equal(deviceFileName('My Tune: #1!'), 'My-Tune-1.unifile.json');
  assert.equal(deviceFileName(''), 'untitled.unifile.json');
  assert.match(newId(), /^d_[0-9a-z]+$/);
  assert.notEqual(newId(), newId());
});
