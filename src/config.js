// Settings: secrets come from the environment (or a .env file), everything else from built-in defaults that an
// optional config.json can override field by field.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// A tiny .env reader (KEY=value per line, # comments, optional quotes). Real environment variables win.
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export const HOME = resolve(process.env.GATEWAY_HOME ?? join(homedir(), ".config", "free-llm-gateway"));
loadEnvFile(process.env.GATEWAY_ENV ?? join(HOME, ".env"));
loadEnvFile(resolve(".env"));

const env = process.env;

// One tier: free. ("auto" and "free" mean the same thing here; both names are accepted.)
export const TIERS = ["free"];
export const MODES = ["auto", ...TIERS];

// Free tiers, official endpoints only, all OpenAI-compatible. `discover` keeps the models whose id matches; order
// within a provider follows `prefer` (first match wins), then the provider's own listing.
const FREE = [
  {
    id: "cerebras", key: "CEREBRAS_API_KEY", base: "https://api.cerebras.ai/v1",
    discover: { match: "." }, prefer: ["qwen", "gpt-oss", "llama"],
  },
  {
    id: "groq", key: "GROQ_API_KEY", base: "https://api.groq.com/openai/v1",
    discover: { match: ".", exclude: "whisper|guard|tts|orpheus|playai|prompt-guard|compound|allam" },
    prefer: ["gpt-oss-120b", "kimi", "qwen", "llama-4", "gpt-oss-20b", "llama-3.3"],
    // Free tier: small tokens-per-minute limits (8k on some models), so long Claude Code prompts are refused (413)
    // and fall through to the next provider. Chat and short prompts fit fine.
    maxOutput: 16_384,
    // Until Groq's headers say otherwise: free-tier TPM limit. Bigger requests (Claude Code's ~22k) skip Groq.
    maxRequestTokens: 8000,
  },
  {
    id: "gemini", key: "GEMINI_API_KEY", base: "https://generativelanguage.googleapis.com/v1beta/openai",
    // Checked 2026-11-17 on a free key: 3.x pro/flash and *-latest answer; gemini-2.5-pro is 404 on the free tier.
    discover: { match: "gemini-.*(pro|flash)", exclude: "image|tts|audio|live|embedding|vision|lite|customtools|omni|gemini-2\\.|gemini-1\\." },
    maxOutput: 65_536, thoughtSignatures: true,
    prefer: ["3.1-pro", "pro-latest", "3.8-flash", "3.7-flash", "3.6-flash", "3.5-flash", "flash-latest", "3-flash"],
  },
  {
    id: "mistral", key: "MISTRAL_API_KEY", base: "https://api.mistral.ai/v1",
    discover: { match: "(large|medium|devstral|codestral|magistral)-latest$" }, prefer: ["devstral", "large", "medium", "codestral"],
  },
  {
    id: "openrouter", key: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1",
    // Checked 2026-11-17: inkling is harness-only (403) and lfm-3-1.7b answers empty, so they are left out.
    discover: { match: ":free$", exclude: "inkling|lfm-3-1\\.7b" },
    prefer: ["nemotron-3-ultra", "deepseek", "qwen", "kimi", "glm", "ernie", "ling", "north", "dots", "gemma-4-31b", "nemotron"],
  },
  {
    id: "nvidia", key: "NVIDIA_API_KEY", base: "https://integrate.api.nvidia.com/v1",
    discover: { match: "deepseek|qwen|kimi|glm|llama-3.3|nemotron", exclude: "embed|rerank|guard|vision|vl|reward|safety" },
    prefer: ["deepseek", "qwen", "kimi", "glm", "nemotron"],
  },
  // GitHub Models is left out: on 2026-11-17 models.github.ai answered a plain "OK" to every request (with or
  // without a token, on any path), so it no longer serves completions. Add it back here if it returns.
  {
    id: "cloudflare", key: "CLOUDFLARE_AI_TOKEN", base: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID ?? "ACCOUNT_ID"}/ai/v1`,
    needs: ["CLOUDFLARE_ACCOUNT_ID"], models: ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwen2.5-coder-32b-instruct"],
    // Fine for chat; rejects Claude Code's tool schemas ("oneOf ... not met") and large max_tokens.
    tools: false, maxOutput: 8192,
  },
];

const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  defaultMode: "auto",
  autoTiers: ["free"],
  providers: FREE,
  // Seconds a model or provider sits out after each kind of failure.
  cooldown: { rateLimit: 60, serverError: 30, timeout: 45, auth: 3600, notFound: 6 * 3600 },
  firstByteTimeoutMs: 45_000,
  // Output-token cap for OpenAI-compatible upstreams without their own maxOutput (Claude Code asks for 128k).
  defaultMaxOutput: 32_768,
  rediscoverMinutes: 360,
  // Sent to OpenRouter as HTTP-Referer / X-Title (it shows apps by these). Override with GATEWAY_REFERER.
  referer: env.GATEWAY_REFERER ?? "https://github.com/bakhtiarrifai/free-llm-gateway",
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

const file = process.env.GATEWAY_CONFIG ?? join(HOME, "config.json");
const user = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
export const config = merge(DEFAULTS, user);
config.port = Number(env.GATEWAY_PORT ?? config.port);
config.host = env.GATEWAY_HOST ?? config.host;

// The one key every client uses. Required: the gateway refuses to start without it.
export const GATEWAY_KEY = env.GATEWAY_KEY ?? "";
export const STATE_FILE = join(HOME, "state.json");

export const keyOf = (p) => (p.key ? env[p.key] : undefined);
export const enabled = (p) => (p.optionalKey || Boolean(keyOf(p))) && (p.needs ?? []).every((n) => env[n]) && Boolean(p.base ?? p.openaiBase ?? true);
