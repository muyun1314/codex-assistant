// Streaming SSE translation: Chat Completions SSE -> Responses API SSE

import { uid, translateUsage } from "./protocol.mjs";
import { clientGone, writeWithBackpressure, wireClientCancel } from "./shared.mjs";

export function buildStreamingResponseEvents(responseId, model, previousResponseId, metadata) {
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };

  return {
    created: () => `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: baseResponse })}\n\n`,
    inProgress: () => `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress", response: baseResponse })}\n\n`,
    outputItemAdded: (index, item) => `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item })}\n\n`,
    contentPartAdded: (outIdx, contentIdx, part) => `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    textDelta: (outIdx, contentIdx, delta) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: outIdx, content_index: contentIdx, delta })}\n\n`,
    textDone: (outIdx, contentIdx, text) => `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", output_index: outIdx, content_index: contentIdx, text })}\n\n`,
    contentPartDone: (outIdx, contentIdx, part) => `event: response.content_part.done\ndata: ${JSON.stringify({ type: "response.content_part.done", output_index: outIdx, content_index: contentIdx, part })}\n\n`,
    outputItemDone: (outIdx, item) => `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: outIdx, item })}\n\n`,
    fnCallArgsDelta: (outIdx, callId, delta) => `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: outIdx, call_id: callId, delta })}\n\n`,
    fnCallArgsDone: (outIdx, callId, args) => `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: outIdx, call_id: callId, arguments: args })}\n\n`,
    completed: (response) => `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  };
}

function emptyOutputTextPart() {
  return { type: "output_text", text: "", annotations: [] };
}

function makeNonAppendableMessageItem(item) {
  return {
    ...item,
    content: Array.isArray(item.content)
      ? item.content.map((part) => part?.type === "output_text" ? emptyOutputTextPart() : part)
      : [],
  };
}

function makeStatusOnlyResponse(response) {
  // Codex clients already render response.output_text.delta. Keeping full text in
  // terminal events can make some versions append the same assistant message again.
  // But completed.response.output is also the contract Codex uses to remember
  // function_call call_id values. Keep tool/function_call items intact and only
  // strip visible assistant text from message items.
  const output = Array.isArray(response?.output)
    ? response.output.map((item) => item?.type === "message" ? makeNonAppendableMessageItem(item) : item)
    : [];
  return { ...response, output };
}

function previewText(text, limit = 120) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function logStreamSummary(diag, responseId, model, fullText, toolCalls, finishReason, phase) {
  if (!diag?.log?.info) return;
  const text = String(fullText || "").trim();
  diag.log.info(
    `[proxy] [${diag.requestId || responseId}] ${phase} response=${responseId} source=${diag.routeSource || "unknown"} route=${diag.routeLabel || model} text_len=${text.length} tools=${toolCalls?.size || 0} finish=${finishReason || "done"} preview="${previewText(text)}"`
  );
}

function getResponseOutputText(response) {
  const texts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && part.text) texts.push(part.text);
    }
  }
  return texts.join("\n");
}

export async function handleStreamingResponse(req, upstreamRes, res, model, previousResponseId, metadata, diag = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Keepalive heartbeat: send SSE comment every 10s to prevent Codex Desktop from timing out
  // Codex Desktop SSE timeout is ~30-60s; keepalives must be more frequent than that.
  var keepaliveTimer = setInterval(function() {
    if (!res.writableEnded) { try { res.write(": keepalive\n\n"); } catch {} }
  }, 10000);

  // Stream stall timeout: if no upstream data arrives for 5 minutes, abort.
  // Use diag.log when available; this module has no global logger.
  const streamLog = diag?.log || console;
  var STREAM_STALL_MS = parseInt(process.env.STREAM_STALL_TIMEOUT_MS || "300000", 10);
  var stallTimer = null;
  const teardown = wireClientCancel(res, upstreamRes);
  const responseId = `resp_${uid()}`;
  const events = buildStreamingResponseEvents(responseId, model, previousResponseId, metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  // resetStall defined after responseId is available (needed for error event)
  var resetStall = function() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function() {
      streamLog.warn?.("[proxy] stream stall timeout - no data for " + STREAM_STALL_MS + "ms, aborting");
      // Send response.failed SSE event so Codex knows the stream failed
      if (!res.writableEnded) {
        try {
          const failedEvent = {
            type: "response.completed",
            response: {
              id: responseId, object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "failed", model: model, output: [],
              error: { message: "Stream stall timeout - no data from upstream for " + STREAM_STALL_MS + "ms", type: "upstream_error" }
            }
          };
          res.write("event: response.completed\ndata: " + JSON.stringify(failedEvent) + "\n\n");
        } catch (writeErr) { /* client already gone, safe to ignore */ }
      }
      try { upstreamRes.body?.cancel?.(); } catch {}
    }, STREAM_STALL_MS);
  };
  resetStall();

  let fullText = "";
  let reasoningContent = "";
  let inThink = false;
  let messageStarted = false;
  let completionSent = false;
  const toolCalls = new Map();
  let outputIndex = 0;
  let textOutputIdx = -1;
  let buffer = "";
  let streamOutput = null;
  const decoder = new TextDecoder();

  try {
    for await (const chunk of upstreamRes.body) {
      if (clientGone(res)) break;
      resetStall(); // reset stall timer on each upstream chunk
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          if (!completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, null, null, previousResponseId, metadata, diag);
          }
          continue;
        }

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        const delta = parsed.choices?.[0]?.delta;
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (!delta && !finishReason) continue;

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const tcOutIdx = (messageStarted && textOutputIdx === 0) ? outputIndex + idx + 1 : outputIndex + idx;
            if (!toolCalls.has(idx)) {
              const callId = tc.id || `call_${uid()}`;
              const fcId = `fc_${uid()}`;
              toolCalls.set(idx, { id: fcId, callId, name: tc.function?.name || "", arguments: "", outputIdx: tcOutIdx });
              await writeWithBackpressure(res, events.outputItemAdded(tcOutIdx, {
                type: "function_call", id: fcId, call_id: callId,
                name: tc.function?.name || "", arguments: "", status: "in_progress",
              }));
            }
            if (tc.function?.arguments) {
              const tcData = toolCalls.get(idx);
              tcData.arguments += tc.function.arguments;
              await writeWithBackpressure(res, events.fnCallArgsDelta(tcData.outputIdx, tcData.callId, tc.function.arguments));
            }
          }
          if (finishReason && !completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata, diag);
          }
          continue;
        }

        if (typeof delta?.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
          continue;
        }

        if (delta?.content) {
          let text = delta.content;
          if (text.includes("<think>")) { inThink = true; text = text.replace(/<think>/g, ""); }
          if (text.includes("</think>")) { inThink = false; text = text.replace(/<\/think>/g, ""); }
          if (inThink || !text) continue;

          if (!messageStarted) {
            messageStarted = true;
            textOutputIdx = outputIndex + toolCalls.size;
            await writeWithBackpressure(res, events.outputItemAdded(textOutputIdx, {
              type: "message", id: `msg_${uid()}`, status: "in_progress", role: "assistant", content: [],
            }));
            await writeWithBackpressure(res, events.contentPartAdded(textOutputIdx, 0, { type: "output_text", text: "", annotations: [] }));
          }

          fullText += text;
          await writeWithBackpressure(res, events.textDelta(textOutputIdx, 0, text));
        }

        if (finishReason && !completionSent) {
          completionSent = true;
          streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata, diag);
        }
      }
    }
  } finally {
    clearInterval(keepaliveTimer);
    clearTimeout(stallTimer);
    teardown();
  }

  if (clientGone(res)) {
    try { res.end(); } catch { /* ignore */ }
    return { responseId, output: streamOutput || [], reasoningContent };
  }

  if (!completionSent) {
    completionSent = true;
    const wasGenerating = fullText.length > 0 || toolCalls.size > 0;
    const fallbackReason = wasGenerating ? "length" : "stop";
    streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, fallbackReason, null, previousResponseId, metadata, diag);
  }

  res.end();
  return { responseId, output: streamOutput || [], reasoningContent };
}

async function sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, usage, previousResponseId, metadata, diag = {}) {
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    await writeWithBackpressure(res, events.fnCallArgsDone(tcIdx, tc.callId, tc.arguments));
    await writeWithBackpressure(res, events.outputItemDone(tcIdx, {
      type: "function_call", id: tc.id, call_id: tc.callId,
      name: tc.name, arguments: tc.arguments, status: "completed",
    }));
  }

  const msgOutIdx = textOutputIdx >= 0 ? textOutputIdx : outputIndex + toolCalls.size;
  const trimmed = fullText.trim();
  if (trimmed) {
    const donePart = emptyOutputTextPart();
    await writeWithBackpressure(res, events.textDone(msgOutIdx, 0, ""));
    await writeWithBackpressure(res, events.contentPartDone(msgOutIdx, 0, donePart));
    await writeWithBackpressure(res, events.outputItemDone(msgOutIdx, {
      type: "message", id: `msg_${uid()}`, status: "completed",
      role: "assistant", content: [donePart],
    }));
  }

  const outputItems = [];
  for (const [idx, tc] of toolCalls) {
    const tcIdx = tc.outputIdx != null ? tc.outputIdx : outputIndex + idx;
    outputItems.push({
      sortIdx: tcIdx,
      item: { type: "function_call", id: tc.id, call_id: tc.callId, name: tc.name, arguments: tc.arguments, status: "completed" },
    });
  }
  if (trimmed) {
    outputItems.push({
      sortIdx: msgOutIdx,
      item: { type: "message", id: `msg_${uid()}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: trimmed, annotations: [] }] },
    });
  }
  outputItems.sort((a, b) => a.sortIdx - b.sortIdx);
  const finalOutput = outputItems.map((o) => o.item);

  let status = "completed";
  let incompleteDetails = null;
  if (finishReason === "length") { status = "incomplete"; incompleteDetails = { reason: "max_output_tokens" }; }

  const finalResponse = {
    id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000),
    status, model, output: finalOutput,
    previous_response_id: previousResponseId || null,
    metadata: metadata || {},
    usage: translateUsage(usage),
    incomplete_details: incompleteDetails,
  };

  logStreamSummary(diag, responseId, model, fullText, toolCalls, finishReason, "stream_done_summary");
  await writeWithBackpressure(res, events.completed(makeStatusOnlyResponse(finalResponse)));
  return finalOutput;
}

