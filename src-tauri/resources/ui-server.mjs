import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { spawn, exec, execFile, execSync, execFileSync } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'url';
import {
  stripEndpointSuffix, normalizeModelsUrl, buildModelCandidateUrls,
  requestModelsOnce, fetchModelsFromAPI, readJsonBody
} from './src/shared.mjs';
import {
  isEncrypted, encryptApiKeyWithPrefix, tryDecryptApiKey,
  migrateToEncrypted, getMachineKey, migrateProvidersToMachineKey
} from './src/crypto-store.mjs';
import { initOperationLogger, logOperation, readOperationLogs } from './src/operation-logger.mjs';

var UI_PORT = parseInt(process.env.UI_PORT, 10) || 8788;
var PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Detect installed vs portable: installed version has resources/ subdirectory
var IS_INSTALLED = fs.existsSync(path.join(PROJECT_DIR, 'resources'));
var APP_DATA_BASE = IS_INSTALLED
  ? (process.env.APPDATA || process.env.USERPROFILE || PROJECT_DIR)
  : PROJECT_DIR;
var USER_DIR = path.join(APP_DATA_BASE, IS_INSTALLED ? 'CodexAssistant' : '', 'user');
var CODEXPP_CONFIG_FILE = path.join(USER_DIR, 'codexpp-config.json');
var CODEX_CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
var CODEX_MARKER = '# Modified by Codex Assistant';
var CODEX_DIVIDER = '# ============================================';
var CODEX_RESTORE_HINT = '# 替换去掉注释，即可恢复初始配置';

// ==================== CSRF Protection ====================
var CSRF_TOKEN = crypto.randomBytes(32).toString('hex');

function getAllowedUiOrigins() {
  return [
    'http://127.0.0.1:' + UI_PORT,
    'http://localhost:' + UI_PORT
  ];
}

function validateRequestOrigin(req, res) {
  var allowedOrigins = getAllowedUiOrigins();
  var origin = String(req.headers.origin || '');
  var referer = String(req.headers.referer || '');
  var host = String(req.headers.host || '').toLowerCase();
  var expectedHosts = [
    '127.0.0.1:' + UI_PORT,
    'localhost:' + UI_PORT
  ];

  if (expectedHosts.indexOf(host) === -1) {
    sendJson(res, 403, { error: 'Invalid Host header' });
    return false;
  }

  if (origin) {
    if (allowedOrigins.indexOf(origin) === -1) {
      sendJson(res, 403, { error: 'Invalid Origin header' });
      return false;
    }
  } else if (referer) {
    try {
      var refererUrl = new URL(referer);
      if (allowedOrigins.indexOf(refererUrl.origin) === -1) {
        sendJson(res, 403, { error: 'Invalid Referer header' });
        return false;
      }
    } catch (e) {
      sendJson(res, 403, { error: 'Invalid Referer header' });
      return false;
    }
  }

  return true;
}

function validateCsrf(req, res) {
  if (!validateRequestOrigin(req, res)) {
    return false;
  }
  var token = req.headers['x-csrf-token'] || '';
  // Use timing-safe comparison to prevent timing attacks
  try {
    if (!token || token.length !== CSRF_TOKEN.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(CSRF_TOKEN))) {
      sendJson(res, 403, { error: 'CSRF token invalid or missing' });
      return false;
    }
  } catch {
    sendJson(res, 403, { error: 'CSRF token invalid or missing' });
    return false;
  }
  return true;
}

let proxyProcess = null;
let proxyLog = [];
const PROXY_LOG_MAX = 2000; // 内存缓冲区上限
const PROXY_LOG_DIR = path.join(APP_DATA_BASE, IS_INSTALLED ? 'CodexAssistant' : '', 'log');
let currentProxyLogFile = null; // 本次会话代理日志文件，重启后自动刷新

function getCurrentProxyLogFile() {
  // 只返回当前会话的日志文件（最近 2 分钟内有修改），不读取旧会话日志
  if (!currentProxyLogFile) {
    try {
      if (!fs.existsSync(PROXY_LOG_DIR)) return null;
      var now = Date.now();
      var TWO_MIN = 2 * 60 * 1000;
      var files = fs.readdirSync(PROXY_LOG_DIR)
        .filter(function(f) { return /^proxy.*\.log$/i.test(f); })
        .map(function(f) {
          var fullPath = path.join(PROXY_LOG_DIR, f);
          var st = fs.statSync(fullPath);
          return { name: f, path: fullPath, mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort(function(a, b) { return b.mtimeMs - a.mtimeMs; });
      var recent = files.find(function(f) { return (now - f.mtimeMs) < TWO_MIN; });
      currentProxyLogFile = recent || null;
    } catch { currentProxyLogFile = null; }
  }
  return currentProxyLogFile;
}

function refreshProxyLogFile() { currentProxyLogFile = null; }

function parseLogCursor(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {}
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch (e) {}
  return null;
}

function parseDiskProxyLogLine(line, fallbackTimeMs) {
  var text = String(line || '').trim();
  if (!text) return null;
  var m = text.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/);
  if (m) {
    var dt = new Date(m[1].replace(' ', 'T') + '+08:00');
    return {
      time: isNaN(dt.getTime()) ? new Date(fallbackTimeMs || Date.now()).toISOString() : dt.toISOString(),
      type: String(m[2] || 'info').toLowerCase(),
      msg: m[3] || '',
      source: 'disk'
    };
  }
  return { time: new Date(fallbackTimeMs || Date.now()).toISOString(), type: 'info', msg: text, source: 'disk' };
}

function readLatestDiskProxyLogs(limit, cursor) {
  var current = getCurrentProxyLogFile();
  if (!current) return { logs: [], file: null, size: 0, mtimeMs: 0, cursor: null, truncated: false, no_current_session: true };
  try {
    var buf = fs.readFileSync(current.path);
    var start = 0;
    if (cursor && cursor.file === current.name && Number.isFinite(cursor.size)) {
      start = cursor.size > current.size ? 0 : Math.max(0, Math.min(cursor.size, current.size));
    }
    var content = buf.slice(start).toString('utf8');
    var lines = content.split(/\r?\n/).filter(function(line) { return line.trim(); });
    var truncated = false;
    if (start === 0 && lines.length > limit) {
      lines = lines.slice(-limit);
      truncated = true;
    }
    return {
      logs: lines.map(function(line) { return parseDiskProxyLogLine(line, current.mtimeMs); }).filter(Boolean),
      file: current.name,
      path: current.path,
      size: current.size,
      mtimeMs: current.mtimeMs,
      cursor: { file: current.name, size: current.size, mtimeMs: current.mtimeMs },
      truncated: truncated,
      no_current_session: false
    };
  } catch (e) {
    return { logs: [], file: current.name, path: current.path, size: current.size, mtimeMs: current.mtimeMs, cursor: null, truncated: false, error: e.message };
  }
}

function isFormattedProxyOutput(msg) {
  return /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s+\[[A-Z]+\]/.test(String(msg || '').trim());
}

// ==================== 初始化 user 文件夹 ====================
function initUserDir() {
  // 如果 user 文件夹不存在，自动创建
  if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    console.log('[ui] Created user directory');
  }
  
  // 如果 .env 不存在，创建空白模板
  const envPath = path.join(USER_DIR, '.env');
  if (!fs.existsSync(envPath)) {
    const envTemplate = `# Codex Assistant 配置文件
# 首次访问 UI 时会自动生成访问密钥

# 代理端口
PROXY_PORT=4000

# 日志级别
LOG_LEVEL=info
`;
    fs.writeFileSync(envPath, envTemplate);
    console.log('[ui] Created user/.env template');
  }
  
  // 如果 provider-configs.json 不存在，创建空白模板
  const providersPath = path.join(USER_DIR, 'provider-configs.json');
  if (!fs.existsSync(providersPath)) {
    const providersTemplate = {
      providers: []
    };
    fs.writeFileSync(providersPath, JSON.stringify(providersTemplate, null, 2));
    console.log('[ui] Created user/provider-configs.json template');
  }
  
  // 如果 aux-model-config.json 不存在，创建空白模板
  const auxConfigPath = path.join(USER_DIR, 'aux-model-config.json');
  if (!fs.existsSync(auxConfigPath)) {
    const auxConfigTemplate = {};
    fs.writeFileSync(auxConfigPath, JSON.stringify(auxConfigTemplate, null, 2));
    console.log('[ui] Created user/aux-model-config.json template');
  }
  
  // 如果 message-trim-config.json 不存在，创建默认配置（默认开启上下文裁剪）
  const trimConfigPath = path.join(USER_DIR, 'message-trim-config.json');
  if (!fs.existsSync(trimConfigPath)) {
    const trimConfigTemplate = {
      enabled: true,
      keepToolRounds: 20,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(trimConfigPath, JSON.stringify(trimConfigTemplate, null, 2));
    console.log('[ui] Created user/message-trim-config.json (default: enabled)');
  }
}

// 启动时初始化
initUserDir();

// 备份文件名时间戳格式: YYYY-MM-DD-HH-MM-SS
function backupTimestamp() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '-' +
    String(d.getHours()).padStart(2, '0') + '-' +
    String(d.getMinutes()).padStart(2, '0') + '-' +
    String(d.getSeconds()).padStart(2, '0');
}

// 自动备份 Codex 配置（启动时检测，通过哈希去重，避免重复备份）
function autoBackupCodexConfig() {
  try {
    const configPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
    if (!fs.existsSync(configPath)) {
      console.log('[backup] Config file not found:', configPath);
      return;
    }

    // 检查是否已有 CA 的标注（有 = CA 已接管，无需自动备份）
    var content = fs.readFileSync(configPath, 'utf8');
    if (content.startsWith(CODEX_HEADER)) {
      console.log('[backup] Config already has CA header, skipping auto-backup');
      return;
    }

    console.log('[backup] Config not managed by CA, checking if backup needed...');

    // 复用 backupCodexFiles 的哈希去重逻辑
    const backupDir = IS_INSTALLED
      ? path.join(APP_DATA_BASE, 'CodexAssistant', 'backup')
      : path.join(PROJECT_DIR, 'backup');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const filesToBackup = [];
    const authPath = path.join(CODEX_CONFIG_DIR, 'auth.json');
    if (fs.existsSync(configPath)) filesToBackup.push({ name: 'config.toml', path: configPath });
    if (fs.existsSync(authPath)) filesToBackup.push({ name: 'auth.json', path: authPath });
    if (filesToBackup.length === 0) return;

    // SHA-256 哈希去重
    var hash = crypto.createHash('sha256');
    for (var fi = 0; fi < filesToBackup.length; fi++) {
      hash.update(fs.readFileSync(filesToBackup[fi].path));
    }
    var currentHash = hash.digest('hex');
    var hashFile = path.join(backupDir, '.backup-hash');
    if (fs.existsSync(hashFile)) {
      var lastHash = fs.readFileSync(hashFile, 'utf8').trim();
      if (lastHash === currentHash) {
        console.log('[backup] Auto-backup skipped: config unchanged since last backup');
        return;
      }
    }
    fs.writeFileSync(hashFile, currentHash);

    const zipName = `原始配置自动备份-${backupTimestamp()}.zip`;
    const zipPath = path.join(backupDir, zipName);
    console.log('[backup] Creating auto-backup:', zipName);

    const tempDir = path.join(os.tmpdir(), 'codex-auto-backup-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    for (const f of filesToBackup) {
      if (fs.existsSync(f.path)) {
        fs.copyFileSync(f.path, path.join(tempDir, f.name));
      }
    }
    try {
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipPath}' -Force`
      ], { stdio: 'ignore' });
      console.log('[backup] Auto-backup created:', zipName);
    } catch (zipError) {
      console.error('[backup] Failed to create zip:', zipError.message);
      throw zipError;
    } finally {
      try { fs.rmSync(tempDir, { recursive: true }); } catch {}
    }

    // 首次自动备份默认锁定，不可删除
    fs.writeFileSync(zipPath + '.locked', '', 'utf8');
    console.log('[backup] Auto-backup locked:', zipName);

    // 清理超过 50 份的旧备份（跳过锁定的和原始配置备份）
    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('用户手动备份-') && f.endsWith('.zip') && !f.startsWith('原始配置自动备份-'))
      .sort();
    while (backups.length > 50) {
      const oldBackup = backups.shift();
      const oldPath = path.join(backupDir, oldBackup);
      if (!fs.existsSync(oldPath + '.locked')) {
        try { fs.unlinkSync(oldPath); } catch {}
      }
    }
  } catch (e) {
    console.error('[backup] Auto-backup failed:', e.message);
  }
}
autoBackupCodexConfig();

// 从 Codex auth.json 初始化 PROXY_AUTH_KEY（auth.json 为唯一权威源）
function initProxyAuthKey() {
  try {
    const env = readEnv();
    const auth = readCodexAuth();
    const codexKey = auth.OPENAI_API_KEY || '';

    if (codexKey && codexKey !== env.PROXY_AUTH_KEY) {
      // auth.json 有密钥，且与 .env 不一致 → 以 auth.json 为准覆盖
      env.PROXY_AUTH_KEY = codexKey;
      writeEnv(env);
      console.log('[ui] Synced PROXY_AUTH_KEY from Codex auth.json');
    }
    // auth.json 无密钥时保持 .env 现有值不动
    // 不再自动生成随机密钥 — 用户需通过「随机刷新」按钮手动生成
  } catch (e) {
    console.error('[ui] Failed to init PROXY_AUTH_KEY:', e.message);
  }
}
initProxyAuthKey();

// 工厂启动时自动将旧的 PROXY_AUTH_KEY 加密的 provider 密钥迁移到机器码加密
function migrateToMachineKeyIfNeeded() {
  try {
    if (!fs.existsSync(PROVIDERS_FILE)) return;
    
    var machineKey = getMachineKey();
    if (!machineKey) {
      console.log('[ui] Migration: machine key unavailable, skipping');
      return;
    }
    
    var data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    if (!data.providers || data.providers.length === 0) return;
    
    // Check if already using machine key
    var firstEncrypted = data.providers.find(function(p) {
      return p.api_key && isEncrypted(p.api_key);
    });
    if (firstEncrypted) {
      var testResult = tryDecryptApiKey(firstEncrypted.api_key, machineKey);
      if (testResult.key !== null) {
        // Already using machine key, no migration needed
        return;
      }
    }
    
    // Try to migrate using the old PROXY_AUTH_KEY
    var env = readEnv();
    var oldMasterKey = (env.PROXY_AUTH_KEY || '').trim();
    if (!oldMasterKey) {
      console.log('[ui] Migration: no legacy master key available');
      return;
    }
    
    var result = migrateProvidersToMachineKey(data.providers, oldMasterKey);
    if (result.migrated > 0) {
      fs.writeFileSync(PROVIDERS_FILE, JSON.stringify({ providers: result.providers }, null, 2));
      console.log('[ui] Migration: re-encrypted ' + result.migrated + ' providers to machine key');
    }
    if (result.failed > 0) {
      console.log('[ui] Migration: ' + result.failed + ' providers could not be migrated (keys may need manual re-entry)');
    }
  } catch (e) {
    console.error('[ui] Migration error:', e.message);
  }
}
migrateToMachineKeyIfNeeded();

