// ============================================================
// Codex Assistant — Encrypted API Key Storage
// ============================================================
// Uses AES-256-GCM with PBKDF2 key derivation.
// Master key derived from PROXY_AUTH_KEY ensures that even if
// provider-configs.json is leaked, the upstream API keys remain
// protected without the master key.
// ============================================================

import crypto from 'node:crypto';

var ALGORITHM = 'aes-256-gcm';
var KEY_LENGTH = 32;
var IV_LENGTH = 16;
var TAG_LENGTH = 16;
var SALT_LENGTH = 32;
var PBKDF2_ITERATIONS = 100000;
var PBKDF2_DIGEST = 'sha256';

// ---- PBKDF2 key derivation ----

function deriveKey(masterKey, salt) {
  return crypto.pbkdf2Sync(
    Buffer.from(masterKey, 'utf8'),
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

// ---- Encrypt ----

export function encryptApiKey(plaintext, masterKey) {
  if (!plaintext || !masterKey) {
    throw new Error('encryptApiKey: plaintext and masterKey are required');
  }
  var salt = crypto.randomBytes(SALT_LENGTH);
  var iv = crypto.randomBytes(IV_LENGTH);
  var key = deriveKey(masterKey, salt);

  var cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  var encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  var tag = cipher.getAuthTag();

  // Format: salt(32) || iv(16) || tag(16) || ciphertext
  var combined = Buffer.concat([salt, iv, tag, encrypted]);
  return combined.toString('base64');
}

// ---- Decrypt ----

export function decryptApiKey(encryptedBase64, masterKey) {
  if (!encryptedBase64 || !masterKey) {
    throw new Error('decryptApiKey: encryptedBase64 and masterKey are required');
  }
  var combined;
  try {
    combined = Buffer.from(encryptedBase64, 'base64');
  } catch (e) {
    throw new Error('decryptApiKey: invalid base64 input');
  }

  if (combined.length <= SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('decryptApiKey: ciphertext too short');
  }

  var salt = combined.subarray(0, SALT_LENGTH);
  var iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  var tag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + TAG_LENGTH
  );
  var ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  var key = deriveKey(masterKey, salt);
  var decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8');
}

// ---- Detection helpers ----

var ENCRYPTED_PREFIX = 'CAENC:';
var ENCRYPTED_PREFIX_LEN = ENCRYPTED_PREFIX.length;

// Check if a string is already encrypted (has our prefix).
export function isEncrypted(data) {
  if (!data || typeof data !== 'string') return false;
  return data.startsWith(ENCRYPTED_PREFIX);
}

// Encrypt and add prefix marker so we can detect encrypted values.
export function encryptApiKeyWithPrefix(plaintext, masterKey) {
  return ENCRYPTED_PREFIX + encryptApiKey(plaintext, masterKey);
}

// Decrypt: auto-detect whether the value is encrypted or plaintext.
// Returns { key, wasEncrypted }.
// - If value has prefix and decryption succeeds → return decrypted key
// - If value has prefix but decryption fails → return null (master key changed)
// - If value has no prefix → return as-is (legacy plaintext)
export function tryDecryptApiKey(value, masterKey) {
  if (!value || !masterKey) return { key: value, wasEncrypted: false };

  if (!isEncrypted(value)) {
    return { key: value, wasEncrypted: false };
  }

  try {
    var encrypted = value.substring(ENCRYPTED_PREFIX_LEN);
    var decrypted = decryptApiKey(encrypted, masterKey);
    return { key: decrypted, wasEncrypted: true };
  } catch (e) {
    // Master key changed or data corrupted
    return { key: null, wasEncrypted: true, error: e.message };
  }
}

// Automatically migrate plaintext keys to encrypted format.
// Returns the updated providers array.
export function migrateToEncrypted(providers, masterKey) {
  if (!masterKey) return providers;
  var changed = false;
  var result = providers.map(function(p) {
    if (!p.api_key || isEncrypted(p.api_key)) return p;
    changed = true;
    var encrypted = encryptApiKeyWithPrefix(p.api_key, masterKey);
    return Object.assign({}, p, { api_key: encrypted });
  });
  return changed ? result : providers;
}
