#!/usr/bin/env node
// free-llm-gateway: one endpoint and one key in front of the official free tiers of many LLM providers.
//   POST /v1/chat/completions   OpenAI Chat Completions (apps, chat UIs, most coding tools)
//   POST /v1/messages           Anthropic Messages (Claude Code, Anthropic SDKs)
//   GET  /v1/models             what can be asked for
//   GET  /health                pool summary (used by the `fgw` launcher)
//   GET  /status, /status.json  dashboard (gateway key, or a login proxy such as Cloudflare Access)
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { GATEWAY_KEY, MODES, config } from "./config.js";
import { anthropicToOpenAIRequest, anthropicUsage, openAIStreamToAnthropic, openAIToAnthropicResponse } from "./convert/anthropic.js";
import { UpstreamError, callOpenAI, catalogView, refreshCatalog, retryFailedDiscovery } from "./providers.js";
import { QUOTA_REFRESH_MS, estimateTokens, quotaView, refreshQuotas, tpmLimitOf } from "./quota.js";
import { noteAttempt, noteFailure, plan, skipReason } from "./router.js";
import { startSSE, writeData, writeEvent } from "./sse.js";
import { activeCooldowns, clearCooldown, recordUsage, usageDays } from "./state.js";
import { statusPage } from "./status.js";

const MAX_BODY = 50 * 1024 * 1024;

// ------------------------------------------------------------------ helpers
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const errorBody = (surface, status, type, message) =>
  surface === "anthropic" ? { type: "error", error: { type, message } } : { error: { message, type, code: status } };

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        fail(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", fail);
  });
}