// ==================== .env 读写（只保留真正全局的变量）====================
// GLOBAL_ENV_KEYS defines the allowed keys for .env (non-provider settings).
// Provider API keys now live exclusively in provider-configs.json (encrypted).
var GLOBAL_ENV_KEYS = [
  'PROXY_PORT', 'PROXY_AUTH_KEY', 'DEFAULT_PROVIDER', 'DEFAULT_MODEL', 'LOG_LEVEL',
  'LOG_RETENTION_DAYS', 'UPSTREAM_TIMEOUT_MS', 'STORE_TTL_MS', 'STORE_MAX',
  'MAX_CONSECUTIVE_TOOL_CALLS', 'FETCH_TIMEOUT_MS', 'FETCH_MAX_BODY',
  'MAX_FETCH_LOOPS', 'DEEPSEEK_DISABLE_THINKING', 'DEEPSEEK_REASONING_EFFORT',
  'MIMO_REASONING_EFFORT', 'PROXY_KEYS', 'MODEL_CATALOG_PATH',
  'DEEPSEEK_MODELS', 'MIMO_MODELS', 'OPENAI_MODELS', 'OPENAI_MODEL_PREFIXES',
  'DEEPSEEK_BASE_URL', 'MIMO_BASE_URL', 'OPENAI_BASE_URL',
  'JINA_BASE', 'JINA_FETCH_TIMEOUT_MS', 'JINA_MAX_BODY',
  'GITHUB_TOKEN', 'MODEL_LIST_CACHE_TTL_MS'
];
function readEnv() {
  var envPath = path.join(USER_DIR, '.env');
  if (!fs.existsSync(envPath)) return {};
  var env = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
    var trimmed = line.trim();
    // 跳过注释行和空行
    if (!trimmed || trimmed.startsWith('#')) return;
    var idx = line.indexOf('=');
    if (idx > 0) {
      var key = line.substring(0, idx).trim();
      var val = line.substring(idx + 1).trim();
      // 去掉首尾引号
      var wasQuoted = /^["']/.test(val);
      val = val.replace(/^["']|["']$/g, '');
      // 去掉行内注释（但保留引号内的 # 字符）
      if (!wasQuoted) {
        var ci = val.indexOf('#');
        if (ci >= 0) val = val.substring(0, ci).trim();
      }
      if (key) env[key] = val;
    }
  });
  return env;
}

function serializeEnvValue(value) {
  var str = value == null ? '' : String(value);
  if (/[\r\n]/.test(str)) {
    str = str.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/"/g, '\\"');
    return '"' + str + '"';
  }
  if (str === '' || /^[\s]|[\s]$/.test(str) || /[#"'\\]/.test(str)) {
    str = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '"' + str + '"';
  }
  return str;
}

function writeEnv(envObj) {
  const envPath = path.join(USER_DIR, '.env');
  const lines = [];
  const keys = new Set(Object.keys(envObj));

  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        lines.push(line);
        return;
      }
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        if (envObj[key] !== undefined) {
          lines.push(key + '=' + serializeEnvValue(envObj[key]));
          keys.delete(key);
        } else {
          lines.push(line);
        }
      } else {
        lines.push(line);
      }
    });
  }
  for (const key of keys) {
    lines.push(key + '=' + serializeEnvValue(envObj[key]));
  }
  // 去掉末尾空行
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

// ==================== 提供商配置读写 ====================
var PROVIDERS_FILE = path.join(USER_DIR, 'provider-configs.json');

function getMasterKey() {
  // Encryption master key is now derived from the machine's hardware fingerprint,
  // independent of PROXY_AUTH_KEY. This means changing the access key no longer
  // breaks encrypted API Key storage.
  return getMachineKey();
}

function readProviders() {
  if (!fs.existsSync(PROVIDERS_FILE)) return { providers: [] };
  var data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
  var masterKey = getMasterKey();
  
  // Decrypt API keys transparently
  if (masterKey && data.providers) {
    data.providers = data.providers.map(function(p) {
      if (!p.api_key) return p;
      var result = tryDecryptApiKey(p.api_key, masterKey);
      if (result.key !== null) {
        return Object.assign({}, p, { api_key: result.key });
      }
      if (result.wasEncrypted) {
        console.error('[ui] Failed to decrypt key for provider "' + p.name + '" — master key may have changed. Provider will appear without API key.');
        return Object.assign({}, p, {
          api_key: '',
          _decrypt_error: result.error,
          _decrypt_warning: '加密环境发生改变，密钥无法解密，请编辑重新输入'
        });
      }
      return p;
    });
  }
  
  return data;
}

function writeProviders(data) {
  var masterKey = getMasterKey();
  
  // Encrypt API keys before saving
  if (masterKey && data.providers) {
    var toSave = {
      providers: data.providers.map(function(p) {
        if (!p.api_key) return p;
        if (isEncrypted(p.api_key)) return p;
        try {
          return Object.assign({}, p, {
            api_key: encryptApiKeyWithPrefix(p.api_key, masterKey)
          });
        } catch (e) {
          console.error('[ui] Failed to encrypt key for provider "' + p.name + '":', e.message);
          return p;
        }
      })
    };
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(toSave, null, 2));
  } else {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(data, null, 2));
  }
}


// 根据 providers 自动生成 user/proxy-models.json
function generateProxyModels() {
  const { providers } = readProviders();
  const models = [];
  const defaultReasoning = [
    { "effort": "none",    "description": "Thinking disabled" },
    { "effort": "minimal", "description": "Minimal reasoning" },
    { "effort": "low",     "description": "Low reasoning effort" },
    { "effort": "medium",  "description": "Medium reasoning effort" },
    { "effort": "high",    "description": "High reasoning effort" }
  ];
  // Known context windows for fallback when model has no explicit context_window
  const KNOWN_CTX = {
    'mimo-v2.5': 1048576, 'mimo-v2.5-pro': 1048576,
    'deepseek-v4-pro': 1048576, 'deepseek-v4-flash': 1048576,
    'deepseek-v3': 131072, 'deepseek-r1': 131072,
    'gpt-4o': 128000, 'gpt-4o-mini': 128000,
    'gpt-4.1': 1048576, 'gpt-4.1-mini': 1048576,
    'gpt-5': 409600, 'gpt-5.2': 409600,
    'gpt-5.4': 272000, 'gpt-5.4-pro': 272000,
    'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 128000,
    'o1': 200000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
    'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000,
    'claude-haiku-3-5': 200000,
    'gemini-2.5-pro': 1048576, 'gemini-2.5-flash': 1048576,
    'qwen3-235b': 131072, 'qwen-max': 131072,
    'mistral-large': 128000, 'llama-4-maverick': 1048576,
  };

  // First pass: detect slug conflicts across providers
  const slugCounts = {};
  (providers || []).forEach(p => {
    (p.models || []).forEach(m => {
      const rawSlug = m.slug || m.id;
      slugCounts[rawSlug] = (slugCounts[rawSlug] || 0) + 1;
    });
  });

  (providers || []).forEach((p, idx) => {
    (p.models || []).forEach(m => {
      const rawSlug = m.slug || m.id;
      const hasConflict = slugCounts[rawSlug] > 1;
      const slug = hasConflict
        ? p.name.toLowerCase().replace(/\s+/g, '') + '/' + rawSlug
        : rawSlug;
      const displayName = hasConflict
        ? p.name + ' / ' + (m.display_name || m.id)
        : (m.display_name || m.id);
      const ctxWindow = m.context_window || KNOWN_CTX[rawSlug] || 200000;
      models.push({
        "slug": slug,
        "display_name": displayName,
        "context_window": ctxWindow,
        "supported_reasoning_levels": defaultReasoning,
        "shell_type": "default",
        "visibility": "list",
        "supported_in_api": true,
        "priority": idx * 100 + (m.priority || 0),
        "base_instructions": "",
        "supports_reasoning_summaries": false,
        "support_verbosity": false,
        "truncation_policy": { "mode": "tokens", "limit": ctxWindow },
        "supports_parallel_tool_calls": true,
        "experimental_supported_tools": [],
        "_upstream_base_url": normalizeModelsUrl(p.base_url).replace(/\/models$/, ''),
        "_upstream_protocol": p.protocol || "openai"
      });
    });
  });

  const result = { models };
  const modelPath = path.join(USER_DIR, 'proxy-models.json');
  fs.writeFileSync(modelPath, JSON.stringify(result, null, 2));
  return result;
}

// ==================== Codex 配置 ====================
function readCodexConfig() {
  const cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
  if (!fs.existsSync(cfgPath)) return '';
  return fs.readFileSync(cfgPath, 'utf8');
}

// 直接更新 config.toml 中的顶级 key=value，不存在则追加

var CODEX_HEADER = '# 以下配置信息由 Codex Assistant 生成，原始配置信息已通过软件自动备份\n';

function ensureCodexHeader() {
  var cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
  var content = readCodexConfig();
  if (!content.startsWith(CODEX_HEADER)) {
    fs.writeFileSync(cfgPath, CODEX_HEADER + content);
  }
}

function updateCodexTopKey(key, value) {
  const cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
  var content = readCodexConfig();
  var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var keyRegex = new RegExp('^' + escaped + '\\s*=\\s*.*$', 'm');
  if (keyRegex.test(content)) {
    content = content.replace(keyRegex, key + ' = ' + value);
  } else {
    content = content.trimEnd() + '\n' + key + ' = ' + value;
  }
  fs.writeFileSync(cfgPath, content);
}

// 更新 config.toml 中指定 section 下的 key=value
function updateCodexSectionKey(section, key, value) {
  const cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
  var content = readCodexConfig();
  var sectionHeader = '[' + section + ']';
  var sectionIdx = content.indexOf(sectionHeader);
  if (sectionIdx < 0) {
    // section 不存在，追加
    content = content.trimEnd() + '\n\n[' + section + ']\n' + key + ' = ' + value;
    fs.writeFileSync(cfgPath, content);
    return;
  }
  // section 存在，找下一个 section 位置
  var nextSection = content.indexOf('\n[', sectionIdx + sectionHeader.length);
  var sectionEnd = nextSection >= 0 ? nextSection : content.length;
  var sectionBody = content.substring(sectionIdx, sectionEnd);
  var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var keyRegex = new RegExp('^' + escaped + '\\s*=\\s*.*$', 'm');
  if (keyRegex.test(sectionBody)) {
    sectionBody = sectionBody.replace(keyRegex, key + ' = ' + value);
  } else {
    sectionBody = sectionBody.trimEnd() + '\n' + key + ' = ' + value;
  }
  content = content.substring(0, sectionIdx) + sectionBody + content.substring(sectionEnd);
  fs.writeFileSync(cfgPath, content);
}

// Codex auth.json 读写
function readCodexAuth() {
  const authPath = path.join(CODEX_CONFIG_DIR, 'auth.json');
  if (!fs.existsSync(authPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch { return {}; }
}

function writeCodexAuth(data) {
  const authPath = path.join(CODEX_CONFIG_DIR, 'auth.json');
  data._note = '以下配置信息由 Codex Assistant 生成，原始配置信息已通过软件自动备份';
  fs.writeFileSync(authPath, JSON.stringify(data, null, 2));
}

// 完整重写 config.toml：只保留 Codex 自己的 section，其余由 CA 重新生成
// 彻底清除旧版 # 替换去掉注释 标记和 CA 生成的冗余内容
function rewriteCodexConfig(model, ctxWindow, proxyPort) {
  var cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
  var oldContent = readCodexConfig();

  // 提取 Codex 原生的 section（非 CA 管理），逐 section 收集
  var codexSections = [];
  var lines = oldContent.split('\n');
  var inSection = false;
  var sectionLines = [];
  var currentSectionName = '';

  // CA 管理的 section 名称
  var caManaged = ['model_providers.local_proxy'];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // 跳过 CA 的 header 和注释
    if (trimmed.startsWith('#') && trimmed.includes('Codex Assistant')) continue;
    if (trimmed === CODEX_HEADER.trim()) continue;

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // 保存前一个 section
      if (inSection && sectionLines.length > 0 && !caManaged.includes(currentSectionName)) {
        codexSections.push(sectionLines.join('\n'));
      }
      currentSectionName = trimmed.slice(1, -1);
      sectionLines = [line];
      inSection = true;
    } else if (inSection) {
      sectionLines.push(line);
    }
    // 顶级 key 由 CA 重新生成，直接丢弃
  }
  // 保存最后一个 section
  if (inSection && sectionLines.length > 0 && !caManaged.includes(currentSectionName)) {
    codexSections.push(sectionLines.join('\n'));
  }

  // 组装新内容
  var parts = [CODEX_HEADER.trimEnd()];
  parts.push('');
  parts.push('# Codex 配置 - 由 Codex Assistant UI 自动生成');
  parts.push('model = ' + JSON.stringify(model));
  parts.push('model_reasoning_effort = "medium"');
  parts.push('model_provider = "local_proxy"');
  parts.push('model_context_window = ' + ctxWindow);
  parts.push('max_tokens = 4096');
  parts.push('enable_request_compression = false');
  parts.push('allow_model_truncation = false');
  parts.push('');
  parts.push('[model_providers.local_proxy]');
  parts.push('name = ' + JSON.stringify(model));
  parts.push('base_url = "http://127.0.0.1:' + proxyPort + '/v1"');
  parts.push('wire_api = "responses"');
  parts.push('requires_openai_auth = true');

  // 追加 Codex 原生 section，并同步 CA 管理的 model 相关 key
  // 确保 Codex CLI 和桌面版使用统一的模型配置
  var syncKeys = {
    'model': JSON.stringify(model),
    'model_provider': '"local_proxy"',
    'model_context_window': ctxWindow,
    'max_tokens': '4096'
  };
  for (var j = 0; j < codexSections.length; j++) {
    var section = codexSections[j];
    // 在该 section 内替换匹配的 key（忽略大小写，允许行首空格）
    for (var sk in syncKeys) {
      var re = new RegExp('^(\\s*' + sk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*).+', 'gim');
      section = section.replace(re, '$1' + syncKeys[sk]);
    }
    parts.push('');
    parts.push(section);
  }

  fs.writeFileSync(cfgPath, parts.join('\n') + '\n');
  console.log('[codex] Config rewritten: model=' + model + ', port=' + proxyPort);
}

