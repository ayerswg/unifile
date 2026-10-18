import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePickedFile, dataFromPickedFile, adoptDeviceDocument } from '../src/core/device-file.js';
import { Library, memoryStore, memoryPrefs, emptyData } from '../src/core/library.js';
import { VCS } from '../src/core/vcs.js';

test('describePickedFile: a .uni carries its name + version in the file name', () => {
  const p = describePickedFile('X:1\nK:C\nCDEF|', 'tune-A02.uni');
  assert.deepEqual(p, { text: 'X:1\nK:C\nCDEF|', data: null, apiName: 'tune', version: 'A02', fileName: 'tune-A02.uni' });
  const q = describePickedFile('hello', 'My Notes.txt');
  assert.equal(q.apiName, 'My-Notes');
  assert.equal(q.version, null);
});

test('describePickedFile: an older .unifile.json loads whole', () => {
  const json = JSON.stringify({ title: 'Old', currentContent: 'body', commits: {}, branches: { main: { name: 'main', head: null } } });
  const p = describePickedFile(json, 'old.unifile.json');
  assert.equal(p.text, 'body');
  assert.equal(p.data.title, 'Old');
  assert.equal(p.apiName, 'old');
  assert.equal(p.version, null);
  // JSON that is not a unifile file is plain text
  const t = describePickedFile('{"a":1}', 'thing.json');
  assert.equal(t.data, null);
  assert.equal(t.text, '{"a":1}');
});

test('dataFromPickedFile: a versioned .uni starts its history at that version', async () => {
  const d = await dataFromPickedFile('abcjs', describePickedFile('X:1\nK:C\nCDEF|', 'tune-A02.uni'));
  assert.equal(d.dslType, 'abcjs');
  assert.equal(d.apiName, 'tune');
  assert.equal(d.savedVersion, 'A02');
  assert.equal(d.currentContent, 'X:1\nK:C\nCDEF|');
  const vcs = new VCS(d);
  assert.equal(vcs.log().length, 1);
  assert.equal(vcs.log()[0].tag, 'A02');
  assert.equal(vcs.headContent, 'X:1\nK:C\nCDEF|');
  // no version → no snapshot, just the text
  const e = await dataFromPickedFile('markdown', describePickedFile('hi', 'notes.uni'));
  assert.equal(e.savedVersion, undefined);
  assert.equal(new VCS(e).log().length, 0);
  assert.equal(e.title, 'notes');
});

test('adoptDeviceDocument: new record, marked saved; same file reopens; name clashes start unnamed', async () => {
  const L = new Library(memoryStore(), { app: 'markdown', prefs: memoryPrefs() });
  const picked = describePickedFile('hello', 'notes-A01.uni');
  const r = await adoptDeviceDocument(L, picked);
  assert.equal(r.apiName, 'notes');
  assert.equal(r.version, 'A01');
  assert.equal(r.fileName, 'notes-A01.uni');
  assert.ok(r.savedAt);
  // opening the very same file again → the same record
  const again = await adoptDeviceDocument(L, picked);
  assert.equal(again.id, r.id);
  // a later version of the same name is a different file: the name is taken,
  // so the new record starts unnamed
  const r2 = await adoptDeviceDocument(L, describePickedFile('hello again', 'notes-A02.uni'));
  assert.notEqual(r2.id, r.id);
  assert.equal(r2.apiName, null);
  assert.equal(r2.version, null);
  assert.equal(r2.data.currentContent, 'hello again');
  assert.equal((await L.list()).length, 2);
  // an unnamed .txt gets a suggested name when free
  const r3 = await adoptDeviceDocument(L, describePickedFile('x', 'Shopping list.txt'));
  assert.equal(r3.apiName, 'Shopping-list');
  assert.equal(r3.savedAt, null);
});

test('saveVersionToDevice: a kept folder is written into silently; the picker is asked once', async () => {
  const written = {};
  let picks = 0;
  class FakeDir {
    constructor() { this.kind = 'directory'; this.name = 'Versions'; }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async getFileHandle(name) { return { kind: 'file', name, createWritable: async () => ({ write: async (t) => { written[name] = t; }, close: async () => {} }) }; }
  }
  globalThis.window = {
    showDirectoryPicker: async () => { picks++; return new FakeDir(); },
    showSaveFilePicker: async () => { throw new Error('should not be used'); },
    showOpenFilePicker: async () => null,
  };
  try {
    const { saveVersionToDevice } = await import('../src/core/device-file.js');
    const L = new Library(memoryStore(), { app: 'markdown', prefs: memoryPrefs() });
    const rec = await L.create(emptyData('markdown', { title: 'A', extra: { apiName: 'a' } }));
    // memoryStore JSON-clones records, which would drop the handle's methods —
    // keep the handle alive the way IndexedDB keeps a real FileSystemHandle.
    const live = new Map();
    const put = L.store.put.bind(L.store), get = L.store.get.bind(L.store);
    L.store.put = async (r) => { if (r.handle) live.set(r.id, r.handle); return put(r); };
    L.store.get = async (id) => { const r = await get(id); if (r && live.has(id)) r.handle = live.get(id); return r; };

    const r1 = await saveVersionToDevice({ library: L, docId: rec.id, text: 'one', apiName: 'a', version: 'A00' });
    assert.equal(r1.result, 'linked');
    assert.equal(r1.fileName, 'a-A00.uni');
    assert.equal(written['a-A00.uni'], 'one');
    assert.equal(r1.record.version, 'A00');
    assert.equal(r1.record.handle.kind, 'directory');
    assert.equal(picks, 1);
    // the next version lands in the same folder without asking
    const r2 = await saveVersionToDevice({ library: L, docId: rec.id, text: 'two', apiName: 'a', version: 'A01', mark: false });
    assert.equal(r2.result, 'linked');
    assert.equal(written['a-A01.uni'], 'two');
    assert.equal(picks, 1);
    assert.equal(r2.record.version, 'A00');       // mark:false left the record alone
    assert.equal(r2.handle.kind, 'directory');
    // a cancelled folder pick writes nothing and marks nothing
    const M = new Library(memoryStore(), { app: 'markdown', prefs: memoryPrefs() });
    const other = await M.create(emptyData('markdown', { title: 'B' }));
    globalThis.window.showDirectoryPicker = async () => null;
    const r3 = await saveVersionToDevice({ library: M, docId: other.id, text: 'x', apiName: 'b', version: 'A00' });
    assert.equal(r3.result, 'cancelled');
    assert.equal(written['b-A00.uni'], undefined);
    assert.equal((await M.get(other.id)).savedAt, null);
  } finally {
    delete globalThis.window;
  }
});
