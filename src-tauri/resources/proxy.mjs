import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tryDecryptApiKey } from "./src/crypto-store.mjs";
import { parseCsv, normalizeModelId, contentHasUrl, sendJson, fetchWithTimeout, readJsonBody, sendUpstreamError } from "./src/shared.mjs";
import { uid, applyEffortTranslation, normalizeMessages } from "./src/protocol.mjs";
import {
  jinaRead, rawFetch, executeWebFetch, ensureWebFetchTool,
  ensureWebFetchHint, runWebFetchLoop, WEB_FETCH_TOOL
} from "./src/web-fetch.mjs";
import { handleStreamingResponse, sendResponseAsStream, buildStreamingResponseEvents } from "./src/streaming.mjs";
var execFileAsync = promisify(execFileCb);

var PORT = process.env.PROXY_PORT || 4000;
var MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE) || 10 * 1024 * 1024; // 10 MB default
var MAX_ENTRY_SIZE = Number(process.env.MAX_ENTRY_SIZE_BYTES) || 1024 * 1024; // 1MB per response store entry

// --- SSRF protection for /cop endpoint ---
function isAllowedCopUrl(urlStr) {
  try {
    var u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    var hostname = u.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("172.16.") || hostname.startsWith("172.17.") ||
      hostname.startsWith("172.18.") || hostname.startsWith("172.19.") ||
      hostname.startsWith("172.2") || hostname.startsWith("172.3") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      hostname === "metadata.google.internal" ||
      hostname === "instance-data"
    ) {
      return false;
    }
    return true;
  } catch (e) { return false; }
}

// === Logging ===
//
// LOG_LEVEL = silent | error | warn | info (default) | debug
//   silent: nothing
//   error : only console.error wrappers
//   warn  : + warnings
//   info  : + business + access logs (default)
//   debug : + verbose internal traces
// ACCESS_LOG=0 separately suppresses just the per-request access lines.
var LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
var LOG_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;
var ACCESS_LOG_ON = process.env.ACCESS_LOG !== "0" && LOG_LEVEL >= LOG_LEVELS.info;

// Define log BEFORE any process.on handlers that reference it
var log = {
  error: function() { if (LOG_LEVEL >= LOG_LEVELS.error) { var msg = _formatLog("ERROR", arguments); console.error(msg); _writeLog(msg); } },
  warn:  function() { if (LOG_LEVEL >= LOG_LEVELS.warn)  { var msg = _formatLog("WARN", arguments); console.warn(msg); _writeLog(msg); } },
  info:  function() { if (LOG_LEVEL >= LOG_LEVELS.info)  { var msg = _formatLog("INFO", arguments); console.log(msg); _writeLog(msg); } },
  debug: function() { if (LOG_LEVEL >= LOG_LEVELS.debug) { var msg = _formatLog("DEBUG", arguments); console.log(msg); _writeLog(msg); } },
  access: function() { if (ACCESS_LOG_ON) { var msg = _formatLog("ACCESS", arguments); console.log(msg); _writeLog(msg); } },
};

// --- File logging ---
// Each proxy start creates a new log file: proxy-YYYY-MM-DD-HH-MM-SS.log
// Old files are cleaned up per LOG_RETENTION_DAYS (default 3, range 1-30).
// Use import.meta.url to get the reliable directory of proxy.mjs itself,
// independent of process.cwd() which depends on how the process was spawned.
var _proxyDir = path.dirname(fileURLToPath(import.meta.url));
var LOG_DIR = process.env.CODASS_LOG_DIR || path.resolve(_proxyDir, "log");
var LOG_RETENTION_DAYS = Math.min(30, Math.max(1, parseInt(process.env.LOG_RETENTION_DAYS || "3", 10) || 3));
var _logStream = null;
var _logFile = null;

// Generate timestamped filename and clean old logs on startup
(function _initLogging() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    // Clean old logs
    var now = Date.now();
    var cutoff = now - LOG_RETENTION_DAYS * 86400000;
    var files = fs.readdirSync(LOG_DIR);
    for (var fi = 0; fi < files.length; fi++) {
      var f = files[fi];
      if (!f.match(/^proxy.*\.log$/)) continue;
      var fullPath = path.join(LOG_DIR, f);
      try {
        var st = fs.statSync(fullPath);
        if (st.mtimeMs < cutoff) { fs.unlinkSync(fullPath); }
      } catch(e) { /* file already deleted or locked - safe to ignore */ }
    }
    // Create new log file for this session
    // Slice first to get "YYYY-MM-DDTHH:MM:SS", then replace T and : for filename safety
    var ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-').replace('T', '-');
    _logFile = path.join(LOG_DIR, "proxy-" + ts + ".log");
    _logStream = fs.createWriteStream(_logFile, { flags: "w" });
  } catch(e) {
    console.error("[proxy] Failed to init logging:", e.message);
  }
})();

function _formatLog(level, args) {
  var ts = new Date().toISOString();
  var parts = ["[" + ts + "]", "[" + level + "]"];
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (typeof arg === "object") {
      try { parts.push(JSON.stringify(arg)); } catch(e) { parts.push(String(arg)); }
    } else {
      parts.push(String(arg));
    }
  }
  return parts.join(" ");
}

function _writeLog(msg) {
  try {
    if (!_logStream) return;
    _logStream.write(msg + "\n");
  } catch(e) { /* log write failed - swallow to avoid cascading failure */ }
}

process.on("uncaughtException", function(err) {
  log.error("[proxy] uncaught exception:", err.message);
});
process.on("unhandledRejection", function(err) {
  log.error("[proxy] unhandled rejection:", err.message || err);
});

// === Request statistics ===
const stats = {
  startedAt: Date.now(),
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  byProvider: {}, // { provider: { sent, success, error, totalLatencyMs } }
  recentLatencies: [], // last 100 request latencies in ms
};
function recordStats(provider, success, latencyMs) {
  stats.totalRequests++;
  if (!stats.byProvider[provider]) {
    stats.byProvider[provider] = { sent: 0, success: 0, error: 0, totalLatencyMs: 0 };
  }
  const p = stats.byProvider[provider];
  p.sent++;
  if (success) { stats.successCount++; p.success++; }
  else { stats.errorCount++; p.error++; }
  p.totalLatencyMs += latencyMs;
  stats.recentLatencies.push(latencyMs);
  if (stats.recentLatencies.length > 100) stats.recentLatencies.shift();
}

// === Inbound auth ===
//
// Two env vars, both optional:
//
//   PROXY_AUTH_KEY=sk-xxx                       (legacy, single key, no provider lock)
//   PROXY_KEYS=sk-aaa:deepseek,sk-bbb:mimo,sk-ccc:*   (table, optional provider lock)
//
// Each key in the table either:
//   - locks the request to one provider ("deepseek" / "mimo" / "openai") — body.model
//     must resolve to that provider, otherwise 401. If body.model is empty, the
//     provider's default model is used.
//   - is a wildcard ("*") — model field decides routing, same as legacy behaviour.
//
// PROXY_AUTH_KEY (if set) is appended as a wildcard entry, so existing single-key
// setups keep working untouched.
//
// If both env vars are empty, inbound auth is DISABLED — anyone on localhost can
// hit the proxy. /health is always exempt regardless.

const PROXY_AUTH_KEY = (process.env.PROXY_AUTH_KEY || "").trim();
const PROXY_KEYS_RAW = (process.env.PROXY_KEYS || "").trim();

// Map<key, provider | "*">
var PROXY_KEY_TABLE = new Map();
// Base set: static providers + wildcard. Dynamic providers are added after load.
var VALID_LOCK_PROVIDERS = new Set(["deepseek", "mimo", "openai", "*"]);

function loadProxyKeyTable() {
  for (const entry of parseCsv(PROXY_KEYS_RAW)) {
    const idx = entry.lastIndexOf(":");
    if (idx === -1) {
      log.warn(`[proxy] PROXY_KEYS entry missing ':<provider>': "${entry}" — ignored`);
      continue;
    }
    const key = entry.slice(0, idx).trim();
    const provider = entry.slice(idx + 1).trim().toLowerCase();
    if (!key) {
      log.warn(`[proxy] PROXY_KEYS entry has empty key — ignored`);
      continue;
    }
    if (!VALID_LOCK_PROVIDERS.has(provider)) {
      log.warn(`[proxy] PROXY_KEYS entry has unknown provider "${provider}" (allowed: deepseek, mimo, openai, *) — ignored`);
      continue;
    }
    if (PROXY_KEY_TABLE.has(key)) {
      log.warn(`[proxy] PROXY_KEYS entry duplicates key "${key.slice(0, 12)}…" — last wins`);
    }
    PROXY_KEY_TABLE.set(key, provider);
  }
  if (PROXY_AUTH_KEY) {
    if (!PROXY_KEY_TABLE.has(PROXY_AUTH_KEY)) PROXY_KEY_TABLE.set(PROXY_AUTH_KEY, "*");
  }
}
// Deferred: loadProxyKeyTable() is called after buildProviders()
// so dynamic provider names are available for validation.

