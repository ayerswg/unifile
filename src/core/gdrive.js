/**
 * Google Drive sync (single file).
 *
 * Pushes/pulls the document's `.unifile.json` to ONE Drive file, directly from
 * the browser — unifile.app (static hosting) never sees the data or the token.
 *
 * Auth: Google Identity Services token client (OAuth2), scope `drive.file`, so
 * the app can only touch files IT created/opened — not your whole Drive.
 *
 * Constraints: works on an https origin only (not file://); needs a Google
 * OAuth client ID (set in Settings) whose authorized origin matches this site.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE   = 'https://www.googleapis.com/auth/drive.file';

let _gisLoad = null;       // Promise<void> for the GIS script
let _accessToken = null;   // current OAuth access token (in-memory only)
let _tokenExpiry = 0;      // epoch ms

/** Drive sync needs an https origin (OAuth won't work from file://). */
export function isDriveSupported() {
  return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

export function isConnected() {
  return !!_accessToken && Date.now() < _tokenExpiry - 30_000;
}

function _loadGis() {
  if (_gisLoad) return _gisLoad;
  _gisLoad = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = GIS_SRC; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in (network/CSP).'));
    document.head.appendChild(s);
  });
  return _gisLoad;
}

/** Request (or refresh) an access token via the OAuth popup. */
export async function connect(clientId, { interactive = true } = {}) {
  if (!clientId) throw new Error('No Google OAuth client ID set (Settings → Sync).');
  await _loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        _accessToken = resp.access_token;
        _tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) * 1000);
        resolve(_accessToken);
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google sign-in was cancelled.')),
    });
    client.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

async function _token(clientId) {
  if (isConnected()) return _accessToken;
  return connect(clientId);
}

/**
 * Create (no fileId) or update (with fileId) the Drive file. Returns the fileId.
 * @returns {Promise<string>}
 */
export async function push({ clientId, fileId, name, content }) {
  const token = await _token(clientId);
  const auth = { Authorization: 'Bearer ' + token };

  if (fileId) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
      { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: content }
    );
    if (!res.ok) throw new Error(`Drive update failed (${res.status})`);
    return fileId;
  }

  const boundary = 'uf' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType: 'application/json' }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    content + `\r\n--${boundary}--`;
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    { method: 'POST', headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
  );
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
  return (await res.json()).id;
}

/** Download the file's content as text. */
export async function pull({ clientId, fileId }) {
  const token = await _token(clientId);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return res.text();
}

/** List app-created .unifile.json files (drive.file scope only sees those). */
export async function listAppFiles({ clientId }) {
  const token = await _token(clientId);
  const q = encodeURIComponent("mimeType='application/json' and trashed=false");
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  return (await res.json()).files ?? [];
}
