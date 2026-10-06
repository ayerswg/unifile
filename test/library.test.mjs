import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Library, memoryStore, memoryPrefs, makeRecord, emptyData, normaliseData,
  excerptOf, stateKey, isSavedToDevice, isUnifileData, sortRecords, deviceFileName, newId,
  isValidApiName, suggestApiName, parseVersion, formatVersion, nextVersion, cmpVersion,
  versionFileName, parseVersionFileName, searchRecords,
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

test('markSaved records the device state + version without counting as an edit', async () => {
  const L = lib();
  const a = await L.create(emptyData('markdown', { title: 'A' }));
  const edited = await L.save(a.id, { data: { ...a.data, currentContent: 'v1' } });
  const m = await L.markSaved(a.id, { fileName: 'a-A00.uni', version: 'A00', handle: { kind: 'directory' } });
  assert.equal(m.fileName, 'a-A00.uni');
  assert.equal(m.version, 'A00');
  assert.equal(m.data.savedVersion, 'A00');
  assert.ok(m.savedAt);
  assert.equal(m.updatedAt, edited.updatedAt);
  assert.ok(isSavedToDevice(m));
  // any further edit makes it unsaved again, and keeps the version
  const e2 = await L.save(a.id, { data: { ...m.data, currentContent: 'v2' } });
  assert.ok(!isSavedToDevice(e2));
  assert.equal(e2.version, 'A00');
  assert.equal(e2.data.savedVersion, 'A00');
  // a plain markSaved (no version) keeps the last one
  const m2 = await L.markSaved(a.id, { fileName: 'a-A01.uni', version: 'A01' });
  assert.equal(m2.version, 'A01');
  assert.ok(isSavedToDevice(m2));
});

test('the name is set once (genesis or first save) and never moves', async () => {
  const L = lib();
  const a = await L.create(emptyData('markdown', { title: 'A' }));
  assert.equal(a.apiName, null);
  assert.ok(await L.isApiNameFree('notes'));
  const named = await L.setApiName(a.id, 'notes');
  assert.equal(named.apiName, 'notes');
  assert.equal(named.data.apiName, 'notes');
  assert.equal(named.updatedAt, a.updatedAt);
  assert.ok(!(await L.isApiNameFree('Notes')));
  assert.ok(await L.isApiNameFree('notes', { exceptId: a.id }));
  await assert.rejects(L.setApiName(a.id, 'other'));
  await assert.rejects(L.setApiName((await L.create()).id, 'bad name!'));
  // a data write can't rename it either
  const s = await L.save(a.id, { data: { ...named.data, apiName: 'other', currentContent: 'x' } });
  assert.equal(s.apiName, 'notes');
  assert.equal(s.data.apiName, 'notes');
  // genesis: a record created with a name keeps it
  const b = await L.create(emptyData('markdown', { title: 'B', extra: { apiName: 'b-doc' } }));
  assert.equal(b.apiName, 'b-doc');
  // a duplicate starts unnamed and unversioned
  const m = await L.markSaved(b.id, { version: 'A00', fileName: 'b-doc-A00.uni' });
  const c = await L.duplicate(m.id);
  assert.equal(c.apiName, null);
  assert.equal(c.version, null);
  assert.equal(c.title, 'B copy');
});

test('names: validation and suggestions', () => {
  for (const ok of ['a', 'notes', 'my-doc', 'v2.1_final', 'A-b-c', 'x'.repeat(64)]) assert.ok(isValidApiName(ok), ok);
  for (const bad of ['', ' ', 'my doc', 'a-', '-a', 'a--b', 'a/b', 'é', 'x'.repeat(65), null]) assert.ok(!isValidApiName(bad), String(bad));
  assert.equal(suggestApiName('My Tune: #1!'), 'My-Tune-1');
  assert.equal(suggestApiName('  spaced   out  '), 'spaced-out');
  assert.equal(suggestApiName('!!!'), '');
  assert.equal(suggestApiName('---a---'), 'a');
});

