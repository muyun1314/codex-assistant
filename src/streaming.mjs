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

export async function handleStreamingResponse(req, upstreamRes, res, model, previousResponseId, metadata) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const teardown = wireClientCancel(res, upstreamRes);
  const responseId = `resp_${uid()}`;
  const events = buildStreamingResponseEvents(responseId, model, previousResponseId, metadata);
  await writeWithBackpressure(res, events.created());
  await writeWithBackpressure(res, events.inProgress());

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
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          if (!completionSent) {
            completionSent = true;
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, null, null, previousResponseId, metadata);
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
            streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
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
          streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, parsed.usage, previousResponseId, metadata);
        }
      }
    }
  } finally {
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
    streamOutput = await sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, fallbackReason, null, previousResponseId, metadata);
  }

  res.end();
  return { responseId, output: streamOutput || [], reasoningContent };
}

async function sendCompletion(res, events, responseId, model, fullText, toolCalls, outputIndex, textOutputIdx, finishReason, usage, previousResponseId, metadata) {
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
    const donePart = { type: "output_text", text: trimmed, annotations: [] };
    await writeWithBackpressure(res, events.textDone(msgOutIdx, 0, trimmed));
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

  await writeWithBackpressure(res, events.completed(finalResponse));
  return finalOutput;
}

export async function sendResponseAsStream(res, response, req) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

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
          await writeWithBackpressure(res, events.textDone(i, ci, text));
          await writeWithBackpressure(res, events.contentPartDone(i, ci, part));
        }
      }
      await writeWithBackpressure(res, events.outputItemDone(i, item));
    }
  }

  await writeWithBackpressure(res, events.completed(response));
  res.end();
}
