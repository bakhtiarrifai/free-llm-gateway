// Translation between the Anthropic Messages format and the OpenAI Chat Completions format: requests, whole
// responses and streams, including images and tool calls. Thinking blocks are dropped when crossing over.
import { randomUUID } from "node:crypto";

const STOP_O2A = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
// Gemini 3 attaches a "thought signature" (extra_content) to each tool call and refuses the next turn unless it comes
// back with the call. Anthropic clients drop unknown fields, so the gateway remembers it by tool call id.
const toolExtras = new Map();
export function rememberToolExtra(id, extra) {
  if (!id || !extra) return;
  toolExtras.set(id, extra);
  if (toolExtras.size > 20_000) toolExtras.delete(toolExtras.keys().next().value);
}
// Google's documented placeholder for a call whose signature is unknown (e.g. the call came from another model).
const PLACEHOLDER_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };

const text = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const asJson = (s) => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { _raw: s };
  }
};

// ------------------------------------------------------------------ Anthropic request -> OpenAI request
export function anthropicToOpenAIRequest(body, { model, maxOutput, streamOptions = true, signatures = false } = {}) {
  const messages = [];
  const system = text(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of body.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "assistant") {
      const content = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => {
        const extra = toolExtras.get(b.id) ?? (signatures ? PLACEHOLDER_SIGNATURE : undefined);
        return { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(extra ? { extra_content: extra } : {}) };
      });
      messages.push({ role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant turn that asked for them, so they go first.
    for (const b of blocks.filter((x) => x.type === "tool_result")) {
      const out = typeof b.content === "string" ? b.content : text(b.content) || JSON.stringify(b.content ?? "");
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${out}` : out });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") {
        const url = b.source?.type === "url" ? b.source.url : `data:${b.source?.media_type};base64,${b.source?.data}`;
        parts.push({ type: "image_url", image_url: { url } });
      } else if (b.type === "document") parts.push({ type: "text", text: "[a document was attached here; this model cannot read documents]" });
    }
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
  }

  const out = { model, messages, stream: Boolean(body.stream) };
  if (body.max_tokens) out.max_tokens = maxOutput ? Math.min(body.max_tokens, maxOutput) : body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  const tools = (body.tools ?? []).filter((t) => t.input_schema || !t.type || t.type === "custom");
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } } }));
    const tc = body.tool_choice;
    if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  if (out.stream && streamOptions) out.stream_options = { include_usage: true };
  return out;
}

// ------------------------------------------------------------------ OpenAI response -> Anthropic message
export function openAIToAnthropicResponse(resp, model) {
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  const body = typeof msg.content === "string" ? msg.content : text(msg.content);
  if (body) content.push({ type: "text", text: body });
  for (const c of msg.tool_calls ?? []) {
    const id = c.id || `toolu_${randomUUID().slice(0, 12)}`;
    rememberToolExtra(id, c.extra_content);
    content.push({ type: "tool_use", id, name: c.function?.name, input: asJson(c.function?.arguments) });
  }
  return {
    id: `msg_${(resp.id ?? randomUUID()).replace(/[^\w-]/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: model ?? resp.model,
    content,
    stop_reason: content.some((b) => b.type === "tool_use") && (!choice.finish_reason || choice.finish_reason === "stop") ? "tool_use" : (STOP_O2A[choice.finish_reason] ?? "end_turn"),
    stop_sequence: null,
    usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0 },
  };
}

// ------------------------------------------------------------------ OpenAI stream -> Anthropic events
// `records` yields parsed OpenAI chunks (or "[DONE]"); yields {event, data} for Anthropic SSE.
export async function* openAIStreamToAnthropic(records, model) {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let started = false;
  let index = -1;
  let open = null; // {kind: "text"} or {kind: "tool", key}
  const toolBlocks = new Map(); // openai tool index -> anthropic block index
  const toolIds = new Map(); // openai tool index -> tool call id
  let stop = null;
  const usage = { input_tokens: 0, output_tokens: 0 };

  const start = () => ({ event: "message_start", data: { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
  const close = () => {
    const ev = { event: "content_block_stop", data: { type: "content_block_stop", index } };
    open = null;
    return ev;
  };

  for await (const rec of records) {
    const chunk = rec.data ?? rec;
    if (chunk === "[DONE]") break;
    if (!started) {
      started = true;
      yield start();
    }
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (open && open.kind !== "text") yield close();
      if (!open) {
        index += 1;
        open = { kind: "text" };
        yield { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } };
      }
      yield { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } } };
    }
    for (const tc of delta.tool_calls ?? []) {
      const key = tc.index ?? 0;
      if (!toolBlocks.has(key)) {
        if (open) yield close();
        index += 1;
        toolBlocks.set(key, index);
        open = { kind: "tool", key, id: tc.id || `toolu_${randomUUID().slice(0, 12)}` };
        yield { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: open.id, name: tc.function?.name ?? "", input: {} } } };
        toolIds.set(key, open.id);
      }
      rememberToolExtra(toolIds.get(key), tc.extra_content);
      const args = tc.function?.arguments;
      if (args) yield { event: "content_block_delta", data: { type: "content_block_delta", index: toolBlocks.get(key), delta: { type: "input_json_delta", partial_json: args } } };
    }
    if (choice.finish_reason) stop = choice.finish_reason;
  }
  if (!started) yield start();
  if (open) yield close();
  // Some providers (Gemini) report "stop" on a turn that ends in tool calls; the client must still see tool_use.
  const stopReason = toolBlocks.size && (!stop || stop === "stop") ? "tool_use" : (STOP_O2A[stop] ?? (toolBlocks.size ? "tool_use" : "end_turn"));
  yield { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage } };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

export const anthropicUsage = (u) => ({ inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), outputTokens: u?.output_tokens ?? 0 });
