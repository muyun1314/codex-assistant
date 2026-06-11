import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tryDecryptApiKey, getMachineKey } from "./src/crypto-store.mjs";
import { parseCsv, normalizeModelId, contentHasUrl, sendJson, fetchWithTimeout, readJsonBody, sendUpstreamError, wireClientCancel, clientGone, writeWithBackpressure, conversationHasUrls, latestUserMessageHasUrl } from "./src/shared.mjs";
import { uid, applyEffortTranslation, normalizeMessages, KNOWN_CONTEXT_WINDOWS, AVG_TOKENS_PER_MESSAGE, DEFAULT_CONTEXT_WINDOW, getModelContextWindow, calcMaxMessages, normalizeInputToArray, translateUsage, chatCompletionToResponse, forceDisableDeepSeekThinking } from "./src/protocol.mjs";
import {
  jinaRead, rawFetch, executeWebFetch, ensureWebFetchTool,
  ensureWebFetchHint, runWebFetchLoop, WEB_FETCH_TOOL
} from "./src/web-fetch.mjs";
import { handleStreamingResponse, sendResponseAsStream, buildStreamingResponseEvents } from "./src/streaming.mjs";
import { checkRateLimit, startRateLimitCleanup } from "./src/rate-limit.mjs";
import { touchResponse, storeResponse, resolveResponseChain, reasoningIndex as storeReasoningIndex, MAX_CONSECUTIVE_TOOL_CALLS } from "./src/store.mjs";
var execFileAsync = promisify(execFileCb);

// === Diagnostics: concurrent request tracking & event-loop monitor ===
var _activeRequests = 0;
var _activeByProvider = new Map();   // provider -> count
var _eventLoopMaxLag = 0;
var _eventLoopCheckCount = 0;

// === Message trim stats: cumulative savings tracking ===
var _trimStats = { totalTrimmed: 0, totalRequests: 0, lastTrimCount: 0 };

// Event-loop lag monitor: lightweight non-blocking check every 5s
// Measures lag by scheduling a callback and comparing expected vs actual fire time.
// No busy-wait spin — zero CPU cost when the event loop is healthy.
setInterval(function() {
  var scheduled = Date.now();
  setImmediate(function() {
    var lag = Date.now() - scheduled;
    if (lag > _eventLoopMaxLag) _eventLoopMaxLag = lag;
    _eventLoopCheckCount++;
    if (lag > 500) {
      console.warn('[proxy] DIAG: event-loop lag=' + lag + 'ms active=' + _activeRequests + ' providers=' + JSON.stringify(Object.fromEntries(_activeByProvider)));
    }
  });
}, 5000).unref();

function _diagReqStart(provider) {
  _activeRequests++;
  _activeByProvider.set(provider, (_activeByProvider.get(provider) || 0) + 1);
}

function _diagReqEnd(provider) {
  _activeRequests--;
  var c = (_activeByProvider.get(provider) || 1) - 1;
  if (c <= 0) _activeByProvider.delete(provider);
  else _activeByProvider.set(provider, c);
}

function _diagDump() {
  var dump = {
    active: _activeRequests,
    byProvider: Object.fromEntries(_activeByProvider),
    eventLoopMaxLag: _eventLoopMaxLag,
    eventLoopChecks: _eventLoopCheckCount,
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  };
  return dump;
}

// Expose diagnostics via health endpoint

var PORT = process.env.PROXY_PORT || 4000;
var MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE) || 10 * 1024 * 1024; // 10 MB default
var MAX_ENTRY_SIZE = Number(process.env.MAX_ENTRY_SIZE_BYTES) || 1024 * 1024; // 1MB per response store entry

// --- SSRF protection for /cop endpoint ---
function isPrivateIPv4(hostname) {
  // Normalize: strip brackets (IPv6), leading zeros, etc.
  var h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv6 loopback variants
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // Check IPv4 octets
  var parts = h.split(".");
  if (parts.length !== 4) return false;
  for (var i = 0; i < 4; i++) {
    if (parts[i] === "" || isNaN(parts[i])) return false;
  }
  var a = parseInt(parts[0], 10);
  var b = parseInt(parts[1], 10);
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16.x.x ~ 172.31.x.x)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 0.0.0.0
  if (a === 0 && b === 0) return true;
  return false;
}

function isAllowedCopUrl(urlStr) {
  try {
    var u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    var hostname = u.hostname;
    // Block localhost by name
    if (
      hostname === "localhost" ||
      hostname === "metadata.google.internal" ||
      hostname === "instance-data"
    ) {
      return false;
    }
    // Block all private/internal IPv4 ranges (RFC1918 + link-local + loopback)
    if (isPrivateIPv4(hostname)) return false;
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
    // Create new log file for this session (使用本地时间)
    var d = new Date();
    var ts = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') + '-' +
      String(d.getMinutes()).padStart(2, '0') + '-' +
      String(d.getSeconds()).padStart(2, '0');
    _logFile = path.join(LOG_DIR, "proxy-" + ts + ".log");
    _logStream = fs.createWriteStream(_logFile, { flags: "w" });
  } catch(e) {
    console.error("[proxy] Failed to init logging:", e.message);
  }
})();

// 确保进程退出时关闭日志流
process.on('exit', function() {
  if (_logStream) {
    _logStream.end();
    _logStream = null;
  }
});

// SIGINT/SIGTERM handled by gracefulShutdown below (line ~2280)

function _formatLog(level, args) {
  var d = new Date();
  d.setHours(d.getHours() + 8);
  var ts = d.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
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
  log.error("[proxy] UNCAUGHT EXCEPTION (fatal):", err.stack || err.message);
  log.error("[proxy] Process will exit in 2s to avoid running in undefined state...");
  setTimeout(function() { process.exit(1); }, 2000);
});
process.on("unhandledRejection", function(err) {
  log.error("[proxy] UNHANDLED REJECTION:", err?.stack || err?.message || err);
});

