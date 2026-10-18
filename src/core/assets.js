/**
 * Document assets — images (any binary, really) stored in `data.assets` as
 * `{ name: { type, data } }` (base64), OUTSIDE the versioned text, and
 * referenced from it by bare name: `![alt](photo.png)`.  Pure + Node-tested;
 * no Marpit / DOM here so the standard shell (app.js) can prune assets at
 * save time in every build without bundling the deck engine.
 */

/** `data:<type>;base64,<data>` for a stored asset `{ type, data }`. */
export function assetDataUri(asset) {
  if (!asset || !asset.data) return '';
  return `data:${asset.type || 'application/octet-stream'};base64,${asset.data}`;
}

/** Split a `data:` URL into the stored asset shape `{ type, data }` (null if not base64). */
export function parseDataUri(uri) {
  const m = /^data:([^;,]+)(;[^,]*)?;base64,(.*)$/s.exec(uri || '');
  if (!m) return null;
  return { type: m[1], data: m[3] };
}

/**
 * A safe asset name from a file name: lower-cased, spaces → `-`, anything
 * outside `[a-z0-9._-]` dropped, an extension guaranteed from the MIME type.
 */
export function assetNameFor(fileName, mime = '') {
  const extOf = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
                  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
  let base = String(fileName || '').split(/[\\/]/).pop().trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '');
  base = base.replace(/^[.-]+/, '');
  if (!base) base = 'image';
  const wantExt = extOf[mime];
  if (wantExt && !/\.[a-z0-9]+$/.test(base)) base += `.${wantExt}`;
  return base;
}

/** `photo.png` → `photo-2.png`, … until the name is free in `assets`. */
export function uniqueAssetName(name, assets = {}) {
  if (!Object.prototype.hasOwnProperty.call(assets, name)) return name;
  const m = /^(.*?)(\.[a-z0-9]+)?$/i.exec(name);
  const stem = m[1], ext = m[2] || '';
  for (let i = 2; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!Object.prototype.hasOwnProperty.call(assets, cand)) return cand;
  }
}

// `![alt](target …)` — the target up to whitespace / `)`, so a trailing
// `"title"` survives.  `<target>` (angle form) is not supported for assets.
const IMG_RE = /(!\[[^\]]*\]\()\s*([^)\s"']+)/g;

/**
 * Asset names referenced by image syntax anywhere in `text` (fence-blind:
 * a name in a code block counts as referenced — that only ever keeps an
 * asset alive, never drops one).
 */
export function referencedAssets(text) {
  const names = new Set();
  for (const m of String(text || '').matchAll(IMG_RE)) names.add(m[2]);
  return names;
}

/** Substitute every `![…](name)` whose name is a stored asset with its data URI. */
export function resolveAssets(text, assets) {
  if (!assets || !Object.keys(assets).length) return text;
  return text.replace(IMG_RE, (whole, open, target) =>
    Object.prototype.hasOwnProperty.call(assets, target) ? `${open}${assetDataUri(assets[target])}` : whole);
}

/**
 * The subset of `assets` no `texts` entry references.  Used at save time to
 * drop images whose every `![…](name)` was deleted — the commit history is
 * passed in serialized, so an image any commit still mentions is kept.
 */
export function unreferencedAssets(assets, texts) {
  const out = [];
  if (!assets) return out;
  const names = Object.keys(assets);
  if (!names.length) return out;
  const joined = (texts || []).map(t => String(t || '')).join('\n');
  for (const name of names) if (!joined.includes(name)) out.push(name);
  return out;
}

/** `assets` minus the unreferenced ones (same object when nothing changes). */
export function pruneAssets(assets, texts) {
  const drop = unreferencedAssets(assets, texts);
  if (!drop.length) return assets;
  const kept = { ...assets };
  for (const n of drop) delete kept[n];
  return kept;
}