// Note: PROXY_AUTH_ENABLED is evaluated after loadProxyKeyTable() below
let PROXY_AUTH_ENABLED = false;

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODELS = parseCsv(process.env.DEEPSEEK_MODELS || "deepseek-v4-pro,deepseek-v4-flash");

// DeepSeek V4 默认会开启 thinking mode。Codex / Codex Assistant 目前不会稳定回传
// DeepSeek 要求的 `reasoning_content`，所以默认强制关闭 DeepSeek thinking，
// 避免 400: "reasoning_content in the thinking mode must be passed back"。
// 如确实想重新开启，可在 .env 设置：DEEPSEEK_DISABLE_THINKING=0
const DEEPSEEK_DISABLE_THINKING = process.env.DEEPSEEK_DISABLE_THINKING !== "0";
if (DEEPSEEK_DISABLE_THINKING && DEEPSEEK_KEY) {
  console.log("[config] DeepSeek thinking disabled by default (reasoning_content from history is still preserved to avoid 400 errors)");
}

const MIMO_BASE = process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
const MIMO_KEY = process.env.MIMO_API_KEY || "";
const MIMO_MODELS = parseCsv(process.env.MIMO_MODELS || "mimo-v2.5-pro");

const OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Default empty — OpenAI is opt-in, set OPENAI_MODELS or OPENAI_API_KEY explicitly to enable.
const OPENAI_MODELS = parseCsv(process.env.OPENAI_MODELS || "");
const OPENAI_MODEL_PREFIXES = parseCsv(process.env.OPENAI_MODEL_PREFIXES || "gpt-,o1,o3,o4,codex-,chatgpt-");

const DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "").trim().toLowerCase();
const DEFAULT_MODEL = (process.env.DEFAULT_MODEL || "").trim();

// Reasoning effort settings
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "";
const MIMO_REASONING_EFFORT = process.env.MIMO_REASONING_EFFORT || "";

// GitHub token is fetched lazily on first github.com web_fetch call so we don't
// pay the gh-CLI startup cost during proxy boot. Sentinel "unresolved" means
// "haven't checked yet"; "" means "checked, none available".
let _githubToken = process.env.GITHUB_TOKEN || null; // null = not yet resolved
async function getGithubToken() {
  if (_githubToken !== null) return _githubToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf-8", timeout: 3000 });
    _githubToken = stdout.trim();
  } catch { _githubToken = ""; }
  return _githubToken;
}

// --- Startup configuration validation ---
function validateConfig() {
  const warnings = [];
  const errors = [];
  const urlFields = [
    { name: "DEEPSEEK_BASE", value: DEEPSEEK_BASE },
    { name: "MIMO_BASE", value: MIMO_BASE },
    { name: "OPENAI_BASE", value: OPENAI_BASE },
  ];
  for (const { name, value } of urlFields) {
    if (value) {
      try { new URL(value); }
      catch { errors.push(`${name}="${value}" is not a valid URL`); }
    }
  }
  if (DEEPSEEK_REASONING_EFFORT) {
    const valid = ["none", "low", "medium", "high"];
    if (!valid.includes(DEEPSEEK_REASONING_EFFORT)) warnings.push(`DEEPSEEK_REASONING_EFFORT="${DEEPSEEK_REASONING_EFFORT}" invalid; expected: ${valid.join(", ")}`);
  }
  if (MIMO_REASONING_EFFORT) {
    const valid = ["none", "low", "medium", "high"];
    if (!valid.includes(MIMO_REASONING_EFFORT)) warnings.push(`MIMO_REASONING_EFFORT="${MIMO_REASONING_EFFORT}" invalid; expected: ${valid.join(", ")}`);
  }
  if (errors.length) {
    for (const e of errors) console.error(`[config] ERROR: ${e}`);
    throw new Error("Configuration validation failed");
  }
  for (const w of warnings) console.warn(`[config] WARNING: ${w}`);
}
validateConfig();

// 检查是否有任何上游 Key（环境变量 或 动态提供商配置文件）
var _hasDynamicProviders = false;
try {
  var _providersFile = path.join(_proxyDir, 'user', 'provider-configs.json');
  if (fs.existsSync(_providersFile)) {
    var _pData = JSON.parse(fs.readFileSync(_providersFile, 'utf-8'));
    for (var _i = 0; _i < (_pData.providers || []).length; _i++) {
      if (_pData.providers[_i].api_key && _pData.providers[_i].api_key.trim()) {
        _hasDynamicProviders = true;
        break;
      }
    }
  }
} catch (e) { /* ignore */ }

if (!DEEPSEEK_KEY && !OPENAI_KEY && !MIMO_KEY && !_hasDynamicProviders) {
  console.error("没有配置任何上游 API Key。请通过 Web 管理界面添加提供商，或在 user/.env 中设置 DEEPSEEK_API_KEY / MIMO_API_KEY / OPENAI_API_KEY");
  process.exit(1);
}

// Optional: read MODEL_CATALOG_PATH (the same proxy-models.json Codex uses) so the
// proxy and Codex agree on which models exist. If a model in the catalog has an
// explicit `provider` field, that wins. Otherwise we infer by name (deepseek-* /
// mimo-* / gpt-*). When the file is absent or unreadable we fall back to the
// env-var lists (DEEPSEEK_MODELS, MIMO_MODELS, OPENAI_MODELS) — i.e. backwards
// compatible with the original setup.
const MODEL_CATALOG_PATH = (process.env.MODEL_CATALOG_PATH || "").trim();
function loadCatalogModels(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    const out = { deepseek: [], mimo: [], openai: [] };
    for (const m of raw.models || []) {
      if (!m?.slug) continue;
      let p = (m.provider || "").toLowerCase();
      if (!p) {
        const s = m.slug.toLowerCase();
        if (s.startsWith("deepseek")) p = "deepseek";
        else if (s.startsWith("mimo") || s.startsWith("xiaomi")) p = "mimo";
        else if (s.startsWith("gpt-") || s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.startsWith("codex-") || s.startsWith("chatgpt-")) p = "openai";
      }
      if (out[p]) out[p].push(m.slug);
    }
    console.log(`[Codex Assistant] model_catalog: loaded ${path} (deepseek=${out.deepseek.length}, mimo=${out.mimo.length}, openai=${out.openai.length})`);
    return out;
  } catch (err) {
    console.warn(`[Codex Assistant] model_catalog: ${path} unreadable (${err.message}), falling back to env lists`);
    return null;
  }
}
const CATALOG = MODEL_CATALOG_PATH ? loadCatalogModels(MODEL_CATALOG_PATH) : null;
if (CATALOG) {
  if (CATALOG.deepseek.length) DEEPSEEK_MODELS.splice(0, DEEPSEEK_MODELS.length, ...CATALOG.deepseek);
  if (CATALOG.mimo.length) MIMO_MODELS.splice(0, MIMO_MODELS.length, ...CATALOG.mimo);
  if (CATALOG.openai.length) OPENAI_MODELS.splice(0, OPENAI_MODELS.length, ...CATALOG.openai);
}

// ==================== 动态加载提供商配置 ====================
const USER_DIR = path.join(_proxyDir, 'user');
const PROVIDERS_FILE = path.join(USER_DIR, 'provider-configs.json');

// 初始化 user 文件夹
function initUserDir() {
  if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR, { recursive: true });
    console.log('[proxy] Created user directory');
  }
}
initUserDir();

function loadDynamicProviders() {
  try {
    if (!fs.existsSync(PROVIDERS_FILE)) return { providers: {}, providerNames: [] };
    var data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf-8'));
    var providers = {};
    var providerNames = [];
    var masterKey = (process.env.PROXY_AUTH_KEY || '').trim();
    
    for (var i = 0; i < (data.providers || []).length; i++) {
      var p = data.providers[i];
      if (!p.name || !p.base_url) continue;
      
      // Decrypt API key if encrypted
      var apiKey = p.api_key || '';
      if (masterKey && apiKey) {
        var result = tryDecryptApiKey(apiKey, masterKey);
        if (result.key !== null) {
          apiKey = result.key;
        } else if (result.wasEncrypted) {
          console.error('[proxy] Failed to decrypt key for provider "' + p.name + '" — skipping. Master key may have changed.');
          continue;
        }
      }
      
      if (!apiKey) continue;
      
      // 提取提供商名称作为 key（转小写，去掉空格）
      var name = p.name.toLowerCase().replace(/\s+/g, '');
      providerNames.push(name);
      
      // 从模型列表中提取模型 ID
      var models = [];
      for (var j = 0; j < (p.models || []).length; j++) {
        var slug = p.models[j].slug || p.models[j].id;
        if (slug) models.push(slug);
      }
      
      if (models.length === 0) continue;
      
      // 处理 base_url：智能提取 API 基础路径
      var baseUrl = p.base_url.replace(/\/+$/, '');
      // Strip known endpoint suffixes
      baseUrl = baseUrl.replace(/\/chat\/completions$/i, '');
      baseUrl = baseUrl.replace(/\/completions$/i, '');
      baseUrl = baseUrl.replace(/\/models$/i, '');
      // If the remaining path already ends with a version segment (/v1, /v2, etc.), keep it
      if (!/\/v\d+$/i.test(baseUrl)) {
        // Otherwise append /v1 as the default API version
        baseUrl += '/v1';
      }
      
      providers[name] = {
        base: baseUrl,
        key: apiKey,
        models: models,
        defaultModel: models[0],
        envKey: null,
        protocol: p.protocol || 'openai',
      };
    }
    
    return { providers: providers, providerNames: providerNames };
  } catch (err) {
    console.error('[Codex Assistant] Failed to load user/provider-configs.json:', err.message);
    return { providers: {}, providerNames: [] };
  }
}