// === Request statistics ===
var stats = {
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
  var p = stats.byProvider[provider];
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
//   - locks the request to one provider ("deepseek" / "mimo" / "openai") → body.model
//     must resolve to that provider, otherwise 401. If body.model is empty, the
//     provider's default model is used.
//   - is a wildcard ("*") — model field decides routing, same as legacy behaviour.
//
// PROXY_AUTH_KEY (if set) is appended as a wildcard entry, so existing single-key
// setups keep working untouched.
//
// If both env vars are empty, inbound auth is DISABLED — anyone on localhost can
// hit the proxy. /health is always exempt regardless.

var PROXY_AUTH_KEY = (process.env.PROXY_AUTH_KEY || "").trim();
var PROXY_KEYS_RAW = (process.env.PROXY_KEYS || "").trim();

// Map<key, provider | "*">
var PROXY_KEY_TABLE = new Map();
// Base set: static providers + wildcard. Dynamic providers are added after load.
var VALID_LOCK_PROVIDERS = new Set(["deepseek", "mimo", "openai", "*"]);

function loadProxyKeyTable() {
  for (var entry of parseCsv(PROXY_KEYS_RAW)) {
    var idx = entry.lastIndexOf(":");
    if (idx === -1) {
      log.warn(`[proxy] PROXY_KEYS entry missing ':<provider>': "${entry}" — ignored`);
      continue;
    }
    var key = entry.slice(0, idx).trim();
    var provider = entry.slice(idx + 1).trim().toLowerCase();
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
var PROXY_AUTH_ENABLED = false;

var DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
var DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
var DEEPSEEK_MODELS = parseCsv(process.env.DEEPSEEK_MODELS || "deepseek-v4-pro,deepseek-v4-flash");

// DeepSeek V4 默认会开启 thinking mode。Codex / Codex Assistant 目前不会稳定回传
// DeepSeek 要求的 `reasoning_content`，所以默认强制关闭 DeepSeek thinking，
// 避免 400: "reasoning_content in the thinking mode must be passed back"。
// 如确实想重新开启，可在 .env 设置：DEEPSEEK_DISABLE_THINKING=0
var DEEPSEEK_DISABLE_THINKING = process.env.DEEPSEEK_DISABLE_THINKING !== "0";
if (DEEPSEEK_DISABLE_THINKING && DEEPSEEK_KEY) {
  console.log("[config] DeepSeek thinking disabled by default (reasoning_content from history is still preserved to avoid 400 errors)");
}

var MIMO_BASE = process.env.MIMO_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
var MIMO_KEY = process.env.MIMO_API_KEY || "";
var MIMO_MODELS = parseCsv(process.env.MIMO_MODELS || "mimo-v2.5-pro");

var OPENAI_BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
var OPENAI_KEY = process.env.OPENAI_API_KEY || "";
// Default empty — OpenAI is opt-in, set OPENAI_MODELS or OPENAI_API_KEY explicitly to enable.
var OPENAI_MODELS = parseCsv(process.env.OPENAI_MODELS || "");
var OPENAI_MODEL_PREFIXES = parseCsv(process.env.OPENAI_MODEL_PREFIXES || "gpt-,o1,o3,o4,codex-,chatgpt-");

var DEFAULT_PROVIDER = (process.env.DEFAULT_PROVIDER || "").trim().toLowerCase();
var DEFAULT_MODEL = (process.env.DEFAULT_MODEL || "").trim();

// Reasoning effort settings
var DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "";
var MIMO_REASONING_EFFORT = process.env.MIMO_REASONING_EFFORT || "";

// --- Startup configuration validation ---
function validateConfig() {
  var warnings = [];
  var errors = [];
  var urlFields = [
    { name: "DEEPSEEK_BASE", value: DEEPSEEK_BASE },
    { name: "MIMO_BASE", value: MIMO_BASE },
    { name: "OPENAI_BASE", value: OPENAI_BASE },
  ];
  for (var { name, value } of urlFields) {
    if (value) {
      try { new URL(value); }
      catch { errors.push(`${name}="${value}" is not a valid URL`); }
    }
  }
  if (DEEPSEEK_REASONING_EFFORT) {
    var valid = ["none", "low", "medium", "high"];
    if (!valid.includes(DEEPSEEK_REASONING_EFFORT)) warnings.push(`DEEPSEEK_REASONING_EFFORT="${DEEPSEEK_REASONING_EFFORT}" invalid; expected: ${valid.join(", ")}`);
  }
  if (MIMO_REASONING_EFFORT) {
    var valid = ["none", "low", "medium", "high"];
    if (!valid.includes(MIMO_REASONING_EFFORT)) warnings.push(`MIMO_REASONING_EFFORT="${MIMO_REASONING_EFFORT}" invalid; expected: ${valid.join(", ")}`);
  }
  if (errors.length) {
    for (var e of errors) console.error(`[config] ERROR: ${e}`);
    throw new Error("Configuration validation failed");
  }
  for (var w of warnings) console.warn(`[config] WARNING: ${w}`);
}
validateConfig();

// 检查是否有任何上游 Key（环境变量、动态提供商配置文件）
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
  setTimeout(function() { process.exit(1); }, 1000);
}

// Optional: read MODEL_CATALOG_PATH (the same proxy-models.json Codex uses) so the
// proxy and Codex agree on which models exist. If a model in the catalog has an
// explicit `provider` field, that wins. Otherwise we infer by name (deepseek-* /
// mimo-* / gpt-*). When the file is absent or unreadable we fall back to the
// env-var lists (DEEPSEEK_MODELS, MIMO_MODELS, OPENAI_MODELS) — i.e. backwards
// compatible with the original setup.
var MODEL_CATALOG_PATH = (process.env.MODEL_CATALOG_PATH || "").trim();
function loadCatalogModels(path) {
  try {
    var raw = JSON.parse(fs.readFileSync(path, "utf-8"));
    var out = { deepseek: [], mimo: [], openai: [] };
    for (var m of raw.models || []) {
      if (!m?.slug) continue;
      var p = (m.provider || "").toLowerCase();
      if (!p) {
        var s = m.slug.toLowerCase();
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
var CATALOG = MODEL_CATALOG_PATH ? loadCatalogModels(MODEL_CATALOG_PATH) : null;
if (CATALOG) {
  if (CATALOG.deepseek.length) DEEPSEEK_MODELS.splice(0, DEEPSEEK_MODELS.length, ...CATALOG.deepseek);
  if (CATALOG.mimo.length) MIMO_MODELS.splice(0, MIMO_MODELS.length, ...CATALOG.mimo);
  if (CATALOG.openai.length) OPENAI_MODELS.splice(0, OPENAI_MODELS.length, ...CATALOG.openai);
}

// ==================== 动态加载提供商配置 ====================
var USER_DIR = path.join(_proxyDir, 'user');
var PROVIDERS_FILE = path.join(USER_DIR, 'provider-configs.json');

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
    var masterKey = getMachineKey();
    if (!masterKey) masterKey = (process.env.PROXY_AUTH_KEY || '').trim();
    
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
          // Fallback: try PROXY_AUTH_KEY if machine key failed
          var proxyAuthKey = (process.env.PROXY_AUTH_KEY || '').trim();
          if (proxyAuthKey) {
            var fallback = tryDecryptApiKey(apiKey, Buffer.from(proxyAuthKey, 'utf8'));
            if (fallback.key !== null) {
              apiKey = fallback.key;
            } else {
              console.error('[proxy] Failed to decrypt key for provider "' + p.name + '" — skipping. Master key may have changed.');
              continue;
            }
          } else {
            console.error('[proxy] Failed to decrypt key for provider "' + p.name + '" — skipping. Master key may have changed.');
            continue;
          }
        }
      }
      
      if (!apiKey) continue;
      
      // 提取提供商名称作为 key（转小写，去掉空格）
      var name = p.name.toLowerCase().replace(/\s+/g, '');
      providerNames.push(name);
      
      // 从模型列表中提取模型 ID 和上下文窗口大小
      var models = [];
      for (var j = 0; j < (p.models || []).length; j++) {
        var slug = p.models[j].slug || p.models[j].id;
        if (slug) {
          models.push(slug);
          // 存储每个模型的上下文窗口大小
          if (p.models[j].context_window) {
            MODEL_CONTEXT_WINDOWS.set(slug, p.models[j].context_window);
          }
        }
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

// ---- Model context window sizes (tokens) ----
// Dynamically populated from provider-configs.json; known models get defaults from protocol.mjs.
var MODEL_CONTEXT_WINDOWS = new Map();

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

var OAI_COMPAT_PROVIDERS = buildProviders();

// Populate MODEL_CONTEXT_WINDOWS with known defaults for models not yet configured
for (var [model, ctx] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
  if (!MODEL_CONTEXT_WINDOWS.has(model)) {
    MODEL_CONTEXT_WINDOWS.set(model, ctx);
  }
}

// Load proxy key table AFTER providers are built so dynamic
// provider names are registered in VALID_LOCK_PROVIDERS.
loadProxyKeyTable();
PROXY_AUTH_ENABLED = PROXY_KEY_TABLE.size > 0;

// 启动时打印加载的提供商信息
console.log('[Codex Assistant] Loaded providers:');
for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  var status = cfg.key ? '[key]' : '[no key]';
  console.log(`  ${name}: ${cfg.models.length} models, base=${cfg.base} ${status}`);
}

var enabledProviders = new Set();
for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  if (cfg.key) enabledProviders.add(name);
}
if (OPENAI_KEY) enabledProviders.add("openai");

// 打印启用的提供商
console.log('[Codex Assistant] Enabled providers:', [...enabledProviders].join(', ') || 'none');

var providerModels = {
  ...Object.fromEntries(Object.entries(OAI_COMPAT_PROVIDERS).map(([n, c]) => [n, c.models])),
  openai: OPENAI_MODELS,
};

var modelOwners = new Map();
for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  if (!cfg.key) continue;
  for (var model of cfg.models) {
    var key = normalizeModelId(model);
    if (!modelOwners.has(key)) modelOwners.set(key, new Set());
    modelOwners.get(key).add(name);
  }
}
if (OPENAI_KEY) {
  for (var model of OPENAI_MODELS) {
    var key = normalizeModelId(model);
    if (!modelOwners.has(key)) modelOwners.set(key, new Set());
    modelOwners.get(key).add("openai");
  }
}

function publicModelId(provider, model) {
  var key = normalizeModelId(model);
  var owners = modelOwners.get(key);
  return owners && owners.size > 1 ? `${provider}/${model}` : model;
}

var explicitModelProvider = new Map();
for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
  for (var model of cfg.models) {
    var key = normalizeModelId(model);
    var publicKey = normalizeModelId(publicModelId(name, model));
    explicitModelProvider.set(publicKey, name);
    if (MODEL_CONTEXT_WINDOWS.has(model) && publicKey !== key) {
      MODEL_CONTEXT_WINDOWS.set(publicKey, MODEL_CONTEXT_WINDOWS.get(model));
    }

    if (!explicitModelProvider.has(key)) {
      explicitModelProvider.set(key, name);
    } else {
      var existing = explicitModelProvider.get(key);
      if (existing !== name) {
        var existingCfg = OAI_COMPAT_PROVIDERS[existing];
        var newCfg = OAI_COMPAT_PROVIDERS[name];
        var existingHasKey = existingCfg && existingCfg.key;
        var newHasKey = newCfg && newCfg.key;
        if (newHasKey && !existingHasKey) {
          log.warn('[proxy] model conflict override: "' + key + '" reassigned from "' + existing + '" (no key) to "' + name + '" (keyed)');
          explicitModelProvider.set(key, name);
        } else {
          log.warn('[proxy] model slug conflict: "' + key + '" registered by "' + existing + '", using public ids "' + existing + '/' + key + '" and "' + name + '/' + key + '"');
        }
      }
    }
  }
}
for (var model of OPENAI_MODELS) {
  var key = normalizeModelId(model);
  var publicKey = normalizeModelId(publicModelId("openai", model));
  explicitModelProvider.set(publicKey, "openai");
  if (!explicitModelProvider.has(key)) {
    explicitModelProvider.set(key, "openai");
  }
}

var modelCatalog = [
  ...Object.entries(OAI_COMPAT_PROVIDERS)
    .filter(([name, cfg]) => cfg.key) // 只包含有 key 的提供商
    .flatMap(([name, cfg]) => cfg.models.map((id) => ({ id: publicModelId(name, id), object: "model", owned_by: name }))),
  ...OPENAI_MODELS.map((id) => ({ id: publicModelId("openai", id), object: "model", owned_by: "openai" })),
];

// --- Dynamic model list fetching from upstream providers ---
var MODEL_LIST_CACHE_TTL = Number(process.env.MODEL_LIST_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
var _modelListCache = { data: null, ts: 0 };

async function fetchUpstreamModels() {
  var now = Date.now();
  if (_modelListCache.data && (now - _modelListCache.ts) < MODEL_LIST_CACHE_TTL) {
    return _modelListCache.data;
  }

  // Build fallback model-list URLs for a given base URL
  function buildModelUrls(base) {
    var b = base.replace(/\/+$/, '');
    var urls = [];
    // Primary: ${base}/models  (e.g. /v1/models)
    urls.push(`${b}/models`);
    // Fallback: strip /v1 and try /models (e.g. /models)
    var noV1 = b.replace(/\/v1$/i, '');
    if (noV1 !== b) urls.push(`${noV1}/models`);
    return [...new Set(urls)];
  }

  async function tryFetchModels(baseUrl, key, owner) {
    var urls = buildModelUrls(baseUrl);
    for (var url of urls) {
      try {
        var r = await fetchWithTimeout(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
        }, 10_000);
        if (!r.ok) {
          log.warn(`[proxy] model-list ${url} → HTTP ${r.status}`);
          continue;
        }
        var json = await r.json().catch(() => null);
        var list = json?.data || json?.models || [];
        if (list.length > 0) {
          return list.map((m) => {
            var id = typeof m === "string" ? m : m.id;
            return {
              id: publicModelId(owner, id),
              object: "model",
              owned_by: owner,
            };
          });
        }
        log.warn(`[proxy] model-list ${url} → empty list`);
      } catch (e) {
        log.warn(`[proxy] model-list ${url} → ${e.message}`);
      }
    }
    return [];
  }

  var fetches = [];

  for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    if (!cfg.key) continue;
    fetches.push(tryFetchModels(cfg.base, cfg.key, name));
  }

  if (OPENAI_KEY) {
    fetches.push(tryFetchModels(OPENAI_BASE, OPENAI_KEY, "openai"));
  }

  var results = await Promise.all(fetches);
  var upstreamModels = results.flat();

  // Merge: upstream models override static catalog; keep static ones not in upstream
  var upstreamIds = new Set(upstreamModels.map((m) => m.id));
  var merged = [...upstreamModels, ...modelCatalog.filter((m) => !upstreamIds.has(m.id))];

  _modelListCache = { data: merged, ts: now };
  return merged;
}



