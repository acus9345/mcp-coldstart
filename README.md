# mcp-coldstart

**A CI regression gate for MCP stdio server startup.** Save a baseline from repeated cold starts (spawn → `initialize` → `tools/list`), then fail the build when p50/p95 startup time, memory, or tool-definition size grows past a threshold or a fixed budget.
MCP clients launch stdio servers on every session and give up after a timeout. A heavy new import or a slow auth check at startup does not break a single test, but users feel it on every launch.
What `mcp-coldstart` adds is the tracking over time: N cold starts per run, p50/p95 per phase, a saved JSON baseline, `--max-regression` with noise floors, `--budget`, `compare base.json head.json`, and CI exit codes. It also flags stdout noise and estimates tool-definition tokens, but other tools already do those (see below). Zero runtime dependencies, Node ≥ 18, MIT.

```text
$ npx mcp-coldstart --baseline baseline.json -- node dist/server.js
mcp-coldstart — demo-server 1.0.0 (protocol 2025-06-18)
command: node *** (arguments hidden; use --show-args to record them)
runs: 5 (+1 warmup) · tools: 3 · linux/x64 · Node v24.22.1

metric                                p50        p95        min        max
ready (spawn → tools listed)     327.1 ms   328.6 ms   326.9 ms   328.9 ms
initialize                       325.6 ms   327.1 ms   325.3 ms   327.5 ms
...
FAIL
  ✖ ready p50 regressed 26.5 ms → 327.1 ms (+1134.8%, limit 20%)
```

## How it differs from existing tools

Several tools already measure parts of this. Detecting stdout noise and counting tool-definition tokens are side features here, and the dedicated tools below do them more thoroughly. Token cost already has a baseline CI gate (toolism). As far as we found, the part that is new is gating **startup timing and memory**: repeated cold starts summarized as p50/p95, compared with a saved baseline using noise floors, plus budgets and `compare`, with an exit code for CI.

