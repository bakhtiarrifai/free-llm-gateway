// The dashboard: one self-contained page rendered from the same data as /status.json.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (x) => (x === null || x === undefined ? "–" : Number(x).toLocaleString("en-US"));
const big = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : n(x));
const bar = (left, max) => {
  if (!max) return "";
  const pct = Math.max(0, Math.min(100, Math.round((left / max) * 100)));
  return `<div class="bar" title="${pct}%"><span style="width:${pct}%"></span></div>`;
};

export function statusPage(s) {
  const q = s.quota ?? { rows: [], totals: {} };
  const t = q.totals ?? {};
  const quotaRows = q.rows
    .map((r) => `<tr><td>${esc(r.provider)}</td><td>${n(r.requestsToday)}</td><td>${big(r.tokensToday)}</td>
      <td>${r.dailyLimit === null ? "–" : `${n(r.remaining)} / ${n(r.dailyLimit)}${bar(r.remaining, r.dailyLimit)}`}</td>
      <td class="small">${esc(r.source)}${r.tokensPerMinute ? ` · ${n(r.tokensPerMinute.limit)} tokens/min` : ""}</td></tr>`)
    .join("");
  const rows = Object.entries(s.today)
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([k, r]) => `<tr><td>${esc(k)}</td><td>${r.requests}</td><td>${r.errors}</td><td>${big(r.input)}</td><td>${big(r.output)}</td><td>${r.requests ? Math.round(r.ms / r.requests) : 0} ms</td></tr>`)
    .join("");
  const providers = s.providers
    .map((p) => `<tr><td>${esc(p.provider)}</td><td>${p.error ? `<span class="bad">${esc(p.error)}</span>` : `${p.models.length} models`}</td><td class="small">${esc(p.models.slice(0, 6).join(", "))}${p.models.length > 6 ? " …" : ""}</td></tr>`)
    .join("");
  const cool = s.cooldowns.map((c) => `<li>${esc(c.key)}: ${c.seconds} s (${esc(c.reason)})</li>`).join("") || "<li>none</li>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Free LLM Gateway</title><style>
:root{--bg:#f7f7f5;--fg:#1b1b1b;--muted:#6b6b6b;--line:#e2e2de;--card:#fff;--acc:#2f6f4f;--bad:#b3261e;--track:#ececea}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#9a9a9a;--line:#2a2a2a;--card:#1c1c1c;--acc:#6fcf97;--bad:#f28b82;--track:#2a2a2a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}.small{font-size:12px;color:var(--muted);white-space:normal}
.bad{color:var(--bad)}.kpi{display:flex;gap:32px;flex-wrap:wrap}.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}
.bar{height:6px;background:var(--track);border-radius:3px;margin-top:4px;min-width:90px}.bar span{display:block;height:100%;background:var(--acc);border-radius:3px}
td{font-variant-numeric:tabular-nums}.cmd td{white-space:normal}.cmd td:first-child{white-space:nowrap}code{font:13px ui-monospace,monospace;background:var(--track);padding:1px 5px;border-radius:4px}
</style></head><body><main>
<h1>Free LLM Gateway</h1><div class="small">Official free tiers only · updated ${new Date(q.at ?? Date.now()).toLocaleTimeString("en-GB")}</div>

<h2>Free quota today</h2>
<div class="card kpi">
  <div><b>${t.requestsLimit ? `${n(t.requestsRemaining)} / ${n(t.requestsLimit)}` : "–"}</b>free requests left${t.providersCounted?.length ? ` (${esc(t.providersCounted.join(", "))})` : ""}${bar(t.requestsRemaining, t.requestsLimit)}</div>
  <div><b>≈ ${big(t.tokensRemainingEstimate ?? 0)} / ${big(t.tokensLimitEstimate ?? 0)}</b>free tokens left (estimate)</div>
  <div><b>${big(t.tokensToday ?? 0)}</b>tokens used today</div>
</div>
<div class="card" style="margin-top:10px"><table><tr><th>Provider</th><th>Requests today</th><th>Tokens today</th><th>Left / daily limit</th><th>Source</th></tr>${quotaRows}</table>
<p class="small">Free tiers limit <b>requests per day</b>, not tokens. Tokens left = requests left × today's average of ${n(t.avgTokensPerRequest)} tokens per request. Gemini, NVIDIA and Cloudflare don't report their quota; their limit is recorded when they first answer a daily-quota 429.</p></div>

<h2>Commands</h2>
<div class="card"><table class="cmd">
<tr><th>Command</th><th>What it does</th></tr>
<tr><td><code>fgw claude</code></td><td>Claude Code on the free models; your own Claude login if none are ready</td></tr>
<tr><td><code>fgw claude --model gemini::models/gemini-3.1-pro-preview</code></td><td>one specific model (never swapped for another)</td></tr>
<tr><td><code>fgw claude --sub</code></td><td>Claude Code on your own Claude login, not through the gateway</td></tr>
<tr><td><code>fgw status</code></td><td>free models ready and today's quota</td></tr>
<tr><td><code>fgw env</code></td><td>the variables to point any tool at the gateway</td></tr>
</table>
<p class="small">OpenAI clients: base URL <code>&lt;gateway&gt;/v1</code>, the gateway key as API key, model <code>auto</code> or <code>provider::model</code> (list: <code>GET /v1/models</code>).</p></div>

<h2>Providers</h2><div class="card"><table><tr><th>Provider</th><th>Status</th><th>Models</th></tr>${providers}</table></div>
<h2>Cooling down</h2><div class="card"><ul>${cool}</ul></div>
<h2>Usage today per model</h2><div class="card"><table><tr><th>Model</th><th>Requests</th><th>Errors</th><th>Input</th><th>Output</th><th>Average</th></tr>${rows || '<tr><td colspan="6">No requests yet</td></tr>'}</table></div>
</main></body></html>`;
}
