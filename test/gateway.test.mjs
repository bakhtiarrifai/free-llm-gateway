// End-to-end tests against fake upstreams: a fake OpenAI-compatible provider and a fake Anthropic API.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const KEY = "test-gateway-key-123456";
const servers = [];
const listen = (handler) =>
  new Promise((ok) => {
    const s = createServer(handler);
    servers.push(s);
    s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${s.address().port}`));
  });
const readJson = (req) => new Promise((ok) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => ok(b ? JSON.parse(b) : {}));
});
const sse = (res, records) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const r of records) res.write(r.event ? `event: ${r.event}\ndata: ${JSON.stringify(r.data)}\n\n` : `data: ${typeof r === "string" ? r : JSON.stringify(r)}\n\n`);
  res.end();
};

const seen = { openai: [] };
let gateway;

before(async () => {
  // Fake OpenAI-compatible provider: "busy" always 429s, "good" answers (with a tool call when tools are sent).
  const openaiBase = await listen(async (req, res) => {
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "pricey" }, { id: "busy" }, { id: "good" }] }));
    const body = await readJson(req);
    seen.openai.push(body);
    if (body.model === "busy") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      return res.end(JSON.stringify({ error: { message: "rate limit" } }));
    }
    const wantsTool = Boolean(body.tools?.length);
    if (!body.stream) {
      const message = wantsTool
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Palembang"}' } }] }
        : { role: "assistant", content: "hello from good" };
      res.writeHead(200, { "content-type": "application/json", "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "990", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "7000" });
      return res.end(JSON.stringify({ id: "x1", choices: [{ index: 0, message, finish_reason: wantsTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 11, completion_tokens: 5 } }));
    }
    const base = { id: "x2", object: "chat.completion.chunk", model: "good" };
    const chunks = wantsTool
      ? [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Checking. " } }] },
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"ci' }, extra_content: { google: { thought_signature: "sig123" } } }] } }] },
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Palembang"}' } }] } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, // Gemini says "stop" after tool calls
          { ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } },
        ]
      : [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] },
          { ...base, choices: [{ index: 0, delta: { content: "lo" } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
    sse(res, [...chunks, "[DONE]"]);
  });

  // OpenRouter-style: one model refuses this key with 403, the other model of the same provider works.
  const pickyBase = await listen(async (req, res) => {
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "harness-only" }, { id: "open" }] }));
    const body = await readJson(req);
    if (body.model === "harness-only") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "harness-only is only available on agentic harnesses" } }));
    }
    res.end(JSON.stringify({ id: "p1", choices: [{ index: 0, message: { role: "assistant", content: "open ok" }, finish_reason: "stop" }] }));
  });

  const placeholderBase = await listen((req, res) => {
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "ghost" }] }));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("OK\r\n");
  });

  const home = mkdtempSync(join(tmpdir(), "gw-test-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    autoTiers: ["free"],
    providers: [
      { id: "placeholder", key: "FAKE_KEY", base: `${placeholderBase}/v1`, discover: { match: "." } },
      { id: "fake", key: "FAKE_KEY", base: `${openaiBase}/v1`, discover: { match: "." }, prefer: ["busy", "good"], chainExclude: "^pricey$" },
      { id: "picky", key: "FAKE_KEY", base: `${pickyBase}/v1`, discover: { match: "." } },
      { id: "notools", key: "FAKE_KEY", base: `${placeholderBase}/v1`, models: ["open"], tools: false },
    ],
  }));
  Object.assign(process.env, { GATEWAY_HOME: home, GATEWAY_ENV: join(home, "none.env"), GATEWAY_KEY: KEY, FAKE_KEY: "k" });
  const { createGateway } = await import("../src/server.js");
  const { refreshCatalog } = await import("../src/providers.js");
  await refreshCatalog();
  const g = createGateway();
  servers.push(g);
  gateway = await new Promise((ok) => g.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${g.address().port}`)));
});

after(() => servers.forEach((s) => s.close()));

