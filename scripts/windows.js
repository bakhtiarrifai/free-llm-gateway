#!/usr/bin/env node
// Helpers behind the double-click .bat files for Windows users (Install-Windows.bat, windows\*.bat).
//
//   node scripts/windows.js setup [--autostart]  create the .env (with a fresh GATEWAY_KEY) and client.env, add shortcuts,
//                                                and put windows\bin (the fgw command) on the user PATH
//   node scripts/windows.js uninstall            remove the shortcuts and the PATH entry (the .env with your API keys stays)
//   node scripts/windows.js running              exit 0 when a gateway already answers on the configured port
//   node scripts/windows.js keys                 exit 0 when at least one provider API key is filled in
//   node scripts/windows.js edit                 open the .env in Notepad
//   node scripts/windows.js dashboard            open the /status page in the browser
//
// API keys live only in %USERPROFILE%\.config\free-llm-gateway\.env, outside the downloaded folder, so a new download
// of the repo keeps them.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, parseEnv } from "../src/config.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_FILE = process.env.GATEWAY_ENV ?? join(HOME, ".env");
const CLIENT_FILE = join(HOME, "client.env");
const PROVIDER_KEYS = ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "NVIDIA_API_KEY", "CLOUDFLARE_AI_TOKEN", "CEREBRAS_API_KEY", "MISTRAL_API_KEY"];
const SHORTCUTS = [
  { name: "Free LLM Gateway - Start", bat: "start-gateway.bat", icon: "%SystemRoot%\\System32\\shell32.dll,137" },
  { name: "Free LLM Gateway - Isi API Key", bat: "edit-keys.bat", icon: "%SystemRoot%\\System32\\notepad.exe,0" },
  { name: "Free LLM Gateway - Dashboard", bat: "open-dashboard.bat", icon: "%SystemRoot%\\System32\\shell32.dll,13" },
  { name: "Claude Code Gratis", bat: "claude-gratis.bat", icon: "%SystemRoot%\\System32\\shell32.dll,24" },
];
const AUTOSTART = "Free LLM Gateway";
const BIN_DIR = join(ROOT, "windows", "bin");
// The windows\bin folder last put on PATH, so a reinstall from another folder drops the old entry.
const PATH_NOTE = join(HOME, "fgw-path.txt");

const readEnv = () => (existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {});
const port = () => Number(process.env.GATEWAY_PORT ?? readEnv().GATEWAY_PORT ?? 8787) || 8787;
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");

const HEADER = `# ============================================================================
# FREE LLM GATEWAY - tempat API key kamu (file ini TIDAK ikut ke GitHub)
#
# 1. Isi minimal SATU API key di bawah, tepat setelah tanda "=" tanpa spasi.
#    Contoh:  GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxx
#    Cara mendapatkan key gratis: lihat README, bagian "Cara mendapatkan API key".
#    Paling mudah: Google Gemini -> https://aistudio.google.com/apikey
# 2. Simpan (Ctrl+S), tutup Notepad.
# 3. Jalankan ulang "Free LLM Gateway - Start" di Desktop.
#
# GATEWAY_KEY sudah dibuat otomatis. Jangan dibagikan ke orang lain.
# Jangan kirim isi file ini lewat chat atau screenshot.
# ============================================================================

`;

function setup(autostart) {
  mkdirSync(HOME, { recursive: true });
  const key = randomBytes(24).toString("hex");
  if (!existsSync(ENV_FILE)) {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8").replace(/^# Copy to .*\n/, "").replace(/\s+openssl rand -hex 24/, "");
    writeFileSync(ENV_FILE, crlf(HEADER + example.replace(/^GATEWAY_KEY=.*$/m, `GATEWAY_KEY=${key}`)));
    console.log(`  dibuat   ${ENV_FILE}`);
  } else if ((readEnv().GATEWAY_KEY ?? "").length < 16) {
    // An older .env without a usable GATEWAY_KEY: fill it in, keep everything else (the API keys) as it is.
    const text = readFileSync(ENV_FILE, "utf8");
    const next = /^\s*GATEWAY_KEY\s*=.*$/m.test(text) ? text.replace(/^\s*GATEWAY_KEY\s*=.*$/m, `GATEWAY_KEY=${key}`) : `GATEWAY_KEY=${key}\r\n${text}`;
    writeFileSync(ENV_FILE, next);
    console.log(`  GATEWAY_KEY diisi di ${ENV_FILE}`);
  } else {
    console.log(`  sudah ada ${ENV_FILE} (API key kamu tidak diubah)`);
  }
  const env = readEnv();
  writeFileSync(CLIENT_FILE, crlf(`FREE_GATEWAY_URL=http://127.0.0.1:${port()}\nFREE_GATEWAY_KEY=${env.GATEWAY_KEY}\n`));
  console.log(`  dibuat   ${CLIENT_FILE}`);
  shortcuts(autostart);
  userPath(BIN_DIR);
}

