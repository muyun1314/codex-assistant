// Web fetch tool implementation — bypasses Codex sandbox restrictions.
// Provides both a Jina Reader path (for clean markdown GET) and a raw HTTP path.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFileCb);

// ---- GitHub token (lazy) ----
let _githubToken = process.env.GITHUB_TOKEN || null;
export async function getGithubToken() {
  if (_githubToken !== null) return _githubToken;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { encoding: "utf-8", timeout: 3000 });
    _githubToken = stdout.trim();
  } catch { _githubToken = ""; }
  return _githubToken;
}

export const WEB_FETCH_TOOL = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch content from a URL over HTTP/HTTPS. Use this when you need to retrieve content from a web URL. Returns HTTP status and response body, with HTML pages converted to clean markdown. Supports all HTTP methods.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (http:// or https://)" },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], description: "HTTP method (default: GET)" },
        headers: { type: "object", description: "Optional HTTP headers as key-value pairs" },
        body: { type: "string", description: "Request body for POST/PUT/PATCH requests" },
      },
      required: ["url"],
    },
  },
};

const JINA_BASE = (process.env.JINA_BASE || "https://r.jina.ai").replace(/\/+$/, "");
const JINA_FETCH_TIMEOUT = Number(process.env.JINA_FETCH_TIMEOUT_MS) || 20000;
const JINA_MAX_BODY = Number(process.env.JINA_MAX_BODY) || 80000;
const MAX_FETCH_LOOPS = Number(process.env.MAX_FETCH_LOOPS) || 8;
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS) || 15000;
const FETCH_MAX_BODY = Number(process.env.FETCH_MAX_BODY) || 50000;

export async function jinaRead(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JINA_FETCH_TIMEOUT);
  try {
    const res = await fetch(`${JINA_BASE}/${url}`, {
      signal: controller.signal,
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "markdown",
        "User-Agent": "Mozilla/5.0 (compatible; CodexProxy/1.0)",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return `Jina error: ${res.status} ${res.statusText}\n${text}`.slice(0, JINA_MAX_BODY);
    }
    let text = await res.text();
    if (text.length > JINA_MAX_BODY) {
      text = text.slice(0, JINA_MAX_BODY) + `\n...[content truncated, ${text.length - JINA_MAX_BODY} chars omitted]`;
    }
    return text;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") return "Jina fetch error: request timed out (20s)";
    return `Jina fetch error: ${err.message}`;
  }
}