function parseToml(content) {
  const result = {};
  let currentSection = null;
  (content || '').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      result[currentSection] = {};
    } else if (currentSection && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim().replace(/^["']|["']$/g, '');
      let val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      const ci = val.indexOf('#');
      if (ci >= 0) val = val.substring(0, ci).trim();
      result[currentSection][key] = val;
    } else if (!currentSection && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim().replace(/^["']|["']$/g, '');
      let val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
      const ci = val.indexOf('#');
      if (ci >= 0) val = val.substring(0, ci).trim();
      result[key] = val;
    }
  });
  return result;
}

// ==================== 端口占用检测 ====================
async function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

// 通过 netstat 查找占用指定端口的 PID（Windows）
function findPidByPort(port) {
  try {
    var output = execSync('netstat -ano', { encoding: 'utf8', timeout: 3000 });
    var lines = output.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.includes('LISTENING')) continue;
      if (!line.includes(':' + port)) continue;
      // TCP    127.0.0.1:4000    0.0.0.0:0    LISTENING    12345
      var parts = line.trim().split(/\s+/);
      var pid = parseInt(parts[parts.length - 1], 10);
      if (pid > 0) return pid;
    }
  } catch (e) { /* netstat may fail */ }
  return null;
}

// 判断 PID 是否属于我们自己的代理进程（命令行包含 proxy.mjs）
function isOurProxyProcess(pid) {
  try {
    var output = execSync('wmic process where ProcessId=' + pid + ' get CommandLine /format:list', { encoding: 'utf8', timeout: 3000 });
    return output.includes('proxy.mjs');
  } catch (e) { return false; }
}

// 查端口归属：{ available: true } | { available: false, isOurs: bool, pid: number }
function checkPortOwner(port) {
  var pid = findPidByPort(port);
  if (pid === null) return { available: true };
  return { available: false, isOurs: isOurProxyProcess(pid), pid: pid };
}

// 强制结束进程（Windows）
function killProcessByPid(pid) {
  try {
    execSync('taskkill /PID ' + pid + ' /F', { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch (e) { return false; }
}

async function findAvailablePort(startPort, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await checkPortAvailable(port)) {
      return port;
    }
  }
  return null; // 没有找到可用端口
}

// 查找下一个可用端口并记录日志
async function findNextPort(blockedPort) {
  var newPort = await findAvailablePort(blockedPort + 1, 10);
  if (newPort === null) return null;
  proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '端口 ' + blockedPort + ' 被占用，自动切换到端口 ' + newPort });
  return newPort;
}

// 双重检查：探测代理端口是否真的在监听（防止 proxyProcess 变量失效）
async function checkProxyPortListening(port) {
  return new Promise(function (resolve) {
    var req = http.request({ hostname: '127.0.0.1', port: port, path: '/', method: 'HEAD', timeout: 800 }, function () {
      resolve(true);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
    req.end();
  });
}

// ==================== 配置同步检查 ====================
async function syncCodexConfig() {
  const syncResults = [];
  const env = readEnv();
  const auth = readCodexAuth();
  const codexConfig = readCodexConfig();
  const parsed = parseToml(codexConfig);

  // 1. 同步访问密钥（CA ↔ Codex 双向同步，减少对 Codex 的配置改动）
  const proxyKey = env.PROXY_AUTH_KEY || '';
  const codexKey = auth.OPENAI_API_KEY || '';

  if (codexKey && codexKey !== proxyKey) {
    env.PROXY_AUTH_KEY = codexKey;
    writeEnv(env);
    syncResults.push('已同步访问密钥到 CA');
  }

  if (proxyKey && proxyKey !== codexKey) {
    auth.OPENAI_API_KEY = proxyKey;
    writeCodexAuth(auth);
    syncResults.push('已同步访问密钥到 Codex');
  }

  // 2. 检测配置是否需要完整重写（从备份恢复后 model_provider 不是 local_proxy）
  var needRewrite = !parsed.model_provider || parsed.model_provider !== 'local_proxy';

  // 3. 如果没有 local_proxy section，也说明需要完整重写
  if (!needRewrite && !parsed['model_providers.local_proxy']) {
    needRewrite = true;
  }

  if (needRewrite && codexConfig) {
    // 完整重写：清空旧内容，只保留 Codex 自己的 section，其余由 CA 重新生成
    var currentModel = parsed.model || 'mimo-v2.5';
    var ctxWindow = parsed.model_context_window || 131072;
    var proxyPort = env.PROXY_PORT || '4000';
    rewriteCodexConfig(currentModel, ctxWindow, proxyPort);
    syncResults.push('已完整重写 Codex 配置（model=' + currentModel + ', port=' + proxyPort + '）');
  } else {
    // 4. 只同步端口
    var proxyPort2 = env.PROXY_PORT || '4000';
    var codexPort = '';
    if (parsed['model_providers.local_proxy']) {
      var baseUrl = parsed['model_providers.local_proxy'].base_url || '';
      var match = baseUrl.match(/:(\d+)\/v1/);
      if (match) codexPort = match[1];
    }
    if (proxyPort2 !== codexPort && codexConfig) {
      var newBaseUrl = '"http://127.0.0.1:' + proxyPort2 + '/v1"';
      updateCodexSectionKey('model_providers.local_proxy', 'base_url', newBaseUrl);
      syncResults.push('已同步端口 ' + (codexPort || '?') + ' -> ' + proxyPort2 + ' 到 Codex config.toml');
    }
  }

  return { success: true, synced: syncResults };
}

// ==================== 代理进程管理 ====================
async function startProxy() {
  if (proxyProcess) return { success: false, message: '代理已在运行中' };
  try { generateProxyModels(); } catch (e) { /* ignore */ }

  // 检查是否已配置至少一个提供商（含有效 API Key）
  var currentProviders = readProviders();
  var hasValidProvider = false;
  for (var i = 0; i < (currentProviders.providers || []).length; i++) {
    var p = currentProviders.providers[i];
    if (p.api_key && p.api_key.trim()) { hasValidProvider = true; break; }
  }
  if (!hasValidProvider) {
    return { success: false, message: '请先在提供商管理页面添加至少一个提供商及 API Key，再启动代理' };
  }

  const proxyPath = path.join(PROJECT_DIR, 'proxy.mjs');
  const env = readEnv();
  
  // 智能端口选择：始终优先使用 4000
  let port = parseInt(env.PROXY_PORT || '4000', 10);

  if (!(await checkPortAvailable(port))) {
    var owner = checkPortOwner(port);

    if (owner && owner.isOurs) {
      // 被我们自己的旧代理进程占用 → 终止后重用 4000
      proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '端口 ' + port + ' 被旧代理进程(PID:' + owner.pid + ')占用，正在终止并重用...' });
      killProcessByPid(owner.pid);
      await new Promise(function(r) { setTimeout(r, 1500); });

      if (!(await checkPortAvailable(port))) {
        proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '端口 ' + port + ' 终止旧进程后仍不可用，切换端口' });
        port = await findNextPort(port);
      }
    } else {
      // 被其他软件占用 → 从 4001 开始逐个试
      port = await findNextPort(port);
    }

    if (port === null) {
      return { success: false, message: '所有端口均被占用，无法启动代理' };
    }

    // 端口发生变化时同步到 env 和 .env 文件
    env.PROXY_PORT = port.toString();
    var envObj = readEnv();
    envObj.PROXY_PORT = port.toString();
    writeEnv(envObj);
  }
  
  // 收集 stderr 输出用于诊断
  var stderrChunks = [];
  var envFilePath = path.join(USER_DIR, '.env');
  proxyProcess = spawn('node', ['--env-file=' + envFilePath, proxyPath], {
    cwd: PROJECT_DIR,
    env: Object.assign({}, process.env, env, { CODASS_LOG_DIR: PROXY_LOG_DIR }),
    detached: false,
  });
  proxyProcess.stdout.on('data', function(d) {
    proxyLog.push({ time: new Date().toISOString(), type: 'info', msg: d.toString().trim() });
    if (proxyLog.length > PROXY_LOG_MAX) proxyLog.shift();
  });
  proxyProcess.stderr.on('data', function(d) {
    var text = d.toString().trim();
    stderrChunks.push(text);
    proxyLog.push({ time: new Date().toISOString(), type: 'error', msg: text });
    if (proxyLog.length > PROXY_LOG_MAX) proxyLog.shift();
  });
  proxyProcess.on('close', function(code) {
    if (code !== 0 && code !== null) {
      var errMsg = stderrChunks.join('\n').trim();
      // 提取关键错误信息（去掉技术细节）
      if (errMsg.indexOf('没有配置任何上游 API Key') !== -1) {
        proxyLog.push({ time: new Date().toISOString(), type: 'error', msg: '代理启动失败：没有配置任何上游 API Key，请先在提供商管理页面添加提供商' });
      } else if (errMsg.indexOf('EADDRINUSE') !== -1) {
        proxyLog.push({ time: new Date().toISOString(), type: 'error', msg: '代理启动失败：端口被占用，请在环境配置中更换端口' });
      } else if (errMsg) {
        proxyLog.push({ time: new Date().toISOString(), type: 'error', msg: '代理启动失败：' + errMsg.slice(0, 200) });
      } else {
        proxyLog.push({ time: new Date().toISOString(), type: 'error', msg: '代理启动失败，退出码: ' + code + '（无详细错误信息）' });
      }
    } else {
      proxyLog.push({ time: new Date().toISOString(), type: 'info', msg: '代理已停止运行' });
    }
    proxyProcess = null;
  });

  // 等待子进程稳定启动（等 2 秒，给足时间让 Node.js 加载模块和检测错误）
  await new Promise(function(r) { setTimeout(r, 2000); });
  if (proxyProcess && proxyProcess.exitCode !== null) {
    var exitCode = proxyProcess.exitCode;
    var failMsg = stderrChunks.join('\n').trim();
    proxyProcess = null;
    if (failMsg.indexOf('没有配置任何上游 API Key') !== -1) {
      return { success: false, message: '代理启动失败：没有配置任何上游 API Key，请先在提供商管理页面添加提供商' };
    }
    return { success: false, message: '代理启动失败：' + (failMsg.slice(0, 200) || '退出码 ' + exitCode) };
  }
  
  proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: `代理进程已启动，端口: ${port}` });
  // 刷新当前会话日志文件引用，以便下次请求 /api/logs 读取新文件
  refreshProxyLogFile();
  return { success: true, message: `代理已启动，端口: ${port}`, port: port };
}

function stopProxy() {
  return new Promise((resolve) => {
    if (!proxyProcess) {
      // 即使 proxyProcess 为 null，也检查端口上是否有残留进程
      try {
        var env2 = readEnv();
        var port2 = parseInt(env2.PROXY_PORT || '4000', 10);
        killProcessOnPort(port2);
      } catch { /* ignore */ }
      resolve({ success: false, message: '代理未运行（已清理端口残留）' });
      return;
    }
    const proc = proxyProcess;
    proxyProcess = null;

    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(forceKill);
      // 兜底：通过端口杀残留进程（防止 Windows 强杀父进程后子进程残留）
      try {
        var env3 = readEnv();
        var port3 = parseInt(env3.PROXY_PORT || '4000', 10);
        setTimeout(function() { killProcessOnPort(port3); }, 500);
      } catch { /* ignore */ }
      resolve(result);
    };

    proc.on('close', () => {
      proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '代理进程已停止' });
      done({ success: true, message: '代理已停止' });
    });

    // 先用 taskkill /T /F 杀整个进程树，比 proc.kill 更可靠
    killProcessTree(proc.pid);

    // 超时保护：3秒后强制终止
    var forceKill = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
      proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '代理进程已强制终止' });
      done({ success: true, message: '代理已停止（超时强制终止）' });
    }, 3000);
  });
}

// 通过端口查找并杀死占用该端口的进程（Windows）
// 清理整个进程树：通过 PID 杀死进程及其所有子进程（Windows）
function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch { /* already dead or no children */ }
}

// 通过端口查找并杀死占用该端口的进程（Windows），连带杀死子进程树
function killProcessOnPort(port) {
  try {
    var output = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 3000 });
    var lines = output.split('\n');
    var pids = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.includes('LISTENING')) continue;
      var parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      var addr = parts[1];
      // 匹配 127.0.0.1:PORT 或 [::1]:PORT 或 0.0.0.0:PORT
      var match = addr.match(/:(\d+)$/);
      if (match && parseInt(match[1], 10) === port) {
        var pid = parts[parts.length - 1];
        if (pid && pid !== '0' && pids.indexOf(pid) === -1) {
          pids.push(pid);
        }
      }
    }
    for (var j = 0; j < pids.length; j++) {
      killProcessTree(pids[j]);
    }
  } catch { /* ignore */ }
}

var CODEX_PP_IMAGES = ['codex-plus-plus.exe', 'codexpp.exe', 'codexplusplus.exe', 'CodexPlusPlus.exe', 'CodexPP.exe'];

function checkCodex() {
  try {
    var r = execFileSync('tasklist', ['/FI', 'IMAGENAME eq codex.exe', '/NH'], { encoding: 'utf8' });
    return r.includes('codex.exe') || r.includes('Codex.exe');
  } catch { return false; }
}