const post = (path, body, headers = {}) => fetch(gateway + path, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
async function events(res) {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const ev = block.match(/^event: (.*)$/m)?.[1];
    const data = block.match(/^data: (.*)$/m)?.[1];
    return { event: ev, data: data === "[DONE]" ? data : JSON.parse(data) };
  });
}

test("rejects a wrong key", async () => {
  const res = await fetch(`${gateway}/v1/models`, { headers: { authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
});

test("OpenAI chat falls over from a rate-limited model and cools it down", async () => {
  const res = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-model"), "good");
  assert.equal((await res.json()).choices[0].message.content, "hello from good");
  // the second request skips the cooling model entirely
  const before = seen.openai.filter((b) => b.model === "busy").length;
  await (await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "again" }] })).json();
  assert.equal(seen.openai.filter((b) => b.model === "busy").length, before);
});

test("a 200 that is not an API response (retired endpoint answering OK) falls over instead of failing", async () => {
  const res = await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-provider"), "fake");
  const s = await post("/v1/chat/completions", { model: "placeholder::ghost", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(s.status, 503);
  assert.match((await s.json()).error.message, /placeholder::ghost .*(502|not a stream)/); // cooling down after the first bad answer
});

test("a 403 on one model cools that model only, not the whole provider", async () => {
  const a = await post("/v1/chat/completions", { model: "picky::harness-only", messages: [{ role: "user", content: "hi" }] });
  assert.equal(a.status, 503);
  const b = await post("/v1/chat/completions", { model: "picky::open", messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.status, 200);
  assert.equal((await b.json()).choices[0].message.content, "open ok");
});

test("a provider marked tools:false is skipped for requests with tools", async () => {
  const res = await post("/v1/chat/completions", { model: "notools::open", tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }], messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /no tool support/);
  // without tools it is tried (this fake answers like a dead endpoint, so the reason is a 502, not "no tool support")
  const plain = await post("/v1/chat/completions", { model: "notools::open", messages: [{ role: "user", content: "hi" }] });
  assert.doesNotMatch((await plain.json()).error.message, /no tool support/);
});

test("OpenAI chat streams through unchanged and ends with [DONE]", async () => {
  const evs = await events(await post("/v1/chat/completions", { model: "free", stream: true, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(evs.map((e) => e.data?.choices?.[0]?.delta?.content ?? "").join(""), "hello");
  assert.equal(evs.at(-1).data, "[DONE]");
});

test("Anthropic client on an OpenAI provider: streamed tool call becomes tool_use blocks", async () => {
  const res = await post("/v1/messages", {
    model: "claude-sonnet-5-5", max_tokens: 64000, stream: true,
    system: [{ type: "text", text: "be brief" }],
    tools: [{ name: "get_weather", description: "weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
    messages: [{ role: "user", content: "weather in Palembang?" }],
  });
  assert.equal(res.status, 200);
  const evs = await events(res);
  const types = evs.map((e) => e.event);
  assert.deepEqual(types.slice(0, 2), ["message_start", "content_block_start"]);
  assert.equal(types.at(-1), "message_stop");
  const toolStart = evs.find((e) => e.data.content_block?.type === "tool_use");
  assert.equal(toolStart.data.content_block.name, "get_weather");
  const json = evs.filter((e) => e.data.delta?.type === "input_json_delta" && e.data.index === toolStart.data.index).map((e) => e.data.delta.partial_json).join("");
  assert.deepEqual(JSON.parse(json), { city: "Palembang" });
  assert.equal(evs.find((e) => e.event === "message_delta").data.delta.stop_reason, "tool_use");
  // the request was translated: system first, tools as functions, max_tokens kept
  const sent = seen.openai.at(-1);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.tools[0].function.name, "get_weather");
  assert.equal(sent.max_tokens, 32768); // 64000 asked, capped for OpenAI-compatible upstreams
});

test("Gemini thought signatures come back with the tool call on the next turn", async () => {
  await post("/v1/messages", {
    model: "auto", max_tokens: 100,
    tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Palembang" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "sunny" }] },
    ],
  });
  const sent = seen.openai.at(-1).messages.find((m) => m.tool_calls);
  assert.deepEqual(sent.tool_calls[0].extra_content, { google: { thought_signature: "sig123" } });
});

test("Anthropic client, whole response, tool result round trip is translated", async () => {
  const res = await post("/v1/messages", {
    model: "auto", max_tokens: 1000,
    tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "X" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "sunny" }, { type: "text", text: "and tomorrow?" }] },
    ],
  });
  const msg = await res.json();
  assert.equal(msg.type, "message");
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content[0].input, { city: "Palembang" });
  const sent = seen.openai.at(-1).messages;
  assert.equal(sent[1].tool_calls[0].id, "toolu_a");
  assert.equal(sent[2].role, "tool");
  assert.equal(sent[2].tool_call_id, "toolu_a");
  assert.equal(sent[3].content, "and tomorrow?");
});

