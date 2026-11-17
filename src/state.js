// Everything the gateway learns while running: cooldowns, request counters and usage per day. Saved to state.json
// (debounced) so a restart keeps the stats.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_FILE, config } from "./config.js";

const blank = () => ({ mode: config.defaultMode, cooldowns: {}, days: {} });
let state = blank();
try {
  if (existsSync(STATE_FILE)) state = { ...blank(), ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
} catch {
  state = blank();
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
  }, 1000);
  timer.unref?.();
}

const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

export const getMode = () => state.mode;
export function setMode(mode) {
  state.mode = mode;
  save();
}

// ---- cooldowns: key is "provider" or "provider:model"
export function coolDown(key, seconds, reason) {
  state.cooldowns[key] = { until: Date.now() + seconds * 1000, reason };
  save();
}
export function coolingFor(provider, model) {
  const now = Date.now();
  for (const key of [provider, `${provider}:${model}`]) {
    const c = state.cooldowns[key];
    if (c && c.until > now) return { key, seconds: Math.ceil((c.until - now) / 1000), reason: c.reason };
  }
  return null;
}
export function clearCooldown(provider, model) {
  if (delete state.cooldowns[`${provider}:${model}`]) save();
}
export const activeCooldowns = () =>
  Object.entries(state.cooldowns)
    .filter(([, c]) => c.until > Date.now())
    .map(([key, c]) => ({ key, seconds: Math.ceil((c.until - Date.now()) / 1000), reason: c.reason }));

// ---- per-minute request counters (memory only) for providers with an rpm limit
const minute = new Map();
export function underRpm(provider, rpm) {
  if (!rpm) return true;
  const now = Date.now();
  const hits = (minute.get(provider) ?? []).filter((t) => now - t < 60_000);
  minute.set(provider, hits);
  return hits.length < rpm;
}
export function countRequest(provider) {
  minute.set(provider, [...(minute.get(provider) ?? []), Date.now()]);
}

// ---- daily usage per provider/model
export function recordUsage({ provider, model, tier, ok, inputTokens = 0, outputTokens = 0, ms = 0 }) {
  const day = (state.days[today()] ??= {});
  const row = (day[`${provider}:${model}`] ??= { tier, requests: 0, errors: 0, input: 0, output: 0, ms: 0 });
  row.requests += 1;
  if (!ok) row.errors += 1;
  row.input += inputTokens;
  row.output += outputTokens;
  row.ms += ms;
  // keep 31 days
  const keys = Object.keys(state.days).sort();
  while (keys.length > 31) delete state.days[keys.shift()];
  save();
}
export const usageDays = () => state.days;
export const requestsToday = (provider) =>
  Object.entries(state.days[today()] ?? {})
    .filter(([k]) => k.startsWith(`${provider}:`))
    .reduce((n, [, r]) => n + r.requests, 0);
