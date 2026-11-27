#!/usr/bin/env node
// fgw: starts Claude Code on free-llm-gateway, or on your own Claude login when the free pool is empty.
//
//   fgw claude [claude args...]        Claude Code on the free models (falls back to your Claude login if none are ready)
//   fgw claude --sub [claude args...]  Claude Code on your own Claude login, not through the gateway
//   fgw status                         free models ready, and today's free quota
//   fgw env                            print the variables to use the gateway in your own shell
//
// Reads FREE_GATEWAY_URL and FREE_GATEWAY_KEY from the environment or ~/.config/free-llm-gateway/client.env.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = join(homedir(), ".config", "free-llm-gateway");
const envFile = join(HOME, "client.env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const URL_ = (process.env.FREE_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const KEY = process.env.FREE_GATEWAY_KEY ?? "";
const say = (s) => process.stderr.write(`\x1b[2m[fgw]\x1b[0m ${s}\n`);

async function gateway(path) {
  const res = await fetch(URL_ + path, { headers: { authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`gateway ${path}: HTTP ${res.status}`);
  return res.json();
}

// Windows: an npm-installed claude is claude.cmd, which only starts through the shell, and the shell joins the
// arguments as they are. Quote the ones with spaces or shell characters (a settings path under C:\Users\Ada Lovelace).
const WIN = process.platform === "win32";
const winQuote = (a) => (/^[\w\-.:\\/=@,+]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

function run(cmd, args, env) {
  const child = spawn(cmd, WIN ? args.map(winQuote) : args, { stdio: "inherit", env, shell: WIN });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  child.on("error", (err) => {
    say(`could not start ${cmd}: ${err.message}`);
    process.exit(127);
  });
}

// Claude Code's own login, with every gateway setting removed so nothing points it elsewhere.
const CLAUDE_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
function ownLoginEnv() {
  const env = { ...process.env };
  for (const v of CLAUDE_VARS) delete env[v];
  return env;
}

async function claude(args) {
  const i = args.indexOf("--sub");
  if (i >= 0) {
    args.splice(i, 1);
    return run("claude", args, ownLoginEnv());
  }
  try {
    if (!KEY) throw new Error("FREE_GATEWAY_KEY is not set");
    const h = await gateway("/health");
    if (!h.available.free) {
      say("no free model is ready right now; using your own Claude login");
      return run("claude", args, ownLoginEnv());
    }
    say(`${URL_}: ${h.available.free} free models ready`);
  } catch (err) {
    say(`gateway unreachable (${err.message}); using your own Claude login`);
    return run("claude", args, ownLoginEnv());
  }
  const env = ownLoginEnv();
  Object.assign(env, {
    ANTHROPIC_BASE_URL: URL_,
    ANTHROPIC_AUTH_TOKEN: KEY,
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  });
  // Show "free-gateway" as the model, not the Claude model from ~/.claude/settings.json with its API prices. The
  // gateway reads that name as the free chain. A --model you pass still wins.
  for (const v of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) env[v] = "free-gateway";
  say("Claude Code on free models. If they run dry mid-session, restart with: fgw claude --sub");
  run("claude", [...overrideSettings(env), ...args], env);
}

// The "env" block of ~/.claude/settings.json (or a project's .claude/settings*.json) beats the process environment,
// so a base URL left there by another gateway would take every request. Settings passed with --settings rank above
// all of those files: repeat the gateway variables there, blank the other Anthropic ones the files set, and replace
// an apiKeyHelper (its key would replace ours). The user's own files stay untouched.
function overrideSettings(env) {
  const files = [join(homedir(), ".claude", "settings.json"), join(".claude", "settings.json"), join(".claude", "settings.local.json")];
  const theirs = {};
  let helper = false;
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(f, "utf8"));
      Object.assign(theirs, s.env ?? {});
      helper ||= Boolean(s.apiKeyHelper);
    } catch {}
  }
  const ours = {};
  for (const v of [...CLAUDE_VARS, "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"]) {
    if (env[v] !== undefined) ours[v] = env[v];
    else if (theirs[v] !== undefined) ours[v] = "";
  }
  if (theirs.ANTHROPIC_BASE_URL && theirs.ANTHROPIC_BASE_URL !== URL_) say(`ignoring ANTHROPIC_BASE_URL ${theirs.ANTHROPIC_BASE_URL} from your Claude settings for this session`);
  const settings = { env: ours, model: "free-gateway" };
  if (helper) settings.apiKeyHelper = `echo ${KEY}`;
  const file = join(HOME, "claude-settings.json");
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    say(`could not write ${file} (${err.message}); settings in ~/.claude/settings.json may still win`);
    return [];
  }
  return ["--settings", file];
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "claude":
    await claude(rest);
    break;
  case "status": {
    const h = await gateway("/health");
    const q = h.quota ?? {};
    console.log(`free models ready: ${h.available.free}`);
    if (q.requestsLimit) console.log(`free requests left today: ${q.requestsRemaining} / ${q.requestsLimit} (${q.providersCounted.join(", ")}), ~${q.tokensRemainingEstimate.toLocaleString()} tokens`);
    break;
  }
  case "env":
    console.log(`export ANTHROPIC_BASE_URL=${URL_}\nexport ANTHROPIC_AUTH_TOKEN=${KEY || "<FREE_GATEWAY_KEY>"}\nexport ANTHROPIC_MODEL=free-gateway\n# OpenAI clients: base URL ${URL_}/v1, API key the same, model "auto"`);
    break;
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(cmd ? 2 : 0);
}
