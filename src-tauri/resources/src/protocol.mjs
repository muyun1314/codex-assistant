// Protocol translation: OpenAI Responses API ↔ Chat Completions API
// Contains normalization, translation, and effort mapping functions.

import crypto from "node:crypto";

// ---- Known model context windows (tokens) ----
// Single source of truth for model context window sizes.
// Must stay in sync with providers.js KNOWN_CTX and ui-server.mjs KNOWN_CTX.
export const KNOWN_CONTEXT_WINDOWS = {
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

export const AVG_TOKENS_PER_MESSAGE = 800;
export const DEFAULT_CONTEXT_WINDOW = 131072;

export function getModelContextWindow(model, customMap) {
  if (customMap && customMap.has(model)) return customMap.get(model);
  return KNOWN_CONTEXT_WINDOWS[model] || DEFAULT_CONTEXT_WINDOW;
}

export function calcMaxMessages(contextWindow) {
  const inputBudget = Math.floor(contextWindow * 0.8);
  return Math.max(20, Math.min(200, Math.floor(inputBudget / AVG_TOKENS_PER_MESSAGE)));
}

// ---- ID generation ----
export function uid() {
  return crypto.randomBytes(12).toString("base64url");
}

// ---- Usage translation ----
export function translateUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

// ---- Reasoning effort translation ----
export function applyEffortTranslation(req, effort, provider) {
  if (!effort) return;
  const e = String(effort).toLowerCase().trim();
  if (e === "none") {
    req.thinking = { type: "disabled" };
    return;
  }
  if (e === "minimal") {
    req.reasoning_effort = "low";
    return;
  }
  if (provider === "mimo" && (e === "max" || e === "xhigh")) {
    req.reasoning_effort = "high";
    return;
  }
  req.reasoning_effort = e;
}

export function forceDisableDeepSeekThinking(req, provider, deepseekDisableThinking) {
  if (provider !== "deepseek" || !deepseekDisableThinking) return;
  req.thinking = { type: "disabled" };
  delete req.reasoning_effort;
  delete req.reasoning;
  if (Array.isArray(req.messages)) {
    for (const msg of req.messages) {
      if (msg && Object.prototype.hasOwnProperty.call(msg, "reasoning_content")) {
        delete msg.reasoning_content;
      }
    }
  }
}

// ---- Input normalization ----
export function normalizeInputToArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  }
  return [];
}

// ---- Message normalization ----
export function normalizeMessages(messages, { coerceStrings = false } = {}) {
  // Pass 1: re-order tool replies adjacent to their tool_calls.
  const work = [...messages];
  const fixed = [];
  for (let i = 0; i < work.length; i++) {
    const msg = work[i];
    if (msg === null) continue;
    if (msg.role === "assistant" && msg.tool_calls) {
      fixed.push(msg);
      const callIds = new Set(msg.tool_calls.map((tc) => tc.id));
      for (let j = i + 1; j < work.length; j++) {
        if (work[j]?.role === "tool" && callIds.has(work[j].tool_call_id)) {
          fixed.push(work[j]);
          work[j] = null;
        }
      }
    } else if (msg.role === "tool") {
      const lastTc = [...fixed].reverse().find((m) => m.role === "assistant" && m.tool_calls);
      if (lastTc) {
        let insertIdx = fixed.indexOf(lastTc) + 1;
        while (insertIdx < fixed.length && fixed[insertIdx].role === "tool") insertIdx++;
        fixed.splice(insertIdx, 0, msg);
        work[i] = null;
      }
    } else {
      fixed.push(msg);
    }
  }

  // Pass 2: merge consecutive same-role and drop trailing text-only assistant after tool_calls.
  const merged = [];
  for (const msg of fixed) {
    const prev = merged[merged.length - 1];
    if (
      prev && prev.role === msg.role && msg.role === "user" &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === msg.role && msg.role === "assistant" &&
      !prev.tool_calls && !msg.tool_calls &&
      typeof prev.content === "string" && typeof msg.content === "string"
    ) {
      prev.content += "\n\n" + msg.content;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      !prev.tool_calls && msg.tool_calls
    ) {
      merged[merged.length - 1] = msg;
    } else if (
      prev && prev.role === "assistant" && msg.role === "assistant" &&
      prev.tool_calls && !msg.tool_calls
    ) {
      // Drop text-only assistant after tool_calls.
    } else {
      merged.push(msg);
    }
  }

  // Pass 3: drop orphan tool messages. A tool message is valid only when its
  // tool_call_id matches an unresolved id from the nearest prior assistant tool call.
  const validated = [];
  const pendingToolCallIds = new Set();
  for (const msg of merged) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      validated.push(msg);
      pendingToolCallIds.clear();
      for (const tc of msg.tool_calls) {
        if (tc?.id) pendingToolCallIds.add(tc.id);
      }
    } else if (msg.role === "tool") {
      if (msg.tool_call_id && pendingToolCallIds.has(msg.tool_call_id)) {
        validated.push(msg);
        pendingToolCallIds.delete(msg.tool_call_id);
      }
    } else {
      pendingToolCallIds.clear();
      validated.push(msg);
    }
  }

  // Pass 4 (chat/completions only): coerce tool_call args + tool content to strings.
  if (coerceStrings) {
    for (const msg of validated) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.function) continue;
          const args = tc.function.arguments;
          if (args === undefined || args === null || args === "") {
            tc.function.arguments = "{}";
          } else if (typeof args !== "string") {
            tc.function.arguments = JSON.stringify(args);
          } else {
            try { JSON.parse(args); }
            catch { tc.function.arguments = JSON.stringify({ input: args }); }
          }
        }
      }
      if (msg.role === "tool" && typeof msg.content !== "string") {
        msg.content = JSON.stringify(msg.content);
      }
    }
  }

  return validated;
}