// Edits the user PATH in the registry as stored (REG_EXPAND_SZ, %VARS% kept), then lets Windows know so new
// terminals see it. Removes the previous fgw folder; adds `add` unless it is null.
function userPath(add) {
  const old = existsSync(PATH_NOTE) ? readFileSync(PATH_NOTE, "utf8").trim() : "";
  const ps = `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$cur = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$parts = @($cur -split ';' | Where-Object { $_ -and $_ -ne $env:FGW_OLD -and $_ -ne $env:FGW_ADD })
if ($env:FGW_ADD) { $parts += $env:FGW_ADD }
$next = $parts -join ';'
if ($next -ne $cur) {
  $key.SetValue('Path', $next, 'ExpandString')
  [Environment]::SetEnvironmentVariable('FGW_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('FGW_PATH_REFRESH', $null, 'User')
}
$key.Close()`;
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "inherit",
    env: { ...process.env, FGW_ADD: add ?? "", FGW_OLD: old },
  });
  if (add) {
    writeFileSync(PATH_NOTE, add);
    console.log(`  perintah fgw: ${join(add, "fgw.cmd")} (buka PowerShell/CMD baru, lalu: fgw claude)`);
  } else if (old) {
    writeFileSync(PATH_NOTE, "");
    console.log(`  perintah fgw dihapus dari PATH`);
  }
}

// Shortcuts through WScript.Shell. The list goes in an environment variable, so paths with spaces or quotes need no
// escaping inside the PowerShell command.
function shortcuts(autostart, remove = false) {
  const items = SHORTCUTS.map((s) => ({ folder: "Desktop", name: s.name, target: join(ROOT, "windows", s.bat), icon: s.icon, style: 1 }));
  if (autostart || remove) items.push({ folder: "Startup", name: AUTOSTART, target: join(ROOT, "windows", "start-gateway.bat"), icon: SHORTCUTS[0].icon, style: 7 });
  const ps = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
foreach ($s in (ConvertFrom-Json $env:FGW_SHORTCUTS)) {
  $path = Join-Path ([Environment]::GetFolderPath($s.folder)) ($s.name + '.lnk')
  if ($env:FGW_REMOVE -eq '1') { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path; Write-Output ('  dihapus  ' + $path) }; continue }
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $s.target
  $lnk.WorkingDirectory = Split-Path $s.target
  $lnk.IconLocation = [Environment]::ExpandEnvironmentVariables($s.icon)
  $lnk.WindowStyle = $s.style
  $lnk.Save()
  Write-Output ('  shortcut ' + $path)
}`;
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "inherit",
    env: { ...process.env, FGW_SHORTCUTS: JSON.stringify(items), FGW_REMOVE: remove ? "1" : "0" },
  });
}

async function running() {
  try {
    const res = await fetch(`http://127.0.0.1:${port()}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

const open = (target) => spawn("cmd.exe", ["/c", "start", '""', target], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "setup":
    setup(args.includes("--autostart"));
    break;
  case "uninstall":
    shortcuts(false, true);
    userPath(null);
    console.log(`  API key kamu tetap tersimpan di ${ENV_FILE}`);
    break;
  case "running":
    process.exit((await running()) ? 0 : 1);
    break;
  case "keys":
    process.exit(PROVIDER_KEYS.some((k) => (readEnv()[k] ?? "").trim()) ? 0 : 1);
    break;
  case "edit":
    if (!existsSync(ENV_FILE)) setup(false);
    spawn("notepad.exe", [ENV_FILE], { detached: true, stdio: "ignore" }).unref();
    break;
  case "dashboard":
    open(`http://127.0.0.1:${port()}/status?key=${encodeURIComponent(readEnv().GATEWAY_KEY ?? "")}`);
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(cmd ? 2 : 0);
}
