// Shared utilities used by both proxy.mjs and ui-server.mjs
import http from "node:http";
import https from "node:https";

// ---- JSON response ----
export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// ---- CSV parsing ----
export function parseCsv(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value || "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}

// ---- Model ID normalization ----
export function normalizeModelId(model) {
  return String(model || "").trim().toLowerCase();
}

// ---- URL detection ----
export function contentHasUrl(content) {
  if (typeof content === "string") return /https?:\/\//.test(content);
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (typeof part === "string") return /https?:\/\//.test(part);
      if (part && typeof part.text === "string") return /https?:\/\//.test(part.text);
      if (part && typeof part.url === "string") return /https?:\/\//.test(part.url);
      if (part && typeof part.image_url === "string") return /https?:\/\//.test(part.image_url);
      if (part?.image_url?.url && typeof part.image_url.url === "string") return /https?:\/\//.test(part.image_url.url);
      return false;
    });
  }
  return false;
}

export function conversationHasUrls(messages) {
  return messages.some((message) => contentHasUrl(message?.content));
}

// ---- Fetch with timeout ----
export async function fetchWithTimeout(url, opts, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- Client disconnect detection ----
export function wireClientCancel(res, upstreamRes) {
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

export function clientGone(res) {
  return !!(res && (res.destroyed || res.closed));
}

export function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return;
  return new Promise((resolve) => res.once("drain", resolve));
}

// ---- Request body reading ----
export async function readJsonBody(req, res, maxBodySize = 10 * 1024 * 1024) {
  let rawBody = "";
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > maxBodySize) {
      sendJson(res, 413, { error: { message: "Request body too large", type: "invalid_request_error", code: "body_too_large" } });
      return null;
    }
    rawBody += chunk;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return null;
  }
}

// ---- Upstream error forwarding ----
export async function sendUpstreamError(upstreamRes, res) {
  const errText = await upstreamRes.text();
  if (!res.headersSent) {
    res.writeHead(upstreamRes.status, { "Content-Type": upstreamRes.headers.get("content-type") || "application/json" });
    res.end(errText);
  }
}

// ---- Model URL helpers (shared with ui-server) ----

export function stripEndpointSuffix(userUrl) {
  let url = userUrl.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/completions$/i, '');
  url = url.replace(/\/embeddings$/i, '');
  return url;
}

export function normalizeModelsUrl(userUrl) {
  const base = stripEndpointSuffix(userUrl);
  if (/\/v1\/models$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return base + '/models';
  if (/\/models$/i.test(base)) {
    if (/\/v1\/models$/i.test(base)) return base;
    return base.replace(/\/models$/i, '/v1/models');
  }
  return base + '/v1/models';
}

export function buildModelCandidateUrls(userUrl) {
  const base = stripEndpointSuffix(userUrl);
  const candidates = [];

  if (/\/v1$/i.test(base)) {
    candidates.push(base + '/models');
  } else if (/\/v1\/models$/i.test(base)) {
    candidates.push(base);
  } else {
    candidates.push(base + '/v1/models');
  }

  const baseNoV1 = base.replace(/\/v1$/i, '');
  if (baseNoV1 !== base) {
    candidates.push(baseNoV1 + '/models');
  } else if (!/\/models$/i.test(base)) {
    candidates.push(base + '/models');
  }

  return [...new Set(candidates)];
}

export function requestModelsOnce(modelsUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(modelsUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'Codex-Assistant-UI/1.0',
      },
      timeout: 15000,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', (err) => reject(new Error('Connection failed: ' + err.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout (15s)')); });
    req.end();
  });
}

export async function fetchModelsFromAPI(baseUrl, apiKey) {
  const candidates = buildModelCandidateUrls(baseUrl);
  const errors = [];

  for (const url of candidates) {
    try {
      const { statusCode, body } = await requestModelsOnce(url, apiKey);

      if (statusCode === 200) {
        try {
          const json = JSON.parse(body);
          if (Array.isArray(json.data)) {
            if (json.data.length === 0) {
              errors.push(url + ' -> empty list (data:[])');
              continue;
            }
            return json.data.map(m => ({
              id: m.id,
              display_name: m.id,
              owned_by: m.owned_by || '',
            }));
          }
        } catch (e) {
          errors.push(url + ' -> HTTP 200 but response is not JSON');
          continue;
        }
      }

      const preview = body.substring(0, 150).replace(/[\n\r]/g, ' ');
      errors.push(url + ' -> HTTP ' + statusCode + ': ' + preview);
    } catch (e) {
      errors.push(url + ' -> ' + e.message);
    }
  }

  throw new Error(
    'Unable to fetch model list (provider may not support /v1/models endpoint).\n' +
    'Endpoints tried:\n' + errors.map(e => '  \u2022 ' + e).join('\n') + '\n' +
    '\nSolution: manually add model IDs in the "Model List" area.'
  );
}
