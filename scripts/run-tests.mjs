// Cross-platform test runner: expands test/*.test.mjs itself, because cmd.exe
// does not expand globs and `node --test <glob>` needs Node >= 21.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
