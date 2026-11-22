// Discovery retry and the per-request log. No real providers or keys: loopback mocks only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const KEY = "loopback-test-key-123";
const SECRET_PROMPT = "do-not-log-this-prompt";
const servers = [];
let base, gateway, home, refreshCatalog, catalogView, retryFailedDiscovery;
let modelsUp = false;
let modelListings = 0;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const listen = async (s) => {
  servers.push(s);
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${s.address().port}`;
};

before(async () => {
  base = await listen(createServer(async (req, res) => {
    let text = "";
    for await (const c of req) text += c;
    if (req.url.endsWith("/models")) {
      modelListings += 1;
      if (!modelsUp) return res.writeHead(503).end("not yet");
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "flaky-model" }] }));
    }
    const body = JSON.parse(text);
    if (body.model === "slow") return; // never answers: the gateway's deadline must end it
    if (body.model === "busy") return res.writeHead(429, { "content-type": "application/json" }).end("{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  }));
  home = mkdtempSync(join(tmpdir(), "free-gateway-operations-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: [
      { id: "fixed", base: `${base}/v1`, optionalKey: true, models: ["good", "busy", "slow"] },
      { id: "flaky", base: `${base}/flaky/v1`, optionalKey: true, discover: { match: "." } },
    ],
    firstByteTimeoutMs: 400, requestTimeoutMs: 150, discoveryRetrySeconds: [0.05, 0.1],
  }));
  Object.assign(process.env, { GATEWAY_HOME: home, GATEWAY_ENV: join(home, "none"), GATEWAY_KEY: KEY });
  ({ refreshCatalog, catalogView, retryFailedDiscovery } = await import("../src/providers.js"));
  const { createGateway } = await import("../src/server.js");
  await refreshCatalog();
  gateway = await listen(createGateway());
});

after(async () => {
  for (const s of servers) s.closeAllConnections?.();
  await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  rmSync(home, { recursive: true, force: true });
});

const ask = (model) => fetch(`${gateway}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": KEY },
  body: JSON.stringify({ model, messages: [{ role: "user", content: SECRET_PROMPT }] }),
});

// Runs fn and returns the [request] lines logged while it ran (they are written when the connection closes).
async function logged(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...a) => { const l = a.join(" "); if (l.startsWith("[request]")) lines.push(l); else original(...a); };
  try {
    await fn();
    await sleep(60);
  } finally {
    console.log = original;
  }
  return lines;
}

test("a provider that failed to list is listed again soon and comes back", async () => {
  assert.match(catalogView().find((p) => p.provider === "flaky").error, /503/);
  const recovered = [];
  const stop = retryFailedDiscovery({ log: (l) => recovered.push(l) });
  try {
    await sleep(80); // first retry (50 ms) still fails
    assert.ok(catalogView().find((p) => p.provider === "flaky").error);
    modelsUp = true;
    const before = modelListings;
    await sleep(250); // the 100 ms delay repeats until it answers
    const flaky = catalogView().find((p) => p.provider === "flaky");
    assert.equal(flaky.error, undefined);
    assert.deepEqual(flaky.models, ["flaky-model"]);
    assert.ok(modelListings > before);
    assert.equal(recovered.length, 1);
    assert.match(recovered[0], /\[catalog\] flaky available again: 1 models/);
    const settled = modelListings;
    await sleep(250);
    assert.equal(modelListings, settled, "no more retries once every provider has answered");
  } finally {
    stop();
  }
});

test("retries only the providers that failed", async () => {
  modelsUp = false;
  await refreshCatalog(["flaky"]);
  const fixed = catalogView().find((p) => p.provider === "fixed");
  assert.equal(fixed.error, undefined);
  assert.deepEqual(fixed.models, ["good", "busy", "slow"]);
  modelsUp = true;
  await refreshCatalog(["flaky"]);
});

test("each model request logs one line with status, duration and route, never the prompt", async () => {
  const lines = await logged(async () => {
    assert.equal((await ask("fixed::good")).status, 200);
    assert.equal((await ask("fixed::busy")).status, 503);
    assert.equal((await ask("fixed::slow")).status, 504);
  });
  assert.equal(lines.length, 3);
  const [ok, exhausted, timeout] = lines;
  assert.match(ok, /^\[request\] openai 200 ok \d+ms read=\d+ms mode=auto asked=fixed::good stream=0 via=fixed::good tier=free attempts=1 skipped=0$/);
  assert.match(exhausted, /^\[request\] openai 503 exhausted .* via=- .* attempts=1 /);
  assert.match(timeout, /^\[request\] openai 504 timeout (\d+)ms .* attempts=1 /);
  assert.ok(Number(timeout.match(/ (\d+)ms /)[1]) >= 140);
  for (const l of lines) assert.ok(!l.includes(SECRET_PROMPT) && !l.includes(KEY));
});

test("a malformed request is logged as rejected, and a stopped retry never runs again", async () => {
  const lines = await logged(async () => {
    const r = await fetch(`${gateway}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: "{not json" });
    assert.equal(r.status, 400);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[request\] openai 400 rejected \d+ms read=-ms /);

  modelsUp = false;
  await refreshCatalog(["flaky"]);
  const stop = retryFailedDiscovery({ delays: [0.05], log: () => {} });
  stop();
  const before = modelListings;
  await sleep(200);
  assert.equal(modelListings, before);
  modelsUp = true;
  await refreshCatalog(["flaky"]);
});

test("a client that gives up is logged as client-closed", async () => {
  const lines = await logged(async () => {
    const c = new AbortController();
    const pending = fetch(`${gateway}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ model: "fixed::slow", messages: [] }),
      signal: c.signal,
    }).catch(() => {});
    await sleep(40);
    c.abort();
    await pending;
    await sleep(150);
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[request\] openai - client-closed \d+ms /);
});