// 合并静态和动态提供商
function buildProviders() {
  // 静态 provider 仅作为 .env 配置的回退，且只有配置了 key 的才会加入
  // 所有通过 UI 配置的 provider 来自 provider-configs.json（动态）
  var staticProviders = {};
  if (DEEPSEEK_KEY) {
    staticProviders.deepseek = { base: DEEPSEEK_BASE, key: DEEPSEEK_KEY, models: DEEPSEEK_MODELS, defaultModel: DEEPSEEK_MODELS[0] || "deepseek-v4-pro", envKey: "DEEPSEEK_API_KEY" };
  }
  if (MIMO_KEY) {
    staticProviders.mimo = { base: MIMO_BASE, key: MIMO_KEY, models: MIMO_MODELS, defaultModel: MIMO_MODELS[0] || "mimo-v2.5-pro", envKey: "MIMO_API_KEY" };
  }
  
  // 加载动态提供商
  var dynamicResult = loadDynamicProviders();
  var dynamicProviders = dynamicResult.providers;
  
  // Register dynamic provider names for PROXY_KEYS validation
  for (var k = 0; k < dynamicResult.providerNames.length; k++) {
    VALID_LOCK_PROVIDERS.add(dynamicResult.providerNames[k]);
  }
  
  // 合并，动态提供商优先（覆盖同名的静态回退）
  return Object.assign({}, staticProviders, dynamicProviders);
}

const OAI_COMPAT_PROVIDERS = buildProviders();

// Load proxy key table AFTER providers are built so dynamic
// provider names are registered in VALID_LOCK_PROVIDERS.
loadProxyKeyTable();
PROXY_AUTH_ENABLED = PROXY_KEY_TABLE.size > 0;

// 启动时打印加载的提供商信息
console.log('[Codex Assistant] Loaded providers:');
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  const status = cfg.key ? '✓' : '✗ (no key)';
  console.log(`  ${name}: ${cfg.models.length} models, base=${cfg.base} ${status}`);
}

const enabledProviders = new Set();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  if (cfg.key) enabledProviders.add(name);
}
if (OPENAI_KEY) enabledProviders.add("openai");

// 打印启用的提供商
console.log('[Codex Assistant] Enabled providers:', [...enabledProviders].join(', ') || 'none');

const providerModels = {
  ...Object.fromEntries(Object.entries(OAI_COMPAT_PROVIDERS).map(([n, c]) => [n, c.models])),
  openai: OPENAI_MODELS,
};

const explicitModelProvider = new Map();
for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  for (const model of cfg.models) {
    const key = normalizeModelId(model);
    if (!explicitModelProvider.has(key)) {
      explicitModelProvider.set(key, name);
    } else {
      var existing = explicitModelProvider.get(key);
      if (existing !== name) {
        // Conflict resolution: prefer the provider that actually has an API key configured.
        // Without this, a static no-key provider (e.g. mimo with MIMO_API_KEY unset) can
        // "steal" models from a dynamic provider that does have a key.
        var existingCfg = OAI_COMPAT_PROVIDERS[existing];
        var newCfg = OAI_COMPAT_PROVIDERS[name];
        var existingHasKey = existingCfg && existingCfg.key;
        var newHasKey = newCfg && newCfg.key;
        if (newHasKey && !existingHasKey) {
          log.warn('[proxy] model conflict override: "' + key + '" reassigned from "' + existing + '" (no key) to "' + name + '" (keyed)');
          explicitModelProvider.set(key, name);
        } else {
          log.warn('[proxy] model slug conflict: "' + key + '" registered by "' + existing + '", skipped duplicate from "' + name + '"');
        }
      }
    }
  }
}
for (const model of OPENAI_MODELS) {
  const key = normalizeModelId(model);
  if (!explicitModelProvider.has(key)) {
    explicitModelProvider.set(key, "openai");
  }
}

const modelCatalog = [
  ...Object.entries(OAI_COMPAT_PROVIDERS)
    .filter(([name, cfg]) => cfg.key) // 只包含有 key 的提供商
    .flatMap(([name, cfg]) => cfg.models.map((id) => ({ id, object: "model", owned_by: name }))),
  ...OPENAI_MODELS.map((id) => ({ id, object: "model", owned_by: "openai" })),
];

// --- Dynamic model list fetching from upstream providers ---
const MODEL_LIST_CACHE_TTL = Number(process.env.MODEL_LIST_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
let _modelListCache = { data: null, ts: 0 };

async function fetchUpstreamModels() {
  const now = Date.now();
  if (_modelListCache.data && (now - _modelListCache.ts) < MODEL_LIST_CACHE_TTL) {
    return _modelListCache.data;
  }

  // Build fallback model-list URLs for a given base URL
  function buildModelUrls(base) {
    const b = base.replace(/\/+$/, '');
    const urls = [];
    // Primary: ${base}/models  (e.g. /v1/models)
    urls.push(`${b}/models`);
    // Fallback: strip /v1 and try /models (e.g. /models)
    const noV1 = b.replace(/\/v1$/i, '');
    if (noV1 !== b) urls.push(`${noV1}/models`);
    return [...new Set(urls)];
  }

  async function tryFetchModels(baseUrl, key, owner) {
    const urls = buildModelUrls(baseUrl);
    for (const url of urls) {
      try {
        const r = await fetchWithTimeout(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
        }, 10_000);
        if (!r.ok) {
          log.warn(`[proxy] model-list ${url} → HTTP ${r.status}`);
          continue;
        }
        const json = await r.json().catch(() => null);
        const list = json?.data || json?.models || [];
        if (list.length > 0) {
          return list.map((m) => ({
            id: typeof m === "string" ? m : m.id,
            object: "model",
            owned_by: owner,
          }));
        }
        log.warn(`[proxy] model-list ${url} → empty list`);
      } catch (e) {
        log.warn(`[proxy] model-list ${url} → ${e.message}`);
      }
    }
    return [];
  }

  const fetches = [];

  for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    if (!cfg.key) continue;
    fetches.push(tryFetchModels(cfg.base, cfg.key, name));
  }

  if (OPENAI_KEY) {
    fetches.push(tryFetchModels(OPENAI_BASE, OPENAI_KEY, "openai"));
  }

  const results = await Promise.all(fetches);
  const upstreamModels = results.flat();

  // Merge: upstream models override static catalog; keep static ones not in upstream
  const upstreamIds = new Set(upstreamModels.map((m) => m.id));
  const merged = [...upstreamModels, ...modelCatalog.filter((m) => !upstreamIds.has(m.id))];

  _modelListCache = { data: merged, ts: now };
  return merged;
}



// --- Response store for previous_response_id bridging ---

const responseStore = new Map();
const reasoningIndex = new Map(); // callId -> reasoningContent, incremental index for O(1) lookup
const STORE_TTL = Number(process.env.STORE_TTL_MS) || 60 * 60 * 1000; // 1 hour
const STORE_MAX = Number(process.env.STORE_MAX) || 500;
const MAX_CONSECUTIVE_TOOL_CALLS = Number(process.env.MAX_CONSECUTIVE_TOOL_CALLS) || 20; // circuit breaker threshold
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS) || 120000; // 2 min, applies to upstream chat/completions/responses calls

// --- Proxy-side web_fetch tool (bypasses sandbox restrictions) ---
// WEB_FETCH_TOOL, jinaRead, rawFetch, executeWebFetch, ensureWebFetchTool,
// ensureWebFetchHint, and runWebFetchLoop are all imported from src/web-fetch.mjs

function conversationHasUrls(messages) {
  return messages.some(function(message) { return contentHasUrl(message && message.content); });
}

