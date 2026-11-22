# free-llm-gateway

**[Bahasa Indonesia](#bahasa-indonesia)** · **[English](#english)**

## Bahasa Indonesia

Satu endpoint dan satu key di depan **free tier resmi** Groq, Google Gemini, OpenRouter, NVIDIA, Cloudflare Workers AI,
Cerebras, dan Mistral. Gateway otomatis pindah ke model berikutnya saat sebuah model kena rate limit, down, atau
kuota hariannya habis. Bicara format **OpenAI** (Chatbox, Open WebUI, Cursor, Cline, SDK OpenAI) dan **Anthropic**,
jadi **Claude Code bisa jalan di model gratis**.

- Tanpa dependency, tanpa build: Node.js 22 dan ~1.100 baris kode.
- Hanya endpoint resmi tiap provider, dengan API key milikmu sendiri. Tidak ada scraping, akun bersama, atau proxy
  pihak ketiga.
- Dashboard `/status`: sisa kuota gratis hari ini (request dan perkiraan token), provider, cooldown, dan pemakaian per
  model.

Terinspirasi dari [freellmapi](https://github.com/tashfeenahmed/freellmapi) (MIT), dalam versi yang jauh lebih kecil.

```
Claude Code / aplikasi / chat UI ──> free-llm-gateway (1 key) ──> Gemini ─┐
                                                                  Groq ───┤ bergiliran, pindah otomatis
                                                                  OpenRouter :free, NVIDIA, Cloudflare, …
```

### Mulai cepat

```bash
git clone https://github.com/bakhtiarrifai/free-llm-gateway && cd free-llm-gateway
cp .env.example .env && chmod 600 .env
# isi GATEWAY_KEY (openssl rand -hex 24) dan minimal satu API key provider, lihat tabel di bawah
npm start                     # http://127.0.0.1:8787
```

Tidak perlu `npm install`, karena tidak ada dependency. `.env` sudah ada di `.gitignore`, jadi tidak akan ikut ter-commit.

### Claude Code di model gratis

```bash
npm link                      # sekali saja: memasang perintah fgw
mkdir -p ~/.config/free-llm-gateway
printf 'FREE_GATEWAY_URL=http://127.0.0.1:8787\nFREE_GATEWAY_KEY=<GATEWAY_KEY>\n' > ~/.config/free-llm-gateway/client.env

fgw claude                    # Claude Code di model gratis; pakai login Claude-mu sendiri kalau tidak ada yang siap
fgw claude --model gemini::models/gemini-3.1-pro-preview   # satu model tertentu
fgw claude --sub              # langsung login Claude-mu, tidak lewat gateway
fgw status                    # model yang siap dan sisa kuota hari ini
fgw env                       # variabel untuk dipakai di shell sendiri
```

Lewat `fgw`, Claude Code menampilkan **`free-gateway`** sebagai nama model, bukan model Claude dari setting-mu
(yang akan terlihat seperti ditagih per token). Gateway membaca nama itu sebagai rantai model gratis.

Tanpa `fgw`, cukup set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, `ANTHROPIC_AUTH_TOKEN=<GATEWAY_KEY>`, dan
(opsional) `ANTHROPIC_MODEL=free-gateway`, lalu jalankan `claude`.

**Jujur soal kualitas:** model gratis terbaik untuk Claude Code saat ini adalah Gemini 3.x Pro dan Flash. Model ini
cukup untuk tugas ringan sampai menengah, tapi jelas di bawah Claude untuk pekerjaan besar. Groq free tier hanya 8.000
token per menit, terlalu kecil untuk prompt Claude Code (sekitar 30 ribu token): Groq menolaknya dan gateway langsung
pindah ke model berikutnya.
Untuk chat, Groq sangat cepat.

### Klien OpenAI

```
Base URL : http://127.0.0.1:8787/v1
API key  : <GATEWAY_KEY>
Model    : auto   (atau provider::model, daftar lengkap di GET /v1/models)
```

### Endpoint

| | |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming, tool, gambar) |
| `POST /v1/messages` | Anthropic Messages (Claude Code, SDK Anthropic), diterjemahkan ke OpenAI dan kembali |
| `POST /v1/messages/count_tokens` | perkiraan (~4 karakter per token) |
| `GET /v1/models` | `auto` dan semua model sebagai `provider::model` |
| `GET /health` | jumlah model siap dan ringkasan kuota (dipakai `fgw`) |
| `GET /status`, `/status.json` | dashboard (`?key=<GATEWAY_KEY>`) |
| `POST /gateway/refresh` | muat ulang daftar model semua provider |

Key diterima sebagai `Authorization: Bearer`, `x-api-key`, atau `?key=`.

### Cara mendapatkan API key (gratis)

Isi key yang kamu punya ke `.env`, lalu restart gateway. Provider tanpa key dilewati otomatis. Tampilan situs tiap
provider bisa berubah; kalau menunya tidak ketemu, cari tulisan "API Keys".

| Provider | Variabel `.env` | Langkah |
|---|---|---|
| **Google Gemini** | `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → login Google → **Create API key** → salin (`AIza…`). Catatan: data di free tier bisa dipakai Google untuk meningkatkan produknya. |
| **Groq** | `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) → login → **Create API Key** → salin (`gsk_…`, hanya tampil sekali). |
| **OpenRouter** | `OPENROUTER_API_KEY` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) → login → **Create Key**. Hanya model berakhiran `:free` yang dipakai (50 request per hari; naik jauh setelah sekali top-up kecil). |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | [build.nvidia.com](https://build.nvidia.com) → login → buka satu model → **Get API Key** → **Generate Key** → salin (`nvapi-…`). |
| **Cloudflare Workers AI** | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | [dash.cloudflare.com](https://dash.cloudflare.com) → **AI → Workers AI** → **Use REST API** → **Create a Workers AI API Token**. Account ID ada di halaman yang sama. Gratis 10.000 neuron per hari; hanya untuk chat tanpa tool. |
| **Cerebras** | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) → daftar → **API Keys** → **Generate API Key** (`csk-…`). |
| **Mistral** (opsional) | `MISTRAL_API_KEY` | Sejak akhir 2026 Mistral tampaknya menghapus API gratis. Kalau [console.mistral.ai](https://console.mistral.ai) meminta upgrade, lewati saja. |

Simpan key hanya di `.env` (izin `600`). Jangan tempel di chat, screenshot, atau commit ke Git.

### Kuota dan dashboard

Buka `http://127.0.0.1:8787/status?key=<GATEWAY_KEY>`.
- **Sisa / batas request hari ini** per provider dan totalnya. Sumbernya header `x-ratelimit-*` (Groq) dan
  `GET /api/v1/key` (OpenRouter). Gemini, NVIDIA, dan Cloudflare tidak melaporkan kuota; batasnya tercatat saat mereka
  pertama kali menjawab 429 kuota harian.
- **Token tersisa adalah perkiraan.** Free tier membatasi request per hari, bukan token, jadi angkanya dihitung dari
  sisa request × rata-rata token per request hari ini.
- Kuota diperbarui tiap 5 menit.

### Cara kerja fallback
- Model diurutkan bergiliran antar-provider (model terbaik tiap provider dulu), maksimal 10 percobaan per request.
- Respons streaming baru dikirim ke klien setelah upstream mengirim data pertama. Kalau upstream gagal sebelum itu,
  gateway pindah ke model berikutnya tanpa klien tahu.
- Cooldown otomatis: 429 → sesuai `retry-after` (atau 60 dtk; kuota harian → 10 menit per provider), 5xx → 30 dtk,
  key ditolak → 1 jam, model tidak ada → 6 jam. Status 403 hanya mengistirahatkan model itu, bukan seluruh provider.
- Model yang diminta dengan nama (`groq::…`) tidak pernah diganti model lain: kalau tidak tersedia, gateway menjawab
  503. Nama model Claude dari Claude Code (`claude-…`) berarti "model gratis terbaik yang ada".
- Header respons `x-gateway-provider`, `x-gateway-model`, dan `x-gateway-attempts` memberi tahu siapa yang menjawab.
- Hal khusus yang sudah ditangani: thought signature Gemini 3 diingat per tool call, batas output per provider
  (Claude Code meminta 128 ribu token), dan provider tanpa dukungan tool (`tools: false`) dilewati untuk request
  bertool.

### Pengaturan

Urutan provider, model pilihan (`prefer`), cooldown, dan batas output bisa ditimpa lewat
`~/.config/free-llm-gateway/config.json` (field demi field; lihat `src/config.js`). Untuk dipakai dari jaringan, set
`GATEWAY_HOST=0.0.0.0` dan pasang di belakang HTTPS (misalnya Cloudflare Tunnel). Kalau dashboard dilindungi
Cloudflare Access, set `TRUST_CF_ACCESS=1` agar pengguna yang sudah login bisa membukanya tanpa `?key=`.

Provider yang gagal dicek saat start (misalnya jaringan belum siap setelah boot) dicoba lagi setelah 30 detik sampai
tiap 10 menit (`discoveryRetrySeconds`), tidak menunggu 6 jam. Kalau dijalankan sebagai service systemd user, drop-in
`deploy/systemd/free-llm-gateway.service.d/wait-for-network.conf` membuatnya menunggu DNS dulu.

Setiap request model menulis satu baris `[request]` ke log: status, hasil (`ok`, `timeout`, `exhausted`,
`stream-error`, `rejected`, `client-closed`), durasi, waktu baca body, provider, dan model. Isi prompt dan key tidak
dicatat. Matikan dengan `"requestLog": false`.

### Tes

```bash
npm test     # 31 tes end-to-end dengan upstream palsu
```

Lisensi MIT.

---

## English

One endpoint and one key in front of the **official free tiers** of Groq, Google Gemini, OpenRouter, NVIDIA,
Cloudflare Workers AI, Cerebras and Mistral. The gateway moves to the next model when one is rate limited, down or out
of daily quota. It speaks **OpenAI** (Chatbox, Open WebUI, Cursor, Cline, OpenAI SDKs) and **Anthropic**, so **Claude
Code runs on free models**.

- No dependencies, no build: Node.js 22 and ~1,100 lines of code.
- Official endpoints only, with your own API keys. No scraping, shared accounts or third-party proxies.
- A `/status` dashboard: free quota left today (requests and estimated tokens), providers, cooldowns and usage per
  model.

Inspired by [freellmapi](https://github.com/tashfeenahmed/freellmapi) (MIT), in a much smaller form.

```
Claude Code / apps / chat UI ──> free-llm-gateway (1 key) ──> Gemini ─┐
                                                              Groq ───┤ round-robin, automatic fallback
                                                              OpenRouter :free, NVIDIA, Cloudflare, …
```

### Quick start

```bash
git clone https://github.com/bakhtiarrifai/free-llm-gateway && cd free-llm-gateway
cp .env.example .env && chmod 600 .env
# fill GATEWAY_KEY (openssl rand -hex 24) and at least one provider key, see the table below
npm start                     # http://127.0.0.1:8787
```

No `npm install` needed, since there are no dependencies. `.env` is in `.gitignore`, so it is never committed.

### Claude Code on free models

```bash
npm link                      # once: installs the fgw command
mkdir -p ~/.config/free-llm-gateway
printf 'FREE_GATEWAY_URL=http://127.0.0.1:8787\nFREE_GATEWAY_KEY=<GATEWAY_KEY>\n' > ~/.config/free-llm-gateway/client.env

fgw claude                    # Claude Code on free models; your own Claude login if none are ready
fgw claude --model gemini::models/gemini-3.1-pro-preview   # one specific model
fgw claude --sub              # straight to your own Claude login, not through the gateway
fgw status                    # models ready and quota left today
fgw env                       # the variables to use in your own shell
```

Through `fgw`, Claude Code shows **`free-gateway`** as the model, not the Claude model from your settings (which would
look billed per token). The gateway reads that name as the free chain.

Without `fgw`, set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, `ANTHROPIC_AUTH_TOKEN=<GATEWAY_KEY>` and (optionally)
`ANTHROPIC_MODEL=free-gateway`, and run `claude`.

**Honest note on quality:** the best free models for Claude Code right now are Gemini 3.x Pro and Flash. They are fine
for small to medium tasks but clearly below Claude for big work. Groq's free tier allows only 8,000 tokens per minute,
too small for Claude Code's prompt (~30k tokens): Groq refuses it and the gateway moves straight to the next model. For chat, Groq is very fast.

### OpenAI clients

```
Base URL : http://127.0.0.1:8787/v1
API key  : <GATEWAY_KEY>
Model    : auto   (or provider::model, full list at GET /v1/models)
```

### Endpoints

| | |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming, tools, images) |
| `POST /v1/messages` | Anthropic Messages (Claude Code, Anthropic SDKs), translated to OpenAI and back |
| `POST /v1/messages/count_tokens` | an estimate (~4 characters per token) |
| `GET /v1/models` | `auto` and every model as `provider::model` |
| `GET /health` | models ready and a quota summary (used by `fgw`) |
| `GET /status`, `/status.json` | dashboard (`?key=<GATEWAY_KEY>`) |
| `POST /gateway/refresh` | reload every provider's model list |

The key is accepted as `Authorization: Bearer`, `x-api-key` or `?key=`.

### Getting the API keys (free)

Put the keys you have in `.env` and restart the gateway. Providers without a key are skipped. Each provider's site can
change; if a menu is not where described, look for "API Keys".

| Provider | `.env` variable | Steps |
|---|---|---|
| **Google Gemini** | `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → sign in with Google → **Create API key** → copy (`AIza…`). Note: on the free tier Google may use the data to improve its products. |
| **Groq** | `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) → sign in → **Create API Key** → copy (`gsk_…`, shown once). |
| **OpenRouter** | `OPENROUTER_API_KEY` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) → sign in → **Create Key**. Only models ending in `:free` are used (50 requests a day; much higher after a one-time small top-up). |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | [build.nvidia.com](https://build.nvidia.com) → sign in → open any model → **Get API Key** → **Generate Key** → copy (`nvapi-…`). |
| **Cloudflare Workers AI** | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | [dash.cloudflare.com](https://dash.cloudflare.com) → **AI → Workers AI** → **Use REST API** → **Create a Workers AI API Token**. The account ID is on the same page. Free: 10,000 neurons a day; chat without tools only. |
| **Cerebras** | `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) → sign up → **API Keys** → **Generate API Key** (`csk-…`). |
| **Mistral** (optional) | `MISTRAL_API_KEY` | Since late 2026 Mistral appears to have dropped its free API. If [console.mistral.ai](https://console.mistral.ai) asks you to upgrade, skip it. |

Keep the keys only in `.env` (mode `600`). Never paste them into a chat, a screenshot or a Git commit.

### Quota and dashboard

Open `http://127.0.0.1:8787/status?key=<GATEWAY_KEY>`.
- **Requests left / limit today** per provider and in total. Sources: `x-ratelimit-*` headers (Groq) and
  `GET /api/v1/key` (OpenRouter). Gemini, NVIDIA and Cloudflare don't report their quota; their limit is recorded when
  they first answer a daily-quota 429.
- **Tokens left is an estimate.** Free tiers limit requests per day, not tokens, so it is requests left × today's
  average tokens per request.
- Quotas refresh every 5 minutes.

### How fallback works
- Models are ordered round-robin across providers (each provider's best model first), at most 10 attempts per request.
- A streamed response is only sent to the client once the upstream has produced its first data. If the upstream fails
  before that, the gateway moves to the next model without the client noticing.
- Automatic cooldowns: 429 → `retry-after` (or 60 s; daily quota → 10 minutes for the provider), 5xx → 30 s, key
  rejected → 1 hour, model not found → 6 hours. A 403 cools only that model, not the whole provider.
- A model asked for by name (`groq::…`) is never swapped for another: if it is not offered, the gateway answers 503.
  A Claude model name from Claude Code (`claude-…`) means "the best free model available".
- Response headers `x-gateway-provider`, `x-gateway-model` and `x-gateway-attempts` say who answered.
- Handled quirks: Gemini 3 thought signatures are remembered per tool call, output caps per provider (Claude Code asks
  for 128k tokens), and providers without tool support (`tools: false`) are skipped for requests with tools.

### Settings

Provider order, preferred models (`prefer`), cooldowns and output caps can be overridden in
`~/.config/free-llm-gateway/config.json` (field by field; see `src/config.js`). To use it over the network, set
`GATEWAY_HOST=0.0.0.0` and put it behind HTTPS (for example a Cloudflare Tunnel). If the dashboard sits behind
Cloudflare Access, set `TRUST_CF_ACCESS=1` so logged-in users can open it without `?key=`.

Providers that fail to list at start (for example when the network is not up yet after a boot) are tried again after
30 s up to every 10 minutes (`discoveryRetrySeconds`), not after 6 hours. When it runs as a systemd user service, the
drop-in `deploy/systemd/free-llm-gateway.service.d/wait-for-network.conf` makes it wait for DNS first.

Each model request writes one `[request]` line to the log: status, outcome (`ok`, `timeout`, `exhausted`,
`stream-error`, `rejected`, `client-closed`), duration, body read time, provider and model. Prompts and keys are never
logged. Turn it off with `"requestLog": false`.

### Tests

```bash
npm test     # 31 end-to-end tests against fake upstreams
```

MIT license.
