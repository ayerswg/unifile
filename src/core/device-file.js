/**
 * Device files — the one implementation of Save / Open from device that every
 * shell (the standard app, {write}, {draft}) calls.
 *
 * SAVE writes the document's text — just the DSL, nothing else — out of the
 * browser sandbox as `<apiName>-<version>.uni`: one NEW file per save, the
 * version counting up (core/library.js `nextVersion`).  By capability:
 *   • File System Access (Chromium): the folder is picked once ("where do this
 *     document's versions go?"), its handle is kept on the library record, and
 *     every later save lands in it silently (after a permission check that
 *     may prompt — only inside a user gesture, which a save always is).  If
 *     the folder picker refuses, a per-file save picker is used instead;
 *   • the OS share sheet (iOS): "Save to Files";
 *   • a download (everything else).
 * The snapshot that goes with the save (the commit tagged with the version)
 * is the caller's: the device write comes FIRST so a cancelled save burns no
 * version number and leaves no snapshot behind.
 *
 * OPEN is the mirror image: a picked `.uni` (or an older `.unifile.json`,
 * text + history) becomes a new library document named after the file, or —
 * with no library (a quine) — replaces the open one.
 *
 * Nothing here touches the network.
 */

import {
  shareOrDownloadFile, canLinkDeviceFiles, canLinkDeviceFolders, pickDirectoryHandle,
  writeFileInDirectory, pickSaveHandle, pickOpenHandle, ensureHandleWritable, writeHandle,
  readHandle, pickFileInput,
} from './storage.js';
import {
  isUnifileData, versionFileName, parseVersionFileName, emptyData, normaliseData, suggestApiName,
} from './library.js';
import { VCS } from './vcs.js';

/**
 * Write one version of the document to the device.
 * @param {object} o
 * @param {import('./library.js').Library|null} o.library
 * @param {string|null} o.docId   the open document's record id (null in a quine)
 * @param {string} o.text         the document text (the whole file)
 * @param {string} o.apiName      the document's name
 * @param {string} o.version      the version this file carries ('A00' …)
 * @param {boolean} [o.mark=true] mark the record saved here; false when the
 *                                caller snapshots first and marks afterwards
 * @returns {Promise<{ result: 'linked'|'picked'|'shared'|'downloaded'|'cancelled'|'failed', fileName: string, handle: FileSystemDirectoryHandle|null, record: object|null, error?: Error }>}
 *   `record` is the library record marked saved at that version (PWA, with
 *   `mark`), else null; `handle` the folder the file went into, if any.
 */
export async function saveVersionToDevice({ library, docId, text, apiName, version, mark = true }) {
  const fileName = versionFileName(apiName, version);
  const rec = (library && docId) ? await library.get(docId) : null;
  const done = async (result, handle, extra = {}) => {
    const record = (mark && library && docId)
      ? await library.markSaved(docId, { fileName: extra.fileName ?? fileName, version, ...(handle !== undefined ? { handle } : {}) })
      : rec;
    return { result, fileName: extra.fileName ?? fileName, handle: handle ?? null, record };
  };

  if (typeof window !== 'undefined' && (canLinkDeviceFolders() || canLinkDeviceFiles())) {
    // 1. The document's folder — kept from an earlier save.
    let dir = rec?.handle?.kind === 'directory' ? rec.handle : null;
    if (dir && !(await ensureHandleWritable(dir, { request: true }))) dir = null;
    // 2. No folder yet: ask for one (once per document).
    let pickerBroken = false;
    if (!dir && canLinkDeviceFolders()) {
      try {
        dir = await pickDirectoryHandle();
        if (!dir) return { result: 'cancelled', fileName, handle: null, record: rec };
      } catch (e) {
        console.warn('[device-file] folder picker unavailable:', e);
        pickerBroken = true;
      }
    }
    if (dir) {
      try {
        await writeFileInDirectory(dir, fileName, text);
      } catch (error) {
        return { result: 'failed', fileName, handle: null, record: rec, error };
      }
      return done('linked', dir);
    }
    // 3. Folders are out: a save picker for this one file.
    if (!pickerBroken && canLinkDeviceFiles()) {
      try {
        const fh = await pickSaveHandle(fileName);
        if (!fh) return { result: 'cancelled', fileName, handle: null, record: rec };
        await writeHandle(fh, text);
        return done('picked', null, { fileName: fh.name ?? fileName });
      } catch (e) {
        // The API exists but the picker refused (no user activation, a
        // sandboxed/embedded context…): fall through to share / download.
        console.warn('[device-file] save picker unavailable:', e);
      }
    }
  }

  const result = await shareOrDownloadFile(text, fileName, 'text/plain');
  // 'cancelled' = the share sheet was dismissed before a target — the file
  // never left, so the record is not marked saved.
  if (result === 'cancelled') return { result, fileName, handle: null, record: rec };
  return done(result, undefined);
}