function getFallbackProvider() {
  if (DEFAULT_PROVIDER && enabledProviders.has(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
  if (enabledProviders.has("openai")) return "openai";
  for (const name of Object.keys(OAI_COMPAT_PROVIDERS)) {
    if (enabledProviders.has(name)) return name;
  }
  throw new Error("No providers are enabled. Please configure at least one provider in user/provider-configs.json or user/.env");
}

// Heuristic name-based routing for OAI-compatible providers when the explicit map misses.
// Order matters: longer/more-specific tokens first so e.g. "deepseek-mimo" wouldn't
// accidentally fall through to MiMo. Keep this list short and add entries when needed.
const OAI_COMPAT_NAME_HINTS = [
  { provider: "deepseek", tokens: ["deepseek"] },
  { provider: "mimo",     tokens: ["mimo", "xiaomi"] },
];

// ==================== 模型别名映射 ====================
// 运行时别名（由 UI 的辅助模型配置动态生成）
let MODEL_ALIASES = {};

// 读取辅助模型配置
function loadAuxModelConfig() {
  try {
    const auxConfigPath = path.join(USER_DIR, 'aux-model-config.json');
    if (!fs.existsSync(auxConfigPath)) return null;
    return JSON.parse(fs.readFileSync(auxConfigPath, 'utf-8'));
  } catch {
    return null;
  }
}

// 更新别名映射
function updateModelAliases() {
  MODEL_ALIASES = {};
  const auxConfig = loadAuxModelConfig();
  if (auxConfig && auxConfig.auxModel && auxConfig.mainModel && auxConfig.auxModel !== auxConfig.mainModel) {
    const mainProvider = explicitModelProvider.get(normalizeModelId(auxConfig.mainModel));
    if (mainProvider && enabledProviders.has(mainProvider)) {
      MODEL_ALIASES[normalizeModelId(auxConfig.auxModel)] = mainProvider;
      console.log(`[Codex Assistant] Aux model alias: ${auxConfig.auxModel} -> ${mainProvider}`);
    }
  }
}

// 启动时更新别名
updateModelAliases();

function resolveProviderForModel(model) {
  const normalized = normalizeModelId(model);
  if (normalized) {
    // 先检查别名映射
    const aliasTarget = MODEL_ALIASES[normalized];
    if (aliasTarget && enabledProviders.has(aliasTarget)) {
      return aliasTarget;
    }
    
    const explicit = explicitModelProvider.get(normalized);
    if (explicit && enabledProviders.has(explicit)) return explicit;
    for (const { provider, tokens } of OAI_COMPAT_NAME_HINTS) {
      if (enabledProviders.has(provider) && tokens.some((t) => normalized.includes(t))) return provider;
    }
    if (enabledProviders.has("openai")) {
      const looksOpenAI = OPENAI_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
      if (looksOpenAI) return "openai";
    }
  }
  
  // 如果找不到提供商，返回 null 而不是抛出错误
  return null;
}

// Read with LRU bookkeeping: refreshes insertion order so frequently-used roots
// don't get evicted by the eviction loop in storeResponse.
function touchResponse(id) {
  if (!id) return undefined;
  const entry = responseStore.get(id);
  if (!entry) return undefined;
  // Re-insert to move it to the most-recently-used end of the Map.
  responseStore.delete(id);
  responseStore.set(id, entry);
  return entry;
}

function storeResponse(id, data) {
  if (!id) return;

  // Reject oversized entries to prevent memory exhaustion
  try {
    var entrySize = JSON.stringify(data).length;
    if (entrySize > MAX_ENTRY_SIZE) {
      log.warn(`[proxy] response ${id} exceeds max entry size (${entrySize} > ${MAX_ENTRY_SIZE} bytes), skipping store`);
      return;
    }
  } catch (e) { /* stringify may fail on circular refs, allow storage attempt */ }

  if (responseStore.size >= STORE_MAX) {
    const now = Date.now();
    for (const [key, val] of responseStore) {
      if (now - val.storedAt > STORE_TTL) {
        // Clean up reasoning index for evicted entry
        if (val.reasoningContent) {
          for (const out of Array.isArray(val.output) ? val.output : []) {
            if (out.type === "function_call" && out.call_id) reasoningIndex.delete(out.call_id);
          }
        }
        responseStore.delete(key);
      }
    }
    if (responseStore.size >= STORE_MAX) {
      const oldest = responseStore.keys().next().value;
      const oldestVal = responseStore.get(oldest);
      if (oldestVal?.reasoningContent) {
        for (const out of Array.isArray(oldestVal.output) ? oldestVal.output : []) {
          if (out.type === "function_call" && out.call_id) reasoningIndex.delete(out.call_id);
        }
      }
      responseStore.delete(oldest);
    }
  }

  const isToolCallOnly = Array.isArray(data.output) &&
    data.output.length > 0 &&
    data.output.every((o) => o.type === "function_call");

  let consecutiveToolCalls = 0;
  if (data.previousResponseId) {
    const prev = touchResponse(data.previousResponseId);
    if (prev?.breakerFired) {
      // Hard breaker already fired up-chain — counter has been reset; don't propagate.
      consecutiveToolCalls = 0;
    } else if (isToolCallOnly) {
      consecutiveToolCalls = (prev?.consecutiveToolCalls || 0) + 1;
    }
  }

  responseStore.set(id, { ...data, storedAt: Date.now(), consecutiveToolCalls });
  
  // Update reasoning index for O(1) lookup
  if (data.reasoningContent) {
    for (const out of Array.isArray(data.output) ? data.output : []) {
      if (out.type === "function_call" && out.call_id) {
        reasoningIndex.set(out.call_id, data.reasoningContent);
      }
    }
  }
  
  log.info(
    `[proxy] stored response ${id} (provider=${data.provider || "unknown"}, store size: ${responseStore.size}${consecutiveToolCalls > 0 ? `, consecutive_tc: ${consecutiveToolCalls}` : ""})`
  );
}

function resolveResponseChain(previousResponseId) {
  const chain = [];
  let currentId = previousResponseId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const stored = touchResponse(currentId);
    if (!stored) {
      log.warn(`[proxy] previous_response_id ${currentId} not found in store`);
      break;
    }
    chain.unshift(stored);
    currentId = stored.previousResponseId;
  }

  const items = [];
  for (const entry of chain) {
    if (Array.isArray(entry.input)) items.push(...entry.input);
    if (Array.isArray(entry.output)) items.push(...entry.output);
  }
  return items;
}

function normalizeInputToArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return [];
}

function maybeResolvePreviousResponseChain(body, targetProvider) {
  if (!body.previous_response_id) return;

  const previous = responseStore.get(body.previous_response_id);
  if (!previous) {
    if (targetProvider === "deepseek") {
      log.warn(`[proxy] previous_response_id ${body.previous_response_id} missing; DeepSeek request will continue without restored history`);
    }
    return;
  }

  const needsLocalResolution = targetProvider === "deepseek" || previous.provider !== targetProvider;
  if (!needsLocalResolution) return;

  const chainItems = resolveResponseChain(body.previous_response_id);
  if (chainItems.length === 0) return;

  const currentInput = normalizeInputToArray(body.input);
  body.input = [...chainItems, ...currentInput];
  delete body.previous_response_id;
  log.info(`[proxy] locally resolved previous_response_id across provider boundary -> ${targetProvider} (${chainItems.length} items prepended)`);
}

// --- Shared message-list normalisation ---
// normalizeMessages imported from src/protocol.mjs

// --- Request translation: Responses API -> Chat Completions (DeepSeek path only) ---

// Codex CLI's effort enum is: none | minimal | low | medium | high | xhigh.
//
// Each upstream accepts a different subset (verified via probe):
//   DeepSeek (deepseek-v4-*): low | medium | high | max | xhigh
//     - default = thinking ON (no field needed)
//     - to disable thinking: send `thinking: { type: "disabled" }`
//       (NB: `enable_thinking: false` is silently ignored by DeepSeek)
//   MiMo (mimo-v2.5-*):       low | medium | high
//     - same `thinking: { type: "disabled" }` to disable
//
// Translation rules (per provider):
//
//   Codex effort       DeepSeek                          MiMo
//   ----------------   --------------------------------  --------------------------------
//   none               thinking:{type:"disabled"}        thinking:{type:"disabled"}
//   minimal            reasoning_effort:"low"            reasoning_effort:"low"
//   low / medium / high reasoning_effort:<same>          reasoning_effort:<same>
//   xhigh              reasoning_effort:"xhigh"          reasoning_effort:"high" (clamped)
//
// `max` is NOT in Codex's enum (Codex would refuse it during config parse), so it
// can't reach the proxy from a Codex client. We still accept it here for direct
// callers that want DeepSeek's extended max tier; MiMo clamps it like xhigh.
// Anything else is passed through as-is and the upstream gets to 400 it.
// applyEffortTranslation imported from src/protocol.mjs

function forceDisableDeepSeekThinking(req, provider) {
  if (provider !== "deepseek" || !DEEPSEEK_DISABLE_THINKING) return;

  // 关键：DeepSeek 官方关闭 thinking mode 的写法。
  req.thinking = { type: "disabled" };

  // thinking=disabled 时不要再带 reasoning_effort / reasoning，避免上游误判为思考模式。
  delete req.reasoning_effort;
  delete req.reasoning;

  // 如果历史消息里残留了 reasoning_content，关闭 thinking 后也一并移除，
  // 防止历史脏数据导致 DeepSeek 继续要求 reasoning_content round-trip。
  if (Array.isArray(req.messages)) {
    for (const msg of req.messages) {
      if (msg && Object.prototype.hasOwnProperty.call(msg, "reasoning_content")) {
        delete msg.reasoning_content;
      }
    }
  }
}

