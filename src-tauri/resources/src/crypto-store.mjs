// ============================================================
// Codex Assistant — Encrypted API Key Storage
// ============================================================
// Uses AES-256-GCM with PBKDF2 key derivation.
// Master key is derived from the machine's hardware fingerprint
// (Windows MachineGuid) so it is independent of PROXY_AUTH_KEY.
// If the hardware changes, encrypted keys become unreadable.
// ============================================================

import crypto from 'node:crypto';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';

var ALGORITHM = 'aes-256-gcm';
var KEY_LENGTH = 32;
var IV_LENGTH = 16;
var TAG_LENGTH = 16;
var SALT_LENGTH = 32;
var PBKDF2_ITERATIONS = 100000;
var PBKDF2_DIGEST = 'sha256';

// ---- Machine fingerprint ----

var _cachedMachineKey = null;

function getMachineFingerprint() {
  // 方法1：使用 execFileSync 直接调用 reg.exe（避免 shell 转义问题）
  try {
    var result = execFileSync(
      'reg.exe',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    var match = result.match(/MachineGuid\s+REG_SZ\s+([0-9a-f\-]+)/i);
    if (match && match[1]) return match[1];
  } catch (e) {
    // Fall through to method 2
  }
  
  // 方法2：使用 PowerShell（更可靠的路径处理）
  try {
    var psResult = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 
       'try { (Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography" -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { "" }'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    var guid = (psResult || '').trim();
    if (guid && /^[0-9a-f\-]+$/i.test(guid)) return guid;
  } catch (e) {
    // Fall through to fallback
  }
  
  // 方法3：回退到 hostname + username（最后的备选方案）
  var fallback = (os.hostname() || 'unknown') + '|' + ((os.userInfo() || {}).username || 'unknown');
  return fallback;
}

export function getMachineKey() {
  if (_cachedMachineKey) return _cachedMachineKey;
  var fingerprint = getMachineFingerprint();
  // Static extra salt to ensure deterministic key per machine
  var STATIC_SALT = Buffer.from('CA::MachineKey::2025::Static', 'utf8');
  _cachedMachineKey = crypto.pbkdf2Sync(
    Buffer.from(fingerprint, 'utf8'),
    STATIC_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
  return _cachedMachineKey;
}

// ---- PBKDF2 key derivation ----

function deriveKey(masterKeyBuf, salt) {
  return crypto.pbkdf2Sync(
    masterKeyBuf,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

// ---- Key normalisation (supports Buffer from machine key or string from legacy) ----

function normaliseKey(masterKey) {
  if (Buffer.isBuffer(masterKey)) return masterKey;
  return Buffer.from(masterKey, 'utf8');
}

// ---- Encrypt ----

export function encryptApiKey(plaintext, masterKey) {
  if (!plaintext || !masterKey) {
    throw new Error('encryptApiKey: plaintext and masterKey are required');
  }
  var salt = crypto.randomBytes(SALT_LENGTH);
  var iv = crypto.randomBytes(IV_LENGTH);
  var key = deriveKey(normaliseKey(masterKey), salt);

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

  var key = deriveKey(normaliseKey(masterKey), salt);
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

// ---- Machine-key migration ----
// Attempt to migrate providers encrypted with an old master key (PROXY_AUTH_KEY)
// to the new machine-based key. Returns the updated providers array.
// Providers that fail decryption with the old key are left as-is.
// Returns { providers, migrated: number, skipped: number, failed: number }

export function migrateProvidersToMachineKey(providers, oldMasterKey) {
  var machineKey = getMachineKey();
  if (!oldMasterKey || !machineKey) {
    return { providers: providers, migrated: 0, skipped: providers.length, failed: 0 };
  }

  var migrated = 0;
  var skipped = 0;
  var failed = 0;

  var result = providers.map(function(p) {
    if (!p.api_key) {
      skipped++;
      return p;
    }

    // Already encrypted with machine key? Try to decrypt first
    var testMachine = tryDecryptApiKey(p.api_key, machineKey);
    if (testMachine.key !== null && testMachine.wasEncrypted) {
      skipped++;  // Already using machine key
      return p;
    }

    // Try to decrypt with old key
    var decResult = tryDecryptApiKey(p.api_key, oldMasterKey);
    if (decResult.key === null) {
      if (decResult.wasEncrypted) {
        failed++;
        console.error('[crypto] Migration: cannot decrypt [' + p.name + '] with old master key');
      } else {
        skipped++;  // Plaintext, will be encrypted by writeProviders later
      }
      return p;
    }

    // Re-encrypt with machine key
    try {
      var reEncrypted = encryptApiKeyWithPrefix(decResult.key, machineKey);
      migrated++;
      console.log('[crypto] Migration: re-encrypted [' + p.name + '] to machine key');
      return Object.assign({}, p, { api_key: reEncrypted });
    } catch (e) {
      failed++;
      console.error('[crypto] Migration: failed to re-encrypt [' + p.name + ']:', e.message);
      return p;
    }
  });

  return { providers: result, migrated: migrated, skipped: skipped, failed: failed };
}
