#!/usr/bin/env node
// Syntax-checks every source file without running it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
for (const dir of ["src", "src/convert", "bin"]) for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith(".js"))) execFileSync(process.execPath, ["--check", join(root, dir, f)], { stdio: "inherit" });
console.log("ok");
