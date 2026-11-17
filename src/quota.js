// What is left of each free quota, as far as each provider tells us:
//   - rate-limit headers on every answer (Groq: requests per day and tokens per minute, per model)
//   - an API (OpenRouter: free-model requests per day)
//   - a 429 whose message names the daily limit (Gemini and others), learned when it happens
// Free tiers count requests per day, not tokens, so "tokens left" is an estimate: requests left x average tokens per
// request today.
import { keyOf } from "./config.js";
import { upstreams } from "./providers.js";

const quotas = new Map(); // provider id -> { models: Map(model -> header info), daily?, learned? }
const entry = (id) => {
  if (!quotas.has(id)) quotas.set(id, { models: new Map() });
  return quotas.get(id);
};

// Groq and other OpenAI-style providers: x-ratelimit-{limit,remaining,reset}-{requests,tokens}.
export function noteRateHeaders(providerId, model, headers) {
  const get = (k) => headers?.get?.(`x-ratelimit-${k}`);
  const num = (k) => (get(k) === null || get(k) === undefined || get(k) === "" ? undefined : Number(get(k)));
  const info = {
    limitRequests: num("limit-requests"), remainingRequests: num("remaining-requests"), resetRequests: get("reset-requests") ?? undefined,
    limitTokens: num("limit-tokens"), remainingTokens: num("remaining-tokens"), resetTokens: get("reset-tokens") ?? undefined,
    at: Date.now(),
  };
  if (info.limitRequests === undefined && info.limitTokens === undefined) return;
  entry(providerId).models.set(model, info);
}

// A daily-quota 429 ("... limit: 250 ... PerDay") teaches the limit for that model.
export function noteQuotaError(providerId, model, message) {
  const m = String(message ?? "");
  if (!/per ?day|perday|daily|requests per day|RPD/i.test(m)) return;
  const limit = Number(m.match(/limit:?\s*(\d+)/i)?.[1]);
  if (!limit) return;
  const e = entry(providerId);
  e.learned = { ...(e.learned ?? {}), [model]: { limit, at: Date.now() } };
}

// A 413 "on tokens per minute (TPM): Limit 8000, Requested 22429" teaches that model's TPM limit, so the next
// request that size skips it instead of being refused again.
export function noteTooLarge(providerId, model, message) {
  const limit = Number(String(message ?? "").match(/tokens per minute[^]*?limit:?\s*(\d+)/i)?.[1]);
  if (!limit) return;
  const e = entry(providerId);
  e.models.set(model, { ...(e.models.get(model) ?? {}), limitTokens: limit, at: Date.now() });
}

// The tokens-per-minute limit known for a model: learned from headers or a 413, else the provider's configured
// maxRequestTokens. A request bigger than this can never pass, however long it waits.
export function tpmLimitOf(provider, model) {
  return quotas.get(provider.id)?.models.get(model)?.limitTokens ?? provider.maxRequestTokens;
}

// Rough size of a request in tokens (~5 characters per token for JSON-heavy prompts; Groq counted a Claude Code
// request of 161k characters as 22.4k tokens, so this errs slightly high).
export const estimateTokens = (body) => Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 5);

async function getJson(url, key) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let lastRefresh = 0;
export async function refreshQuotas(force = false) {
  if (!force && Date.now() - lastRefresh < 60_000) return;
  lastRefresh = Date.now();
  const ups = upstreams();
  const or = ups.find((p) => p.id === "openrouter");
  if (or) {
    try {
      const d = (await getJson("https://openrouter.ai/api/v1/key", keyOf(or))).data ?? {};
      const f = d.free_model_daily_requests;
      if (f) entry("openrouter").daily = { used: f.used, limit: f.limit, remaining: f.remaining, source: "API", at: Date.now() };
    } catch (err) {
      entry("openrouter").error = err.message;
    }
  }
}

// One row per free provider plus totals, for the dashboard and /status.json.
export function quotaView(today) {
  const used = {}; // provider -> {requests, tokens}
  for (const [k, r] of Object.entries(today ?? {})) {
    const p = k.slice(0, k.indexOf(":"));
    used[p] ??= { requests: 0, ok: 0, tokens: 0, tier: r.tier };
    used[p].requests += r.requests;
    used[p].ok += r.requests - r.errors;
    used[p].tokens += r.input + r.output;
  }
  const rows = [];
  for (const p of upstreams().filter((x) => x.tier === "free")) {
    const q = quotas.get(p.id) ?? { models: new Map() };
    const u = used[p.id] ?? { requests: 0, ok: 0, tokens: 0 };
    let limit;
    let remaining;
    let source = "–";
    if (q.daily) {
      ({ limit, remaining } = q.daily);
      source = "API";
    } else if (q.models.size) {
      // Each model has its own daily request quota, so they add up.
      const withReq = [...q.models.values()].filter((m) => m.limitRequests !== undefined);
      if (withReq.length) {
        limit = withReq.reduce((n, m) => n + m.limitRequests, 0);
        remaining = withReq.reduce((n, m) => n + (m.remainingRequests ?? 0), 0);
        source = `header (${withReq.length} model)`;
      }
    } else if (q.learned) {
      limit = Object.values(q.learned).reduce((n, m) => n + m.limit, 0);
      remaining = Math.max(0, limit - u.requests);
      source = "dipelajari dari 429";
    } else if (p.dailyRequests) {
      limit = p.dailyRequests;
      remaining = Math.max(0, limit - u.requests);
      source = "config";
    }
    const tpm = [...q.models.values()].find((m) => m.limitTokens !== undefined);
    rows.push({
      provider: p.id,
      requestsToday: u.requests,
      tokensToday: u.tokens,
      avgTokensPerRequest: u.ok ? Math.round(u.tokens / u.ok) : 0,
      dailyLimit: limit ?? null,
      remaining: remaining ?? null,
      source,
      tokensPerMinute: tpm ? { limit: tpm.limitTokens, remaining: tpm.remainingTokens } : null,
      note: p.quotaNote ?? null,
    });
  }
  const known = rows.filter((r) => r.dailyLimit !== null);
  const totalTokensToday = rows.reduce((n, r) => n + r.tokensToday, 0);
  const totalOk = Object.values(used).filter((x) => x.tier === "free").reduce((n, x) => n + x.ok, 0);
  const avg = totalOk ? totalTokensToday / totalOk : 0;
  const remainingRequests = known.reduce((n, r) => n + r.remaining, 0);
  const totals = {
    requestsLimit: known.reduce((n, r) => n + r.dailyLimit, 0),
    requestsRemaining: remainingRequests,
    providersCounted: known.map((r) => r.provider),
    tokensToday: totalTokensToday,
    avgTokensPerRequest: Math.round(avg),
    // Estimate: what the remaining requests would carry at today's average size.
    tokensRemainingEstimate: Math.round(remainingRequests * avg),
    tokensLimitEstimate: Math.round(remainingRequests * avg + totalTokensToday),
  };

  return { rows, totals, at: Date.now() };
}

export const QUOTA_REFRESH_MS = 5 * 60_000;
