// The catalog of usable models, and calling an upstream over OpenAI-compatible HTTP.
import { config, enabled, keyOf } from "./config.js";
import { noteQuotaError, noteRateHeaders, noteTooLarge } from "./quota.js";
import { parseSSE } from "./sse.js";

// Every upstream with the tier it belongs to and the wire format it speaks.
export function upstreams() {
  return config.providers.map((p) => ({ ...p, tier: "free", wire: "openai" })).filter(enabled);
}

const catalog = new Map(); // provider id -> { provider, models: [ids], error? , at }

async function listModels(p) {
  if (p.models && !p.discover) return p.models;
  const res = await fetch(`${p.base.replace(/\/$/, "")}/models`, { headers: keyOf(p) ? { authorization: `Bearer ${keyOf(p)}` } : {}, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} listing models`);
  const body = await res.json();
  const ids = (body.data ?? body.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  const match = new RegExp(p.discover?.match ?? ".", "i");
  const exclude = p.discover?.exclude ? new RegExp(p.discover.exclude, "i") : null;
  const kept = ids.filter((id) => match.test(id) && !(exclude && exclude.test(id)));
  const rank = (id) => {
    const i = (p.prefer ?? []).findIndex((w) => id.toLowerCase().includes(w.toLowerCase()));
    return i < 0 ? 999 : i;
  };
  return [...new Set([...(p.models ?? []), ...kept.sort((a, b) => rank(a) - rank(b))])];
}

export async function refreshCatalog() {
  await Promise.all(
    upstreams().map(async (p) => {
      try {
        catalog.set(p.id, { provider: p, models: await listModels(p), at: Date.now() });
      } catch (err) {
        // Keep the last good list; a provider that never listed stays out until it answers.
        const old = catalog.get(p.id);
        catalog.set(p.id, { provider: p, models: old?.models ?? [], error: err.message, at: Date.now() });
      }
    }),
  );
  return catalogView();
}

// In configured order, not in the order the model listings happened to come back.
export const catalogEntries = () => upstreams().map((p) => catalog.get(p.id)).filter(Boolean);
export const catalogView = () => catalogEntries().map((e) => ({ provider: e.provider.id, tier: e.provider.tier, models: e.models, ...(e.error ? { error: e.error } : {}) }));

// ------------------------------------------------------------------ calls
export class UpstreamError extends Error {
  constructor(status, message, { retryAfter, type } = {}) {
    super(message);
    this.status = status; // 0 = network / timeout
    this.retryAfter = retryAfter;
    this.type = type;
  }
}

const retryAfterOf = (headers) => {
  const v = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// Waits for the first record so a failure can still fall over to the next model before anything reaches the client.
async function primed(iterable, timeoutMs) {
  const it = iterable[Symbol.asyncIterator]();
  let timer;
  const first = await Promise.race([
    it.next(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError(0, `no response within ${timeoutMs / 1000} s`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return {
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      while (true) {
        const n = await it.next();
        if (n.done) return;
        yield n.value;
      }
    },
  };
}

// OpenAI-compatible chat completion. Returns the parsed body, or a primed async iterable of SSE records.
export async function callOpenAI(p, body, { signal } = {}) {
  const headers = { "content-type": "application/json" };
  if (keyOf(p)) headers.authorization = `Bearer ${keyOf(p)}`;
  if (p.id === "openrouter") Object.assign(headers, { "http-referer": config.referer, "x-title": "free-llm-gateway" });
  const timeout = p.firstByteTimeoutMs ?? config.firstByteTimeoutMs;
  let res;
  try {
    res = await fetch(`${p.base.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(body.stream ? 10 * 60_000 : timeout) });
  } catch (err) {
    throw new UpstreamError(0, err.name === "TimeoutError" ? `no response within ${timeout / 1000} s` : err.message);
  }
  noteRateHeaders(p.id, body.model, res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text.slice(0, 500);
    try {
      const j = JSON.parse(text);
      const e = Array.isArray(j) ? j[0] : j; // Google wraps errors in an array
      message = e?.error?.message ?? e?.message ?? message;
    } catch {}
    if (res.status === 429) noteQuotaError(p.id, body.model, message);
    if (res.status === 413) noteTooLarge(p.id, body.model, message);
    throw new UpstreamError(res.status, message, { retryAfter: retryAfterOf(res.headers) });
  }
  // A 200 that is not what an OpenAI-compatible API sends (a placeholder page, a retired endpoint answering "OK")
  // must fall over like an outage, not crash the request.
  const type = res.headers.get("content-type") ?? "";
  if (!body.stream) {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (!Array.isArray(json.choices)) throw new Error("no choices");
      return json;
    } catch {
      throw new UpstreamError(502, `not an OpenAI chat response (${type || "no content-type"}): ${text.slice(0, 80)}`);
    }
  }
  if (!/event-stream|json/i.test(type)) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(502, `not a stream (${type || "no content-type"}): ${text.slice(0, 80)}`);
  }
  return primed(parseSSE(res.body), timeout);
}