function presentedKey(req, url) {
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers["x-api-key"] ?? url.searchParams.get("key") ?? "";
}
function keyOk(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(GATEWAY_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
// Optional: when the gateway is published behind Cloudflare Access, the dashboard also opens for logged-in users
// (Access adds this header). Off unless TRUST_CF_ACCESS=1, since anyone could send the header to a bare server.
const viaAccess = (req) => process.env.TRUST_CF_ACCESS === "1" && Boolean(req.headers["cf-access-jwt-assertion"]);

// ------------------------------------------------------------------ one attempt against one candidate
// Returns { body } for a whole response, or { stream } of records already in the client's format.
async function attempt(c, surface, body, signal) {
  const p = c.provider;
  const stream = Boolean(body.stream);
  const cap = p.maxOutput ?? config.defaultMaxOutput;
  if (surface === "openai") {
    const out = { ...body, model: c.model };
    if (cap && out.max_tokens > cap) out.max_tokens = cap;
    if (cap && out.max_completion_tokens > cap) out.max_completion_tokens = cap;
    const r = await callOpenAI(p, out, { signal });
    return stream ? { stream: r } : { body: r };
  }
  // Anthropic client (Claude Code, Anthropic SDKs): translate to OpenAI and back.
  // Claude Code asks for up to 128k output tokens; most OpenAI-compatible models reject more than they allow.
  const out = anthropicToOpenAIRequest(body, { model: c.model, maxOutput: cap, streamOptions: p.streamOptions !== false, signatures: p.thoughtSignatures === true });
  const r = await callOpenAI(p, out, { signal });
  return stream ? { stream: openAIStreamToAnthropic(r, c.model) } : { body: openAIToAnthropicResponse(r, c.model) };
}

// Token counts seen in a response or stream record, whichever format it is in.
function usageOf(x) {
  const d = x?.data ?? x;
  if (!d || typeof d !== "object") return null;
  if (d.usage?.prompt_tokens !== undefined || d.usage?.completion_tokens !== undefined) return { inputTokens: d.usage.prompt_tokens ?? 0, outputTokens: d.usage.completion_tokens ?? 0 };
  if (d.type === "message_start") return { inputTokens: anthropicUsage(d.message?.usage).inputTokens, outputTokens: 0 };
  if (d.type === "message_delta" && d.usage) return { inputTokens: anthropicUsage(d.usage).inputTokens, outputTokens: d.usage.output_tokens ?? 0 };
  if (d.type === "message" && d.usage) return anthropicUsage(d.usage);
  return null;
}

function account(c, usage, ok, started) {
  const u = usage ?? { inputTokens: 0, outputTokens: 0 };
  recordUsage({ provider: c.provider.id, model: c.model, tier: c.tier, ok, inputTokens: u.inputTokens, outputTokens: u.outputTokens, ms: Date.now() - started });
}

// ------------------------------------------------------------------ the fallback loop
async function serve(req, res, surface, body, trace = {}) {
  const { want, candidates } = plan({ requested: body.model });
  Object.assign(trace, { mode: want.mode, requested: body.model, stream: Boolean(body.stream) });
  const tried = [];
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(new Error("client disconnected")); };
  req.on("aborted", disconnect);
  res.on("close", disconnect);
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    controller.abort(new Error("gateway response deadline exceeded"));
  }, Math.min(config.requestTimeoutMs, 100_000));
  try {
  const maxAttempts = config.maxAttempts ?? 10;
  let attempts = 0;
  const size = estimateTokens(body);
  for (const c of candidates) {
    if (controller.signal.aborted || attempts >= maxAttempts) break;
    const tpm = tpmLimitOf(c.provider, c.model);
    const skip = body.tools?.length && c.provider.tools === false ? "no tool support"
      : tpm && size > tpm ? `request ~${size} tokens is over its ${tpm} tokens-per-minute limit`
      : skipReason(c);
    if (skip) {
      tried.push(`${c.provider.id}::${c.model} skipped: ${skip}`);
      trace.skipped = (trace.skipped ?? 0) + 1;
      continue;
    }
    attempts += 1;
    trace.attempts = attempts;
    noteAttempt(c);
    const started = Date.now();
    let result;
    try {
      result = await attempt(c, surface, body, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) break;
      if (!(err instanceof UpstreamError)) throw err;
      const k = noteFailure(c, err);
      account(c, null, false, started);
      console.error(`[fallback] ${surface} ${c.provider.id}::${c.model} ${err.status || "network"} ${k.reason}: ${(err.message ?? "").slice(0, 200)}`);
      tried.push(`${c.provider.id}::${c.model} ${err.status || "network"}: ${k.reason}${err.message && k.reason !== err.message ? ` - ${err.message.slice(0, 160)}` : ""}`);
      continue;
    }
    clearTimeout(deadline);
    if (controller.signal.aborted) break;
    clearCooldown(c.provider.id, c.model);
    Object.assign(trace, { provider: `${c.provider.id}::${c.model}`, tier: c.tier });
    const headers = { "x-gateway-provider": c.provider.id, "x-gateway-model": c.model, "x-gateway-tier": c.tier, "x-gateway-attempts": String(attempts) };
    if (result.body) {
      json(res, 200, result.body, headers);
      account(c, usageOf(result.body), true, started);
      return;
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    startSSE(res);
    let usage = { inputTokens: 0, outputTokens: 0 };
    let ok = true;
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(": keepalive\n\n");
    }, Math.min(config.sseHeartbeatMs, 30_000));
    try {
      for await (const rec of result.stream) {
        if (res.destroyed) break;
        const u = usageOf(rec);
        if (u) usage = { inputTokens: u.inputTokens || usage.inputTokens, outputTokens: u.outputTokens || usage.outputTokens };
        if (surface === "openai") {
          const payload = rec?.data !== undefined && rec?.event !== undefined ? rec.data : (rec?.data ?? rec);
          if (payload !== "[DONE]") writeData(res, payload);
        } else if (rec?.event && rec?.data) writeEvent(res, rec.event, rec.data);
        else if (rec?.type) writeEvent(res, rec.type, rec);
      }
      if (surface === "openai") writeData(res, "[DONE]");
    } catch (err) {
      // Too late to fall over: the client already has part of the answer.
      ok = false;
      if (controller.signal.aborted || res.destroyed) return;
      trace.outcome = "stream-error";
      noteFailure(c, err);
      const message = `upstream ${c.provider.id}::${c.model} failed mid-stream: ${err.message}`;
      if (surface === "openai") writeData(res, { error: { message, type: "upstream_error" } });
      else writeEvent(res, "error", { type: "error", error: { type: "api_error", message } });
    } finally {
      clearInterval(heartbeat);
    }
    res.end();
    account(c, usage, ok, started);
    return;
  }

  if (res.destroyed || (controller.signal.aborted && !expired)) return;
  if (expired) {
    trace.outcome = "timeout";
    return json(res, 504, errorBody(surface, 504, "api_error", "gateway_response_timeout: upstream attempts exceeded the response deadline; no answer data was sent."), { "x-gateway-timeout": "1" });
  }
  // Nothing left.
  const none = want.exact && !candidates.length ? ` Model "${want.exact}" is not offered${want.provider ? ` on ${want.provider}` : ""} (see GET /v1/models).` : " No provider has a key configured.";
  const message = `pool_exhausted. All free models are used up or unavailable right now; try again later, or start Claude Code on your own subscription (fgw claude --sub).${tried.length ? ` Tried: ${tried.join(" | ")}` : none}`;
  trace.outcome = "exhausted";
  json(res, 503, errorBody(surface, 503, surface === "anthropic" ? "overloaded_error" : "pool_exhausted", message), { "x-gateway-exhausted": "1" });
  } finally {
    clearTimeout(deadline);
    req.off("aborted", disconnect);
    res.off("close", disconnect);
  }
}