function checkCodexRunningType() {
  try {
    // 检查 Codex++ (try multiple possible image names)
    for (var i = 0; i < CODEX_PP_IMAGES.length; i++) {
      try {
        var r1 = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + CODEX_PP_IMAGES[i], '/NH'], { encoding: 'utf8' });
        if (r1.toLowerCase().indexOf(CODEX_PP_IMAGES[i].toLowerCase()) !== -1) return 'codexpp';
      } catch { /* try next image name */ }
    }

    // 检查 Codex，通过路径区分桌面版和 CLI
    try {
      var psScript = "Get-Process -Name 'codex' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path";
      var pathResult = execFileSync('powershell', ['-Command', psScript], { encoding: 'utf8', timeout: 3000 }).trim();

      if (pathResult) {
        // 微软商店版路径包含 WindowsApps
        if (pathResult.includes('WindowsApps')) return 'app';
        return 'app'; // 默认桌面版（无法从路径区分 CLI/桌面，统一按桌面处理）
      }
    } catch {}

    // 如果 PowerShell 失败，回退到 tasklist
    var r2 = execFileSync('tasklist', ['/FI', 'IMAGENAME eq codex.exe', '/NH'], { encoding: 'utf8' });
    if (r2.includes('codex.exe')) return 'app'; // 默认桌面版

    return null;
  } catch { return null; }
}

function trustCodexDirectory(dir) {
  try {
    const cfgPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
    if (!fs.existsSync(cfgPath)) {
      console.log('[trust] config.toml not found:', cfgPath);
      return;
    }

    let content = fs.readFileSync(cfgPath, 'utf8');
    // Codex 使用小写反斜杠路径格式，如 f:\workspace\myproject
    const normalizedDir = dir.replace(/\//g, '\\').toLowerCase();
    const projectKey = `[projects.'${normalizedDir}']`;

    console.log('[trust] checking:', projectKey);

    // 检查是否已经信任
    if (content.includes(projectKey)) {
      // 已存在，检查是否有 trust_level
      const lines = content.split('\n');
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === projectKey) {
          // 检查后续几行是否有 trust_level
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j].includes('trust_level')) {
              found = true;
              break;
            }
            if (lines[j].startsWith('[')) break; // 新段落
          }
          break;
        }
      }
      if (found) {
        console.log('[trust] already trusted');
        return;
      }
      // 添加 trust_level 到现有项目配置
      content = content.replace(projectKey, `${projectKey}\ntrust_level = "trusted"`);
      console.log('[trust] added trust_level to existing entry');
    } else {
      // 追加新项目信任配置到文件末尾
      content = content.trimEnd() + '\n\n' + projectKey + '\ntrust_level = "trusted"\n';
      console.log('[trust] added new trust entry');
    }

    fs.writeFileSync(cfgPath, content);
    console.log('[trust] saved');
  } catch (e) {
    console.error('[trust] Failed:', e.message);
  }
}

var _codexInstallCache = null;

function getCodexInstallInfo() {
  if (_codexInstallCache) return _codexInstallCache;

  // 1. 微软商店版检测（优先，因为"启动 Codex 桌面版"应指向商店版）
  try {
    var storeResult = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-AppxPackage -Name "OpenAI.Codex" | Select-Object -ExpandProperty PackageFamilyName'
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    if (storeResult && storeResult.includes('OpenAI.Codex')) {
      var storeAlias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'codex.exe');
      var hasAlias = fs.existsSync(storeAlias);
      _codexInstallCache = {
        type: 'store',
        packageFamilyName: storeResult,
        path: hasAlias ? storeAlias : 'codex'
      };
      return _codexInstallCache;
    }
  } catch {}

  // 2. 安装包版固定路径（排除 .chatclaw 沙箱版，那是 CLI 环境）
  var exePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'Codex.exe'),
  ];
  for (var i = 0; i < exePaths.length; i++) {
    if (fs.existsSync(exePaths[i])) {
      _codexInstallCache = { type: 'exe', path: exePaths[i] };
      return _codexInstallCache;
    }
  }

  // 3. 检查 .chatclaw 沙箱版（CLI 专用，不用于桌面模式）
  var chatclawPath = path.join(process.env.USERPROFILE || '', '.chatclaw', 'native', 'bin', 'codex.exe');
  var hasChatclaw = fs.existsSync(chatclawPath);

  // 4. 兜底：PATH 中的 codex（npm 全局安装或手动放 PATH 的）
  _codexInstallCache = { type: 'path', path: hasChatclaw ? chatclawPath : 'codex' };
  return _codexInstallCache;
}

function getCodexPath() {
  const info = getCodexInstallInfo();
  return info.path || 'codex';
}

function isCodexStoreApp() {
  return getCodexInstallInfo().type === 'store';
}

// ---- Codex++ / Codex++ Manager 路径搜索 ----
// 多级搜索策略：固定路径 → 注册表 → PATH → PowerShell Get-Command → 深度递归

function searchExecutable(name, altNames) {
  altNames = altNames || [];
  var allNames = [name].concat(altNames);
  var allExeNames = [];
  for (var n = 0; n < allNames.length; n++) {
    allExeNames.push(allNames[n] + '.exe');
  }

  // Level 1: common install directories
  var basePaths = [];
  if (process.env.ProgramFiles) basePaths.push(process.env.ProgramFiles);
  if (process.env['ProgramFiles(x86)']) basePaths.push(process.env['ProgramFiles(x86)']);
  if (process.env.LOCALAPPDATA) basePaths.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.env.APPDATA) basePaths.push(path.join(process.env.APPDATA, 'Programs'));
  if (process.env.USERPROFILE) {
    basePaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs'));
    basePaths.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'Programs'));
    basePaths.push(path.join(process.env.USERPROFILE, 'Desktop'));
    basePaths.push(path.join(process.env.USERPROFILE, 'Downloads'));
  }

  // Deduplicate base paths (case-insensitive)
  var seen = {};
  var uniquePaths = [];
  for (var b = 0; b < basePaths.length; b++) {
    var key = basePaths[b].toLowerCase();
    if (!seen[key]) { seen[key] = true; uniquePaths.push(basePaths[b]); }
  }

  // Check each base path / exeName and base path / subdir / exeName
  for (var i = 0; i < uniquePaths.length; i++) {
    for (var e = 0; e < allExeNames.length; e++) {
      var direct = path.join(uniquePaths[i], allExeNames[e]);
      if (fs.existsSync(direct)) return direct;
      // Also check subdirs named after any variant
      for (var s = 0; s < allNames.length; s++) {
        var subDir = path.join(uniquePaths[i], allNames[s], allExeNames[e]);
        if (fs.existsSync(subDir)) return subDir;
      }
    }
  }

  // Level 2: Windows Registry Uninstall key (search all name variants)
  try {
    var regPaths = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (var r = 0; r < regPaths.length; r++) {
      for (var v = 0; v < allNames.length; v++) {
        try {
          // Search keys/values/data (no /d flag) for broader matching
          var regOutput = execSync(
            'reg query "' + regPaths[r] + '" /s /f "' + allNames[v] + '"',
            { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
          );
          var lines = regOutput.split('\n');
          for (var l = 0; l < lines.length; l++) {
            var line = lines[l].trim();
            // Extract DisplayIcon, InstallLocation, or UninstallString paths
            var match = line.match(/^\s*(DisplayIcon|InstallLocation|UninstallString)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
            if (match) {
              var val = match[2].trim();
              // UninstallString often includes quotes and args; extract the exe path
              if (match[1].toLowerCase() === 'uninstallstring') {
                var quoted = val.match(/^"([^"]+\.exe)"/i);
                if (quoted) val = quoted[1];
              }
              // DisplayIcon might include ",0" suffix, strip it
              val = val.replace(/,\d+$/, '');
              // If val is an exe, check if it matches any target name; also probe sibling dir
              if (fs.existsSync(val) && val.toLowerCase().endsWith('.exe')) {
                var valName = path.basename(val).toLowerCase();
                for (var e2 = 0; e2 < allExeNames.length; e2++) {
                  if (valName === allExeNames[e2].toLowerCase()) return val;
                }
                // Not a direct match — but it's in the same install dir; probe siblings
                var valDir = path.dirname(val);
                for (var e3 = 0; e3 < allExeNames.length; e3++) {
                  var candidate = path.join(valDir, allExeNames[e3]);
                  if (fs.existsSync(candidate)) return candidate;
                }
              }
              if (fs.existsSync(val) && fs.statSync(val).isDirectory()) {
                for (var e4 = 0; e4 < allExeNames.length; e4++) {
                  var candidate2 = path.join(val, allExeNames[e4]);
                  if (fs.existsSync(candidate2)) return candidate2;
                }
              }
            }
          }
        } catch (e) { /* registry key not found or permission denied */ }
      }
    }
  } catch (e) { /* registry search failed */ }

  // Level 3: PATH environment search (where command) — try all exe names
  for (var wn = 0; wn < allExeNames.length; wn++) {
    try {
      var whereOutput = execFileSync('where', [allExeNames[wn]], { encoding: 'utf8', timeout: 3000 }).trim();
      if (whereOutput) {
        var whereLines = whereOutput.split('\n');
        for (var w = 0; w < whereLines.length; w++) {
          var candidate = whereLines[w].trim();
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch (e) { /* not in PATH */ }
  }

  // Level 4: PowerShell Get-Command — try all exe names
  for (var gn = 0; gn < allExeNames.length; gn++) {
    try {
      var psOutput = execFileSync(
        'powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command -Name \'' + allExeNames[gn] + '\' -ErrorAction SilentlyContinue).Source'],
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      if (psOutput && fs.existsSync(psOutput)) return psOutput;
    } catch (e) { /* PS failed */ }
  }

  // Level 5: Deep recursive search (last resort, capped tight to avoid blocking)
  try {
    var deepRoots = [];
    if (process.env.ProgramFiles) deepRoots.push(process.env.ProgramFiles);
    if (process.env['ProgramFiles(x86)']) deepRoots.push(process.env['ProgramFiles(x86)']);
    if (process.env.LOCALAPPDATA) deepRoots.push(path.join(process.env.LOCALAPPDATA, 'Programs'));
    if (process.env.USERPROFILE) deepRoots.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs'));

    for (var dr = 0; dr < deepRoots.length; dr++) {
      try {
        var filterPattern = allNames[0]; // use primary name as wildcard base
        var psDeep = 'Get-ChildItem -Path "' + deepRoots[dr] + '" -Recurse -Filter "*' + filterPattern + '*.exe" -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName';
        var deepOutput = execFileSync(
          'powershell', ['-NoProfile', '-NonInteractive', '-Command', psDeep],
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        if (deepOutput) {
          var deepLines = deepOutput.split('\n');
          for (var dl = 0; dl < deepLines.length; dl++) {
            var candidate = deepLines[dl].trim();
            if (candidate && fs.existsSync(candidate)) return candidate;
          }
        }
      } catch (e) { /* deep search failed for this root */ }
    }
  } catch (e) { /* deep search failed */ }

  return null;
}

function loadCodexppManualConfig() {
  try {
    if (fs.existsSync(CODEXPP_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CODEXPP_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return {};
}

var _codexppPathCache = undefined;
var _codexppMgrPathCache = undefined;

function getCodexPlusPlusPath() {
  if (_codexppPathCache !== undefined) {
    // Verify cached path still exists
    if (_codexppPathCache && fs.existsSync(_codexppPathCache)) return _codexppPathCache;
    // Cache is stale (null or path gone) — re-scan so freshly installed Codex++ is detected
    _codexppPathCache = undefined;
  }
  // Check manual config first
  var manual = loadCodexppManualConfig();
  if (manual.codexppPath && fs.existsSync(manual.codexppPath)) {
    _codexppPathCache = manual.codexppPath;
    return _codexppPathCache;
  }
  // Windows filenames cannot contain '+', so try common variations
  _codexppPathCache = searchExecutable('codex-plus-plus', [
    'codexpp',
    'codexplusplus',
    'CodexPlusPlus',
    'CodexPP',
    'codex++',
    'Codex++'
  ]);
  return _codexppPathCache;
}

function getCodexPlusPlusManagerPath() {
  if (_codexppMgrPathCache !== undefined) {
    // Verify cached path still exists
    if (_codexppMgrPathCache && fs.existsSync(_codexppMgrPathCache)) return _codexppMgrPathCache;
    // Cache is stale (null or path gone) — re-scan
    _codexppMgrPathCache = undefined;
  }

  // 手动配置优先
  var manual = loadCodexppManualConfig();
  if (manual.codexppMgrPath && fs.existsSync(manual.codexppMgrPath)) {
    _codexppMgrPathCache = manual.codexppMgrPath;
    return _codexppMgrPathCache;
  }

  // 和 codex++ 主程序在同一目录，先查主程序位置再拼 manager 名
  var mainPath = getCodexPlusPlusPath();
  if (mainPath) {
    var mgrNames = ['codex-plus-plus-manager.exe', 'codexpp-manager.exe', 'codexplusplus-manager.exe', 'CodexPlusPlusManager.exe', 'CodexPPManager.exe'];
    var dir = path.dirname(mainPath);
    for (var i = 0; i < mgrNames.length; i++) {
      var candidate = path.join(dir, mgrNames[i]);
      if (fs.existsSync(candidate)) {
        _codexppMgrPathCache = candidate;
        return _codexppMgrPathCache;
      }
    }
  }

  // 主程序没找到或同目录没有 manager → 独立搜索
  _codexppMgrPathCache = searchExecutable('codex-plus-plus-manager', [
    'codexpp-manager',
    'codexplusplus-manager',
    'CodexPlusPlusManager',
    'CodexPPManager'
  ]);
  return _codexppMgrPathCache;
}

var _codexCheckCache = null;

function checkCodexInstalled() {
  if (_codexCheckCache) return _codexCheckCache;

  const codexInfo = getCodexInstallInfo();
  // Desktop: store version or exe in known paths
  const hasDesktop = codexInfo.type === 'store' || (codexInfo.type === 'exe' && codexInfo.path);
  // CLI: must be in PATH (not just a desktop exe)
  let hasCli = false;
  try {
    execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 2000 });
    hasCli = true;
  } catch {}
  _codexCheckCache = {
    codexCli: hasCli,
    codexDesktop: hasDesktop,
    codexType: codexInfo.type,
    codexPlusPlus: getCodexPlusPlusPath() !== null,
    codexPlusPlusManager: getCodexPlusPlusManagerPath() !== null,
  };
  return _codexCheckCache;
}

function startCodexCli() {
  try {
    // CLI mode specifically looks for npm global install or sandbox version,
    // NOT the Microsoft Store version (which is GUI-only).
    var cliPath = null;

    // 1. Check npm global install (prefer .cmd over shell script)
    try {
      var whereResult = execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 3000 }).trim();
      if (whereResult) {
        var lines = whereResult.split('\n');
        // First pass: find .cmd (Windows batch) or .ps1 (PowerShell)
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.endsWith('.cmd') || line.endsWith('.ps1')) {
            cliPath = line;
            break;
          }
        }
        // Second pass: find any npm path that isn't a bare shell script
        if (!cliPath) {
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.includes('npm') && line.includes('.') && !line.endsWith('\\npm\\codex')) {
              cliPath = line;
              break;
            }
          }
        }
        // Fallback: first result (will likely fail if it's a shell script, but worth trying)
        if (!cliPath) cliPath = lines[0].trim();
      }
    } catch {}

    // 2. Check .chatclaw sandbox version
    if (!cliPath) {
      var chatclawExe = path.join(process.env.USERPROFILE || '', '.chatclaw', 'native', 'bin', 'codex.exe');
      if (fs.existsSync(chatclawExe)) cliPath = chatclawExe;
    }

    if (!cliPath) {
      return { success: false, message: '未找到 Codex CLI，请运行 npm install -g @openai/codex 安装' };
    }

    trustCodexDirectory(PROJECT_DIR);
    var cmd = `start "Codex CLI" cmd /k ${cliPath} -C "${PROJECT_DIR.replace(/\\/g, '/')}"`;
    console.log('[codex] Starting CLI:', cmd);
    exec(cmd, { shell: true }, (err, stdout, stderr) => {
      if (err) console.error('[codex] CLI error:', err.message);
      if (stderr) console.error('[codex] CLI stderr:', stderr);
    });
    return { success: true, message: 'Codex CLI 启动命令已发送' };
  } catch (e) { return { success: false, message: `启动失败: ${e.message}` }; }
}



