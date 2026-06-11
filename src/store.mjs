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

export function makeStorableResponseData(data, maxEntrySize = MAX_ENTRY_SIZE) {
  const base = { ...data };
  const initialSize = JSON.stringify(base).length;
  if (initialSize <= maxEntrySize) {
    return { data: base, degraded: false, entrySize: initialSize, originalSize: initialSize };
  }

  const compact = {
    ...base,
    input: [],
    output: Array.isArray(base.output)
      ? base.output.filter((item) => item?.type === "function_call")
      : [],
    oversized: true,
    originalEntrySize: initialSize,
  };
  const compactSize = JSON.stringify(compact).length;
  if (compactSize <= maxEntrySize) {
    return { data: compact, degraded: true, entrySize: compactSize, originalSize: initialSize };
  }

  const minimal = {
    provider: base.provider,
    input: [],
    output: [],
    previousResponseId: base.previousResponseId || null,
    breakerFired: !!base.breakerFired,
    reasoningContent: "",
    oversized: true,
    originalEntrySize: initialSize,
  };
  return { data: minimal, degraded: true, entrySize: JSON.stringify(minimal).length, originalSize: initialSize };
}

export function storeResponse(id, data, log) {
  if (!id) return;

  try {
    const storable = makeStorableResponseData(data);
    data = storable.data;
    if (storable.degraded && log) {
      log.warn(`[proxy] response ${id} exceeds max entry size (${storable.originalSize} > ${MAX_ENTRY_SIZE} bytes), storing compact metadata (${storable.entrySize} bytes)`);
    }
  } catch (e) {
    if (log) log.warn(`[proxy] response ${id} could not be size-checked before store: ${e.message}`);
  }

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

  // Periodic cleanup of orphaned reasoningIndex entries
  cleanupOrphanedReasoningEntries();

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

// Periodic cleanup: remove reasoningIndex entries whose parent response
// is no longer in responseStore. Called during eviction to prevent
// unbounded growth when many tool_call round-trips occur.
const REASONING_INDEX_CLEANUP_THRESHOLD = 1000;
export function cleanupOrphanedReasoningEntries() {
  if (reasoningIndex.size < REASONING_INDEX_CLEANUP_THRESHOLD) return;
  var validCallIds = new Set();
  for (var [, entry] of responseStore) {
    for (var out of Array.isArray(entry.output) ? entry.output : []) {
      if (out.type === "function_call" && out.call_id) {
        validCallIds.add(out.call_id);
      }
    }
  }
  for (var callId of reasoningIndex.keys()) {
    if (!validCallIds.has(callId)) reasoningIndex.delete(callId);
  }
}

export function sanitizeResponseItems(items, logFn) {
  const sanitized = [];
  const availableCallIds = new Set();
  let droppedOrphanOutputs = 0;

  for (const item of Array.isArray(items) ? items : []) {
    const itemType = item?.type || (item?.role ? "message" : undefined);

    if (itemType === "function_call") {
      const callId = item.call_id || item.id;
      if (callId) availableCallIds.add(callId);
      sanitized.push(item);
      continue;
    }

    if (itemType === "function_call_output") {
      const callId = item.call_id || item.id;
      if (callId && availableCallIds.has(callId)) {
        sanitized.push(item);
      } else {
        droppedOrphanOutputs++;
      }
      continue;
    }

    sanitized.push(item);
  }

  if (droppedOrphanOutputs && logFn) {
    logFn.warn(`[proxy] dropped ${droppedOrphanOutputs} orphan function_call_output item(s) while rebuilding response chain`);
  }
  return { items: sanitized, droppedOrphanOutputs };
}

export function resolveResponseChain(previousResponseId, logFn) {
  const chain = [];
  let currentId = previousResponseId;
  const visited = new Set();
  let complete = true;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const stored = touchResponse(currentId);
    if (!stored) {
      complete = false;
      if (logFn) logFn.warn(`[proxy] previous_response_id ${currentId} not found in store`);
      break;
    }
    chain.unshift(stored);
    currentId = stored.previousResponseId;
  }

  if (currentId && visited.has(currentId)) {
    complete = false;
    if (logFn) logFn.warn(`[proxy] previous_response_id chain cycle detected at ${currentId}`);
  }

  if (!complete) {
    return { items: [], complete: false, droppedOrphanOutputs: 0 };
  }

  const rawItems = [];
  for (const entry of chain) {
    if (Array.isArray(entry.input)) rawItems.push(...entry.input);
    if (Array.isArray(entry.output)) rawItems.push(...entry.output);
  }

  const sanitized = sanitizeResponseItems(rawItems, logFn);
  return { items: sanitized.items, complete: true, droppedOrphanOutputs: sanitized.droppedOrphanOutputs };
}

export function getConsecutiveToolCalls(responseId) {
  const stored = touchResponse(responseId);
  return stored?.consecutiveToolCalls || 0;
}

export { STORE_TTL, STORE_MAX, MAX_CONSECUTIVE_TOOL_CALLS };