test("exhausted pool answers 503 with what was tried", async () => {
  const res = await post("/v1/chat/completions", { model: "fake::busy", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("x-gateway-exhausted"), "1");
  assert.match((await res.json()).error.message, /busy/);
});

test("an explicit model that is not offered is refused, not swapped for another", async () => {
  const res = await post("/v1/chat/completions", { model: "free::no-such-model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /"no-such-model" is not offered/);
});

test("chainExclude keeps a model out of automatic chains but selectable by name", async () => {
  await post("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "x" }] });
  assert.equal(seen.openai.some((b) => b.model === "pricey"), false);
  const res = await post("/v1/chat/completions", { model: "fake::pricey", messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, 200);
  assert.equal(seen.openai.at(-1).model, "pricey");
});

test("free quota: rate-limit headers become remaining/limit with a token estimate", async () => {
  const st = await (await fetch(`${gateway}/status.json?key=${KEY}`)).json();
  const fake = st.quota.rows.find((r) => r.provider === "fake");
  // Every model has its own daily quota, so the provider's limit is the sum over the models it has answered with.
  const models = fake.dailyLimit / 1000;
  assert.ok(Number.isInteger(models) && models >= 1);
  assert.equal(fake.remaining, 990 * models);
  assert.equal(fake.tokensPerMinute.limit, 8000);
  assert.ok(st.quota.totals.requestsRemaining >= 990);
  assert.ok(st.quota.totals.tokensRemainingEstimate > 0);
  const html = await (await fetch(`${gateway}/status?key=${KEY}`)).text();
  assert.match(html, /Free quota today/);
  assert.match(html, /fgw claude --sub/);
});

test("providers keep their configured order whatever order their model lists arrive in", async () => {
  const { catalogEntries } = await import("../src/providers.js");
  assert.deepEqual(catalogEntries().map((e) => e.provider.id).filter((id) => ["placeholder", "fake", "picky", "notools"].includes(id)), ["placeholder", "fake", "picky", "notools"]);
});

test("the fgw label free-gateway means the whole free chain", async () => {
  const res = await post("/v1/messages", { model: "free-gateway", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-gateway-model"));
});

test("a request bigger than a model's tokens-per-minute limit skips it; small ones still use it", async () => {
  const big = "x".repeat(60_000); // ~12k tokens, over the fake's 8000 TPM header
  const res = await post("/v1/chat/completions", { model: "fake::good", messages: [{ role: "user", content: big }] });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /tokens-per-minute limit/);
  const small = await post("/v1/chat/completions", { model: "fake::good", messages: [{ role: "user", content: "hi" }] });
  assert.equal(small.status, 200);
});

test("models list and health", async () => {
  const models = await (await fetch(`${gateway}/v1/models`, { headers: { "x-api-key": KEY } })).json();
  assert.ok(models.data.some((m) => m.id === "fake::good"));
  const health = await (await fetch(`${gateway}/health`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  assert.equal(health.available.free >= 1, true);
});