function responsesRequestToChatCompletions(body, provider) {
  const messages = [];

  if (body.instructions) {
    messages.push({
      role: "user",
      content: "[System Instructions] " + body.instructions + "\n\nNote: Be efficient with tool calls. Avoid repeating the same tool call unnecessarily.",
    });
  }

  // Build callId -> reasoning_content map from the incremental index for O(1) lookup.
  // Previously this scanned the entire responseStore on every DeepSeek request.
  const reasoningByCallId = reasoningIndex; // already indexed by storeResponse

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    let pendingToolCalls = [];
    const flushPendingToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      const msg = { role: "assistant", content: null, tool_calls: pendingToolCalls };
      // Attach reasoning if any of the calls in this batch has one cached.
      // (DeepSeek emits one reasoning per response, shared by all tool_calls.)
      for (const tc of pendingToolCalls) {
        const r = reasoningByCallId.get(tc.id);
        if (r) { msg.reasoning_content = r; break; }
      }
      messages.push(msg);
      pendingToolCalls = [];
    };

    for (const item of body.input) {
      // Tolerate items without explicit `type`: if it has a role/content shape,
      // treat it as a plain message (Codex CLI / cc-switch health probe sends
      // `[{role,content}]` without setting type, and OpenAI's Responses API
      // accepts that form too).
      const itemType = item.type || (item.role ? "message" : undefined);
      if (itemType === "message") {
        const role = (item.role === "developer" || item.role === "system") ? "user" : item.role;
        let content;

        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content.map((block) => {
            if (block.type === "input_text") return { type: "text", text: block.text };
            if (block.type === "output_text") return { type: "text", text: block.text };
            if (block.type === "input_image") {
              return { type: "image_url", image_url: { url: block.image_url || block.url } };
            }
            return block;
          });
          if (content.length === 1 && content[0].type === "text") {
            content = content[0].text;
          }
        }

        if (pendingToolCalls.length > 0 && role === "assistant") {
          flushPendingToolCalls();
        } else {
          flushPendingToolCalls();
          messages.push({ role, content });
        }
      } else if (itemType === "function_call") {
        pendingToolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
      } else if (itemType === "function_call_output") {
        flushPendingToolCalls();
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
      }
    }

    flushPendingToolCalls();
  }

  const merged = normalizeMessages(messages);

  const TOOL_OUTPUT_MAX = 2000;
  const KEEP_RECENT_FULL = 10;
  for (let i = 0; i < Math.max(0, merged.length - KEEP_RECENT_FULL); i++) {
    const msg = merged[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_OUTPUT_MAX) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX) + "\n...[output truncated, " + (msg.content.length - TOOL_OUTPUT_MAX) + " chars removed]";
    }
  }

  const MAX_MESSAGES = 55;
  let finalMessages = merged;
  if (merged.length > MAX_MESSAGES) {
    const head = merged.slice(0, 2);
    let tail = merged.slice(-(MAX_MESSAGES - 3));
    while (tail.length > 0 && tail[0].role === "tool") tail.shift();
    finalMessages = [
      ...head,
      {
        role: "user",
        content: "[Earlier conversation trimmed. Do not repeat previous statements or tool calls you already made. Continue with the current task. If you have enough information, respond to the user instead of making more tool calls.]",
      },
      ...tail,
    ];
    log.info(`[proxy] trimmed ${merged.length} -> ${finalMessages.length} messages`);
  }

  // After trim we may have left orphan tool messages — re-normalise to drop them.
  if (merged.length > MAX_MESSAGES) {
    finalMessages = normalizeMessages(finalMessages);
  }

  const req = {
    model: body.model,
    messages: finalMessages,
    stream: body.stream || false,
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  req.max_tokens = body.max_output_tokens || 16384;

  if (body.tools?.length > 0) {
    const supported = body.tools.filter((t) => t.type === "function");
    if (supported.length > 0) {
      req.tools = supported.map((t) => {
        if (!t.function) {
          return {
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          };
        }
        return t;
      });
    }
  }

  if (body.tool_choice != null) {
    if (typeof body.tool_choice === "object" && body.tool_choice.name) {
      req.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    } else {
      req.tool_choice = body.tool_choice;
    }
  }

  applyEffortTranslation(req, body.reasoning?.effort, provider);
  forceDisableDeepSeekThinking(req, provider);
  if (body.parallel_tool_calls != null) req.parallel_tool_calls = body.parallel_tool_calls;

  // DeepSeek thinking-mode + tool-call round-trip safety net.
  //
  // When DeepSeek runs in thinking mode (the default unless we send
  // `thinking:{type:"disabled"}`), it requires the original `reasoning_content`
  // to be sent back attached to any prior assistant tool_call message; otherwise
  // it 400s with "The `reasoning_content` in the thinking mode must be passed
  // back to the API.". Codex CLI does NOT round-trip `reasoning_content` through
  // this proxy (we strip it from the upstream stream and Codex stores nothing
  // we can replay), so any conversation that includes an assistant tool_call
  // must run with thinking disabled — otherwise the very next turn dies.
  //
  // We trigger this defensively whenever the request body contains an assistant
  // message with `tool_calls` and `req.thinking` isn't already disabled. This
  // also covers the case where the client sends `reasoning:{}` without an
  // explicit effort (then applyEffortTranslation is a no-op and DeepSeek would
  // default to thinking ON).
  if (provider === "deepseek" && req.thinking?.type !== "disabled") {
    const hasAssistantToolCalls = finalMessages.some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !m.reasoning_content
    );
    if (hasAssistantToolCalls) {
      req.thinking = { type: "disabled" };
      delete req.reasoning_effort;
      log.info("[proxy] deepseek: assistant tool_calls without reasoning_content -> forcing thinking:disabled");
    }
  }

  return req;
}

// --- Response translation: Chat Completions -> Responses (DeepSeek path) ---

// uid() imported from src/protocol.mjs

function chatCompletionToResponse(cc, model, previousResponseId, metadata) {
  const responseId = `resp_${uid()}`;
  const output = [];
  const choice = cc.choices?.[0];

  if (!choice) {
    return {
      id: responseId,
      object: "response",
      created_at: cc.created || Math.floor(Date.now() / 1000),
      status: "completed",
      model: model || cc.model,
      output: [],
      usage: translateUsage(cc.usage),
    };
  }

  const msg = choice.message;

  if (msg.tool_calls?.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${uid()}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      });
    }
  }

  let text = msg.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  if (text) {
    output.push({
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (msg.refusal) {
    const msgItem = output.find((o) => o.type === "message") || {
      type: "message",
      id: `msg_${uid()}`,
      status: "completed",
      role: "assistant",
      content: [],
    };
    msgItem.content.push({ type: "refusal", refusal: msg.refusal });
    if (!output.find((o) => o.type === "message")) output.push(msgItem);
  }

  let status = "completed";
  let incompleteDetails = null;
  if (choice.finish_reason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  } else if (choice.finish_reason === "content_filter") {
    status = "incomplete";
    incompleteDetails = { reason: "content_filter" };
  }

  return {
    id: responseId,
    object: "response",
    created_at: cc.created || Math.floor(Date.now() / 1000),
    status,
    model: model || cc.model,
    output,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(cc.usage),
    incomplete_details: incompleteDetails,
  };
}

function translateUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

// buildStreamingResponseEvents, handleStreamingResponse, sendResponseAsStream imported from src/streaming.mjs

// --- Generic upstream helpers (imported from src/shared.mjs) ---

// Wire client-disconnect to upstream cancel so Ctrl+C in Codex CLI doesn't leave
// the upstream stream running. Returns a teardown fn the caller invokes on success.
//
// IMPORTANT: we listen on `res` (ServerResponse), not `req` (IncomingMessage). On
// Node's http server, `req.destroyed` becomes `true` and `req` emits `close` as
// soon as the request body is fully consumed — even while the client is still
// happily waiting for the response. Listening on `req.close` would therefore fire
// a false "client gone" the moment we finished reading the POST body and would
// kill the upstream stream before any chunk got out. `res.close` only fires when
// the underlying socket actually goes away.
//
// `clientGone(res)` is the corresponding "is the socket actually dead?" check
// used inside the SSE loops below; it must NOT consult req.destroyed for the same
// reason.
function wireClientCancel(res, upstreamRes) {
  if (!res || !upstreamRes?.body) return () => {};
  let cancelled = false;
  const onClose = () => {
    if (cancelled) return;
    cancelled = true;
    try { upstreamRes.body.cancel?.(); } catch { /* ignore */ }
  };
  res.once("close", onClose);
  return () => {
    cancelled = true;
    res.off("close", onClose);
  };
}

// True iff the response socket is gone — i.e. the client really disconnected.
// Use this in SSE loops instead of `req.destroyed`, which falsely turns true the
// moment the request body finishes streaming in.
//
// `res.destroyed` flips true on socket teardown. `res.closed` flips true when the
// underlying socket emits 'close'. We deliberately do NOT check `res.writableEnded`
// because that becomes true after our own `res.end()` call — and we don't want
// "we finished writing" to look like "client disappeared".
function clientGone(res) {
  return !!(res && (res.destroyed || res.closed));
}

// Backpressure-aware write. Honours res.write's false return by awaiting drain
// before resolving. Use in SSE loops so slow clients don't blow up memory.
function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return;
  return new Promise((resolve) => res.once("drain", resolve));
}

// readJsonBody, sendUpstreamError — imported from src/shared.mjs

async function pipeResponsesStreamAndCapture(req, upstreamRes, res, onCompleted) {
  res.writeHead(upstreamRes.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  let buffer = "";
  const decoder = new TextDecoder();

  const handleBlock = (block) => {
    const lines = block.split("\n");
    let eventType = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;

    try {
      const parsed = JSON.parse(data);
      if (eventType === "response.completed" || parsed.type === "response.completed") {
        onCompleted(parsed.response || parsed);
      }
    } catch {
      // Ignore parse failures in streamed event capture; stream still passes through.
    }
  };

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      await writeWithBackpressure(res, chunk);
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      let splitIdx;
      while ((splitIdx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        handleBlock(block);
      }
    }

    if (buffer.trim()) handleBlock(buffer);
  } finally {
    teardown();
  }
  res.end();
}

async function forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId) {
  // OpenAI Responses API doesn't accept thinking:{type:"disabled"}; "none" means
  // strip the reasoning hint entirely. Other values pass through unchanged
  // (OpenAI accepts the same enum names: minimal/low/medium/high).
  const eff = body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    if (e === "none") delete body.reasoning;
    else if (e === "xhigh") body.reasoning = { ...body.reasoning, effort: "high" };
    // minimal / low / medium / high pass through.
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    await pipeResponsesStreamAndCapture(req, upstreamRes, res, (completedResponse) => {
      if (completedResponse?.id && Array.isArray(completedResponse.output)) {
        storeResponse(completedResponse.id, {
          provider: "openai",
          input: originalInput,
          output: completedResponse.output,
          previousResponseId: originalPreviousResponseId || null,
        });
      }
    });
    return;
  }

  const response = await upstreamRes.json();
  if (response?.id && Array.isArray(response.output)) {
    storeResponse(response.id, {
      provider: "openai",
      input: originalInput,
      output: response.output,
      previousResponseId: originalPreviousResponseId || null,
    });
  }
  sendJson(res, upstreamRes.status, response);
}

