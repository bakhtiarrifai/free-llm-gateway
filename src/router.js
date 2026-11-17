// Picks the models to try for a request and walks them in order, falling over on rate limits, outages and
// exhausted quotas. A model or provider that fails sits out for a while (cooldown) so the next request skips it.
import { TIERS, config } from "./config.js";
import { catalogEntries } from "./providers.js";
import { coolDown, coolingFor, countRequest, getMode, underRpm } from "./state.js";

// How a client names what it wants:
//   "auto" / "free" / "" / a Claude model name -> the whole free chain
//   "<provider>::<model>"                       -> that model on that provider (e.g. "groq::llama-3.3-70b-versatile")
//   any other model id                          -> wherever it is offered (never swapped for another)
export function parseModel(requested, modeOverride) {
  const raw = String(requested ?? "").trim();
  let mode = modeOverride && [...TIERS, "auto"].includes(modeOverride) ? modeOverride : getMode();
  let exact = null;
  let provider = null;
  // "free-gateway" is the label `fgw` gives Claude Code, so its screen shows the gateway instead of a Claude model
  // name (which would look billed). Like "auto", it means the whole free chain.
  if (TIERS.includes(raw) || /^free-gateway$/i.test(raw)) return { mode, exact, provider, raw };
  const m = raw.match(/^([\w.-]+)::(.+)$/);
  if (m) {
    if (TIERS.includes(m[1])) mode = m[1];
    else provider = m[1];
    exact = m[2];
  } else if (raw && raw !== "auto") exact = raw;
  return { mode, exact, provider, raw };
}

const isClaude = (id) => /^claude-/i.test(id ?? "");

export function plan({ requested, modeOverride }) {
  const want = parseModel(requested, modeOverride);
  const tiers = want.mode === "auto" ? config.autoTiers : [want.mode];
  const entries = catalogEntries().filter((e) => e.models.length);
  const out = [];
  const add = (e, model) => {
    if (!out.some((c) => c.provider.id === e.provider.id && c.model === model)) out.push({ provider: e.provider, model, tier: e.provider.tier });
  };

  // An explicitly named provider or exact model goes first.
  if (want.provider) {
    const e = entries.find((x) => x.provider.id === want.provider);
    if (e) add(e, want.exact);
    return { want, tiers, candidates: out };
  }
  if (want.exact) {
    for (const e of entries) {
      if (!tiers.includes(e.provider.tier)) continue;
      if (e.models.includes(want.exact)) add(e, want.exact);
    }
    // A Claude name from Claude Code means "whatever the chain has". Any other name is a hard choice: never swap in a
    // different model behind the client's back.
    if (!isClaude(want.exact)) return { want, tiers, candidates: out };
  }

  for (const tier of tiers) {
    const inTier = entries.filter((e) => e.provider.tier === tier);
    // Round-robin over providers: everyone's best model first, then everyone's second, and so on.
    const depth = Math.max(0, ...inTier.map((e) => e.models.length));
    const allowed = (e, m) => !e.provider.chainExclude || !new RegExp(e.provider.chainExclude, "i").test(m);
    for (let i = 0; i < depth; i++) for (const e of inTier) if (e.models[i] && allowed(e, e.models[i])) add(e, e.models[i]);
  }
  return { want, tiers, candidates: out };
}

// Why a candidate cannot be tried right now, or null.
export function skipReason(c) {
  const cool = coolingFor(c.provider.id, c.model);
  if (cool) return `cooling down ${cool.seconds}s (${cool.reason})`;
  if (!underRpm(c.provider.id, c.provider.rpm)) return "rpm limit";
  return null;
}

// What a failure means: whether to try the next candidate, and what should sit out and for how long.
export function classify(err, c) {
  const s = err.status ?? 0;
  const cd = config.cooldown;
  const msg = (err.message ?? "").toLowerCase();
  const model = `${c.provider.id}:${c.model}`;
  if (s === 0) return { retry: true, key: model, seconds: cd.timeout, reason: err.message };
  if (s === 429) {
    const providerWide = /quota|per day|daily|billing|credits/.test(msg);
    return { retry: true, key: providerWide ? c.provider.id : model, seconds: err.retryAfter ?? (providerWide ? cd.rateLimit * 10 : cd.rateLimit), reason: "rate limited" };
  }
  // 401 is the key itself. 403 is often one model refusing this key (OpenRouter: "only available on agentic
  // harnesses", region or moderation blocks), so only that model sits out unless the message is about the key.
  if (s === 401 || (s === 403 && /api key|invalid key|unauthori[sz]ed|authentication/.test(msg))) return { retry: true, key: c.provider.id, seconds: cd.auth, reason: `key rejected (${s})` };
  if (s === 403) return { retry: true, key: model, seconds: cd.notFound, reason: "model refused for this key (403)" };
  if (s === 404) return { retry: true, key: model, seconds: cd.notFound, reason: "model not found" };
  if (s === 408 || s >= 500) return { retry: true, key: model, seconds: cd.serverError, reason: `upstream ${s}` };
  // 400/413/422: usually this model cannot take this request (context, tools, images). Try the next one, no cooldown.
  return { retry: true, key: null, seconds: 0, reason: `rejected the request (${s})` };
}

export function noteFailure(c, err) {
  const k = classify(err, c);
  if (k.key && k.seconds) coolDown(k.key, k.seconds, k.reason);
  return k;
}

export const noteAttempt = (c) => countRequest(c.provider.id);
