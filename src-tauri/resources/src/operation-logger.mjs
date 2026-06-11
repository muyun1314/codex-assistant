// 操作日志模块：统一记录软件所有用户操作及其结果
// - 启动即开始记录，写入磁盘文件 (JSON Lines)
// - 自动脱敏 API key / token / password
// - 内存缓冲 + 磁盘持久化，支持筛选和分页

import fs from "node:fs";
import path from "node:path";

// ==== 状态 ====
let logStream = null;
let logFilePath = null;
let started = false;
const memLog = [];
const MEM_LOG_MAX = 2000;

// ==== 脱敏 ====
const SENSITIVE_PATTERNS = [
  [/\b(sk-[a-zA-Z0-9_-]{20,})\b/g, "sk-***"],
  [/\b(Bearer\s+)\S+/gi, "$1***"],
  [/"api_key"\s*:\s*"[^"]+"/gi, '"api_key":"***"'],
  [/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"***"'],
  [/"password"\s*:\s*"[^"]+"/gi, '"password":"***"'],
  [/"key"\s*:\s*"[A-Za-z0-9+/=]{20,}"/gi, '"key":"***"'],
  [/"access_key"\s*:\s*"[^"]+"/gi, '"access_key":"***"'],
  [/"secret_key"\s*:\s*"[^"]+"/gi, '"secret_key":"***"'],
];

function redact(text) {
  if (!text || typeof text !== "string") return String(text || "");
  let out = text;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ==== 格式化日期 ====
function fmtDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ==== 初始化 ====
export function initOperationLogger(logDir) {
  if (started) return;
  started = true;

  const dir = logDir || path.join(process.cwd(), "logs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* dir may already exist */ }

  logFilePath = path.join(dir, `operations-${fmtDate(new Date())}.log`);
  try {
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  } catch { /* best effort: logging disabled if stream fails */ 
    logStream = null;
  }

  _append({
    category: "system",
    action: "startup",
    detail: "操作日志系统已启动",
  });
}

// ==== 写入一条操作日志 ====
export function logOperation(category, action, detail, error) {
  _append({
    category,   // provider | model | env | proxy | codex | backup | system | connection | auth
    action,     // save | update | delete | apply | start | stop | restart | export | import | test | fetch | refresh
    detail: redact(String(detail || action)),
    success: !error,
    error: error ? redact(error.message || String(error)) : null,
  });
}

// ==== 内部写入 ====
function _append(entry) {
  const record = {
    time: new Date().toISOString(),
    category: entry.category || "unknown",
    action: entry.action || "unknown",
    detail: entry.detail || "",
    success: entry.success !== false,
    error: entry.error || null,
  };

  // 内存缓冲
  memLog.push(record);
  if (memLog.length > MEM_LOG_MAX) memLog.shift();

  // 磁盘写入
  if (logStream) {
    try { logStream.write(JSON.stringify(record) + "\n"); } catch { /* best effort: don't crash on log write failure */ }
  }
}

// ==== 读取操作日志 ====
export function readOperationLogs(opts = {}) {
  const { limit = 100, offset = 0, category, action, success } = opts;
  let filtered = [...memLog];

  if (category) {
    const cats = String(category).toLowerCase().split(",").map((s) => s.trim());
    filtered = filtered.filter((r) => cats.includes(r.category));
  }
  if (action) {
    const acts = String(action).toLowerCase().split(",").map((s) => s.trim());
    filtered = filtered.filter((r) => acts.includes(r.action));
  }
  if (success !== undefined && success !== null && success !== "") {
    const want = String(success) === "true";
    filtered = filtered.filter((r) => r.success === want);
  }

  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit);

  return { total, items, logFile: logFilePath };
}

// ==== 导出 ====
export function exportOperationLogs() {
  const lines = memLog.map((r) => JSON.stringify(r));
  return lines.join("\n");
}

// ==== 关闭 ====
export function closeOperationLogger() {
  if (logStream) {
    try { logStream.end(); } catch { /* best effort: stream may already be closed */ }
    logStream = null;
  }
  started = false;
}

// 供 test 使用
export { redact };
