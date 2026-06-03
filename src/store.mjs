// Response store for previous_response_id bridging across providers
// Maintains a LRU Map with TTL eviction and tool-call circuit breaker tracking.
// Also maintains an incremental reasoningIndex for O(1) callId -> reasoningContent lookups.

const STORE_TTL = Number(process.env.STORE_TTL_MS) || 60 * 60 * 1000; // 1 hour
const STORE_MAX = Number(process.env.STORE_MAX) || 500;
const MAX_CONSECUTIVE_TOOL_CALLS = Number(process.env.MAX_CONSECUTIVE_TOOL_CALLS) || 20;
const MAX_ENTRY_SIZE = Number(process.env.MAX_ENTRY_SIZE_BYTES) || 1024 * 1024; // 1MB per response store entry

export const responseStore = new Map();
export const reasoningIndex = new Map(); // callId -> reasoningContent

// Read with LRU bookkeeping: refreshes insertion order so frequently-used roots
// don't get evicted by the eviction loop in storeResponse.
export function touchResponse(id) {
  if (!id) return undefined;
  const entry = responseStore.get(id);
  if (!entry) return undefined;
  responseStore.delete(id);
  responseStore.set(id, entry);
  return entry;
}

export function storeResponse(id, data, log) {
  if (!id) return;

  // Reject oversized entries to prevent memory exhaustion
  try {
    var entrySize = JSON.stringify(data).length;
    if (entrySize > MAX_ENTRY_SIZE) {
      if (log) log.warn(`[proxy] response ${id} exceeds max entry size (${entrySize} > ${MAX_ENTRY_SIZE} bytes), skipping store`);
      return;
    }
  } catch (e) { /* stringify may fail on circular refs, allow storage attempt */ }

  if (responseStore.size >= STORE_MAX) {
    const now = Date.now();
    for (const [key, val] of responseStore) {
      if (now - val.storedAt > STORE_TTL) {
        _cleanupReasoningIndex(val);
        responseStore.delete(key);
      }
    }
    if (responseStore.size >= STORE_MAX) {
      const oldest = responseStore.keys().next().value;
      const oldestVal = responseStore.get(oldest);
      if (oldestVal) _cleanupReasoningIndex(oldestVal);
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

  if (log) {
    log.info(
      `[proxy] stored response ${id} (provider=${data.provider || "unknown"}, store size: ${responseStore.size}${consecutiveToolCalls > 0 ? `, consecutive_tc: ${consecutiveToolCalls}` : ""})`
    );
  }
}

function _cleanupReasoningIndex(entry) {
  if (!entry?.reasoningContent) return;
  for (const out of Array.isArray(entry.output) ? entry.output : []) {
    if (out.type === "function_call" && out.call_id) {
      reasoningIndex.delete(out.call_id);
    }
  }
}

export function resolveResponseChain(previousResponseId, logFn) {
  const chain = [];
  let currentId = previousResponseId;
  const visited = new Set();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const stored = touchResponse(currentId);
    if (!stored) {
      if (logFn) logFn.warn(`[proxy] previous_response_id ${currentId} not found in store`);
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

export function getConsecutiveToolCalls(responseId) {
  const stored = touchResponse(responseId);
  return stored?.consecutiveToolCalls || 0;
}

export { STORE_TTL, STORE_MAX, MAX_CONSECUTIVE_TOOL_CALLS };