// ---- Responses API → Chat Completions ----
export function responsesRequestToChatCompletions(body, provider, reasoningByCallId, deepseekDisableThinking) {
  const messages = [];

  if (body.instructions) {
    messages.push({
      role: "user",
      content: "[System Instructions] " + body.instructions + "\n\nNote: Be efficient with tool calls. Avoid repeating the same tool call unnecessarily.",
    });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    let pendingToolCalls = [];
    const flushPendingToolCalls = () => {
      if (pendingToolCalls.length === 0) return;
      const msg = { role: "assistant", content: null, tool_calls: pendingToolCalls };
      for (const tc of pendingToolCalls) {
        const r = reasoningByCallId.get(tc.id);
        if (r) { msg.reasoning_content = r; break; }
      }
      messages.push(msg);
      pendingToolCalls = [];
    };

    for (const item of body.input) {
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

  // Truncate old tool outputs
  const TOOL_OUTPUT_MAX = 2000;
  const KEEP_RECENT_FULL = 10;
  for (let i = 0; i < Math.max(0, merged.length - KEEP_RECENT_FULL); i++) {
    const msg = merged[i];
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.length > TOOL_OUTPUT_MAX) {
      msg.content = msg.content.slice(0, TOOL_OUTPUT_MAX) + "\n...[output truncated, " + (msg.content.length - TOOL_OUTPUT_MAX) + " chars removed]";
    }
  }

  // Message cap — dynamic based on model context window
  const ctx = getModelContextWindow(body?.model);
  const MAX_MESSAGES = calcMaxMessages(ctx);
  let finalMessages = merged;
  if (merged.length > MAX_MESSAGES) {
    const head = merged.slice(0, 2);
    let tail = merged.slice(-(MAX_MESSAGES - 3));
    while (tail.length > 0 && tail[0].role === "tool") tail.shift();
    finalMessages = [
      ...head,
      { role: "user", content: "[Earlier conversation trimmed. Do not repeat previous statements or tool calls you already made. Continue with the current task. If you have enough information, respond to the user instead of making more tool calls.]" },
      ...tail,
    ];
  }

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
          return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
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
  forceDisableDeepSeekThinking(req, provider, deepseekDisableThinking);
  if (body.parallel_tool_calls != null) req.parallel_tool_calls = body.parallel_tool_calls;

  if (provider === "deepseek" && req.thinking?.type !== "disabled") {
    const hasAssistantToolCalls = finalMessages.some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !m.reasoning_content
    );
    if (hasAssistantToolCalls) {
      req.thinking = { type: "disabled" };
      delete req.reasoning_effort;
    }
  }

  return req;
}

// ---- Chat Completions → Responses API ----
export function chatCompletionToResponse(cc, model, previousResponseId, metadata, uidFn) {
  const genUid = uidFn || uid;
  const responseId = `resp_${genUid()}`;
  const output = [];
  const choice = cc.choices?.[0];

  if (!choice) {
    return {
      id: responseId, object: "response",
      created_at: cc.created || Math.floor(Date.now() / 1000),
      status: "completed", model: model || cc.model,
      output: [{
        type: "message", id: `msg_${genUid()}`, status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Upstream model returned no assistant choice. Please retry the request.", annotations: [] }],
      }],
      usage: translateUsage(cc.usage),
    };
  }

  const msg = choice.message || {};

  if (msg.tool_calls?.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call", id: `fc_${genUid()}`, call_id: tc.id,
        name: tc.function.name, arguments: tc.function.arguments, status: "completed",
      });
    }
  }

  let text = msg.content || "";
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  if (text) {
    output.push({
      type: "message", id: `msg_${genUid()}`, status: "completed",
      role: "assistant", content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (msg.refusal) {
    const msgItem = output.find((o) => o.type === "message") || {
      type: "message", id: `msg_${genUid()}`, status: "completed",
      role: "assistant", content: [],
    };
    msgItem.content.push({ type: "refusal", refusal: msg.refusal });
    if (!output.find((o) => o.type === "message")) output.push(msgItem);
  }

  if (output.length === 0) {
    const fallbackText = typeof msg.reasoning_content === "string"
      ? msg.reasoning_content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
      : "";
    output.push({
      type: "message", id: `msg_${genUid()}`, status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: fallbackText || "Upstream model returned an empty assistant response. Please retry the request.",
        annotations: [],
      }],
    });
  }

  let status = "completed";
  let incompleteDetails = null;
  if (choice.finish_reason === "length") {
    status = "incomplete"; incompleteDetails = { reason: "max_output_tokens" };
  } else if (choice.finish_reason === "content_filter") {
    status = "incomplete"; incompleteDetails = { reason: "content_filter" };
  }

  return {
    id: responseId, object: "response",
    created_at: cc.created || Math.floor(Date.now() / 1000),
    status, model: model || cc.model, output,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(cc.usage),
    incomplete_details: incompleteDetails,
  };
}