async function forwardOpenAIChatCompletions(req, body, res) {
  // Same effort normalisation as the responses path. Chat Completions uses the
  // flat `reasoning_effort` field; either form may arrive from callers.
  const eff = body.reasoning_effort || body.reasoning?.effort;
  if (eff) {
    const e = String(eff).toLowerCase().trim();
    delete body.reasoning_effort;
    delete body.reasoning;
    if (e === "none") {
      // Drop entirely — OpenAI doesn't support disabling thinking via a flag.
    } else if (e === "xhigh") {
      body.reasoning_effort = "high";
    } else {
      body.reasoning_effort = e;
    }
  }

  const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamRes.ok) {
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  if (body.stream) {
    res.writeHead(upstreamRes.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Stream stall timeout: if no data arrives for 5 minutes, abort
    const STREAM_STALL_TIMEOUT = parseInt(process.env.STREAM_STALL_TIMEOUT_MS || "300000", 10);
    let streamTimer = null;
    const resetStreamTimer = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = setTimeout(() => {
        log.warn("[proxy] stream stall timeout - no data received, aborting");
        if (!res.writableEnded) { try { res.end(); } catch {} }
      }, STREAM_STALL_TIMEOUT);
    };
    resetStreamTimer();
    const teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (const chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        resetStreamTimer();
        await writeWithBackpressure(res, chunk);
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      teardown();
    }
    res.end();
    return;
  }

  const response = await upstreamRes.json();
  sendJson(res, upstreamRes.status, response);
}

// --- OAI-compatible handlers (DeepSeek, MiMo, ...) ---

async function handleOaiCompatResponses(req, provider, body, res, originalInput) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  const originalPreviousResponseId = body.previous_response_id || null;
  maybeResolvePreviousResponseChain(body, provider);

  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS) {
      log.warn(`[proxy] CIRCUIT BREAKER: ${consecutiveTc} consecutive tool-call-only responses detected — injecting stop-loop nudge`);
      const nudge = {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[SYSTEM: You have made ${consecutiveTc} consecutive tool calls without responding to the user. You MUST now stop making tool calls and provide a text response summarizing your progress, findings, and any remaining work. Do NOT make any more tool calls in this response.]`,
        }],
      };
      const currentInput = normalizeInputToArray(body.input);
      body.input = [...currentInput, nudge];
    } else if (consecutiveTc >= Math.floor(MAX_CONSECUTIVE_TOOL_CALLS * 0.75)) {
      log.warn(`[proxy] tool-call loop warning: ${consecutiveTc}/${MAX_CONSECUTIVE_TOOL_CALLS} consecutive tool-call responses`);
    }
  }

  const chatReq = responsesRequestToChatCompletions(body, provider);
  // Honour the model the client asked for if it belongs to this provider; otherwise fall back to the
  // provider's first configured model. (Codex usually sends the configured `model` field already.)
  const requested = normalizeModelId(chatReq.model);
  const isProviderModel = cfg.models.some((m) => normalizeModelId(m) === requested);
  
  // 检查是否使用了别名
  const aliasTarget = MODEL_ALIASES[requested];
  if (aliasTarget && !isProviderModel) {
    log.info(`[proxy] Model alias: "${chatReq.model}" -> provider "${aliasTarget}" -> model "${cfg.defaultModel}"`);
  }
  
  chatReq.model = isProviderModel ? chatReq.model : cfg.defaultModel;
  const isStream = chatReq.stream;

  const upstreamUrl = `${cfg.base}/chat/completions`;
  const upstreamKey = cfg.key;
  const routeLabel = `${provider}(${chatReq.model})`;

  let hardBreakerFired = false;
  if (originalPreviousResponseId) {
    const prevStored = touchResponse(originalPreviousResponseId);
    const consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS + 3) {
      log.warn("[proxy] HARD CIRCUIT BREAKER: stripping all tools to force text response");
      delete chatReq.tools;
      delete chatReq.tool_choice;
      hardBreakerFired = true;
    }
  }

  const hasConversationUrls = conversationHasUrls(chatReq.messages);
  if (hasConversationUrls) {
    chatReq.tools = ensureWebFetchTool(chatReq.tools);
    chatReq.messages = ensureWebFetchHint(chatReq.messages);
  }

  log.info(
    `[proxy] ${routeLabel} | stream=${isStream} | messages=${chatReq.messages.length}${hasConversationUrls ? " | web_fetch_injected" : ""} | roles=[${chatReq.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`
  );

  const t0 = Date.now();

  if (hasConversationUrls) {
    const result = await runWebFetchLoop({
      baseRequest: chatReq,
      initialMessages: chatReq.messages,
      upstreamUrl,
      upstreamKey,
      prefix: "",
      fetchWithTimeout,
      log,
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    const responsesResponse = chatCompletionToResponse(result.response, body.model, originalPreviousResponseId, body.metadata);
    storeResponse(responsesResponse.id, {
      provider,
      input: originalInput,
      output: responsesResponse.output,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: result.response?.choices?.[0]?.message?.reasoning_content || "",
    });

    if (isStream) await sendResponseAsStream(res, responsesResponse, req);
    else sendJson(res, 200, responsesResponse);
    return;
  }

  const upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamKey}`,
    },
    body: JSON.stringify(chatReq),
  });

  if (!upstreamRes.ok) {
    recordStats(provider, false, Date.now() - t0);
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  recordStats(provider, true, Date.now() - t0);
  if (isStream) {
    const { responseId: streamRespId, output: streamOutput, reasoningContent: streamReasoning } = await handleStreamingResponse(
      req,
      upstreamRes,
      res,
      body.model,
      originalPreviousResponseId,
      body.metadata
    );
    storeResponse(streamRespId, {
      provider,
      input: originalInput,
      output: streamOutput,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: streamReasoning || "",
    });
    return;
  }

  const ccResponse = await upstreamRes.json();
  const responsesResponse = chatCompletionToResponse(ccResponse, body.model, originalPreviousResponseId, body.metadata);
  const nonStreamReasoning = ccResponse.choices?.[0]?.message?.reasoning_content || "";
  storeResponse(responsesResponse.id, {
    provider,
    input: originalInput,
    output: responsesResponse.output,
    reasoningContent: nonStreamReasoning,
    previousResponseId: originalPreviousResponseId,
    breakerFired: hardBreakerFired,
  });
  sendJson(res, 200, responsesResponse);
}

async function handleOaiCompatChatCompletions(req, provider, body, res) {
  const cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  const requested = normalizeModelId(body.model);
  const isProviderModel = body.model && cfg.models.some((m) => normalizeModelId(m) === requested);
  body.model = isProviderModel ? body.model : cfg.defaultModel;
  const isStream = body.stream || false;

  const validated = normalizeMessages(body.messages || [], { coerceStrings: true });
  body.messages = validated;
  if (!body.max_tokens) body.max_tokens = 16384;

  // Translate effort hints on the chat/completions path too. Either:
  //   - body.reasoning_effort (Chat Completions native field)
  //   - body.reasoning?.effort (Responses-style field, in case caller mixes them)
  // are normalised through the same per-provider translator that the responses path uses.
  const ccEffort = body.reasoning_effort || body.reasoning?.effort;
  if (ccEffort) {
    delete body.reasoning_effort;
    delete body.reasoning;
    applyEffortTranslation(body, ccEffort, provider);
  }
  forceDisableDeepSeekThinking(body, provider);

  const ccHasUrls = conversationHasUrls(validated);

  if (ccHasUrls) {
    body.tools = ensureWebFetchTool(body.tools);
    body.messages = ensureWebFetchHint(body.messages);
  }

  log.info(`[proxy] chat/completions ${provider}(${body.model}) | stream=${isStream} | messages=${body.messages.length}${ccHasUrls ? " | web_fetch_injected" : ""} | roles=[${body.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`);

  if (ccHasUrls) {
    const result = await runWebFetchLoop({
      baseRequest: body,
      initialMessages: body.messages,
      upstreamUrl: `${cfg.base}/chat/completions`,
      upstreamKey: cfg.key,
      prefix: "cc",
      fetchWithTimeout,
      log,
    });
    if (!result.ok) {
      await sendUpstreamError(result.errorRes, res);
      return;
    }
    // web_fetch succeeded — send the captured chat completion response
    sendJson(res, 200, result.response);
    return;
  }

  // No URLs in conversation — normal chat/completions forwarding
  var upstreamChatRes = await fetchWithTimeout(cfg.base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.key,
    },
    body: JSON.stringify(body),
  });

  if (!upstreamChatRes.ok) {
    await sendUpstreamError(upstreamChatRes, res);
    return;
  }

  if (isStream) {
    res.writeHead(upstreamChatRes.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    var ccStreamTimer = null;
    var resetCcStreamTimer = function () {
      if (ccStreamTimer) clearTimeout(ccStreamTimer);
      ccStreamTimer = setTimeout(function () {
        log.warn("[proxy] chat/completions stream stall - no data, aborting");
        if (!res.writableEnded) { try { res.end(); } catch (e) {} }
      }, 300000);
    };
    resetCcStreamTimer();
    var ccTeardown = wireClientCancel(res, upstreamChatRes);
    try {
      for await (var ccChunk of upstreamChatRes.body) {
        if (clientGone(res)) break;
        resetCcStreamTimer();
        await writeWithBackpressure(res, ccChunk);
      }
    } finally {
      if (ccStreamTimer) clearTimeout(ccStreamTimer);
      ccTeardown();
    }
    res.end();
    return;
  }

  var ccResponse = await upstreamChatRes.json();
  sendJson(res, upstreamChatRes.status, ccResponse);
}