export async function rawFetch(url, method = "GET", headers = {}, reqBody = null) {
  if (!headers["User-Agent"]) headers["User-Agent"] = "Mozilla/5.0 (compatible; CodexProxy/1.0)";
  if (/api\.github\.com/.test(url) && !headers["Authorization"] && !headers["authorization"]) {
    const tok = await getGithubToken();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const fetchOpts = { method, headers, signal: controller.signal, redirect: "follow" };
  if (reqBody && /^(POST|PUT|PATCH)$/i.test(method)) {
    if (typeof reqBody === "string" || reqBody instanceof Uint8Array || reqBody instanceof ArrayBuffer) {
      fetchOpts.body = reqBody;
    } else {
      fetchOpts.body = JSON.stringify(reqBody);
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  const response = await fetch(url, fetchOpts);
  clearTimeout(timeout);
  const ct = response.headers.get("content-type") || "";
  const status = `HTTP ${response.status} ${response.statusText}`;
  if (/^(HEAD|OPTIONS)$/i.test(method)) {
    const hdrs = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    return `${status}\n${hdrs}`;
  }
  if (/image|audio|video|octet-stream/.test(ct)) {
    return `${status}\nContent-Type: ${ct}\n(binary content, not shown)`;
  }
  let text = await response.text();
  if (text.length > FETCH_MAX_BODY) {
    text = text.slice(0, FETCH_MAX_BODY) + `\n...[truncated, ${text.length - FETCH_MAX_BODY} chars omitted]`;
  }
  return `${status}\n\n${text}`;
}

export async function executeWebFetch(argsStr) {
  try {
    const args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
    const { url, method = "GET", headers = {}, body: reqBody } = args;
    if (!url) return "Error: no URL provided";
    if (method === "GET") return await jinaRead(url);
    return await rawFetch(url, method, headers, reqBody);
  } catch (err) {
    if (err.name === "AbortError") return "Fetch error: request timed out";
    return `Fetch error: ${err.message}`;
  }
}

export function ensureWebFetchTool(tools) {
  const list = Array.isArray(tools) ? [...tools] : [];
  const alreadyPresent = list.some((tool) => {
    if (tool?.type !== "function") return false;
    return tool?.function?.name === WEB_FETCH_TOOL.function.name || tool?.name === WEB_FETCH_TOOL.function.name;
  });
  if (!alreadyPresent) list.push(WEB_FETCH_TOOL);
  return list;
}

export function ensureWebFetchHint(messages) {
  const hint =
    "[System: You have a `web_fetch` tool available for making HTTP requests. Use it instead of curl, wget, or other shell-based HTTP tools. Call web_fetch with {\"url\": \"...\"} to fetch any URL. It supports GET, HEAD, POST, PUT, DELETE, PATCH, and OPTIONS methods.]";
  const alreadyPresent = messages.some((message) => message?.role === "user" && message?.content === hint);
  if (alreadyPresent) return messages;
  return [...messages, { role: "user", content: hint }];
}

export async function runWebFetchLoop({ baseRequest, initialMessages, upstreamUrl, upstreamKey, prefix = "", fetchWithTimeout, log }) {
  const WEB_FETCH_LOOP_TIMEOUT = 300_000;
  const loopStart = Date.now();
  let loopMessages = [...initialMessages];
  let finalCcResponse = null;
  let fetchLoopCount = 0;
  const fetchCache = new Map();
  let prevFetchUrls = "";
  const tag = prefix ? `${prefix}: ` : "";
  const checkBudget = () => { if (Date.now() - loopStart > WEB_FETCH_LOOP_TIMEOUT) throw new Error("web_fetch loop total timeout exceeded"); };

  for (let loop = 0; loop <= MAX_FETCH_LOOPS; loop++) {
    checkBudget();
    const loopReq = { ...baseRequest, messages: loopMessages, stream: false };
    const upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(loopReq),
    });

    if (!upstreamRes.ok) {
      return { ok: false, errorRes: upstreamRes };
    }

    const ccResponse = await upstreamRes.json();
    const msg = ccResponse.choices?.[0]?.message;
    const webFetchCalls = (msg?.tool_calls || []).filter((tc) => tc.function?.name === "web_fetch");
    const currentFetchUrls = webFetchCalls.map((tc) => {
      try { return JSON.parse(tc.function.arguments).url; }
      catch { return ""; }
    }).sort().join("|");
    const isStuckLoop = webFetchCalls.length > 0 && currentFetchUrls === prevFetchUrls;

    if (webFetchCalls.length === 0 || loop === MAX_FETCH_LOOPS) {
      if (loop === MAX_FETCH_LOOPS && webFetchCalls.length > 0) {
        log.warn(`[proxy] ${tag}web_fetch MAX_FETCH_LOOPS exhausted at loop ${loop + 1}`);
      }
      if (msg?.tool_calls) {
        msg.tool_calls = msg.tool_calls.filter((tc) => tc.function?.name !== "web_fetch");
        if (msg.tool_calls.length === 0) {
          delete msg.tool_calls;
          if (ccResponse.choices[0].finish_reason === "tool_calls") {
            ccResponse.choices[0].finish_reason = "stop";
          }
        }
      }
      finalCcResponse = ccResponse;
      fetchLoopCount = loop;
      break;
    }

    prevFetchUrls = currentFetchUrls;
    if (isStuckLoop) {
      log.info(`[proxy] ${tag}web_fetch loop repeating URLs at loop ${loop + 1}, continuing with cached results`);
    }
    log.info(`[proxy] ${tag}executing ${webFetchCalls.length} web_fetch call(s) (loop ${loop + 1}/${MAX_FETCH_LOOPS})`);
    const results = await Promise.all(webFetchCalls.map(async (tc) => {
      const fetchUrl = (() => {
        try { return JSON.parse(tc.function.arguments).url; }
        catch { return "unknown"; }
      })();
      if (fetchCache.has(fetchUrl)) {
        log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${fetchCache.get(fetchUrl).length} chars (cached)`);
        return { role: "tool", tool_call_id: tc.id, content: fetchCache.get(fetchUrl) };
      }
      const content = await executeWebFetch(tc.function.arguments);
      fetchCache.set(fetchUrl, content);
      log.info(`[proxy] ${tag}web_fetch ${fetchUrl} -> ${content.length} chars`);
      return { role: "tool", tool_call_id: tc.id, content };
    }));

    loopMessages = [
      ...loopMessages,
      { role: "assistant", content: null, tool_calls: webFetchCalls },
      ...results,
    ];
  }

  if (fetchLoopCount > 0) {
    log.info(`[proxy] ${tag}web_fetch resolved after ${fetchLoopCount} loop(s)`);
  }
  return { ok: true, response: finalCcResponse };
}