/**
 * Pick a document file on the device and read it.
 * @returns {Promise<{ text: string, data: object|null, apiName: string|null, version: string|null, fileName: string }|null>}
 *   `data` is set for an older `.unifile.json` (text + history); `apiName` /
 *   `version` are read off a `<name>-<version>.uni` file name.  Null when
 *   cancelled; throws on an unreadable file.
 */
export async function pickDocumentFromDevice({ library } = {}) {
  let text, fileName = null;
  let picked = false;
  if (library && canLinkDeviceFiles()) {
    try {
      const handle = await pickOpenHandle();
      if (!handle) return null;
      fileName = handle.name;
      text = await readHandle(handle);
      picked = true;
    } catch (e) {
      console.warn('[device-file] open picker unavailable:', e);
    }
  }
  if (!picked) {
    const file = await pickFileInput();
    if (!file) return null;
    fileName = file.name;
    text = await file.text();
  }
  return describePickedFile(text, fileName);
}

/**
 * What a picked file is: an older `.unifile.json` (→ `data`), else plain
 * text with the name / version read off the file name.  Pure.
 */
export function describePickedFile(text, fileName) {
  let data = null;
  if (/\.json$/i.test(fileName) || /^\s*\{/.test(text)) {
    try { const j = JSON.parse(text); if (isUnifileData(j)) data = j; } catch { /* plain text then */ }
  }
  if (data) {
    const base = String(fileName).replace(/\.unifile\.json$|\.json$/i, '');
    return { text: String(data.currentContent ?? ''), data, apiName: data.apiName ?? (suggestApiName(base) || null),
             version: data.savedVersion ?? null, fileName };
  }
  const parsed = parseVersionFileName(fileName);
  return { text: String(text ?? ''), data: null, apiName: parsed?.apiName ?? (suggestApiName(fileName.replace(/\.[^.]+$/, '')) || null),
           version: parsed?.version ?? null, fileName };
}

/**
 * The data object a picked file becomes: a `.uni` is one snapshot tagged with
 * its version (so the history starts where the file left off); an older
 * `.unifile.json` is loaded whole.  Pure apart from the commit hash.
 */
export async function dataFromPickedFile(app, picked, { author = 'anonymous', email = '' } = {}) {
  if (picked.data) {
    const d = normaliseData(picked.data, app);
    if (picked.apiName && !d.apiName) d.apiName = picked.apiName;
    return d;
  }
  const d = emptyData(app, { title: picked.apiName || 'Untitled' });
  d.apiName = picked.apiName ?? null;
  d.currentContent = picked.text;
  if (picked.version) {
    const vcs = new VCS(d);
    await vcs.commit({ content: picked.text, message: `Opened ${picked.fileName}`, author, email, tag: picked.version });
    Object.assign(d, vcs.serialize());
    d.savedVersion = picked.version;
  }
  return d;
}

/**
 * Add a picked file to the library: a record that already carries the same
 * name AND version is reopened instead of duplicated; else a new record is
 * created and, when the file carried a version, marked as the device state.
 * @returns {Promise<object>} the record to open
 */
export async function adoptDeviceDocument(library, picked, identity = {}) {
  if (picked.apiName) {
    const same = (await library.list()).find(r => r.apiName === picked.apiName
      && (picked.version ? r.version === picked.version : false)
      && (r.data?.currentContent ?? '') === picked.text);
    if (same) return same;
  }
  const data = await dataFromPickedFile(library.app, picked, identity);
  // A second document can't share a name (names are file names): the new one
  // starts unnamed and gets its own at its first save.
  if (data.apiName && !(await library.isApiNameFree(data.apiName))) { data.apiName = null; data.savedVersion = null; }
  const rec = await library.create(data, { fileName: picked.fileName });
  return data.savedVersion ? library.markSaved(rec.id, { version: data.savedVersion, fileName: picked.fileName }) : rec;
}