// --- Rate limiting ---
const RATE_LIMIT_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS) || 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;
const rateBuckets = new Map();

function checkRateLimit(req) {
  const key = req.socket.remoteAddress || '127.0.0.1';
  const now = Date.now();
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > RATE_LIMIT_WINDOW * 2) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW).unref();

const server = http.createServer(async (req, res) => {
  // Rate limit check
  if (!checkRateLimit(req)) {
    sendJson(res, 429, { error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: "rate_limit_exceeded" } });
    return;
  }

  // Lightweight access log so we can see what cc-switch / Codex actually sends.
  // Toggle off by setting ACCESS_LOG=0 in .env.
  if (process.env.ACCESS_LOG !== "0") {
    const ua = req.headers["user-agent"] || "";
    log.access(`[access] ${req.method} ${req.url} ua="${ua.slice(0, 60)}"`);
  }

  // Inbound auth gate. /health stays open so cc-switch's reachability ping works
  // without a key (and so smoke tests can verify the server is up before auth kicks in).
  // On success, req.lockedProvider is set to "deepseek" / "mimo" / "openai" / "*".
  req.lockedProvider = "*";
  if (PROXY_AUTH_ENABLED) {
    const isHealth = req.method === "GET" && (req.url === "/health" || req.url === "/");
    const isStats = req.method === "GET" && req.url === "/v1/stats";
    if (!isHealth && !isStats) {
      const header = req.headers["authorization"] || "";
      const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const lock = presented ? PROXY_KEY_TABLE.get(presented) : undefined;
      if (!lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 unauthorized (presented=${presented ? presented.slice(0, 8) + "…" : "<none>"})`);
        }
        sendJson(res, 401, {
          error: {
            message: "Invalid or missing proxy key. Set Authorization: Bearer <key> using one of the keys configured in PROXY_KEYS or PROXY_AUTH_KEY.",
            type: "invalid_request_error",
            code: "proxy_auth_required",
          },
        });
        return;
      }
      req.lockedProvider = lock;
    }
  }

  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    sendJson(res, 200, {
      status: "ok",
      proxy: "Codex Assistant",
      providers: [...enabledProviders],
      default_provider: getFallbackProvider(),
    });
    return;
  }

  // Stats endpoint for UI dashboard
  if (req.method === "GET" && req.url === "/v1/stats") {
    const providerDetails = {};
    for (const [name, p] of Object.entries(stats.byProvider)) {
      providerDetails[name] = {
        sent: p.sent,
        success: p.success,
        error: p.error,
        avgLatencyMs: p.sent > 0 ? Math.round(p.totalLatencyMs / p.sent) : 0,
      };
    }
    const avgLatency = stats.recentLatencies.length > 0
      ? Math.round(stats.recentLatencies.reduce((a,b)=>a+b,0) / stats.recentLatencies.length)
      : 0;
    sendJson(res, 200, {
      uptime_seconds: Math.round((Date.now() - stats.startedAt) / 1000),
      total_requests: stats.totalRequests,
      success_count: stats.successCount,
      error_count: stats.errorCount,
      success_rate: stats.totalRequests > 0 ? Math.round(stats.successCount / stats.totalRequests * 100) : 100,
      avg_latency_ms: avgLatency,
      by_provider: providerDetails,
    });
    return;
  }

  // Images generation endpoint — forwards to OpenAI DALL-E
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    if (!OPENAI_KEY) {
      sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured. Image generation requires an OpenAI API key." } });
      return;
    }
    const body = await readJsonBody(req, res);
    if (!body) return;
    log.info(`[proxy] images/generations model=${body.model || "dall-e-3"} prompt="${(body.prompt || "").slice(0, 60)}..."`);
    try {
      const upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!upstreamRes.ok) {
        await sendUpstreamError(upstreamRes, res);
        return;
      }
      const result = await upstreamRes.json();
      sendJson(res, 200, result);
    } catch (err) {
      log.error("[proxy] images/generations error:", err.message);
      sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/cop")) {
    let url = "";
    let method = "GET";
    let body2 = null;
    let headers2 = {};

    if (req.method === "GET") {
      const parsed = new URL(req.url, "http://localhost");
      url = parsed.searchParams.get("url") || "";
    } else {
      const parsedBody = await readJsonBody(req, res);
      if (!parsedBody) return;
      url = parsedBody.url || "";
      method = parsedBody.method || "GET";
      body2 = parsedBody.body || null;
      headers2 = parsedBody.headers || {};
    }

    if (!url) {
      sendJson(res, 400, { error: "url parameter required" });
      return;
    }

    if (!isAllowedCopUrl(url)) {
      log.warn(`[proxy] /cop blocked SSRF attempt: ${method} ${url}`);
      sendJson(res, 403, { error: "URL not allowed. Only public HTTPS endpoints are permitted." });
      return;
    }

    log.info(`[proxy] /cop ${method} ${url}`);
    const content = await executeWebFetch({ url, method, headers: headers2, body: body2 });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    try {
      const models = await fetchUpstreamModels();
      sendJson(res, 200, {
        object: "list",
        data: models,
        default_provider: getFallbackProvider(),
      });
    } catch (err) {
      log.warn(`[models] upstream fetch failed, falling back to static catalog: ${err.message}`);
      sendJson(res, 200, {
        object: "list",
        data: modelCatalog,
        default_provider: getFallbackProvider(),
      });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/responses" || req.url === "/responses")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    if (process.env.ACCESS_LOG !== "0") {
      const inputType = Array.isArray(body.input) ? `array(${body.input.length})` : typeof body.input;
      log.access(`[access] /v1/responses body keys=${Object.keys(body).join(",")} model=${body.model || "<none>"} input=${inputType} stream=${!!body.stream}`);
    }

    try {
      // If the inbound key locks the request to one provider, fill in the provider's
      // default model when body.model is missing — this lets cc-switch probes (which
      // omit `model` entirely) still get a sensible synthetic response.
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }

      let provider = resolveProviderForModel(body.model);

      // 如果找不到提供商，尝试使用辅助模型的提供商作为回退
      if (!provider) {
        const auxConfig = loadAuxModelConfig();
        if (auxConfig?.auxProvider && enabledProviders.has(auxConfig.auxProvider)) {
          provider = auxConfig.auxProvider;
          log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to aux provider "${provider}"`);
        }
      }

      // 如果还是找不到提供商，使用默认提供商作为回退
      if (!provider) {
        const defaultProvider = getFallbackProvider();
        if (defaultProvider) {
          provider = defaultProvider;
          // Determine which model to use for the fallback provider
          var fallbackModel = DEFAULT_MODEL;
          if (!fallbackModel) {
            // No DEFAULT_MODEL set — use the first available model from this provider
            fallbackModel = (providerModels[defaultProvider] || [])[0] || body.model || '';
          }
          if (fallbackModel && body.model !== fallbackModel) {
            log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to "${provider}" model "${fallbackModel}"`);
            body.model = fallbackModel;
          } else {
            log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to default provider "${provider}"`);
          }
        }
      }

      if (!provider) {
        const availableProviders = [...enabledProviders].join(', ') || 'none';
        const errorMsg = body.model
          ? `Model "${body.model}" is not configured. Available providers: ${availableProviders}. Please add the model in user/provider-configs.json.`
          : `No model specified and no default provider available. Available providers: ${availableProviders}.`;

        log.error(`[proxy] ${errorMsg}`);
        sendJson(res, 400, {
          error: {
            message: errorMsg,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        });
        return;
      }

      // Provider-lock enforcement: the inbound key dictates which upstream is allowed.
      // If body.model resolves to a different provider, refuse (the user almost certainly
      // forgot to /model after switching cc-switch profile, or is reusing a key).
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }

      const originalInput = normalizeInputToArray(body.input);

      // Health-check / probe short-circuit: cc-switch (and similar managers) ping the
      // proxy with empty or input-less bodies just to verify reachability. Forwarding
      // those upstream produces a 400 ("Empty input messages") which surfaces in the UI
      // as "供应商拒绝了请求格式". Detect probes (no input AND no previous_response_id)
      // and answer locally without touching the upstream provider.
      const hasInput = originalInput.length > 0 || (typeof body.input === "string" && body.input.trim().length > 0);
      const hasPrevious = !!body.previous_response_id;
      if (!hasInput && !hasPrevious) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] /v1/responses probe short-circuit (provider=${provider})`);
        }
        const probeId = `resp_probe_${uid()}`;
        sendJson(res, 200, {
          id: probeId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: body.model || (OAI_COMPAT_PROVIDERS[provider]?.defaultModel) || "probe",
          output: [
            {
              type: "message",
              id: `msg_probe_${uid()}`,
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          previous_response_id: null,
          metadata: { probe: true },
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
          incomplete_details: null,
        });
        return;
      }

      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        const originalPreviousResponseId = body.previous_response_id || null;
        maybeResolvePreviousResponseChain(body, "openai");
        log.info(`[proxy] responses openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatResponses(req, provider, body, res, originalInput);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] responses route error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    const body = await readJsonBody(req, res);
    if (!body) return;

    try {
      const lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        const lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }
      let provider = resolveProviderForModel(body.model);

      // 如果找不到提供商，尝试使用辅助模型的提供商作为回退
      if (!provider) {
        const auxConfig = loadAuxModelConfig();
        if (auxConfig?.auxProvider && enabledProviders.has(auxConfig.auxProvider)) {
          provider = auxConfig.auxProvider;
          log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to aux provider "${provider}"`);
        }
      }

      // 如果还是找不到提供商，使用默认提供商作为回退
      if (!provider) {
        const defaultProvider = getFallbackProvider();
        if (defaultProvider) {
          provider = defaultProvider;
          // Determine which model to use for the fallback provider
          var fallbackModel = DEFAULT_MODEL;
          if (!fallbackModel) {
            // No DEFAULT_MODEL set — use the first available model from this provider
            fallbackModel = (providerModels[defaultProvider] || [])[0] || body.model || '';
          }
          if (fallbackModel && body.model !== fallbackModel) {
            log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to "${provider}" model "${fallbackModel}"`);
            body.model = fallbackModel;
          } else {
            log.info(`[Codex Assistant] Unknown model "${body.model}" → fallback to default provider "${provider}"`);
          }
        }
      }

      if (!provider) {
        const availableProviders = [...enabledProviders].join(', ') || 'none';
        const errorMsg = body.model
          ? `Model "${body.model}" is not configured. Available providers: ${availableProviders}. Please add the model in user/provider-configs.json.`
          : `No model specified and no default provider available. Available providers: ${availableProviders}.`;

        log.error(`[proxy] ${errorMsg}`);
        sendJson(res, 400, {
          error: {
            message: errorMsg,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        });
        return;
      }
      
      if (lock !== "*" && provider !== lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 provider lock mismatch (key locks=${lock}, model=${body.model || "<none>"} -> provider=${provider})`);
        }
        sendJson(res, 401, {
          error: {
            message: `This proxy key is locked to provider "${lock}", but the request model "${body.model || "<none>"}" routes to "${provider}". Either switch model or use a different key.`,
            type: "invalid_request_error",
            code: "proxy_provider_lock",
          },
        });
        return;
      }
      if (provider === "openai") {
        if (!OPENAI_KEY) {
          sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured" } });
          return;
        }
        log.info(`[proxy] chat/completions openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIChatCompletions(req, body, res);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatChatCompletions(req, provider, body, res);
        return;
      }

      sendJson(res, 400, { error: { message: `Unknown provider resolved: ${provider}` } });
    } catch (err) {
      log.error("[proxy] chat/completions route error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  // Assistants API stubs — Codex++ Tasks feature probes these endpoints.
  // Return empty/valid responses so Codex++ doesn't show "thread not found".
  if (req.method === "POST" && (req.url === "/v1/threads" || req.url === "/threads")) {
    var threadId = "thread_" + uid();
    sendJson(res, 200, { id: threadId, object: "thread", created_at: Math.floor(Date.now() / 1000), metadata: {} });
    return;
  }
  if (req.method === "POST" && req.url.match(/^\/v1\/threads\/[^/]+\/runs$/)) {
    var runId = "run_" + uid();
    var body2 = await readJsonBody(req, res);
    if (!body2) return;
    sendJson(res, 200, {
      id: runId, object: "thread.run", created_at: Math.floor(Date.now() / 1000),
      thread_id: req.url.split("/")[3],
      assistant_id: body2.assistant_id || "asst_default",
      status: "completed", model: body2.model || "default"
    });
    return;
  }
  if (req.method === "GET" && req.url.match(/^\/v1\/threads\/[^/]+$/)) {
    sendJson(res, 200, { id: req.url.split("/")[3], object: "thread", created_at: Math.floor(Date.now() / 1000), metadata: {} });
    return;
  }

  sendJson(res, 404, { error: "Not found. Use POST /v1/responses" });
});