function startCodexApp(forceExe) {
  try {
    var installInfo;
    var installerPath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'Codex.exe');

    if (forceExe && fs.existsSync(installerPath)) {
      // User explicitly chose installer version
      installInfo = { type: 'exe', path: installerPath };
    } else {
      installInfo = getCodexInstallInfo();
    }

    if (installInfo.type === 'store') {
      trustCodexDirectory(PROJECT_DIR);
      const cmd = `powershell -Command "Start-Process 'shell:AppsFolder\\${installInfo.packageFamilyName}!App'"`;
      console.log('[codex] Starting Store app:', cmd);
      exec(cmd, { shell: true }, (err, stdout, stderr) => {
        if (err) console.error('[codex] App error:', err.message);
        if (stderr) console.error('[codex] App stderr:', stderr);
      });
      return { success: true, message: 'Codex Store 版启动命令已发送' };
    }

    if (installInfo.type === 'exe') {
      trustCodexDirectory(PROJECT_DIR);
      const codexPath = installInfo.path || 'codex';
      const cmd = `start "" "${codexPath}" app "${PROJECT_DIR}"`;
      console.log('[codex] Starting exe app:', cmd);
      exec(cmd, { shell: true }, (err, stdout, stderr) => {
        if (err) console.error('[codex] App error:', err.message);
        if (stderr) console.error('[codex] App stderr:', stderr);
      });
      return { success: true, message: 'Codex 桌面版启动命令已发送' };
    }

    // Fallback: try PATH
    try {
      execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 3000 });
    } catch {
      return { success: false, message: '未找到 Codex，请先安装 Codex（微软商店或官网下载）' };
    }
    trustCodexDirectory(PROJECT_DIR);
    exec(`start "" codex app "${PROJECT_DIR}"`, { shell: true });
    return { success: true, message: 'Codex 启动命令已发送（PATH 版本）' };
  } catch (e) { return { success: false, message: `启动失败: ${e.message}` }; }
}

function stopCodex(targetType) {
  // targetType: 'app' | 'cli' | 'codexpp' | 'all'（默认 'all'）
  targetType = targetType || 'all';
  try {
    var killed = [];
    var errors = [];

    if (targetType === 'codexpp' || targetType === 'all') {
      // Codex++ 和 Codex++ Manager
      var ppTargets = CODEX_PP_IMAGES.concat(['codex-plus-plus-manager.exe', 'codexpp-manager.exe']);
      for (var i = 0; i < ppTargets.length; i++) {
        try {
          execFileSync('taskkill', ['/IM', ppTargets[i], '/F'], { stdio: 'ignore' });
          killed.push(ppTargets[i]);
        } catch (e) { /* not running */ }
      }
    }

    if (targetType === 'app' || targetType === 'cli' || targetType === 'all') {
      // Codex 桌面版或 CLI 版都使用 codex.exe 进程名
      // 区分方式：通过进程路径判断
      if (targetType === 'cli') {
        try {
          var psScript = "Get-Process -Name 'codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike '*WindowsApps*' } | Stop-Process -Force";
          execFileSync('powershell', ['-Command', psScript], { stdio: 'ignore', timeout: 5000 });
          killed.push('codex (CLI)');
        } catch (e) { errors.push('codex CLI: ' + e.message); }
      } else if (targetType === 'app') {
        try {
          var psScript2 = "Get-Process -Name 'codex' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps*' -or $_.Path -like '*Programs*Codex*' } | Stop-Process -Force";
          execFileSync('powershell', ['-Command', psScript2], { stdio: 'ignore', timeout: 5000 });
          killed.push('codex (Desktop)');
        } catch (e) { errors.push('codex Desktop: ' + e.message); }
      } else {
        // all：杀所有 codex.exe
        try {
          execFileSync('taskkill', ['/IM', 'codex.exe', '/F'], { stdio: 'ignore' });
          killed.push('codex.exe');
        } catch (e) { /* not running */ }
      }
    }

    if (killed.length > 0) return { success: true, message: '已停止: ' + killed.join(', ') };
    if (errors.length > 0) return { success: false, message: '停止失败: ' + errors.join('; ') };
    return { success: true, message: 'Codex 未在运行' };
  } catch (e) {
    return { success: false, message: '停止失败: ' + (e.message || String(e)) };
  }
}

function startCodexPlusPlus() {
  try {
    // 不调用 trustCodexDirectory — Codex++ 是独立应用，有自己的配置目录
    // 如果写入 Codex CLI 的 config.toml，Codex++ 可能会尝试加载 PROJECT_DIR 导致渲染崩溃
    const codexPath = getCodexPlusPlusPath();
    if (!codexPath) return { success: false, message: '未找到 Codex++ 安装' };
    var cmd = 'start "" "' + codexPath + '"';
    console.log('[codex] Starting Codex++:', cmd);
    exec(cmd, { shell: true }, function (err, stdout, stderr) {
      if (err) console.error('[codex] Codex++ exec error:', err.message);
      if (stderr) console.error('[codex] Codex++ stderr:', stderr);
    });
    return { success: true, message: 'Codex++ 启动命令已发送' };
  } catch (e) { return { success: false, message: '启动失败: ' + e.message }; }
}

function startCodexPlusPlusManager() {
  try {
    const managerPath = getCodexPlusPlusManagerPath();
    if (!managerPath) return { success: false, message: '未找到 Codex++ 管理工具安装' };
    const cmd = `start "" "${managerPath}"`;
    console.log('[codex] Starting Codex++ Manager:', cmd);
    exec(cmd, { shell: true }, (err, stdout, stderr) => {
      if (err) console.error('[codex] Manager error:', err.message);
      if (stderr) console.error('[codex] Manager stderr:', stderr);
    });
    return { success: true, message: 'Codex++ 管理工具启动命令已发送' };
  } catch (e) { return { success: false, message: `启动失败: ${e.message}` }; }
}

// ==================== HTTP 工具 ====================
var MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_REQUEST_BODY_BYTES;
    req.on('data', c => {
      totalBytes += c.length;
      if (totalBytes > limit) {
        var err = new Error('Request body too large');
        err.statusCode = 413;
        req.destroy(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ==================== 自动拉取模型（核心）====================

// ---- Model URL helpers now imported from src/shared.mjs ----
// (stripEndpointSuffix, normalizeModelsUrl, buildModelCandidateUrls, 
//  requestModelsOnce, fetchModelsFromAPI)

// ---- SSRF Protection ----
// Blocks cloud metadata endpoints and internal-only addresses that
// should never be legitimate LLM provider targets.
var SSRF_BLOCKED_HOSTS = [
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
  'localhost',
  'localhost.localdomain'
];

function normalizeIpv4Literal(hostname) {
  if (!/^\d+$/.test(hostname)) return hostname;
  var num = Number(hostname);
  if (!Number.isInteger(num) || num < 0 || num > 0xFFFFFFFF) return hostname;
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255
  ].join('.');
}

function isPrivateIpv4(hostname) {
  var normalized = normalizeIpv4Literal(hostname);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  var parts = normalized.split('.').map(function(part) { return Number(part); });
  if (parts.some(function(part) { return !Number.isInteger(part) || part < 0 || part > 255; })) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] >= 224) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  var normalized = String(hostname || '').toLowerCase();
  if (!normalized) return false;
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice(7));
  }
  return false;
}

function validateProviderUrl(urlStr) {
  try {
    var parsed = new URL(urlStr);
    var hostname = parsed.hostname.toLowerCase();

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only http/https protocols are allowed' };
    }

    for (var i = 0; i < SSRF_BLOCKED_HOSTS.length; i++) {
      if (hostname === SSRF_BLOCKED_HOSTS[i]) {
        return { valid: false, error: 'SSRF blocked: internal address not allowed' };
      }
    }

    if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
      return { valid: false, error: 'SSRF blocked: private or loopback address not allowed' };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'Invalid URL: ' + e.message };
  }
}