export async function sendResponseAsStream(res, response, req, skipHeaders = false, diag = {}) {
  if (!skipHeaders) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  }

  const events = buildStreamingResponseEvents(response.id, response.model, response.previous_response_id, response.metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

  for (let i = 0; i < response.output.length; i++) {
    if (clientGone(res)) break;
    const item = response.output[i];
    if (item.type === "function_call") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", arguments: "" }));
      await writeWithBackpressure(res, events.fnCallArgsDelta(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.fnCallArgsDone(i, item.call_id, item.arguments));
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    } else if (item.type === "message") {
      await writeWithBackpressure(res, events.outputItemAdded(i, { ...item, status: "in_progress", content: [] }));
      for (let ci = 0; ci < item.content.length; ci++) {
        const part = item.content[ci];
        if (part.type === "output_text") {
          await writeWithBackpressure(res, events.contentPartAdded(i, ci, { type: "output_text", text: "", annotations: [] }));
          const text = part.text;
          for (let c = 0; c < text.length; c += 80) {
            if (clientGone(res)) break;
            await writeWithBackpressure(res, events.textDelta(i, ci, text.slice(c, c + 80)));
          }
          await writeWithBackpressure(res, events.textDone(i, ci, ""));
          await writeWithBackpressure(res, events.contentPartDone(i, ci, emptyOutputTextPart()));
        }
      }
      await writeWithBackpressure(res, events.outputItemDone(i, makeNonAppendableMessageItem(item)));
    }
  }

  const responseText = getResponseOutputText(response);
  logStreamSummary(diag, response.id, response.model, responseText, new Map(), "synthetic", "synthetic_stream_summary");
  await writeWithBackpressure(res, events.completed(makeStatusOnlyResponse(response)));
  res.end();
}