server.timeout = 0;
server.keepAliveTimeout = 300000;
server.headersTimeout = 300000;
server.requestTimeout = 0;

// --- Graceful shutdown ---
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Codex Assistant] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log("[Codex Assistant] server closed");
    process.exit(0);
  });
  setTimeout(() => { console.log("[Codex Assistant] forced exit after timeout"); process.exit(1); }, 10_000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[Codex Assistant] Listening on http://localhost:${PORT}`);
  console.log(`[Codex Assistant] Default provider: ${getFallbackProvider()}`);
  for (const [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`[Codex Assistant] ${label.padEnd(8)}: ${cfg.key ? `${cfg.base} | models=${cfg.models.join(", ")}` : "DISABLED"}`);
  }
  console.log(`[Codex Assistant] OpenAI  : ${OPENAI_KEY ? `${OPENAI_BASE} | models=${OPENAI_MODELS.join(", ")}` : "DISABLED"}`);
  console.log(`[Codex Assistant] GitHub  : ${process.env.GITHUB_TOKEN ? "authenticated (env)" : "lazy (will run `gh auth token` on first api.github.com fetch)"}`);
  
  if (!PROXY_AUTH_ENABLED) {
    console.log(`[Codex Assistant] Inbound : OPEN — anyone on localhost can use this proxy (set PROXY_AUTH_KEY or PROXY_KEYS to lock down)`);
  } else {
    console.log(`[Codex Assistant] Inbound : auth required (${PROXY_KEY_TABLE.size} key${PROXY_KEY_TABLE.size === 1 ? "" : "s"} loaded)`);
    for (const [key, lock] of PROXY_KEY_TABLE) {
      const fingerprint = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
      const lockLabel = lock === "*" ? "any provider" : `locked to ${lock}`;
      console.log(`[Codex Assistant]           sha256:${fingerprint} — ${lockLabel}`);
    }
  }
});