const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:' + UI_PORT);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // CSRF token validation for all write operations
  if (method !== 'GET') {
    if (!validateCsrf(req, res)) return;
  }

  // ==================== Codex 配置备份与恢复（变量/函数定义，必须在路由处理器之前）====================

  const CODEX_BACKUP_MAX = 50;
  var CODEX_BACKUP_DIR = IS_INSTALLED
    ? path.join(APP_DATA_BASE, 'CodexAssistant', 'backup')
    : path.join(PROJECT_DIR, 'backup');

  function getCodexBackupDir() {
    if (!fs.existsSync(CODEX_BACKUP_DIR)) fs.mkdirSync(CODEX_BACKUP_DIR, { recursive: true });
    return CODEX_BACKUP_DIR;
  }

  function isAllowedOpenFolderPath(targetPath) {
    if (!targetPath) return { allowed: false, detail: 'empty path' };
    var p = String(targetPath);
    // Must exist on disk as a directory
    try {
      if (!fs.existsSync(p)) return { allowed: false, detail: 'path does not exist', target: p };
      if (!fs.statSync(p).isDirectory()) return { allowed: false, detail: 'not a directory', target: p };
    } catch (e) {
      return { allowed: false, detail: 'stat error: ' + (e && e.message ? e.message : String(e)) };
    }
    // Must be inside one of the allowed base directories
    var bases = [PROJECT_DIR, USER_DIR, getCodexBackupDir(), CODEX_CONFIG_DIR,
                 process.env.USERPROFILE, process.env.HOME, process.cwd()];
    var n = String(p).toLowerCase().replace(/\/+$/, '').replace(/\\+$/, '');
    for (var i = 0; i < bases.length; i++) {
      var b = bases[i];
      if (!b) continue;
      var bn = String(b).toLowerCase().replace(/\/+$/, '').replace(/\\+$/, '');
      if (!bn) continue;
      if (n === bn || (n + '\\').startsWith(bn + '\\')) return { allowed: true };
    }
    return { allowed: false, detail: 'not in allowed paths', target: p };
  }

  function resolveBackupEntry(name, options) {
    options = options || {};
    var backupDir = getCodexBackupDir();
    if (!name || typeof name !== 'string') {
      throw new Error('请指定备份文件名');
    }
    var trimmed = name.trim();
    if (!trimmed || path.basename(trimmed) !== trimmed || trimmed.includes('/') || trimmed.includes('\\')) {
      throw new Error('非法的备份文件名');
    }
    var allowedNames = fs.readdirSync(backupDir).filter(function(file) {
      if (options.allowLockedFile) return file.endsWith('.zip') || file.endsWith('.zip.locked') || file.endsWith('.locked');
      return file.endsWith('.zip');
    });
    if (allowedNames.indexOf(trimmed) === -1) {
      throw new Error('备份文件不存在');
    }
    var resolved = path.resolve(backupDir, trimmed);
    var baseDir = path.resolve(backupDir) + path.sep;
    if (!resolved.startsWith(baseDir)) {
      throw new Error('非法的备份文件路径');
    }
    return resolved;
  }

  // 静态文件（开发模式禁用缓存，确保代码修改立即生效）
  var noCache = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };
  if (pathname === '/' || pathname === '/index.html') {
    var fp = path.join(PROJECT_DIR, 'ui-frontend.html');
    if (fs.existsSync(fp)) {
      var html = fs.readFileSync(fp, 'utf8');
      var csrfMeta = '<meta name="csrf-token" content="' + CSRF_TOKEN + '">';
      html = html.replace('</head>', csrfMeta + '\n</head>');
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, noCache));
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('ui-frontend.html not found');
    }
    return;
  }

  // Serve CSS and JS static files
  if (pathname === '/ui-frontend.css') {
    const fp = path.join(PROJECT_DIR, 'ui-frontend.css');
    if (fs.existsSync(fp)) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/css; charset=utf-8' }, noCache));
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  if (pathname === '/ui-frontend.js') {
    const fp = path.join(PROJECT_DIR, 'ui-frontend.js');
    if (fs.existsSync(fp)) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, noCache));
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  // Module JS files
  var staticModules = ['common.js', 'dashboard.js', 'providers.js', 'env.js', 'backup.js', 'settings.js'];
  if (staticModules.indexOf(pathname.slice(1)) !== -1) {
    const fp = path.join(PROJECT_DIR, pathname.slice(1));
    if (fs.existsSync(fp)) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, noCache));
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  if (pathname === '/ui-favicon.ico') {
    const fp = path.join(PROJECT_DIR, 'ui-favicon.ico');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  if (pathname === '/ui-favicon.png') {
    const fp = path.join(PROJECT_DIR, 'ui-favicon.png');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  if (pathname === '/logo-baidu-pan.png') {
    const fp = path.join(PROJECT_DIR, 'logo-baidu-pan.png');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }
  if (pathname === '/logo-lanzou.png') {
    const fp = path.join(PROJECT_DIR, 'logo-lanzou.png');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(fp));
    } else { res.writeHead(404); res.end(); }
    return;
  }

  // API: 打开外部链接
  if (pathname === '/api/open-url' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var url = data.url || '';
      if (!url) return sendJson(res, 400, { success: false, error: 'url is required' });
      var parsedTarget = new URL(url);
      if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
        return sendJson(res, 400, { success: false, error: 'Only http/https URLs allowed' });
      }
      execFile('cmd', ['/c', 'start', '', parsedTarget.toString()], { windowsHide: true });
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 打开文件夹
  if (pathname === '/api/open-folder' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var folderPath = data.path;
      if (!folderPath || typeof folderPath !== 'string') {
        return sendJson(res, 400, { success: false, error: 'path is required' });
      }
      var check = isAllowedOpenFolderPath(folderPath);
      if (!check.allowed) {
        return sendJson(res, 400, { success: false, error: check.detail, target: check.target });
      }
      execFile('explorer', [folderPath]);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 通过 UI 服务中转代理模型列表，避免前端直接跨域访问 proxy 端口
  if (pathname === '/api/proxy-models' && method === 'GET') {
    try {
      const env = readEnv();
      var proxyPort = parseInt(env.PROXY_PORT || '4000', 10);
      var authKey = env.PROXY_AUTH_KEY || '';
      var opts = {};
      if (authKey) opts.headers = { 'Authorization': 'Bearer ' + authKey };
      var resp = await fetch('http://127.0.0.1:' + proxyPort + '/v1/models', opts);
      var result = await resp.json();
      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 状态
  if (pathname === '/api/status' && method === 'GET') {
    const env = readEnv();
    var port = parseInt(env.PROXY_PORT || '4000', 10);
    // Dual-check: process handle + port probe (handles Windows cmd.exe premature exit)
    var processAlive = proxyProcess !== null;
    var portAlive = false;
    if (processAlive) {
      portAlive = true;
    } else {
      portAlive = await checkProxyPortListening(port);
    }
    return sendJson(res, 200, {
      proxy_running: processAlive || portAlive,
      proxy_process_alive: processAlive,
      proxy_port_alive: portAlive,
      proxy_managed_by_ui: processAlive,
      proxy_external_alive: !processAlive && portAlive,
      codex_running: checkCodex(),
      codex_running_type: checkCodexRunningType(),
      env,
      port: String(port),
    });
  }

  // API: 获取提供商列表
  if (pathname === '/api/providers' && method === 'GET') {
    return sendJson(res, 200, readProviders());
  }

  // API: 保存提供商列表
  if (pathname === '/api/providers' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body);
      // Silently normalize base_url: strip /chat/completions, /completions, /embeddings suffixes
      if (data.providers) {
        data.providers = data.providers.map(function(p) {
          if (p.base_url) {
            p.base_url = p.base_url.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '').replace(/\/embeddings$/i, '');
          }
          return p;
        });
      }
      writeProviders(data);
      generateProxyModels();
      var providerNames = (data.providers || []).map(function(p) { return p.name || p.id || '?'; }).join(', ');
      logOperation('provider', 'save', 'Saved providers: ' + providerNames);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      logOperation('provider', 'save', 'Failed to save providers', e);
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 自动拉取模型列表
  if (pathname === '/api/fetch-models' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var params = JSON.parse(body);
      var base_url = params.base_url;
      var api_key = params.api_key;
      if (!base_url) return sendJson(res, 400, { success: false, error: 'base_url 不能为空' });
      if (!api_key) return sendJson(res, 400, { success: false, error: 'api_key 不能为空' });
      
      // SSRF validation
      var urlCheck = validateProviderUrl(base_url);
      if (!urlCheck.valid) return sendJson(res, 400, { success: false, error: urlCheck.error });
      
      var models = await fetchModelsFromAPI(base_url, api_key);
      return sendJson(res, 200, { success: true, models: models });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 生成 user/proxy-models.json
  if (pathname === '/api/generate-models' && method === 'POST') {
    try {
      generateProxyModels();
      return sendJson(res, 200, { success: true, message: 'user/proxy-models.json 已生成' });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: .env 读写
  if (pathname === '/api/env' && method === 'GET') {
    const env = readEnv();
    
    // 同时返回 Codex auth 中的 key（用于前端显示同步状态）
    const auth = readCodexAuth();
    env.CODEX_API_KEY = auth.OPENAI_API_KEY || '';
    return sendJson(res, 200, env);
  }
  if (pathname === '/api/env' && method === 'PUT') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body);
      
      // Whitelist validation: reject unknown keys
      var allowedKeys = new Set(GLOBAL_ENV_KEYS);
      var rejectedKeys = [];
      for (var k of Object.keys(data)) {
        if (k === 'CODEX_API_KEY') continue; // handled separately
        if (!allowedKeys.has(k)) rejectedKeys.push(k);
      }
      if (rejectedKeys.length > 0) {
        return sendJson(res, 400, {
          success: false,
          error: 'Unknown config keys: ' + rejectedKeys.join(', ') + '. Allowed: ' + GLOBAL_ENV_KEYS.join(', ')
        });
      }
      
      // 如果有 CODEX_API_KEY，同步更新 Codex auth.json
      if (data.CODEX_API_KEY !== undefined) {
        var auth = readCodexAuth();
        auth.OPENAI_API_KEY = data.CODEX_API_KEY;
        writeCodexAuth(auth);
        delete data.CODEX_API_KEY;
      }
      writeEnv(data);
      
      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: Codex 配置
  if (pathname === '/api/codex-config' && method === 'GET') {
    const content = readCodexConfig();
    return sendJson(res, 200, { content, parsed: parseToml(content) });
  }
  if (pathname === '/api/codex-config' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { model, port, context_window } = JSON.parse(body);
      const env = readEnv();
      const actualPort = port || env.PROXY_PORT || '4000';

      ensureCodexHeader();
      updateCodexTopKey('model', JSON.stringify(model));
      updateCodexTopKey('model_reasoning_effort', '"medium"');
      updateCodexTopKey('model_provider', '"local_proxy"');
      if (context_window && context_window > 0) {
        updateCodexTopKey('model_context_window', String(context_window));
      }
      updateCodexTopKey('max_tokens', '4096');
      updateCodexTopKey('enable_request_compression', 'false');
      updateCodexTopKey('allow_model_truncation', 'false');
      updateCodexSectionKey('model_providers.local_proxy', 'name', JSON.stringify(model));
      updateCodexSectionKey('model_providers.local_proxy', 'base_url', '"http://127.0.0.1:' + actualPort + '/v1"');
      updateCodexSectionKey('model_providers.local_proxy', 'wire_api', '"responses"');
      updateCodexSectionKey('model_providers.local_proxy', 'requires_openai_auth', 'true');

      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // NOTE: CODEX_BACKUP_DIR / getCodexBackupDir / isAllowedOpenFolderPath / resolveBackupEntry 已移至本文件上方（路由处理器之前）

  function hasCodexMarker(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.startsWith(CODEX_MARKER);
    } catch { return false; }
  }

  function backupCodexFiles(label, prefix) {
    prefix = prefix || '用户手动备份';
    const backupDir = getCodexBackupDir();
    const zipName = `${prefix}-${label || backupTimestamp()}.zip`;
    const zipPath = path.join(backupDir, zipName);

    const filesToBackup = [];
    const configPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
    const authPath = path.join(CODEX_CONFIG_DIR, 'auth.json');
    if (fs.existsSync(configPath)) filesToBackup.push({ name: 'config.toml', path: configPath });
    if (fs.existsSync(authPath)) filesToBackup.push({ name: 'auth.json', path: authPath });

    if (filesToBackup.length === 0) return null;

    // 计算当前文件哈希，与上次备份对比，相同则跳过
    var hash = crypto.createHash('sha256');
    for (var fi = 0; fi < filesToBackup.length; fi++) {
      hash.update(fs.readFileSync(filesToBackup[fi].path));
    }
    var currentHash = hash.digest('hex');
    var hashFile = path.join(backupDir, '.backup-hash');
    if (fs.existsSync(hashFile)) {
      var lastHash = fs.readFileSync(hashFile, 'utf8').trim();
      if (lastHash === currentHash) {
        console.log('[backup] Skipped: config unchanged since last backup');
        return 'SKIPPED';
      }
    }
    fs.writeFileSync(hashFile, currentHash);

    // Create zip using PowerShell
    const tempDir = path.join(os.tmpdir(), 'codex-backup-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
    for (const f of filesToBackup) {
      fs.copyFileSync(f.path, path.join(tempDir, f.name));
    }
    try {
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipPath}' -Force`
      ], { stdio: 'ignore' });
    } finally {
      try { fs.rmSync(tempDir, { recursive: true }); } catch {}
    }

    // Cleanup old backups (keep max CODEX_BACKUP_MAX)
    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip')).sort();
    while (backups.length > CODEX_BACKUP_MAX) {
      try { fs.unlinkSync(path.join(backupDir, backups.shift())); } catch {}
    }

    return zipPath;
  }

  function markCodexFile(filePath) {
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      if (!content.startsWith(CODEX_MARKER)) {
        content = CODEX_MARKER + '\n' + content;
        fs.writeFileSync(filePath, content, 'utf8');
      }
    } catch {}
  }

  // API: 获取备份列表
  if (pathname === '/api/codex-backup/list' && method === 'GET') {
    try {
      const backupDir = getCodexBackupDir();
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.zip'))
        .map(f => {
          const stat = fs.statSync(path.join(backupDir, f));
          const locked = fs.existsSync(path.join(backupDir, f + '.locked'));
          return { name: f, size: stat.size, time: stat.mtimeMs, locked };
        })
        .sort((a, b) => b.time - a.time);
      // Check if config has Codex Assistant marker
      const configPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
      const isModified = hasCodexMarker(configPath);
      return sendJson(res, 200, { backups, isModified, backupDir: CODEX_BACKUP_DIR });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 手动备份
  if (pathname === '/api/codex-backup/create' && method === 'POST') {
    try {
      const zipPath = backupCodexFiles();
      if (zipPath === 'SKIPPED') return sendJson(res, 200, { skipped: true, message: '当前配置与上次备份配置相同，已为您自动跳过备份' });
      if (!zipPath) return sendJson(res, 400, { success: false, error: '没有可备份的 Codex 配置文件' });
      return sendJson(res, 200, { success: true, path: zipPath, message: '备份已创建' });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 恢复备份
  if (pathname === '/api/codex-backup/restore' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { name } = JSON.parse(body || '{}');
      if (!name) return sendJson(res, 400, { success: false, error: '请指定备份文件名' });

      const zipPath = resolveBackupEntry(name);

      // Backup current config before restoring
      backupCodexFiles(backupTimestamp(), '从备份恢复时自动备份');

      // Extract zip to temp and copy files
      const tempDir = path.join(os.tmpdir(), 'codex-restore-' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });
      try {
        execFileSync('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force`
        ], { stdio: 'ignore' });
        const configPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
        const authPath = path.join(CODEX_CONFIG_DIR, 'auth.json');
        const restoredConfig = path.join(tempDir, 'config.toml');
        const restoredAuth = path.join(tempDir, 'auth.json');
        if (fs.existsSync(restoredConfig)) fs.copyFileSync(restoredConfig, configPath);
        if (fs.existsSync(restoredAuth)) fs.copyFileSync(restoredAuth, authPath);
        return sendJson(res, 200, { success: true, message: '配置已恢复，请重启 Codex 使更改生效' });
      } finally {
        try { fs.rmSync(tempDir, { recursive: true }); } catch {}
      }
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 自动备份（首次启动时调用）
  if (pathname === '/api/codex-backup/auto' && method === 'POST') {
    try {
      const configPath = path.join(CODEX_CONFIG_DIR, 'config.toml');
      if (!fs.existsSync(configPath)) return sendJson(res, 200, { skipped: true });
      // Only backup if config doesn't have our marker (first time or restored by user)
      if (!hasCodexMarker(configPath)) {
        const zipPath = backupCodexFiles(backupTimestamp(), '配置变更自动备份');
        if (zipPath) return sendJson(res, 200, { backedUp: true, path: zipPath });
      }
      return sendJson(res, 200, { backedUp: false });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 删除备份
  if (pathname === '/api/codex-backup/delete' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { name } = JSON.parse(body || '{}');
      const zipPath = resolveBackupEntry(name);
      // Check if locked
      const lockPath = zipPath + '.locked';
      if (fs.existsSync(lockPath)) return sendJson(res, 403, { success: false, error: '备份已锁定，请先解锁后再删除' });
      fs.unlinkSync(zipPath);
      
      // 删除备份后，清除哈希缓存，允许重新备份相同配置
      try {
        const backupDir = getCodexBackupDir();
        const hashFile = path.join(backupDir, '.backup-hash');
        if (fs.existsSync(hashFile)) {
          // 检查是否还有其他备份文件存在
          const remainingBackups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
          if (remainingBackups.length === 0) {
            // 没有剩余备份，删除哈希文件
            fs.unlinkSync(hashFile);
            console.log('[backup] Cleared hash cache: no backups remaining');
          } else {
            // 还有备份，删除哈希文件以便下次备份时重新计算
            fs.unlinkSync(hashFile);
            console.log('[backup] Cleared hash cache: backup deleted, will re-check on next backup');
          }
        }
      } catch (hashErr) {
        console.warn('[backup] Failed to clear hash cache:', hashErr.message);
      }
      
      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 锁定/解锁备份
  if (pathname === '/api/codex-backup/lock' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { name, locked } = JSON.parse(body || '{}');
      const zipPath = resolveBackupEntry(name);
      const lockPath = zipPath + '.locked';
      if (locked) {
        fs.writeFileSync(lockPath, '', 'utf8');
      } else {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 重命名备份
  if (pathname === '/api/codex-backup/rename' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { name, newName } = JSON.parse(body || '{}');
      const oldPath = resolveBackupEntry(name);
      if (!newName || path.basename(newName) !== newName || newName.includes('/') || newName.includes('\\') || !newName.endsWith('.zip')) {
        return sendJson(res, 400, { success: false, error: '请输入有效的新文件名' });
      }
      const backupDir = getCodexBackupDir();
      const newPath = path.resolve(backupDir, newName);
      if (!newPath.startsWith(path.resolve(backupDir) + path.sep)) {
        return sendJson(res, 400, { success: false, error: '非法的目标路径' });
      }
      if (fs.existsSync(newPath)) return sendJson(res, 409, { success: false, error: '目标文件名已存在' });
      fs.renameSync(oldPath, newPath);
      // Also rename lock file if exists
      const oldLock = oldPath + '.locked';
      const newLock = newPath + '.locked';
      if (fs.existsSync(oldLock)) fs.renameSync(oldLock, newLock);
      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 更新辅助模型配置
  if (pathname === '/api/update-aux-model' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const { mainModel, mainProvider, auxModel, auxProvider, aliases } = JSON.parse(body);
      
      // 读取当前的辅助模型配置
      const auxConfigPath = path.join(USER_DIR, 'aux-model-config.json');
      let auxConfig = {};
      try {
        auxConfig = JSON.parse(fs.readFileSync(auxConfigPath, 'utf-8'));
      } catch {}
      
      // 更新配置
      if (mainModel !== undefined) auxConfig.mainModel = mainModel;
      if (mainProvider !== undefined) auxConfig.mainProvider = mainProvider;
      if (auxModel !== undefined) auxConfig.auxModel = auxModel;
      if (auxProvider !== undefined) auxConfig.auxProvider = auxProvider;
      if (aliases !== undefined) auxConfig.aliases = aliases;
      auxConfig.updatedAt = new Date().toISOString();
      
      // 保存配置
      fs.writeFileSync(auxConfigPath, JSON.stringify(auxConfig, null, 2));
      
      return sendJson(res, 200, { success: true, config: auxConfig, needRestart: true });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 获取辅助模型配置
  if (pathname === '/api/get-aux-model' && method === 'GET') {
    try {
      const auxConfigPath = path.join(USER_DIR, 'aux-model-config.json');
      let auxConfig = {};
      try {
        auxConfig = JSON.parse(fs.readFileSync(auxConfigPath, 'utf-8'));
      } catch {}
      return sendJson(res, 200, auxConfig);
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 配置同步检查
  if (pathname === '/api/sync-config' && method === 'POST') {
    try {
      const result = await syncCodexConfig();
      return sendJson(res, 200, result);
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 消息上下文裁剪配置
  if (pathname === '/api/trim-config' && method === 'GET') {
    try {
      const trimPath = path.join(USER_DIR, 'message-trim-config.json');
      let config = { enabled: true, keepToolRounds: 20 };
      try { config = JSON.parse(fs.readFileSync(trimPath, 'utf-8')); } catch {}
      return sendJson(res, 200, config);
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/trim-config' && method === 'POST') {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const config = {
        enabled: !!body.enabled,
        keepToolRounds: Math.max(5, Math.min(50, Number(body.keepToolRounds) || 20)),
        updatedAt: new Date().toISOString()
      };
      const trimPath = path.join(USER_DIR, 'message-trim-config.json');
      fs.writeFileSync(trimPath, JSON.stringify(config, null, 2), 'utf-8');
      proxyLog.push({ time: new Date().toISOString(), type: 'system', msg: '上下文裁剪已' + (config.enabled ? '开启' : '关闭') + ' (保留最近 ' + config.keepToolRounds + ' 轮，代理下次请求立即生效)' });
      if (proxyLog.length > PROXY_LOG_MAX) proxyLog.shift();
      return sendJson(res, 200, { success: true, config });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // API: 转发代理统计（避免跨域问题）
  if (pathname === '/api/proxy-stats' && method === 'GET') {
    try {
      const proxyPort = process.env.PROXY_PORT || '4000';
      const statsUrl = 'http://127.0.0.1:' + proxyPort + '/v1/stats';
      const resp = await fetch(statsUrl, { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 200, { error: 'proxy not reachable' }); }
  }

  // API: 代理启停
  if (pathname === '/api/proxy/start' && method === 'POST') {
    // 启动前先同步配置
    const syncResult = await syncCodexConfig();
    const result = await startProxy();
    result.synced = syncResult.synced;
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/proxy/stop' && method === 'POST') {
    return sendJson(res, 200, stopProxy());
  }
  if (pathname === '/api/proxy/restart' && method === 'POST') {
    await stopProxy();
    // 等待端口释放
    await new Promise(r => setTimeout(r, 1500));
    const result = await startProxy();
    return sendJson(res, 200, result);
  }

  // API: Codex 启停
  if (pathname === '/api/codex/start-cli' && method === 'POST') {
    return sendJson(res, 200, startCodexCli());
  }
  if (pathname === '/api/codex/start-app' && method === 'POST') {
    var forceExe = parsedUrl.searchParams.get('version') === 'exe';
    return sendJson(res, 200, startCodexApp(forceExe));
  }
  if (pathname === '/api/codex/start-codexpp' && method === 'POST') {
    return sendJson(res, 200, startCodexPlusPlus());
  }
  if (pathname === '/api/codex/start-codexpp-manager' && method === 'POST') {
    return sendJson(res, 200, startCodexPlusPlusManager());
  }
  if (pathname === '/api/codex/stop' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      return sendJson(res, 200, stopCodex(data.type));
    } catch (e) {
      return sendJson(res, 200, stopCodex('all'));
    }
  }
  if (pathname === '/api/codex/check-installed' && method === 'GET') {
    return sendJson(res, 200, checkCodexInstalled());
  }

  // 独立检测端点：各自缓存，并行返回，前端逐项显示
  if (pathname === '/api/codex/check-cli' && method === 'GET') {
    var cliOk = false;
    try { execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 2000 }); cliOk = true; } catch (_) {}
    return sendJson(res, 200, { ok: cliOk });
  }
  if (pathname === '/api/codex/check-desktop' && method === 'GET') {
    var info = getCodexInstallInfo();
    // Check installer path separately
    var installerPath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'Codex.exe');
    var hasExe = fs.existsSync(installerPath);
    return sendJson(res, 200, {
      hasStore: info.type === 'store',
      hasExe: hasExe,
      ok: info.type === 'store' || hasExe,
      type: info.type,
      packageFamilyName: info.packageFamilyName || '',
      path: info.path || ''
    });
  }
  if (pathname === '/api/codex/check-plusplus' && method === 'GET') {
    var ppPath = getCodexPlusPlusPath();
    return sendJson(res, 200, { ok: ppPath !== null, path: ppPath || '' });
  }
  if (pathname === '/api/codex/check-plusplus-manager' && method === 'GET') {
    var mgrPath = getCodexPlusPlusManagerPath();
    return sendJson(res, 200, { ok: mgrPath !== null, path: mgrPath || '' });
  }

  // API: Codex++ 手动路径配置
  
  if (pathname === '/api/codexpp-path' && method === 'GET') {
    try {
      var codexppCfg = {};
      if (fs.existsSync(CODEXPP_CONFIG_FILE)) {
        codexppCfg = JSON.parse(fs.readFileSync(CODEXPP_CONFIG_FILE, 'utf-8'));
      }
      // 如果手动配置中没有路径，尝试自动检测
      if (!codexppCfg.codexppPath) {
        var detectedPath = getCodexPlusPlusPath();
        if (detectedPath) codexppCfg.codexppPath = detectedPath;
      }
      if (!codexppCfg.codexppMgrPath) {
        var detectedMgrPath = getCodexPlusPlusManagerPath();
        if (detectedMgrPath) codexppCfg.codexppMgrPath = detectedMgrPath;
      }
      return sendJson(res, 200, codexppCfg);
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/codexpp-path' && method === 'POST') {
    try {
      var body = JSON.parse(await collectBody(req) || '{}');
      var codexppCfg = {};
      if (body.codexppPath) codexppCfg.codexppPath = body.codexppPath;
      if (body.codexppMgrPath) codexppCfg.codexppMgrPath = body.codexppMgrPath;
      fs.writeFileSync(CODEXPP_CONFIG_FILE, JSON.stringify(codexppCfg, null, 2));
      return sendJson(res, 200, { success: true });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  // API: 选择文件
  if (pathname === '/api/select-file' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var title = data.title || '选择文件';
      var defaultPath = data.defaultPath || '';
      var filter = data.filter || '';
      
      var psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$openFileDialog = New-Object System.Windows.Forms.OpenFileDialog',
        '$openFileDialog.Title = "' + title.replace(/"/g, '""') + '"',
      ];
      if (defaultPath && fs.existsSync(defaultPath)) {
        psScript.push('$openFileDialog.InitialDirectory = "' + path.dirname(defaultPath).replace(/"/g, '""') + '"');
      }
      if (filter) {
        psScript.push('$openFileDialog.Filter = "' + filter + '|' + filter + '"');
      } else {
        psScript.push('$openFileDialog.Filter = "可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*"');
      }
      psScript.push(
        '$result = $openFileDialog.ShowDialog()',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  $openFileDialog.FileName',
        '}'
      );
      
      var selectedPath = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript.join('\n')], {
        encoding: 'utf8',
        timeout: 60000
      }).trim();
      
      if (selectedPath) {
        return sendJson(res, 200, { success: true, path: selectedPath });
      } else {
        return sendJson(res, 200, { success: false, message: '未选择文件' });
      }
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 保存文件（弹窗选择保存位置）
  if (pathname === '/api/save-file-dialog' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var content = data.content || '';
      var defaultName = data.defaultName || 'export.txt';
      var filter = data.filter || '文本文件 (*.txt)|*.txt|所有文件 (*.*)|*.*';
      
      // PowerShell SaveFileDialog
      var safeFilter = filter.replace(/"/g, '""');
      var safeDefaultName = defaultName.replace(/"/g, '""');
      
      var psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$saveDialog = New-Object System.Windows.Forms.SaveFileDialog',
        '$saveDialog.Filter = "' + safeFilter + '"',
        '$saveDialog.FileName = "' + safeDefaultName + '"',
        '$saveDialog.DefaultExt = "txt"',
        '$saveDialog.AddExtension = $true',
        '$result = $saveDialog.ShowDialog()',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  $saveDialog.FileName',
        '}'
      ].join('\n');
      
      var selectedPath = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 120000
      }).trim();
      
      if (!selectedPath) {
        return sendJson(res, 200, { success: false, message: '未选择保存路径' });
      }
      
      fs.writeFileSync(selectedPath, content, 'utf-8');
      return sendJson(res, 200, { success: true, path: selectedPath });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 保存文件（直接保存到用户桌面，不弹窗，避免阻塞事件循环）
  if (pathname === '/api/save-file' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var content = data.content || '';
      var defaultName = data.defaultName || 'export.json';

      // 保存到用户桌面
      var desktopDir = path.join(os.homedir(), 'Desktop');
      if (!fs.existsSync(desktopDir)) {
        fs.mkdirSync(desktopDir, { recursive: true });
      }
      var savePath = path.join(desktopDir, defaultName);
      // 避免覆盖：加序号
      if (fs.existsSync(savePath)) {
        var ext = path.extname(defaultName);
        var base = path.basename(defaultName, ext);
        for (var idx = 1; idx < 100; idx++) {
          savePath = path.join(desktopDir, base + '-' + idx + ext);
          if (!fs.existsSync(savePath)) break;
        }
      }

      fs.writeFileSync(savePath, content, 'utf-8');
      return sendJson(res, 200, { success: true, path: savePath });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 选择文件夹
  if (pathname === '/api/select-folder' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var data = JSON.parse(body || '{}');
      var title = data.title || '选择文件夹';
      var defaultPath = data.defaultPath || '';
      
      // PowerShell argument escaping: double all double-quotes
      var safeTitle = title.replace(/"/g, '""');
      var safeDefaultPath = defaultPath.replace(/"/g, '""');
      
      var psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$folderBrowser.Description = "' + safeTitle + '"',
        '$folderBrowser.ShowNewFolderButton = $true',
        'if ("' + safeDefaultPath + '" -and (Test-Path "' + safeDefaultPath + '")) {',
        '  $folderBrowser.SelectedPath = "' + safeDefaultPath + '"',
        '}',
        '$result = $folderBrowser.ShowDialog()',
        'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  $folderBrowser.SelectedPath',
        '}'
      ].join('\n');
      
      var selectedPath = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 60000
      }).trim();
      
      if (selectedPath) {
        return sendJson(res, 200, { success: true, path: selectedPath });
      } else {
        return sendJson(res, 200, { success: false, message: '未选择目录' });
      }
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 操作日志（支持 category/action/success 筛选）
  if (pathname === '/api/operation-logs' && method === 'GET') {
    var opsUrl = new URL(req.url, 'http://localhost');
    var opsLimit = Math.min(parseInt(opsUrl.searchParams.get('limit') || '100', 10) || 100, 500);
    var opsOffset = parseInt(opsUrl.searchParams.get('offset') || '0', 10) || 0;
    var opsCategory = opsUrl.searchParams.get('category') || '';
    var opsAction = opsUrl.searchParams.get('action') || '';
    var opsSuccess = opsUrl.searchParams.get('success') || '';
    try {
      var opsResult = readOperationLogs({
        limit: opsLimit,
        offset: opsOffset,
        category: opsCategory,
        action: opsAction,
        success: opsSuccess
      });
      sendJson(res, 200, opsResult);
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Failed to read operation logs: ' + e.message });
    }
    return;
  }

  if (pathname === '/api/logs' && method === 'GET') {
    var url2 = new URL(req.url, 'http://localhost');
    var limit = parseInt(url2.searchParams.get('limit') || '500', 10);
    var offset = parseInt(url2.searchParams.get('offset') || '0', 10);
    var cursor = parseLogCursor(url2.searchParams.get('cursor'));
    var mode = url2.searchParams.get('mode') || 'combined';
    limit = Math.min(Math.max(limit || 500, 1), 2000);

    var disk = readLatestDiskProxyLogs(limit, cursor);
    var memoryLogs = proxyLog.slice(offset, offset + limit).map(function(l) {
      return Object.assign({ source: 'memory' }, l);
    });
    var diskLogs = disk.logs || [];

    var logs;
    if (mode === 'memory') {
      logs = memoryLogs;
    } else if (mode === 'disk') {
      logs = diskLogs;
    } else {
      // 仅返回当前会话的日志：内存 + 当前会话的磁盘日志
      // 不加载旧会话的磁盘日志
      if (disk.no_current_session) {
        // 当前代理未运行或刚启动还没有新日志文件
        logs = memoryLogs.length > 0 ? memoryLogs : [];
      } else {
        // 去重合并：磁盘日志优先，内存日志补充非格式化消息
        var memoryHasFormattedProxyLogs = memoryLogs.some(function(l) { return isFormattedProxyOutput(l.msg); });
        var useDiskPrimary = proxyProcess && diskLogs.length > 0 && memoryHasFormattedProxyLogs;
        if (useDiskPrimary) {
          // Disk has formatted proxy output (from proxy.mjs file logging).
          // Use disk as primary, supplement with memory entries that are NOT formatted proxy output
          // (e.g. ui-server system messages, codex start/stop events).
          logs = diskLogs.concat(memoryLogs.filter(function(l) { return !isFormattedProxyOutput(l.msg); }));
        } else {
          // No disk logs or proxy not managed by us — use memory, deduplicate with disk
          logs = memoryLogs.concat(diskLogs.filter(function(l) {
            return !memoryLogs.some(function(m) { return String(m.msg || '').trim() === String(l.msg || '').trim(); });
          }));
        }
        // Sort by timestamp to fix ordering when disk and memory logs are interleaved
        logs.sort(function(a, b) {
          var ta = new Date(a.time || 0).getTime() || 0;
          var tb = new Date(b.time || 0).getTime() || 0;
          return ta - tb;
        });
        if (logs.length > limit) logs = logs.slice(-limit);
      }
    }

    return sendJson(res, 200, {
      logs: logs,
      total: logs.length,
      memory_total: proxyLog.length,
      disk_file: disk.file,
      disk_path: disk.path,
      disk_size: disk.size,
      disk_mtime_ms: disk.mtimeMs,
      disk_cursor: disk.cursor,
      disk_truncated: disk.truncated,
      disk_error: disk.error || null,
      proxy_log_source: diskLogs.length > 0 ? 'combined' : 'memory'
    });
  }

  // API: 导出当前会话及最近日志
  if (pathname === '/api/logs/export' && method === 'GET') {
    try {
      var logDir = PROXY_LOG_DIR;
      var lines = [];
      var fileCount = 0;
      // 读取磁盘日志文件
      if (fs.existsSync(logDir)) {
        var files = fs.readdirSync(logDir)
          .filter(function(f) { return f.match(/^proxy.*\.log$/); })
          .sort(function(a, b) { return a.localeCompare(b); });
        // 限制最多读取 10 个最近文件，防止导出超大内容
        var recentFiles = files.slice(-10);
        for (var i = 0; i < recentFiles.length; i++) {
          try {
            var fPath = path.join(logDir, recentFiles[i]);
            var st = fs.statSync(fPath);
            // 跳过超过 5MB 的单个日志文件
            if (st.size > 5 * 1024 * 1024) {
              lines.push('=== ' + recentFiles[i] + ' ===');
              lines.push('[文件过大 (' + Math.round(st.size / 1024) + ' KB)，已跳过]');
              lines.push('');
              continue;
            }
            var content = fs.readFileSync(fPath, 'utf8');
            lines.push('=== ' + recentFiles[i] + ' ===');
            lines.push(content.trim());
            lines.push('');
            fileCount++;
          } catch (e) { /* skip unreadable files */ }
        }
      }
      // 追加当前内存缓冲区中的日志
      if (proxyLog.length > 0) {
        lines.push('=== 当前会话实时日志（内存） ===');
        for (var j = 0; j < proxyLog.length; j++) {
          var l = proxyLog[j];
          lines.push('[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.msg);
        }
        fileCount++;
      }
      var fullText = lines.join('\n');
      return sendJson(res, 200, { text: fullText, lineCount: fullText.split('\n').length, filesIncluded: fileCount });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 导出日志 - 返回日志内容供前端下载
  if (pathname === '/api/logs/export-content' && method === 'GET') {
    try {
      var logDir = PROXY_LOG_DIR;
      var lines = [];
      var fileCount = 0;
      if (fs.existsSync(logDir)) {
        var files = fs.readdirSync(logDir)
          .filter(function(f) { return f.match(/^proxy.*\.log$/); })
          .sort(function(a, b) { return a.localeCompare(b); });
        var recentFiles = files.slice(-10);
        for (var i = 0; i < recentFiles.length; i++) {
          try {
            var fPath = path.join(logDir, recentFiles[i]);
            var st = fs.statSync(fPath);
            if (st.size > 5 * 1024 * 1024) {
              lines.push('=== ' + recentFiles[i] + ' ===');
              lines.push('[文件过大，已跳过]');
              lines.push('');
              continue;
            }
            var content = fs.readFileSync(fPath, 'utf8');
            lines.push('=== ' + recentFiles[i] + ' ===');
            lines.push(content.trim());
            lines.push('');
            fileCount++;
          } catch (e) { /* skip */ }
        }
      }
      if (proxyLog.length > 0) {
        lines.push('=== 当前会话实时日志 ===');
        for (var j = 0; j < proxyLog.length; j++) {
          var l = proxyLog[j];
          lines.push('[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.msg);
        }
        fileCount++;
      }
      var fullText = lines.join('\n');
      if (!fullText.trim()) {
        return sendJson(res, 200, { text: '', lineCount: 0, filesIncluded: 0 });
      }
      return sendJson(res, 200, { text: fullText, lineCount: fullText.split('\n').length, filesIncluded: fileCount });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // API: 导出日志并保存到指定路径（旧接口，保留兼容）
  if (pathname === '/api/logs/export-save' && method === 'POST') {
    try {
      var logDir = PROXY_LOG_DIR;
      var lines = [];
      var fileCount = 0;
      if (fs.existsSync(logDir)) {
        var files = fs.readdirSync(logDir)
          .filter(function(f) { return f.match(/^proxy.*\.log$/); })
          .sort(function(a, b) { return a.localeCompare(b); });
        var recentFiles = files.slice(-10);
        for (var i = 0; i < recentFiles.length; i++) {
          try {
            var fPath = path.join(logDir, recentFiles[i]);
            var st = fs.statSync(fPath);
            if (st.size > 5 * 1024 * 1024) {
              lines.push('=== ' + recentFiles[i] + ' ===');
              lines.push('[文件过大，已跳过]');
              lines.push('');
              continue;
            }
            var content = fs.readFileSync(fPath, 'utf8');
            lines.push('=== ' + recentFiles[i] + ' ===');
            lines.push(content.trim());
            lines.push('');
            fileCount++;
          } catch (e) { /* skip */ }
        }
      }
      if (proxyLog.length > 0) {
        lines.push('=== 当前会话实时日志 ===');
        for (var j = 0; j < proxyLog.length; j++) {
          var l = proxyLog[j];
          lines.push('[' + l.time + '] [' + l.type.toUpperCase() + '] ' + l.msg);
        }
        fileCount++;
      }
      var fullText = lines.join('\n');
      if (!fullText.trim()) {
        return sendJson(res, 200, { success: false, error: '没有可导出的日志' });
      }
      var desktopDir = path.join(os.homedir(), 'Desktop');
      if (!fs.existsSync(desktopDir)) fs.mkdirSync(desktopDir, { recursive: true });
      var defaultName = 'codex-assistant-log-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
      var savePath = path.join(desktopDir, defaultName);
      if (fs.existsSync(savePath)) {
        var ext = '.txt';
        var baseName = defaultName.replace(ext, '');
        for (var idx = 1; idx < 100; idx++) {
          savePath = path.join(desktopDir, baseName + '-' + idx + ext);
          if (!fs.existsSync(savePath)) break;
        }
      }
      fs.writeFileSync(savePath, fullText, 'utf-8');
      return sendJson(res, 200, { success: true, path: savePath, lineCount: fullText.split('\n').length, filesIncluded: fileCount });
    } catch (e) {
      return sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // API: 测试提供商连接
  if (pathname === '/api/providers/test-connection' && method === 'POST') {
    try {
      var body = await collectBody(req);
      var params = JSON.parse(body);
      var base_url = params.base_url;
      var api_key = params.api_key;
      if (!base_url) return sendJson(res, 400, { success: false, error: 'base_url 不能为空' });
      if (!api_key) return sendJson(res, 400, { success: false, error: 'api_key 不能为空' });
      
      // SSRF validation
      var urlCheck = validateProviderUrl(base_url);
      if (!urlCheck.valid) return sendJson(res, 400, { success: false, error: urlCheck.error });
      
      var models = await fetchModelsFromAPI(base_url, api_key);
      return sendJson(res, 200, { success: true, model_count: models.length, models: models.slice(0, 10) });
    } catch (e) { return sendJson(res, 200, { success: false, error: e.message }); }
  }

  // API: 导出配置（明文 API Key，不含 PROXY_AUTH_KEY）
  if (pathname === '/api/export-config' && method === 'GET') {
    try {
      const providers = readProviders();
      const safeProviders = (providers.providers || []).map(p => ({
        name: p.name, base_url: p.base_url, protocol: p.protocol,
        models: p.models || [],
        api_key: p.api_key || '',
      }));
      return sendJson(res, 200, { providers: safeProviders });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 导入配置（明文 Key，自动用机器码加密存储）
  if (pathname === '/api/import-config' && method === 'POST') {
    try {
      const body = await collectBody(req);
      const data = JSON.parse(body);
      var needsKeyProviders = [];

      // 导入环境变量（PROXY_AUTH_KEY 不导入，每台机器各自生成）
      if (data.env) {
        const currentEnv = readEnv();
        var envChanged = false;
        for (const k in data.env) {
          if (k === 'PROXY_AUTH_KEY') continue;  // 永不覆盖本地密钥
          if (data.env[k] !== undefined) { currentEnv[k] = data.env[k]; envChanged = true; }
        }
        if (envChanged) writeEnv(currentEnv);
      }

      if (data.providers && Array.isArray(data.providers)) {
        const current = readProviders();
        const existingNames = new Set(current.providers.map(function(p) { return p.name.toLowerCase(); }));
        for (var i = 0; i < data.providers.length; i++) {
          var imp = data.providers[i];
          if (imp.name && imp.base_url && !existingNames.has(imp.name.toLowerCase())) {
            var apiKey = imp.api_key || '';
            if (apiKey === '***configured***') apiKey = '';  // 旧格式掩码，无法还原
            if (!apiKey) needsKeyProviders.push(imp.name);
            // 明文 Key 直接存入，writeProviders() 会自动用机器码加密
            current.providers.push({
              name: imp.name, base_url: imp.base_url, api_key: apiKey,
              protocol: imp.protocol || 'openai', models: imp.models || [],
            });
          }
        }
        writeProviders(current);  // 自动加密 + 自动生成 PROXY_AUTH_KEY（如果本地没有）
        generateProxyModels();
      }
      return sendJson(res, 200, { success: true, message: '配置已导入', needs_key_providers: needsKeyProviders });
    } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
  }

  // API: 代理统计（从代理实例拉取）
  if (pathname === '/api/stats' && method === 'GET') {
    try {
      const env = readEnv();
      var port = env.PROXY_PORT || '4000';
      var resp = await fetch('http://127.0.0.1:' + port + '/v1/stats');
      const stats = await resp.json();
      return sendJson(res, 200, stats);
    } catch {
      return sendJson(res, 200, { uptime_seconds: 0, total_requests: 0, success_count: 0, error_count: 0, avg_latency_ms: 0, by_provider: {}, proxy_offline: true });
    }
  }

  // ==================== Update API ====================
  
  // Get current version
  if (pathname === '/api/version' && method === 'GET') {
    try {
      const { getCurrentVersion } = await import('./src/updater.mjs');
      const versionInfo = getCurrentVersion(PROJECT_DIR);
      return sendJson(res, 200, versionInfo);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Check for updates
  if (pathname === '/api/check-update' && method === 'GET') {
    try {
      const { getCurrentVersion, checkForUpdates, compareVersions } = await import('./src/updater.mjs');
      const current = getCurrentVersion(PROJECT_DIR);
      const latest = await checkForUpdates();
      
      if (latest.error) {
        // Update check failed — return the error so the frontend can show it
        return sendJson(res, 200, { 
          hasUpdate: false, 
          currentVersion: current.version,
          checkError: latest.error,
          message: '无法检查更新'
        });
      }

      const hasUpdate = compareVersions(current.version, latest.version) > 0 ? false : (compareVersions(current.version, latest.version) < 0);
      
      return sendJson(res, 200, {
        hasUpdate,
        currentVersion: current.version,
        latestVersion: latest.version,
        downloadUrl: latest.downloadUrl,
        fileName: latest.fileName,
        changelog: latest.changelog,
        publishedAt: latest.publishedAt,
        releaseUrl: latest.htmlUrl
      });
    } catch (err) {
      return sendJson(res, 200, { hasUpdate: false, currentVersion: '?', checkError: err.message });
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Port auto-switch: if UI_PORT is occupied, try next 10 ports
(function startListening(port, remaining) {
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE' && remaining > 0) {
      server.close();
      startListening(port + 1, remaining - 1);
    } else {
      console.error('[ui] Failed to start:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', function () {
    UI_PORT = port;
    try { fs.writeFileSync(path.join(os.tmpdir(), '.codex-assistant-ui-port'), String(UI_PORT)); } catch (e) {}
    console.log('[ui] Server listening on http://127.0.0.1:' + UI_PORT);
    console.log('[ui] Press Ctrl+C to stop');
  });

  // Clean up proxy child process on exit (prevents orphan proxy on Windows)
  function killProxyOnExit() {
    // 1. 杀 proxy 子进程及其进程树（taskkill /T /F 比 proc.kill 更可靠）
    if (proxyProcess && !proxyProcess.killed) {
      killProcessTree(proxyProcess.pid);
    }
    // 2. 兜底：通过端口杀残留进程（proxy 端口）
    try {
      var env4 = readEnv();
      var port4 = parseInt(env4.PROXY_PORT || '4000', 10);
      killProcessOnPort(port4);
    } catch { /* ignore */ }
    // 3. 也杀 UI 端口上的残留（防止自身进程树有孤儿）
    try {
      killProcessOnPort(UI_PORT);
    } catch { /* ignore */ }
  }
  
  // 全局异常处理器：防止未捕获异常导致 ui-server 静默崩溃
  process.on('uncaughtException', function(err) {
    console.error('[ui] UNCAUGHT EXCEPTION:', err.stack || err.message || err);
    try { logOperation('system', 'error', '未捕获异常: ' + (err.message || String(err)), err); } catch {}
  });
  process.on('unhandledRejection', function(reason) {
    var msg = reason?.stack || reason?.message || String(reason);
    console.error('[ui] UNHANDLED REJECTION:', msg);
    try { logOperation('system', 'error', '未处理的Promise拒绝: ' + msg); } catch {}
  });
  
  process.on('exit', killProxyOnExit);
  process.on('SIGINT', function() { killProxyOnExit(); process.exit(0); });
  process.on('SIGTERM', function() { killProxyOnExit(); process.exit(0); });
})(UI_PORT, 10);