| Tool | What it does | Overlap / difference |
| --- | --- | --- |
| [mcpfix](https://www.npmjs.com/package/mcpfix) ([mcpdoctor](https://github.com/pratikacharya1234/mcpdoctor) repo) | Reads *your installed* Claude/Cursor/Cline configs, probes each server (`tools/list` × 3 samples), reports cold-start vs warm latency, name collisions, and estimated context-window usage; `--budget`, `--json`, exit codes | Already measures cold-start and `tools/list` latency. It is a one-shot health check of a user's setup, with no saved baseline, no percentile thresholds, and no regression comparison between runs |
| [mcp-stdio-guard](https://github.com/1Utkarsh1/mcp-stdio-guard) ([npm](https://www.npmjs.com/package/mcp-stdio-guard)) | Validates a stdio server: real handshake, fails on stdout pollution, invalid JSON-RPC frames, crashes, missing responses; static source scan; `--repeat` for cold/warm drift; JSON for CI | Much deeper stdout/protocol validation than our stdout-noise warning. It doesn't measure timing, memory or tokens against a baseline |
| [unclog](https://github.com/thomaschill/unclog) (PyPI) | Audits a Claude Code install: token cost of agents, skills and commands, 30-day invocation counts per MCP server, and helps delete unused ones | Context-bloat cleanup for users. It doesn't start servers, and it shows no per-MCP-server token count |
| [toolism](https://github.com/rakeshnitb23/toolism) (PyPI) | Measures tool/MCP schema token cost with real tokenizers, slims schemas while proving the same calls stay valid, and gates token growth in CI against a committed baseline (`check --max-increase`, GitHub Action) | Better choice for tokens: exact tokenizers, slimming, and a token baseline gate. Ours is a rough bytes ÷ 4 estimate. It doesn't measure startup time or memory |
| [MCPBench](https://github.com/David-Wu1119/MCPBench) | Report card for a server: schema quality, description safety, permission clarity, and `initialize` / `tools/list` p50/p95 latency scored into a grade | Measures startup latency with percentiles too, but as a score, not a baseline comparison or regression gate |
| [mcpskillhub-cli](https://github.com/mcp-skill-hub/mcpskillhub-cli) | Tests a third-party server in a sandbox VM before you install it (cold start, memory, network, injection patterns) | Pre-install vetting, not tracking your own server over time |
| [mcp-quality-gate](https://github.com/bhvbhushan/mcp-quality-gate) | Spec compliance and security score; performance benchmarking is on its roadmap | Broad quality score. Its timing is not a per-phase regression gate |
| [mcp-reticle](https://github.com/soth-ai/mcp-reticle), [mcp-session-profiler](https://github.com/henryli777/mcp-session-profiler) | Profile live JSON-RPC traffic and tool-call latency during real sessions | Runtime observability, not startup measurement in CI |

## Quick start

Try it on the demo server that ships with the package (no other installs needed):

```bash
npm install --save-dev mcp-coldstart

# 1. measure (5 runs + 1 warmup) and save a baseline
npx mcp-coldstart -o baseline.json -- node node_modules/mcp-coldstart/examples/demo-server.mjs

# 2. simulate a slower startup and compare: exits 1 with "ready p50 regressed"
npx mcp-coldstart --baseline baseline.json -- node node_modules/mcp-coldstart/examples/demo-server.mjs --startup-delay 300

# 3. absolute budgets work without a baseline
npx mcp-coldstart --budget ready=2000 --budget tokens=5000 -- node node_modules/mcp-coldstart/examples/demo-server.mjs
```

Against a real server:

```bash
npx mcp-coldstart -- npx -y @modelcontextprotocol/server-everything
```

Everything after `--` is the command that starts your server over stdio, exactly as you would put it in an MCP client config. It is launched **without a shell**: on macOS and Linux each argument reaches the server verbatim, and characters like `&`, `|`, `>`, `%` or `$( )` are never interpreted. On Windows, the command is resolved through `PATH`/`PATHEXT` (only `.com`, `.exe`, `.bat` and `.cmd`; `.js`/`.vbs` script-host files are never run), and a command that cannot be found is reported as `command not found` (exit 2). `.exe` files are started directly, with arguments passed verbatim. `.cmd`/`.bat` shims such as `npx.cmd` have to run through `cmd.exe`, which is required since Node 18.20.2/20.12.2 (CVE-2024-27980): spawning a `.cmd` without a shell fails with `EINVAL`. mcp-coldstart runs them as `cmd.exe /d /s /v:off /c "…"` (`%ComSpec%` if it is an absolute path, otherwise `%SystemRoot%\System32\cmd.exe`, never a `PATH`/current-directory lookup) (no AutoRun, no delayed `!VAR!` expansion) and escapes every argument for cmd.exe, so `&`, `|`, `>`, `%VAR%`, `%VAR:a=b%`, `%VAR:~0,3%` and `!VAR!` arrive literally. Batch files that forward `%*` (npm/npx/pnpm/yarn shims, anything in `node_modules\.bin`, or any `.cmd`/`.bat` whose text contains `%*`) are parsed by cmd twice, so their arguments are escaped twice; see Limitations for batch files that read `%1`/`%~1` instead.

## What it measures

Each run spawns the server fresh and talks MCP to it over stdio with its own built-in JSON-RPC client. It does not use the MCP SDK.

| Metric | Meaning |
| --- | --- |
| `ready` | spawn → last `tools/list` page received: how long a client waits before the server is usable |
| `init` | spawn → `initialize` response (process start, imports, boot work) |
| `tools-list` | `initialize` response → all `tools/list` pages received (follows `nextCursor`) |
| `shutdown` | stdin closed → process exited. The MCP stdio spec says servers should exit when stdin closes |
| `memory` | Linux: peak RSS (`VmHWM`) summed over the server's process tree. macOS/BSD: tree RSS from `ps` after `tools/list`. Not measured on Windows |
| `tokens` | ≈ `bytes / 4` of the `tools/list` responses: the context cost of your tool definitions |
| `bytes` | total bytes of the `tools/list` response lines |

It also warns about transport problems it notices along the way:

- **non-JSON lines on stdout.** Startup banners and stray `console.log` calls corrupt the stdio transport.
- **servers that ignore stdin EOF.** These have to be killed with SIGTERM/SIGKILL (on Windows, `taskkill /T /F`).
- **a tool list that changes between runs.**

## CLI reference

```text
mcp-coldstart [run] [options] -- <command> [args...]
mcp-coldstart compare <base.json> <head.json> [gate options]
```

**Run options**

| Option | Default | |
| --- | --- | --- |
| `-n, --runs <n>` | 5 | measured cold starts |
| `--warmup <n>` | 1 | discarded runs first (warms disk / module caches) |
| `--timeout <ms>` | 30000 | per-run timeout for initialize + tools/list |
| `--shutdown-grace <ms>` | 2000 | after closing stdin, wait this long, then terminate the server's process tree; kill it after another grace period. Processes the server leaves behind get the same grace after SIGTERM before SIGKILL. The CLI always exits even if a process cannot be reaped |
| `--protocol-version <v>` | 2025-06-18 | `protocolVersion` sent in `initialize` |
| `--cwd <dir>` | | server working directory |
| `--verbose` | | pass the server's stderr through |
| `--show-args` | off | record the full server command line in output and saved results. By default only the executable name (and the package name for `npx`/`uvx`/`pnpm dlx`/…) is kept, and every other argument is shown as `***`, because args often hold API keys or `Authorization` headers |
| `-o, --output <file>` | | save the result JSON (use it later as `--baseline`) |

**Gate options** (for `run` and `compare`)

| Option | Default | |
| --- | --- | --- |
| `--baseline <file>` | | compare with a saved result (`run` only) |
| `--max-regression <pct>` | 20 | allowed growth in percent |
| `--stat <name>` | p50 | `p50`, `p95`, `mean`, `min`, `max` |
| `--gate <metrics>` | `ready,memory,tokens` | comma-separated metrics that fail on regression (at least one); others are reported only |
| `--min-delta-ms <ms>` | 25 | ignore time regressions smaller than this (noise floor) |
| `--min-delta-mb <mb>` | 5 | ignore memory regressions smaller than this |
| `--budget <metric>=<n>` | | absolute limit, repeatable; ms / MB / tokens / bytes, e.g. `--budget ready=1500` |

A metric **regresses** when it grows by more than `--max-regression` percent *and* by more than its noise floor. Metric names: `ready`, `init`, `tools-list`, `shutdown`, `memory`, `tokens`, `bytes`.

**Output**: text by default (colored on a TTY; honours `NO_COLOR`/`FORCE_COLOR`, `--color`, `--no-color`), `--json` (the JSON is itself a valid baseline file), or `--markdown`/`--md` for PR comments and `$GITHUB_STEP_SUMMARY`. `--format text|json|markdown` also works.

**Exit codes**

| Code | Meaning |
| --- | --- |
| 0 | measured, and every budget and gated metric passed |
| 1 | a budget was exceeded or a gated metric regressed |
| 2 | usage error, unreadable/invalid baseline, or the server failed to start, crashed, or timed out (its stderr is shown) |

## Example: Markdown output

`npx mcp-coldstart --baseline baseline.json --md -- node server.js` renders as:

> ## MCP server cold start
>
> 🔴 **Performance gate failed.**
>
> - ready p50 regressed 26.5 ms → 329.9 ms (+1145.5%, limit 20%)
>
> **demo-server 1.0.0 (protocol 2025-06-18)** · 3 tools · 5 runs (+1 warmup) · linux/x64, Node v24.22.1
>
> | Metric | p50 | p95 | Baseline (p50) | Δ |
> | --- | ---: | ---: | ---: | ---: |
> | ready (spawn → tools listed) | 329.9 ms | 330.4 ms | 26.5 ms | +1145.5% 🔴 |
> | initialize | 328.1 ms | 328.8 ms | 24.9 ms | +1218.1% 🟡 |
> | tools/list | 1.6 ms | 1.9 ms | 1.6 ms | +2.5% |
> | memory | 54.2 MB | 54.2 MB | 46.5 MB | +16.6% |
> | tool tokens (≈) | 201 tok | 201 tok | 201 tok | 0.0% |

🔴 means a gated metric regressed. 🟡 means it regressed but is not gated.

## GitHub Actions

Timing is only comparable on the same machine, so measure the base branch and the PR **in the same job**:

```yaml
name: MCP cold start
on: pull_request

jobs:
  coldstart:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { path: head }
      - uses: actions/checkout@v4
        with: { path: base, ref: "${{ github.base_ref }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Build both versions
        run: |
          (cd base && npm ci && npm run build)
          (cd head && npm ci && npm run build)

      - name: Measure base
        run: npx -y mcp-coldstart -n 10 -o base.json -- node base/dist/index.js

      - name: Measure PR and gate
        run: >
          npx -y mcp-coldstart -n 10 --baseline base.json
          --max-regression 25 --budget ready=3000
          --md -- node head/dist/index.js >> "$GITHUB_STEP_SUMMARY"
```

If you only care about deterministic metrics (tool tokens, bytes) or absolute budgets, a committed baseline is enough:

```yaml
      - run: npx -y mcp-coldstart --baseline .mcp/coldstart.json --gate tokens --budget ready=3000 -- node dist/index.js
```

To post the report as a PR comment, write it with `--md > coldstart.md` and pass that file to your comment action of choice.

## Library

```js
import { measure, evaluate, formatMarkdown, loadResult } from "mcp-coldstart";

const result = await measure({ command: "node", args: ["dist/index.js"], runs: 10 });
const report = evaluate(result, await loadResult("baseline.json"), { maxRegressionPct: 25, budgets: { ready: 3000 } });
console.log(formatMarkdown(result, report));
if (report.failed) process.exit(1);
```

Also exported: `measureOnce`, `StdioClient` (a minimal MCP stdio JSON-RPC client), `computeStats`, `percentile`, `treeMemoryMb`, and the TypeScript types.

## Limitations

- **Stdio only.** Streamable HTTP/SSE servers are not launched or measured.
- **Timing is noisy.** Use ≥ 5 runs (10 in CI). Compare only on the same machine, ideally in the same job. Shared CI runners can vary by 10 to 30%. The noise floors and the default 20% threshold exist for this reason; tune them with `--max-regression` and `--min-delta-ms`. If the baseline came from a different OS, CPU count or Node major version, the report adds a note.
- **"Cold" means a fresh process**, not a cold OS: the first run warms disk and module caches, so it is discarded by default (`--warmup`). Use `--warmup 0` to include it. Package-manager wrappers such as `npx -y pkg` add their own resolution time, which you may or may not want to count.
- **Memory** is approximate. On Linux it is the sum of each process's peak RSS in the tree, an upper bound when memory is shared. On macOS it is a single RSS sample after `tools/list`. Windows is not measured.
- **Tokens** are estimated as `bytes / 4` over the raw JSON-RPC lines, envelope included. This works for tracking trends but is not exact for any tokenizer.
- Only `initialize` and `tools/list` are exercised. Prompts, resources and tool calls are not timed. Servers that need interactive auth or network access at startup will be measured with those costs included.
- **Secrets.** Server arguments are redacted (`***`) in every output format, in saved baselines and in error messages unless you pass `--show-args`. Only the executable's base name (and, for `npx`/`uvx`/`pnpm dlx`/…, the package name and version) is kept. The package is shown only if it is the first word after the runner's value-less flags (`-y`, `--yes`, `--quiet`, …) and looks like a package name: after a value-taking runner flag (`--otp`, `--_authToken`, `--with`, `-p`, any `--flag=value`), or when the word is a URL, a path or token-like, nothing but the executable is shown. A whole command line passed as one string shows only its first word. Environment variables are never recorded or printed. When a server fails, the last 20 lines of its stderr are included in the error message. Argument values (and long pieces of them, such as the token in `Authorization: Bearer …`) are scrubbed from that text on a best-effort basis, but a server that prints a secret in another form (encoded, truncated, read from a file or an env var) is not caught, and `--verbose` passes the server's stderr through unfiltered. Pass secrets through environment variables rather than arguments, and don't let the server log them.
- **Shutdown and process trees.** On POSIX each server runs in its own process group. `npx`/`npm exec` keep their `sh -c` and the server's `node` in that group. After the server exits, mcp-coldstart waits until the whole group is gone before it starts the next run or exits. Leftovers get SIGTERM, up to `--shutdown-grace` to exit on their own, then SIGKILL, and it waits until they are dead and reaped (bounded, so it never hangs). Such runs get a warning and `leftoverProcesses: true` in the sample; `shutdown` still measures only the server process. A process that leaves the group (`setsid`, a daemonizing double fork) cannot be tracked and is not killed. Ctrl-C in the CLI kills the group immediately. On Windows there is no graceful signal: a server that ignores stdin EOF is killed with `taskkill /pid <pid> /T /F` at the first stage (both the "SIGTERM" and "SIGKILL" steps are a forced tree kill). A grandchild that outlives a server which already exited cannot be found by Windows, so it may be orphaned (the CLI still exits). The Windows code was developed on Linux. Its escaping is unit-tested on every OS against a model of cmd.exe and MSVCRT parsing, and Windows-only tests that run real `cmd.exe` shims are part of the CI matrix (`windows-latest`, Node 20 and 22).
- **Windows `.cmd`/`.bat` servers.** For a server started through a `.cmd`/`.bat` (e.g. `npx`), the measured times include `cmd.exe` and the shim's own startup, and the process id is `cmd.exe`'s. Batch files are escaped for how they pass arguments on: double for `%*` forwarders, single otherwise. A custom batch file that both forwards `%*` and reads `%~1` gets double escaping, so the `%~1` copy keeps extra `^` characters. For a batch file that reads `%1`/`"%~1"` instead of forwarding `%*`, an argument containing `"` cannot be escaped at all (cmd would end the quoting there and run whatever follows `&`, the "BatBadBut" problem), so mcp-coldstart refuses to start it: exit 2 with "argument N contains a double quote", without echoing the value. Line breaks and NUL are refused for every batch file. The library throws `UnsafeArgumentError` in both cases. Start such servers with `node server.js` directly (or a `.exe`) instead.
- Servers that send requests to the client during startup get `{}` for `ping`, an empty list for `roots/list`, and "method not found" for anything else (e.g. `sampling/createMessage`).

## Development

```bash
npm ci
npm run build
npm run lint      # tsc --noEmit + syntax check of the fixtures
npm test          # builds, then runs node:test (unit + end-to-end against real child processes)
```

The tests launch `examples/demo-server.mjs`, a configurable, dependency-free MCP server (`--startup-delay`, `--list-delay`, `--tools`, `--page-size`, `--alloc-mb`, `--noise`, `--ignore-eof`, `--crash`, `--spawn-child`). They also launch a fixture built with the official `@modelcontextprotocol/sdk` (a dev dependency only) to check that the client interoperates with it.

## License

MIT
