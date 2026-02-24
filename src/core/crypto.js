/**
 * Password protection for unifile documents.
 *
 * Uses the Web Crypto API:
 *   - PBKDF2 to derive a key from the password
 *   - AES-GCM to encrypt/decrypt the commits and content
 *
 * The encrypted payload replaces the `commits` and `branches` fields
 * in the data object with a single `encrypted` field.
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;  // bytes
const IV_LENGTH = 12;    // bytes for AES-GCM

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt the sensitive parts of unifile data with a password.
 *
 * @param {object} data  – full unifile data object
 * @param {string} password
 * @returns {Promise<object>} – data with commits/branches replaced by `encrypted`
 */
export async function encryptData(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(password, salt);

  const sensitive = { commits: data.commits, branches: data.branches };
  const plaintext = new TextEncoder().encode(JSON.stringify(sensitive));

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const result = { ...data };
  delete result.commits;
  delete result.branches;
  result.encrypted = {
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext)
  };
  return result;
}

/**
 * Decrypt the `encrypted` field in unifile data.
 *
 * @param {object} data   – unifile data with `encrypted` field
 * @param {string} password
 * @returns {Promise<object>} – fully decrypted data
 * @throws if password is wrong
 */
export async function decryptData(data, password) {
  if (!data.encrypted) throw new Error('Data is not encrypted');

  const salt = fromBase64(data.encrypted.salt);
  const iv = fromBase64(data.encrypted.iv);
  const ciphertext = fromBase64(data.encrypted.ciphertext);
  const key = await deriveKey(password, salt);

  let plaintext;
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    plaintext = new TextDecoder().decode(decrypted);
  } catch {
    throw new Error('Incorrect password or corrupted data');
  }

  const sensitive = JSON.parse(plaintext);
  const result = { ...data };
  delete result.encrypted;
  result.commits = sensitive.commits;
  result.branches = sensitive.branches;
  return result;
}

/**
 * Check whether a data object is password-protected.
 * @param {object} data
 * @returns {boolean}
 */
export function isEncrypted(data) {
  return Boolean(data.encrypted);
}

/**
 * Change the password on an already-decrypted data object.
 * Pass null as newPassword to remove protection.
 *
 * @param {object} decryptedData
 * @param {string|null} newPassword
 * @returns {Promise<object>}
 */
export async function changePassword(decryptedData, newPassword) {
  if (!newPassword) {
    // Remove encryption flag
    const result = { ...decryptedData };
    result.password = null;
    return result;
  }
  const encrypted = await encryptData(decryptedData, newPassword);
  encrypted.password = true; // sentinel so the app knows to prompt
  return encrypted;
}