// One line per model request, written when the connection closes, so slow reads, timeouts and clients that gave up
// all show up with their real duration. Only routing facts: never the prompt, the answer or a key.
function traceRequest(req, res, surface) {
  const started = Date.now();
  const trace = {};
  if (!config.requestLog) return trace;
  res.once("close", () => {
    const word = (v) => String(v ?? "-").replace(/\s+/g, "_").slice(0, 80);
    const outcome = trace.outcome ?? (!res.writableEnded ? "client-closed" : res.statusCode >= 400 ? "rejected" : "ok");
    const fields = [
      surface, res.headersSent ? res.statusCode : "-", outcome, `${Date.now() - started}ms`,
      `read=${trace.readMs ?? "-"}ms`, `mode=${word(trace.mode)}`, `asked=${word(trace.requested)}`,
      `stream=${trace.stream ? 1 : 0}`, `via=${word(trace.provider)}`, `tier=${word(trace.tier)}`,
      `attempts=${trace.attempts ?? 0}`, `skipped=${trace.skipped ?? 0}`,
    ];
    console.log(`[request] ${fields.join(" ")}`);
  });
  return trace;
}

// ------------------------------------------------------------------ other endpoints
function modelsList() {
  const data = [{ id: "auto" }, ...MODES.filter((m) => m !== "auto").map((m) => ({ id: m }))];
  for (const e of catalogView()) for (const m of e.models) data.push({ id: `${e.provider}::${m}`, owned_by: `${e.provider} (${e.tier})` });
  return { object: "list", data: data.map((d) => ({ object: "model", type: "model", display_name: d.id, owned_by: "llm-gateway", ...d })), has_more: false, first_id: data[0]?.id, last_id: data.at(-1)?.id };
}

async function health() {
  const { candidates } = plan({ requested: "free" });
  await refreshQuotas().catch(() => {});
  const q = quotaView(usageDays()[new Date().toISOString().slice(0, 10)] ?? {});
  return { ok: true, available: { free: candidates.filter((c) => !skipReason(c)).length }, quota: q.totals };
}

export async function statusJson() {
  const day = new Date().toISOString().slice(0, 10);
  await refreshQuotas().catch(() => {});
  const today = usageDays()[day] ?? {};
  return { quota: quotaView(today), providers: catalogView(), cooldowns: activeCooldowns(), today };
}

// ------------------------------------------------------------------ server
export function createGateway() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://gateway");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const surface = path.startsWith("/v1/messages") ? "anthropic" : "openai";
    try {
      if (path === "/status" || path === "/status.json") {
        if (!viaAccess(req) && !keyOk(presentedKey(req, url))) return json(res, 401, { error: "add ?key=<GATEWAY_KEY>" });
        const status = await statusJson();
        if (path === "/status.json") return json(res, 200, status);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(statusPage(status));
      }
      if (!keyOk(presentedKey(req, url))) return json(res, 401, errorBody(surface, 401, "authentication_error", "missing or wrong gateway key"));

      if (req.method === "GET" && path === "/health") return json(res, 200, await health());
      if (req.method === "GET" && path === "/v1/models") return json(res, 200, modelsList());
      if (req.method === "POST" && path === "/gateway/refresh") return json(res, 200, await refreshCatalog());
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        // An estimate (~4 characters per token) is enough for clients that only use it to manage context.
        const body = await readBody(req);
        return json(res, 200, { input_tokens: Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 4) });
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
        const trace = traceRequest(req, res, surface);
        const read = Date.now();
        const body = await readBody(req);
        trace.readMs = Date.now() - read;
        return await serve(req, res, surface, body, trace);
      }
      return json(res, 404, errorBody(surface, 404, "not_found_error", `no route for ${req.method} ${path}`));
    } catch (err) {
      if (res.headersSent) return res.end();
      return json(res, err.status ?? 500, errorBody(surface, err.status ?? 500, "api_error", err.message));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!GATEWAY_KEY || GATEWAY_KEY.length < 16) {
    console.error("Set GATEWAY_KEY (at least 16 characters) in the environment, ./.env or ~/.config/free-llm-gateway/.env");
    process.exit(1);
  }
  const view = await refreshCatalog();
  // Providers that could not be listed (often no network yet right after boot) are tried again soon, not in 6 hours.
  let stopRetry = retryFailedDiscovery();
  setInterval(async () => {
    await refreshCatalog().catch(() => {});
    stopRetry();
    stopRetry = retryFailedDiscovery();
  }, config.rediscoverMinutes * 60_000).unref();
  refreshQuotas(true).catch(() => {});
  setInterval(() => refreshQuotas(true).catch(() => {}), QUOTA_REFRESH_MS).unref();
  createGateway().listen(config.port, config.host, () => {
    console.log(`free-llm-gateway on http://${config.host}:${config.port}`);
    for (const p of view) console.log(`  ${p.provider.padEnd(11)} ${p.error ? `UNAVAILABLE: ${p.error}` : `${p.models.length} models`}`);
    if (!view.length) console.log("  no provider key found: add at least one key to .env (see .env.example)");
  });
}
