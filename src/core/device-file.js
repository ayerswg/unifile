/**
 * Device files — the one implementation of "Save to device" / "Open from
 * device" that every shell (the standard app, {write}, {draft}) calls.
 *
 * A device file is the document's `.unifile.json` (text + full history,
 * comments, assets) written OUT of the browser sandbox, by capability:
 *   • File System Access (Chromium): picked once, the handle is kept on the
 *     library record, and later saves write to it silently (after a
 *     permission check that may prompt — only inside a user gesture);
 *   • the OS share sheet (iOS): "Save to Files";
 *   • a download (everything else).
 * Opening is the mirror image: a picked file becomes a new library document
 * (linked on Chromium), or — with no library (a quine) — replaces the open one.
 *
 * Nothing here touches the network.
 */

import {
  shareOrDownloadFile, canLinkDeviceFiles, pickSaveHandle, pickOpenHandle,
  ensureHandleWritable, writeHandle, readHandle, pickFileInput,
} from './storage.js';
import { isUnifileData, deviceFileName } from './library.js';

/**
 * Write the document to the device.
 * @param {object} o
 * @param {import('./library.js').Library|null} o.library
 * @param {string|null} o.docId   the open document's record id (null in a quine)
 * @param {object} o.data         the current data object
 * @param {string} o.title
 * @returns {Promise<{ result: 'linked'|'shared'|'downloaded'|'cancelled'|'failed', record: object|null, error?: Error }>}
 */
export async function saveDocumentToDevice({ library, docId, data, title }) {
  const json = JSON.stringify(data, null, 2);
  const name = deviceFileName(title);

  if (library && docId && canLinkDeviceFiles()) {
    const rec = await library.get(docId);
    let handle = rec?.handle ?? null;
    if (handle && !(await ensureHandleWritable(handle, { request: true }))) handle = null;
    let pickerBroken = false;
    if (!handle) {
      try {
        handle = await pickSaveHandle(rec?.fileName ?? name);
        if (!handle) return { result: 'cancelled', record: rec };
      } catch (e) {
        // The API exists but the picker refused (no user activation, a
        // sandboxed/embedded context…): fall through to share / download.
        console.warn('[device-file] save picker unavailable:', e);
        pickerBroken = true;
      }
    }
    if (!pickerBroken) {
      try {
        await writeHandle(handle, json);
      } catch (error) {
        return { result: 'failed', record: rec, error };
      }
      const record = await library.markSaved(docId, { handle, fileName: handle.name ?? name });
      return { result: 'linked', record };
    }
  }

  const result = await shareOrDownloadFile(json, name, 'application/json');
  // 'cancelled' = the share sheet was dismissed before a target — the data
  // never left, so the record is not marked saved.
  let record = null;
  if (result !== 'cancelled' && library && docId) record = await library.markSaved(docId, { fileName: name });
  return { result, record };
}

/**
 * Write through an already-linked handle (after a Save, so the file follows
 * the history).  Never prompts unless `request` is set; false when there is
 * no link or no permission.
 */
export async function writeLinkedFile({ library, docId, data, request = false }) {
  if (!library || !docId) return null;
  const rec = await library.get(docId);
  if (!rec?.handle) return null;
  if (!(await ensureHandleWritable(rec.handle, { request }))) return null;
  try {
    await writeHandle(rec.handle, JSON.stringify(data, null, 2));
    return library.markSaved(docId);
  } catch (e) {
    console.warn('[device-file] write failed:', e);
    return null;
  }
}

/**
 * Pick a `.unifile.json` on the device and read it.
 * @returns {Promise<{ data: object, handle: FileSystemFileHandle|null, fileName: string }|null>}
 *   null when cancelled; throws on an unreadable / non-unifile file.
 */
export async function pickDocumentFromDevice({ library } = {}) {
  let text, handle = null, fileName = null;
  let picked = false;
  if (library && canLinkDeviceFiles()) {
    try {
      handle = await pickOpenHandle();
      if (!handle) return null;
      fileName = handle.name;
      text = await readHandle(handle);
      picked = true;
    } catch (e) {
      console.warn('[device-file] open picker unavailable:', e);
      handle = null;
    }
  }
  if (!picked) {
    const file = await pickFileInput();
    if (!file) return null;
    fileName = file.name;
    text = await file.text();
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!isUnifileData(data)) throw new Error('That doesn’t look like a unifile data file.');
  return { data, handle, fileName };
}

/**
 * Add a picked file to the library: the record already linked to the same
 * file is returned instead of a duplicate (Chromium handles compare), else a
 * new record is created, linked and marked as the device state.
 * @returns {Promise<object>} the record to open
 */
export async function adoptDeviceDocument(library, { data, handle, fileName }) {
  if (handle?.isSameEntry) {
    for (const r of await library.list()) {
      if (r.handle && await r.handle.isSameEntry(handle).catch(() => false)) return r;
    }
  }
  const rec = await library.create(data, { handle, fileName });
  return library.markSaved(rec.id);
}
