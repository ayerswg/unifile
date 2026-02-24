/**
 * Cryptographic hashing for commit IDs.
 * Uses SubtleCrypto (SHA-256) in all modern browsers.
 */

/**
 * Compute a SHA-256 hash of a string and return it as a hex string.
 * @param {string} message
 * @returns {Promise<string>} 64-char hex string
 */
export async function sha256(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive a commit hash from the commit's canonical fields.
 * @param {object} fields - { parent, message, author, email, timestamp, patch }
 * @returns {Promise<string>}
 */
export async function commitHash(fields) {
  const canonical = JSON.stringify({
    parent: fields.parent ?? null,
    message: fields.message,
    author: fields.author,
    email: fields.email,
    timestamp: fields.timestamp,
    patch: fields.patch ?? null
  });
  return sha256(canonical);
}

/**
 * Return the short (12-char) form of a hash for display.
 * @param {string|null} hash
 * @returns {string}
 */
export function shortHash(hash) {
  if (!hash) return '(none)';
  return hash.slice(0, 7);
}