// --- Response store for previous_response_id bridging ---

var reasoningIndex = storeReasoningIndex; // callId -> reasoningContent, shared incremental index for O(1) lookup
var UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS) || 300000; // 5 min, applies to upstream chat/completions/responses calls

// --- Proxy-side web_fetch tool (bypasses sandbox restrictions) ---
// WEB_FETCH_TOOL, jinaRead, rawFetch, executeWebFetch, ensureWebFetchTool,
// ensureWebFetchHint, and runWebFetchLoop are all imported from src/web-fetch.mjs
// conversationHasUrls, latestUserMessageHasUrl imported from src/shared.mjs

function getFallbackProvider() {
  if (DEFAULT_PROVIDER && enabledProviders.has(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER;
  if (enabledProviders.has("openai")) return "openai";
  for (var name of Object.keys(OAI_COMPAT_PROVIDERS)) {
    if (enabledProviders.has(name)) return name;
  }
  throw new Error("No providers are enabled. Please configure at least one provider in user/provider-configs.json or user/.env");
}

// ==================== 消息上下文裁剪====================
// 长对话中累积大量 tool-call 日志（assistant(tc)+tool 对），导致上下文膨胀。
// 上游 API 响应变慢甚至超时。此功能自动裁剪旧的 tool 回合，仅保留：
//   - 所有 user / system / 纯文本 assistant 消息
//   - 最近 N 轮 tool-call 记录

function loadTrimConfig() {
  try {
    var raw = fs.readFileSync(path.join(USER_DIR, 'message-trim-config.json'), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

function trimMessages(messages, keepRounds) {
  if (!messages || messages.length === 0) return messages;
  keepRounds = keepRounds || 20;

  var toolRounds = [];
  var currentRound = null;
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      currentRound = { start: i, end: -1 };
    } else if (msg.role === 'tool' && currentRound && currentRound.start >= 0) {
      currentRound.end = i;
      toolRounds.push(currentRound);
      currentRound = null;
    }
  }

  if (toolRounds.length <= keepRounds) return messages;

  var deleteSet = new Set();
  var roundsToDelete = toolRounds.length - keepRounds;
  for (var r = 0; r < roundsToDelete; r++) {
    for (var idx = toolRounds[r].start; idx <= toolRounds[r].end; idx++) {
      deleteSet.add(idx);
    }
  }

  var trimmed = [];
  for (var j = 0; j < messages.length; j++) {
    if (!deleteSet.has(j)) trimmed.push(messages[j]);
  }
  return trimmed;
}

// Heuristic name-based routing for OAI-compatible providers when the explicit map misses.
// Order matters: longer/more-specific tokens first so e.g. "deepseek-mimo" wouldn't
// accidentally fall through to MiMo. Keep this list short and add entries when needed.
var OAI_COMPAT_NAME_HINTS = [
  { provider: "deepseek", tokens: ["deepseek"] },
  { provider: "mimo",     tokens: ["mimo", "xiaomi"] },
];

// ==================== 模型别名映射 ====================
// 运行时别名（由 UI 的辅助模型配置动态生成）
var MODEL_ALIASES = {};

// 读取当前应用模型配置
function loadAuxModelConfig() {
  try {
    var auxConfigPath = path.join(USER_DIR, 'aux-model-config.json');
    if (!fs.existsSync(auxConfigPath)) return null;
    return JSON.parse(fs.readFileSync(auxConfigPath, 'utf-8'));
  } catch {
    return null;
  }
}

function normalizeProviderName(provider) {
  return String(provider || "").trim().toLowerCase().replace(/\s+/g, "");
}

function isAuxRequestModel(model) {
  var normalized = normalizeModelId(stripProviderPrefix(model));
  var compact = normalized.replace(/[\s_-]/g, "");
  return compact === "gpt5.4" || compact === "gpt54" || compact === "gpt5.4mini" || compact === "gpt54mini";
}

function resolveConfiguredRoute(requestedModel) {
  var auxConfig = loadAuxModelConfig();
  if (!auxConfig || !auxConfig.mainModel) return null;

  var useAuxRoute = isAuxRequestModel(requestedModel) && !!auxConfig.auxModel;
  var targetModel = useAuxRoute ? auxConfig.auxModel : auxConfig.mainModel;
  var configuredProvider = normalizeProviderName(
    useAuxRoute ? (auxConfig.auxProvider || auxConfig.mainProvider) : auxConfig.mainProvider
  );
  var targetProvider = configuredProvider || resolveProviderForModel(targetModel);

  if (!targetProvider || !enabledProviders.has(targetProvider)) return null;
  return {
    provider: targetProvider,
    model: stripProviderPrefix(targetModel),
    source: useAuxRoute ? "aux" : "main",
  };
}

// 更新别名映射
function updateModelAliases() {
  MODEL_ALIASES = {};
  var auxConfig = loadAuxModelConfig();
  if (auxConfig && auxConfig.auxModel && auxConfig.mainModel && auxConfig.auxModel !== auxConfig.mainModel) {
    // 兼容旧逻辑：辅助模型 provider 只作为别名兜底，真正路由以 resolveConfiguredRoute() 的 auxModel/auxProvider 为准。
    var targetProvider = normalizeProviderName(auxConfig.auxProvider || auxConfig.mainProvider) || resolveProviderForModel(auxConfig.auxModel);
    if (targetProvider && enabledProviders.has(targetProvider)) {
      // Codex Desktop may send gpt-5.4/gpt5.4 for background tasks.
      // The match key must be the placeholder request model, NOT auxModel (the target model name).
      MODEL_ALIASES["gpt-5.4"] = targetProvider;
      MODEL_ALIASES["gpt5.4"] = targetProvider;
      MODEL_ALIASES["gpt-5.4-mini"] = targetProvider;
      MODEL_ALIASES["gpt5.4mini"] = targetProvider;
      console.log(`[Codex Assistant] Aux model alias: gpt-5.4 -> ${targetProvider} (target model: ${auxConfig.auxModel})`);
    }
  }
}

// 启动时更新别名
updateModelAliases();

function parseProviderPrefix(model) {
  var s = String(model || "").trim();
  var idx = s.indexOf("/");
  if (idx <= 0) return null;
  return {
    provider: s.slice(0, idx).toLowerCase(),
    model: s.slice(idx + 1),
  };
}

function stripProviderPrefix(model) {
  var parsed = parseProviderPrefix(model);
  return parsed ? parsed.model : model;
}

function resolveProviderForModel(model) {
  var normalized = normalizeModelId(model);
  if (normalized) {
    // 先检查 provider/model 前缀格式（用于区分不同提供商的同名模型）
    var parsed = parseProviderPrefix(model);
    if (parsed) {
      var cfg = OAI_COMPAT_PROVIDERS[parsed.provider];
      if (cfg && cfg.models.some((m) => normalizeModelId(m) === normalizeModelId(parsed.model))) {
        return parsed.provider;
      }
    }

    // 先检查别名映射
    var aliasTarget = MODEL_ALIASES[normalized];
    if (aliasTarget && enabledProviders.has(aliasTarget)) {
      return aliasTarget;
    }

    var explicit = explicitModelProvider.get(normalized);
    if (explicit && enabledProviders.has(explicit)) return explicit;
    for (var { provider, tokens } of OAI_COMPAT_NAME_HINTS) {
      if (enabledProviders.has(provider) && tokens.some((t) => normalized.includes(t))) return provider;
    }
    if (enabledProviders.has("openai")) {
      var looksOpenAI = OPENAI_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
      if (looksOpenAI) return "openai";
    }
  }

  // 如果找不到提供商，返回 null 而不是抛出错误
  return null;
}

function hasFunctionCallOutputInput(input) {
  return normalizeInputToArray(input).some((item) => item?.type === "function_call_output");
}

function maybeResolvePreviousResponseChain(body, targetProvider) {
  if (!body.previous_response_id) return { ok: true, resolved: false };

  var previousResponseId = body.previous_response_id;
  var previous = touchResponse(previousResponseId);
  if (!previous) {
    if (targetProvider === "openai" && hasFunctionCallOutputInput(body.input)) {
      var message = `previous_response_id ${previousResponseId} missing while current input contains function_call_output; refusing to forward orphan tool output`;
      log.warn(`[proxy] ${message}`);
      return { ok: false, status: 409, message, code: "stale_previous_response_id" };
    }
    log.warn(`[proxy] previous_response_id ${previousResponseId} missing; dropping stale chain and continuing with current input only`);
    delete body.previous_response_id;
    return { ok: true, resolved: false, staleDropped: true };
  }

  var needsLocalResolution = targetProvider === "deepseek" || previous.provider !== targetProvider;
  if (!needsLocalResolution) return { ok: true, resolved: false };

  var resolved = resolveResponseChain(previousResponseId, log);
  if (!resolved.complete) {
    delete body.previous_response_id;
    log.warn(`[proxy] previous_response_id ${previousResponseId} chain incomplete; continuing with current input only`);
    return { ok: true, resolved: false, staleDropped: true };
  }
  if (resolved.items.length === 0) {
    delete body.previous_response_id;
    log.warn(`[proxy] previous_response_id ${previousResponseId} resolved to empty history; continuing with current input only`);
    return { ok: true, resolved: false, staleDropped: true };
  }

  var currentInput = normalizeInputToArray(body.input);
  body.input = [...resolved.items, ...currentInput];
  delete body.previous_response_id;
  log.info(`[proxy] locally resolved previous_response_id across provider boundary -> ${targetProvider} (${resolved.items.length} items prepended${resolved.droppedOrphanOutputs ? `, dropped_orphan_outputs=${resolved.droppedOrphanOutputs}` : ""})`);
  return { ok: true, resolved: true, droppedOrphanOutputs: resolved.droppedOrphanOutputs };
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

// forceDisableDeepSeekThinking imported from src/protocol.mjs

function responsesRequestToChatCompletions(body, provider) {
  var messages = [];

  if (body.instructions) {
    messages.push({
      role: "user",
      content: "[System Instructions] " + body.instructions + "\n\nNote: Be efficient with tool calls. Avoid repeating the same tool call unnecessarily.",
    });
  }

  // Build callId -> reasoning_content map from the incremental index for O(1) lookup.
  // Previously this scanned the entire responseStore on every DeepSeek request.
  var reasoningByCallId = reasoningIndex; // already indexed by storeResponse

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    var pendingToolCalls = [];
    var flushPendingToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      var msg = { role: "assistant", content: null, tool_calls: pendingToolCalls };
      // Attach reasoning if any of the calls in this batch has one cached.
      // (DeepSeek emits one reasoning per response, shared by all tool_calls.)
      for (var tc of pendingToolCalls) {
        var r = reasoningByCallId.get(tc.id);
        if (r) { msg.reasoning_content = r; break; }
      }
      messages.push(msg);
      pendingToolCalls = [];
    };

    for (var item of body.input) {
      // Tolerate items without explicit `type`: if it has a role/content shape,
      // treat it as a plain message (Codex CLI / cc-switch health probe sends
      // `[{role,content}]` without setting type, and OpenAI's Responses API
      // accepts that form too).
      var itemType = item.type || (item.role ? "message" : undefined);
      if (itemType === "message") {
        var role = (item.role === "developer" || item.role === "system") ? "user" : item.role;
        var content;

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

  var merged = normalizeMessages(messages);

  var TOOL_OUTPUT_MAX = 2000;
  var KEEP_RECENT_FULL = 10;
  for (var i = 0; i < Math.max(0, merged.length - KEEP_RECENT_FULL); i++) {
    var msg = merged[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_OUTPUT_MAX) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX) + "\n...[output truncated, " + (msg.content.length - TOOL_OUTPUT_MAX) + " chars removed]";
    }
  }

  // Dynamically calculate MAX_MESSAGES based on the model's context window
  var contextWindow = getModelContextWindow(body.model, MODEL_CONTEXT_WINDOWS);
  var MAX_MESSAGES = calcMaxMessages(contextWindow);
  log.info(`[proxy] model="${body.model}" context_window=${contextWindow} tokens, max_messages=${MAX_MESSAGES}`);
  var finalMessages = merged;
  if (merged.length > MAX_MESSAGES) {
    var head = merged.slice(0, 2);
    var tail = merged.slice(-(MAX_MESSAGES - 3));
    while (tail.length > 0 && tail[0].role === "tool") tail.shift();
    finalMessages = [
      ...head,
      {
        role: "user",
        content: "[Earlier conversation trimmed. Do not repeat previous statements or tool calls you already made. Continue with the current task. If you have enough information, respond to the user instead of making more tool calls.]",
      },
      ...tail,
    ];
    var trimmedCount = merged.length - finalMessages.length;
    _trimStats.totalTrimmed += trimmedCount;
    _trimStats.totalRequests++;
    _trimStats.lastTrimCount = trimmedCount;
    log.info(`[proxy] trimmed ${merged.length} -> ${finalMessages.length} messages`);
  }

  // After trim we may have left orphan tool messages — re-normalise to drop them.
  if (merged.length > MAX_MESSAGES) {
    finalMessages = normalizeMessages(finalMessages);
  }

  var droppedAfterNormalize = messages.length - merged.length;
  var droppedAfterFinalNormalize = merged.length > finalMessages.length ? merged.length - finalMessages.length : 0;
  if (droppedAfterNormalize > 0 || droppedAfterFinalNormalize > 0) {
    log.warn(`[proxy] message normalization dropped ${droppedAfterNormalize + droppedAfterFinalNormalize} invalid/orphan message(s) before upstream`);
  }

  var req = {
    model: body.model,
    messages: finalMessages,
    stream: body.stream || false,
  };

  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  req.max_tokens = body.max_output_tokens || 16384;

  if (body.tools?.length > 0) {
    var supported = body.tools.filter((t) => t.type === "function");
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
  forceDisableDeepSeekThinking(req, provider, DEEPSEEK_DISABLE_THINKING);
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
    var hasAssistantToolCalls = finalMessages.some(
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

// chatCompletionToResponse imported from src/protocol.mjs

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
// readJsonBody, sendUpstreamError — imported from src/shared.mjs

async function pipeResponsesStreamAndCapture(req, upstreamRes, res, onCompleted) {
  res.writeHead(upstreamRes.status, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  var teardown = wireClientCancel(res, upstreamRes);
  var buffer = "";
  var decoder = new TextDecoder();

  var handleBlock = (block) => {
    var lines = block.split("\n");
    var eventType = "";
    var dataLines = [];

    for (var line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    var data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;

    try {
      var parsed = JSON.parse(data);
      if (eventType === "response.completed" || parsed.type === "response.completed") {
        onCompleted(parsed.response || parsed);
      }
    } catch {
      // Ignore parse failures in streamed event capture; stream still passes through.
    }
  };

  try {
    for await (var chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      await writeWithBackpressure(res, chunk);
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");

      var splitIdx;
      while ((splitIdx = buffer.indexOf("\n\n")) !== -1) {
        var block = buffer.slice(0, splitIdx);
        buffer = buffer.slice(splitIdx + 2);
        handleBlock(block);
      }
    }

    if (buffer.trim()) handleBlock(buffer);
  } catch (streamErr) {
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 502, { error: { message: "Upstream stream error: " + streamErr.message, type: "upstream_error" } });
    }
  } finally {
    teardown();
  }
  if (!res.writableEnded) res.end();
}

async function forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId) {
  // OpenAI Responses API doesn't accept thinking:{type:"disabled"}; "none" means
  // strip the reasoning hint entirely. Other values pass through unchanged
  // (OpenAI accepts the same enum names: minimal/low/medium/high).
  var eff = body.reasoning?.effort;
  if (eff) {
    var e = String(eff).toLowerCase().trim();
    if (e === "none") delete body.reasoning;
    else if (e === "xhigh") body.reasoning = { ...body.reasoning, effort: "high" };
    // minimal / low / medium / high pass through.
  }

  var upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/responses`, {
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
        }, log);
      }
    });
    return;
  }

  var response = await upstreamRes.json();
  if (response?.id && Array.isArray(response.output)) {
    storeResponse(response.id, {
      provider: "openai",
      input: originalInput,
      output: response.output,
      previousResponseId: originalPreviousResponseId || null,
    }, log);
  }
  sendJson(res, upstreamRes.status, response);
}

async function forwardOpenAIChatCompletions(req, body, res) {
  // Same effort normalisation as the responses path. Chat Completions uses the
  // flat `reasoning_effort` field; either form may arrive from callers.
  var eff = body.reasoning_effort || body.reasoning?.effort;
  if (eff) {
    var e = String(eff).toLowerCase().trim();
    delete body.reasoning_effort;
    delete body.reasoning;
    if (e === "none") {
      // Drop entirely - OpenAI doesn't support disabling thinking via a flag.
    } else if (e === "xhigh") {
      body.reasoning_effort = "high";
    } else {
      body.reasoning_effort = e;
    }
  }

  var upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/chat/completions`, {
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
    var STREAM_STALL_TIMEOUT = parseInt(process.env.STREAM_STALL_TIMEOUT_MS || "300000", 10);
    var streamTimer = null;
    var resetStreamTimer = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = setTimeout(() => {
        log.warn("[proxy] stream stall timeout - no data received, aborting");
        if (!res.writableEnded) {
          try {
            // Send SSE error event so Codex knows the stream failed
            res.write("data: " + JSON.stringify({ type: "error", error: { message: "Stream stall timeout - no data from upstream", type: "upstream_error" } }) + "\n\n");
            res.end();
          } catch {}
        }
      }, STREAM_STALL_TIMEOUT);
    };
    resetStreamTimer();
    var teardown = wireClientCancel(res, upstreamRes);
    try {
      for await (var chunk of upstreamRes.body) {
        if (clientGone(res)) break;
        resetStreamTimer();
        await writeWithBackpressure(res, chunk);
      }
    } catch (streamErr) {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 502, { error: { message: "Upstream stream error: " + streamErr.message, type: "upstream_error" } });
      }
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      teardown();
    }
    if (!res.writableEnded) res.end();
    return;
  }

  var response = await upstreamRes.json();
  sendJson(res, upstreamRes.status, response);
}

// --- OAI-compatible handlers (DeepSeek, MiMo, ...) ---

async function handleOaiCompatResponses(req, provider, body, res, originalInput, diag = {}) {
  _diagReqStart(provider);
  try {
  var cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  var originalPreviousResponseId = body.previous_response_id || null;
  var previousResolution = maybeResolvePreviousResponseChain(body, provider);
  if (!previousResolution.ok) {
    sendJson(res, previousResolution.status || 409, { error: { message: previousResolution.message, type: "invalid_request_error", code: previousResolution.code || "previous_response_unavailable" } });
    return;
  }

  if (originalPreviousResponseId) {
    var prevStored = touchResponse(originalPreviousResponseId);
    var consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS) {
      log.warn(`[proxy] CIRCUIT BREAKER: ${consecutiveTc} consecutive tool-call-only responses detected - injecting stop-loop nudge`);
      var nudge = {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[SYSTEM: You have made ${consecutiveTc} consecutive tool calls without responding to the user. You MUST now stop making tool calls and provide a text response summarizing your progress, findings, and any remaining work. Do NOT make any more tool calls in this response.]`,
        }],
      };
      var currentInput = normalizeInputToArray(body.input);
      body.input = [...currentInput, nudge];
    } else if (consecutiveTc >= Math.floor(MAX_CONSECUTIVE_TOOL_CALLS * 0.75)) {
      log.warn(`[proxy] tool-call loop warning: ${consecutiveTc}/${MAX_CONSECUTIVE_TOOL_CALLS} consecutive tool-call responses`);
    }
  }

  var chatReq = responsesRequestToChatCompletions(body, provider);
  // Honour the model the client asked for if it belongs to this provider; otherwise fall back to the
  // provider's first configured model. (Codex usually sends the configured `model` field already.)
  var requested = normalizeModelId(chatReq.model);
  var isProviderModel = cfg.models.some((m) => normalizeModelId(m) === requested);
  
  // 检查是否使用了别名
  var aliasTarget = MODEL_ALIASES[requested];
  // 优先使用 aux-model-config.json 里配置的 auxModel 作为目标模型
  // 如果没配 alias 或 auxModel 为空，再 fallback 到 DEFAULT_MODEL 或 provider 的第一个模型
  var auxConfig = loadAuxModelConfig();
  var aliasModel;
  if (aliasTarget && auxConfig && auxConfig.auxModel) {
    aliasModel = auxConfig.auxModel;
  } else {
    aliasModel = DEFAULT_MODEL || cfg.defaultModel;
  }
  if (aliasTarget && !isProviderModel) {
    log.info(`[proxy] Model alias: "${chatReq.model}" -> provider "${aliasTarget}" -> model "${aliasModel}"`);
  }
  
  chatReq.model = isProviderModel ? chatReq.model : aliasModel;
  var isStream = chatReq.stream;

  var upstreamUrl = `${cfg.base}/chat/completions`;
  var upstreamKey = cfg.key;
  var routeLabel = `${provider}(${chatReq.model})`;
  diag.routeLabel = routeLabel;
  diag.upstreamProvider = provider;
  diag.upstreamModel = chatReq.model;

  var hardBreakerFired = false;
  if (originalPreviousResponseId) {
    var prevStored = touchResponse(originalPreviousResponseId);
    var consecutiveTc = prevStored?.consecutiveToolCalls || 0;
    if (consecutiveTc >= MAX_CONSECUTIVE_TOOL_CALLS + 3) {
      log.warn("[proxy] HARD CIRCUIT BREAKER: stripping all tools to force text response");
      delete chatReq.tools;
      delete chatReq.tool_choice;
      hardBreakerFired = true;
    }
  }

  // 消息上下文裁剪：删除旧的 tool-call 日志，保留最近 N 轮
  var trimConfig = loadTrimConfig();
  if (trimConfig && trimConfig.enabled) {
    var beforeTrim = chatReq.messages.length;
    chatReq.messages = trimMessages(chatReq.messages, trimConfig.keepToolRounds || 20);
    if (chatReq.messages.length < beforeTrim) {
      var trimmed = beforeTrim - chatReq.messages.length;
      _trimStats.totalTrimmed += trimmed;
      _trimStats.totalRequests++;
      _trimStats.lastTrimCount = trimmed;
      log.info(`[proxy] msg-trim: ${beforeTrim} -> ${chatReq.messages.length} messages (keeping last ${trimConfig.keepToolRounds || 20} tool rounds, saved ${trimmed})`);
    }
    var afterTrim = chatReq.messages.length;
    chatReq.messages = normalizeMessages(chatReq.messages, { coerceStrings: true });
    if (chatReq.messages.length < afterTrim) {
      log.warn(`[proxy] msg-trim normalization dropped ${afterTrim - chatReq.messages.length} orphan tool message(s)`);
    }
  }

  var shouldInjectWebFetch = latestUserMessageHasUrl(chatReq.messages);
  if (shouldInjectWebFetch) {
    chatReq.tools = ensureWebFetchTool(chatReq.tools);
    chatReq.messages = ensureWebFetchHint(chatReq.messages);
  }

  log.info(
    `[proxy] [${diag.requestId || "no-req-id"}] ${routeLabel} | source=${diag.routeSource || "unknown"} requested="${diag.requestedModel || body.model || "<none>"}" stream=${isStream} input=${diag.inputLength ?? "?"} messages=${chatReq.messages.length}${shouldInjectWebFetch ? " | web_fetch_injected" : ""} | roles=[${chatReq.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`
  );

  var t0 = Date.now();

  if (shouldInjectWebFetch) {
    // Early SSE headers + keepalive heartbeat to prevent Codex Desktop from timing out
    // during long web_fetch processing (which can exceed 180s with large contexts).
    // Codex Desktop SSE 超时约 30-60 秒，keepalive 必须更频繁
    var keepaliveTimer = null;
    if (isStream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      keepaliveTimer = setInterval(function() {
        if (!res.writableEnded) { try { res.write(": keepalive\n\n"); } catch {} }
      }, 10000);
    }
    try {
    var wfT0 = Date.now();
    var result = await runWebFetchLoop({
      baseRequest: chatReq,
      initialMessages: chatReq.messages,
      upstreamUrl,
      upstreamKey,
      prefix: "",
      fetchWithTimeout,
      log,
      clientGone: () => clientGone(res),
    });
    var wfMs = Date.now() - wfT0;
    if (!result.ok) {
      log.info(`[proxy] ${routeLabel} | web_fetch=${wfMs}ms ERROR active=${_activeRequests}`);
      if (!res.headersSent) await sendUpstreamError(result.errorRes, res);
      else if (!res.writableEnded) res.end();
      return;
    }
    log.info(`[proxy] ${routeLabel} | web_fetch=${wfMs}ms active=${_activeRequests}`);
    // 客户端可能在 web_fetch 等待期间超时断开
    if (clientGone(res)) {
      log.warn(`[proxy] ${routeLabel} | web_fetch client already gone, discarding upstream response`);
      return;
    }
    var responsesResponse = chatCompletionToResponse(result.response, body.model, originalPreviousResponseId, body.metadata);
    storeResponse(responsesResponse.id, {
      provider,
      input: originalInput,
      output: responsesResponse.output,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: result.response?.choices?.[0]?.message?.reasoning_content || "",
    }, log);

    if (isStream) {
      await sendResponseAsStream(res, responsesResponse, req, true, diag);
      log.info(`[proxy] [${diag.requestId || "no-req-id"}] ${routeLabel} | web_fetch SSE stream sent, output=${responsesResponse.output.length} items`);
    }
    else sendJson(res, 200, responsesResponse);
    } catch (wfErr) {
      // 错误已在 SSE 连接建立后发生，不能改 HTTP 状态码，只能关闭流
      log.error(`[proxy] ${routeLabel} | web_fetch internal error: ${wfErr.message}`);
      if (!res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify({ type: "error", error: { message: wfErr.message } })}\n\n`);
          res.end();
        } catch {}
      }
    } finally {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
    }
    return;
  }

  var upstreamRes = await fetchWithTimeout(upstreamUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamKey}`,
    },
    body: JSON.stringify(chatReq),
  });

  var upstreamMs = Date.now() - t0;
  log.info(`[proxy] [${diag.requestId || "no-req-id"}] ${routeLabel} | upstream=${upstreamMs}ms status=${upstreamRes.status} active=${_activeRequests}`);

  if (!upstreamRes.ok) {
    recordStats(provider, false, upstreamMs);
    await sendUpstreamError(upstreamRes, res);
    return;
  }

  recordStats(provider, true, upstreamMs);
  if (isStream) {
    var streamT0 = Date.now();
    var { responseId: streamRespId, output: streamOutput, reasoningContent: streamReasoning } = await handleStreamingResponse(
      req,
      upstreamRes,
      res,
      body.model,
      originalPreviousResponseId,
      body.metadata,
      diag
    );
    var streamMs = Date.now() - streamT0;
    log.info(`[proxy] [${diag.requestId || "no-req-id"}] ${routeLabel} | stream_done=${streamMs}ms total=${Date.now() - t0}ms response=${streamRespId} output_items=${streamOutput.length}`);
    storeResponse(streamRespId, {
      provider,
      input: originalInput,
      output: streamOutput,
      previousResponseId: originalPreviousResponseId,
      breakerFired: hardBreakerFired,
      reasoningContent: streamReasoning || "",
    }, log);
    return;
  }

  var ccResponse = await upstreamRes.json();
  var responsesResponse = chatCompletionToResponse(ccResponse, body.model, originalPreviousResponseId, body.metadata);
  var nonStreamReasoning = ccResponse.choices?.[0]?.message?.reasoning_content || "";
  storeResponse(responsesResponse.id, {
    provider,
    input: originalInput,
    output: responsesResponse.output,
    reasoningContent: nonStreamReasoning,
    previousResponseId: originalPreviousResponseId,
    breakerFired: hardBreakerFired,
  }, log);
  sendJson(res, 200, responsesResponse);
  } finally { _diagReqEnd(provider); }
}

async function handleOaiCompatChatCompletions(req, provider, body, res) {
  _diagReqStart(provider);
  try {
  var cfg = OAI_COMPAT_PROVIDERS[provider];
  if (!cfg || !cfg.key) {
    sendJson(res, 400, { error: { message: `${cfg?.envKey || provider.toUpperCase() + "_API_KEY"} is not configured` } });
    return;
  }

  var requested = normalizeModelId(body.model);
  var isProviderModel = body.model && cfg.models.some((m) => normalizeModelId(m) === requested);
  body.model = isProviderModel ? body.model : cfg.defaultModel;
  var isStream = body.stream || false;

  var validated = normalizeMessages(body.messages || [], { coerceStrings: true });
  body.messages = validated;
  if (!body.max_tokens) body.max_tokens = 4096;

  // Translate effort hints on the chat/completions path too. Either:
  //   - body.reasoning_effort (Chat Completions native field)
  //   - body.reasoning?.effort (Responses-style field, in case caller mixes them)
  // are normalised through the same per-provider translator that the responses path uses.
  var ccEffort = body.reasoning_effort || body.reasoning?.effort;
  if (ccEffort) {
    delete body.reasoning_effort;
    delete body.reasoning;
    applyEffortTranslation(body, ccEffort, provider);
  }
  forceDisableDeepSeekThinking(body, provider, DEEPSEEK_DISABLE_THINKING);

  var ccHasUrls = latestUserMessageHasUrl(validated);

  if (ccHasUrls) {
    body.tools = ensureWebFetchTool(body.tools);
    body.messages = ensureWebFetchHint(body.messages);
  }

  log.info(`[proxy] chat/completions ${provider}(${body.model}) | stream=${isStream} | messages=${body.messages.length}${ccHasUrls ? " | web_fetch_injected" : ""} | roles=[${body.messages.map((m) => m.role + (m.tool_calls ? "(tc)" : "")).join(",")}]`);

  if (ccHasUrls) {
    var result = await runWebFetchLoop({
      baseRequest: body,
      initialMessages: body.messages,
      upstreamUrl: `${cfg.base}/chat/completions`,
      upstreamKey: cfg.key,
      prefix: "cc",
      fetchWithTimeout,
      log,
      clientGone: () => clientGone(res),
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
        if (!res.writableEnded) {
          try {
            // Send SSE error event so Codex knows the stream failed
            res.write("data: " + JSON.stringify({ error: { message: "Stream stall timeout - no data from upstream", type: "upstream_error" } }) + "\n\n");
            res.end();
          } catch (e) {}
        }
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
    } catch (ccStreamErr) {
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 502, { error: { message: "Upstream stream error: " + ccStreamErr.message, type: "upstream_error" } });
      }
    } finally {
      if (ccStreamTimer) clearTimeout(ccStreamTimer);
      ccTeardown();
    }
    if (!res.writableEnded) res.end();
    return;
  }

  var ccResponse = await upstreamChatRes.json();
  sendJson(res, upstreamChatRes.status, ccResponse);
  } finally { _diagReqEnd(provider); }
}

// 启动限流器清理定时器
var _rateLimitCleanupTimer = startRateLimitCleanup();

var server = http.createServer(async (req, res) => {
  // Rate limit check
  if (!checkRateLimit(req)) {
    sendJson(res, 429, { error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: "rate_limit_exceeded" } });
    return;
  }

  // Lightweight access log so we can see what cc-switch / Codex actually sends.
  // Toggle off by setting ACCESS_LOG=0 in .env.
  if (process.env.ACCESS_LOG !== "0") {
    var ua = req.headers["user-agent"] || "";
    log.access(`[access] ${req.method} ${req.url} ua="${ua.slice(0, 60)}"`);
  }

  // Inbound auth gate. /health stays open so cc-switch's reachability ping works
  // without a key (and so smoke tests can verify the server is up before auth kicks in).
  // On success, req.lockedProvider is set to "deepseek" / "mimo" / "openai" / "*".
  req.lockedProvider = "*";
  if (PROXY_AUTH_ENABLED) {
    var isHealth = req.method === "GET" && (req.url === "/health" || req.url === "/");
    var isStats = req.method === "GET" && req.url === "/v1/stats";
    var isDiag = req.method === "GET" && req.url === "/v1/diag";
    if (!isHealth && !isStats && !isDiag) {
      var header = req.headers["authorization"] || "";
      var presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      // Timing-safe key comparison to prevent timing attacks
      var lock = undefined;
      if (presented) {
        var presentedBuf = Buffer.from(presented);
        for (var [key, val] of PROXY_KEY_TABLE) {
          var keyBuf = Buffer.from(key);
          if (keyBuf.length === presentedBuf.length) {
            try {
              if (crypto.timingSafeEqual(keyBuf, presentedBuf)) {
                lock = val;
                break;
              }
            } catch {}
          }
        }
      }
      if (!lock) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] 401 unauthorized (presented=${presented ? presented.slice(0, 8) + "..." : "<none>"})`);
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
      log_file: _logFile,
      log_dir: LOG_DIR,
      _diag: _diagDump(),
    });
    return;
  }

  // Stats endpoint for UI dashboard
  if (req.method === "GET" && req.url === "/v1/stats") {
    var providerDetails = {};
    for (var [name, p] of Object.entries(stats.byProvider)) {
      providerDetails[name] = {
        sent: p.sent,
        success: p.success,
        error: p.error,
        avgLatencyMs: p.sent > 0 ? Math.round(p.totalLatencyMs / p.sent) : 0,
      };
    }
    var avgLatency = stats.recentLatencies.length > 0
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
      trim_stats: {
        totalTrimmed: _trimStats.totalTrimmed,
        totalRequests: _trimStats.totalRequests,
        lastTrimCount: _trimStats.lastTrimCount,
        estimatedTokensSaved: _trimStats.totalTrimmed * 800  // ~800 tokens per tool message
      }
    });
    return;
  }

  // Diagnostic endpoint for troubleshooting
  if (req.method === "GET" && req.url === "/v1/diag") {
    sendJson(res, 200, _diagDump());
    return;
  }

  // Images generation endpoint — forwards to OpenAI DALL-E
  if (req.method === "POST" && req.url === "/v1/images/generations") {
    if (!OPENAI_KEY) {
      sendJson(res, 400, { error: { message: "OPENAI_API_KEY is not configured. Image generation requires an OpenAI API key." } });
      return;
    }
    var body = await readJsonBody(req, res);
    if (!body) return;
    log.info(`[proxy] images/generations model=${body.model || "dall-e-3"} prompt="${(body.prompt || "").slice(0, 60)}..."`);
    try {
      var upstreamRes = await fetchWithTimeout(`${OPENAI_BASE}/images/generations`, {
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
      var result = await upstreamRes.json();
      sendJson(res, 200, result);
    } catch (err) {
      log.error("[proxy] images/generations error:", err.message);
      sendJson(res, 500, { error: { message: err.message } });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && req.url.startsWith("/cop")) {
    var url = "";
    var method = "GET";
    var body2 = null;
    var headers2 = {};

    if (req.method === "GET") {
      var parsed = new URL(req.url, "http://localhost");
      url = parsed.searchParams.get("url") || "";
    } else {
      var parsedBody = await readJsonBody(req, res);
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
    var content = await executeWebFetch({ url, method, headers: headers2, body: body2 });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(content);
    return;
  }

  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    try {
      var models = await fetchUpstreamModels();
      var enriched = models.map(m => {
        var ctx = MODEL_CONTEXT_WINDOWS.get(m.id);
        return ctx ? { ...m, context_window: ctx } : m;
      });
      sendJson(res, 200, {
        object: "list",
        data: enriched,
        default_provider: getFallbackProvider(),
      });
    } catch (err) {
      log.warn(`[models] upstream fetch failed, falling back to static catalog: ${err.message}`);
      var enriched = modelCatalog.map(m => {
        var ctx = MODEL_CONTEXT_WINDOWS.get(m.id);
        return ctx ? { ...m, context_window: ctx } : m;
      });
      sendJson(res, 200, {
        object: "list",
        data: enriched,
        default_provider: getFallbackProvider(),
      });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/responses" || req.url === "/responses")) {
    var body = await readJsonBody(req, res);
    if (!body) return;

    if (process.env.ACCESS_LOG !== "0") {
      var inputType = Array.isArray(body.input) ? `array(${body.input.length})` : typeof body.input;
      log.access(`[access] /v1/responses body keys=${Object.keys(body).join(",")} model=${body.model || "<none>"} input=${inputType} stream=${!!body.stream}`);
    }

    try {
      // If the inbound key locks the request to one provider, fill in the provider's
      // default model when body.model is missing — this lets cc-switch probes (which
      // omit `model` entirely) still get a sensible synthetic response.
      var lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        var lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }

      var requestedModel = body.model;
      var requestId = `req_${uid().slice(0, 8)}`;
      var inputLength = Array.isArray(body.input) ? body.input.length : (typeof body.input === "string" ? 1 : 0);
      var configuredRoute = resolveConfiguredRoute(requestedModel);
      var provider = configuredRoute ? configuredRoute.provider : resolveProviderForModel(body.model);
      var responseDiag = {
        requestId,
        requestedModel: requestedModel || "<none>",
        routeSource: configuredRoute?.source || "direct",
        inputLength,
        log,
      };
      if (configuredRoute) {
        body.model = configuredRoute.model;
        log.info(`[proxy] [${requestId}] current config route: requested="${requestedModel || "<none>"}" -> ${provider}(${body.model}) source=${configuredRoute.source} input=${inputLength} stream=${!!body.stream}`);
      } else {
        log.info(`[proxy] [${requestId}] direct route: requested="${requestedModel || "<none>"}" -> ${provider || "<none>"} input=${inputLength} stream=${!!body.stream}`);
        // 如果还是找不到提供商，使用默认提供商作为回退
        if (!provider) {
          var defaultProvider = getFallbackProvider();
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

        // Strip provider prefix (e.g. "free/gpt-5.5" -> "gpt-5.5") before sending upstream
        body.model = stripProviderPrefix(body.model);
      }

      if (!provider) {
        var availableProviders = [...enabledProviders].join(', ') || 'none';
        var errorMsg = body.model
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

      var originalInput = normalizeInputToArray(body.input);

      // Health-check / probe short-circuit: cc-switch (and similar managers) ping the
      // proxy with empty or input-less bodies just to verify reachability. Forwarding
      // those upstream produces a 400 ("Empty input messages") which surfaces in the UI
      // as "供应商拒绝了请求格式". Detect probes (no input AND no previous_response_id)
      // and answer locally without touching the upstream provider.
      var hasInput = originalInput.length > 0 || (typeof body.input === "string" && body.input.trim().length > 0);
      var hasPrevious = !!body.previous_response_id;
      if (!hasInput && !hasPrevious) {
        if (process.env.ACCESS_LOG !== "0") {
          log.access(`[access] /v1/responses probe short-circuit (provider=${provider})`);
        }
        var probeId = `resp_probe_${uid()}`;
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
        var originalPreviousResponseId = body.previous_response_id || null;
        var previousResolution = maybeResolvePreviousResponseChain(body, "openai");
        if (!previousResolution.ok) {
          sendJson(res, previousResolution.status || 409, { error: { message: previousResolution.message, type: "invalid_request_error", code: previousResolution.code || "previous_response_unavailable" } });
          return;
        }
        log.info(`[proxy] responses openai(${body.model || OPENAI_MODELS[0] || "default"}) | stream=${!!body.stream}`);
        await forwardOpenAIResponses(req, body, res, originalInput, originalPreviousResponseId);
        return;
      }

      if (OAI_COMPAT_PROVIDERS[provider]) {
        await handleOaiCompatResponses(req, provider, body, res, originalInput, responseDiag);
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
    var body = await readJsonBody(req, res);
    if (!body) return;

    try {
      var ccRequestId = uid();
      var ccInputLength = Array.isArray(body.messages) ? body.messages.length : 0;
      var lock = req.lockedProvider || "*";
      if (lock !== "*" && (!body.model || !String(body.model).trim())) {
        var lockCfg = OAI_COMPAT_PROVIDERS[lock];
        if (lockCfg) body.model = lockCfg.defaultModel;
        else if (lock === "openai") body.model = OPENAI_MODELS[0] || "";
      }
      var requestedModel = body.model;
      var configuredRoute = resolveConfiguredRoute(requestedModel);
      var provider = configuredRoute ? configuredRoute.provider : resolveProviderForModel(body.model);
      if (configuredRoute) {
        body.model = configuredRoute.model;
        log.info(`[proxy] [${ccRequestId}] current config route: requested="${requestedModel || "<none>"}" -> ${provider}(${body.model}) source=${configuredRoute.source} input=${ccInputLength} stream=${!!body.stream}`);
      } else {
        log.info(`[proxy] [${ccRequestId}] direct route: requested="${requestedModel || "<none>"}" -> ${provider || "<none>"} input=${ccInputLength} stream=${!!body.stream}`);
        // 如果还是找不到提供商，使用默认提供商作为回退
        if (!provider) {
          var defaultProvider = getFallbackProvider();
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

        // Strip provider prefix (e.g. "free/gpt-5.5" -> "gpt-5.5") before sending upstream
        body.model = stripProviderPrefix(body.model);
      }

      if (!provider) {
        var availableProviders = [...enabledProviders].join(', ') || 'none';
        var errorMsg = body.model
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

// --- Server error handler ---
// Prevents silent crash on EADDRINUSE, EACCES, EMFILE etc.
server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    log.error('[proxy] FATAL: Port ' + PORT + ' already in use. Exiting.');
  } else if (err.code === 'EACCES') {
    log.error('[proxy] FATAL: Permission denied for port ' + PORT + '. Exiting.');
  } else {
    log.error('[proxy] FATAL: Server error:', err.message);
  }
  process.exit(1);
});

// --- Graceful shutdown ---
var shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Codex Assistant] ${signal} received, shutting down gracefully...`);
  if (_rateLimitCleanupTimer) clearInterval(_rateLimitCleanupTimer);
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
  for (var [name, cfg] of Object.entries(OAI_COMPAT_PROVIDERS)) {
    var label = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`[Codex Assistant] ${label.padEnd(8)}: ${cfg.key ? `${cfg.base} | models=${cfg.models.join(", ")}` : "DISABLED"}`);
  }
  console.log(`[Codex Assistant] OpenAI  : ${OPENAI_KEY ? `${OPENAI_BASE} | models=${OPENAI_MODELS.join(", ")}` : "DISABLED"}`);
  console.log(`[Codex Assistant] GitHub  : ${process.env.GITHUB_TOKEN ? "authenticated (env)" : "lazy (will run `gh auth token` on first api.github.com fetch)"}`);
  console.log(`[Codex Assistant] Diag    : event-loop monitor active | /health shows _diag | /v1/diag for full dump`);
  
  if (!PROXY_AUTH_ENABLED) {
    console.log(`[Codex Assistant] Inbound : OPEN — anyone on localhost can use this proxy (set PROXY_AUTH_KEY or PROXY_KEYS to lock down)`);
  } else {
    console.log(`[Codex Assistant] Inbound : auth required (${PROXY_KEY_TABLE.size} key${PROXY_KEY_TABLE.size === 1 ? "" : "s"} loaded)`);
    for (var [, lock] of PROXY_KEY_TABLE) {
      var lockLabel = lock === "*" ? "any provider" : `locked to ${lock}`;
      console.log(`[Codex Assistant]           key \u2192 ${lockLabel}`);
    }
  }
});