test('versions: A00 … Z99, minor and major bumps, the ceiling', () => {
  assert.deepEqual(parseVersion('A00'), { major: 0, minor: 0 });
  assert.deepEqual(parseVersion('B07'), { major: 1, minor: 7 });
  assert.equal(parseVersion('a07'), null);
  assert.equal(parseVersion('A7'), null);
  assert.equal(parseVersion('AA7'), null);
  assert.equal(formatVersion({ major: 25, minor: 99 }), 'Z99');
  assert.equal(nextVersion(null), 'A00');
  assert.equal(nextVersion(undefined), 'A00');
  assert.equal(nextVersion('garbage'), 'A00');
  assert.equal(nextVersion('A00'), 'A01');
  assert.equal(nextVersion('A09'), 'A10');
  assert.equal(nextVersion('A99'), 'B00');
  assert.equal(nextVersion('A03', { major: true }), 'B00');
  assert.equal(nextVersion(null, { major: true }), 'A00');
  assert.equal(nextVersion('Z99'), null);
  assert.equal(nextVersion('Z03', { major: true }), null);
  assert.equal(nextVersion('Z98'), 'Z99');
  assert.ok(cmpVersion('B00', 'A99') > 0);
  assert.ok(cmpVersion('A01', 'A02') < 0);
  assert.equal(cmpVersion('A01', 'A01'), 0);
});

test('file names: <name>-<version>.uni both ways', () => {
  assert.equal(versionFileName('report', 'A03'), 'report-A03.uni');
  assert.deepEqual(parseVersionFileName('report-A03.uni'), { apiName: 'report', version: 'A03' });
  assert.deepEqual(parseVersionFileName('/tmp/my-doc-B10.uni'), { apiName: 'my-doc', version: 'B10' });
  assert.deepEqual(parseVersionFileName('my-doc-b10.UNI'), { apiName: 'my-doc', version: 'B10' });
  assert.deepEqual(parseVersionFileName('notes.uni'), { apiName: 'notes', version: null });
  assert.deepEqual(parseVersionFileName('notes.txt'), { apiName: 'notes', version: null });
  assert.deepEqual(parseVersionFileName('notes'), { apiName: 'notes', version: null });
  assert.equal(parseVersionFileName('weird name.uni'), null);
  assert.equal(parseVersionFileName(''), null);
});

test('searchRecords: names, titles and contextual content hits', () => {
  const recs = [
    { id: 1, apiName: 'recipes', title: 'Dinner', updatedAt: 1, data: { currentContent: 'Soup\n\nAdd the carrots.\nCarrots again, and more carrots.\nDone' } },
    { id: 2, apiName: 'carrot-farm', title: 'Farm', updatedAt: 2, data: { currentContent: 'nothing here' } },
    { id: 3, apiName: 'other', title: 'Other', updatedAt: 3, data: { currentContent: 'x' } },
  ];
  // empty query: everything, no hits
  assert.equal(searchRecords(recs, '  ').length, 3);
  assert.deepEqual(searchRecords(recs, '').map(r => r.hits), [[], [], []]);
  const res = searchRecords(recs, 'carrot');
  assert.deepEqual(res.map(r => r.record.id), [2, 1]);      // a name match ranks first
  assert.ok(res[0].nameMatch && res[0].hits.length === 0);
  const hits = res[1].hits;
  assert.equal(hits.length, 2);                             // one hit per line
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].from, 'Soup\n\nAdd the '.length);
  assert.equal(hits[0].to, hits[0].from + 'carrot'.length);
  assert.equal(hits[0].snippet, 'Add the carrots.');
  assert.equal(hits[0].snippet.slice(hits[0].matchStart, hits[0].matchEnd), 'carrot');
  assert.equal(hits[1].line, 4);
  assert.equal(hits[1].snippet.slice(hits[1].matchStart, hits[1].matchEnd), 'Carrot');
  // long lines are trimmed around the match
  const long = [{ id: 9, data: { currentContent: 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100) } }];
  const h = searchRecords(long, 'needle', { ctx: 10 })[0].hits[0];
  assert.equal(h.snippet, '…' + 'a'.repeat(10) + 'NEEDLE' + 'b'.repeat(10) + '…');
  assert.equal(h.snippet.slice(h.matchStart, h.matchEnd), 'NEEDLE');
  assert.equal(searchRecords(recs, 'zzz').length, 0);
  // maxHits caps the per-document hits
  assert.equal(searchRecords(recs, 'carrot', { maxHits: 1 })[1].hits.length, 1);
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
  assert.equal(deviceFileName('My Tune: #1!'), 'My-Tune-1-A00.uni');
  assert.equal(deviceFileName('', 'B02'), 'untitled-B02.uni');
  assert.match(newId(), /^d_[0-9a-z]+$/);
  assert.notEqual(newId(), newId());
});
