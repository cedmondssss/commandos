# CommandOS

A voice-driven macOS computer agent. Speak (or type) a complex instruction; CommandOS routes it to
the cheapest reliable execution path, builds a typed dependency graph of tool calls, runs
independent steps in parallel under a least-privilege policy, verifies every result against the
real system state, recovers failed steps selectively, and keeps an undo journal, checkpoints and a
tamper-evident audit log.

| Layer | Technology |
|---|---|
| Desktop shell | Electron 44 (sandboxed renderer, context isolation, validated IPC, runtime in a `utilityProcess`), React 19, Tailwind 4, React Flow |
| Native Mac actions | Swift helper (`native/CommandOSHelper`): Accessibility, NSWorkspace, Spotlight, Vision OCR, ScreenCaptureKit, Keychain, Apple Events, input events — typed JSON-lines RPC |
| Reasoning | OpenAI Responses API: `gpt-6-luna` (router, fast steps), `gpt-6.1-sol` (incremental planner), `gpt-6-astra` (deep plans, patches, hard repairs) |
| Voice | ElevenLabs Scribe v2 Realtime (partials + end-of-utterance commits), ElevenLabs TTS |
| Isolated execution | Daytona sandboxes |
| Browsers | Anchor Browser (remote cloud sessions, agent tasks); Playwright for local browsers |
| Memory | SurrealDB Agent Memory (verified, replayable procedures) |
| Tracing | Arize AX via OpenTelemetry + OpenInference |

**Docs:** [architecture](docs/architecture.md) · [security model](docs/security.md) ·
[providers](docs/providers.md) · [demo scenario](docs/demo-scenario.md) · [status](STATUS.md)

**HackBU:** [three-minute demo and preparation](docs/hackbu-demo.md). Dashboard → **Safety Lab** runs ten controlled evaluations of boundaries, usefulness and recovery with inspectable evidence. Run the same suite with `pnpm safety`. Proposals and approvals in this suite are scripted; it does not measure live-model prompt-injection resistance.

## Quick start

Requirements: macOS 14+ (developed on macOS 26, Apple silicon), Node ≥ 22.12, pnpm 10, Xcode
command-line tools (Swift 6), Google Chrome (used by local Playwright sessions and fixtures).

```bash
pnpm install
pnpm build:helper            # builds and ad-hoc signs the Swift helper
pnpm demo --prepare          # creates ~/CommandOS-Demo with screenshots, documents and a test repo
pnpm dev                     # starts the app
```

Shortcuts: **⌥Space** command bar · **⌃⌥Space** talk · **⌃⌥Esc** emergency stop.

### Credentials

Paste keys in **Settings → API credentials** (stored in the macOS Keychain), or copy `.env.example`
to `.env.local` for development. Then check them with live calls:

```bash
pnpm verify:providers        # writes verification/report.json; shown under Diagnostics
```

| Key | Needed for |
|---|---|
| `OPENAI_API_KEY` | routing open-ended commands, planning, content naming, patches, repairs |
| `ELEVENLABS_API_KEY` | voice input and spoken results |
| `DAYTONA_API_KEY` | running tests and validation in sandboxes |
| `ANCHORBROWSER_API_KEY` | remote browser sessions (without it, web workflows use local Chromium) |
| `SPECTRON_URL`, `SPECTRON_CONTEXT_ID`, `SPECTRON_API_KEY` | SurrealDB Agent Memory (procedures) |
| `ARIZE_SPACE_ID`, `ARIZE_API_KEY` | Arize AX tracing (restart after adding) |

Commands with a local grammar or template (screenshot organizing without renaming, undo, cancel,
emergency stop) work without any key.

### macOS permissions

Grant in System Settings → Privacy & Security (Diagnostics has shortcuts): **Accessibility**
(operate other apps' UI), **Screen Recording** (window captures for the vision fallback),
**Microphone** (voice), and **Automation** per app when an Apple Events template first targets it.
In development macOS attributes these to the launching app (Electron, Terminal or your editor). The
`dev` script unsets `ELECTRON_RUN_AS_NODE`, which VS Code terminals export.

## Things to say

| Workflow | Example |
|---|---|
| Organize screenshots (FAST) | “Find my five latest screenshots in my CommandOS demo, sort them into categories, put them in a folder called Sorted and write a report.” |
| Reuse a procedure (memory) | “Do the same for ~/CommandOS-Demo/Inbox2.” |
| Fix a repo in a sandbox | “Run the tests in ~/CommandOS-Demo/calc-lib and fix the failures.” |
| Cloud browser form | “Open the Northwind partner portal and fill a draft purchase request for Rivera Labs, ops@rivera.example, 40 units of the cheapest in-stock product. Don't submit it.” |
| Parallel work | “In parallel: summarize the documents in ~/CommandOS-Demo/Docs into a report, find my three latest screenshots, and list what's in my Downloads folder.” |
| Control | “stop”, “undo that”, “approve”, “deny”, “emergency stop” |

Headless, same runtime:

```bash
pnpm cmd --demo "Move my 5 latest screenshots into a folder called Keepers and write a report"
pnpm cmd undo last
pnpm cmd runs
pnpm cmd audit                # verifies the hash-chained audit log
```

## Tests, benchmarks, demo, status

```bash
pnpm test              # unit + integration (real Swift helper, real Chromium, real files)
pnpm test:swift        # Swift helper XCTest
pnpm test:e2e          # builds the app and drives it with Playwright's Electron driver
pnpm bench             # repeatable benchmarks → bench/results/latest.md
pnpm demo --run --yes  # runs the six workflows headlessly, records evidence
pnpm status            # regenerates STATUS.md from tests, verification, benchmarks, demo evidence
```

Suites that need credentials or macOS permissions skip with an explicit reason; they are never
reported as passing.

## Layout

```
apps/desktop/            Electron main, preload, runtime utilityProcess, React renderer
packages/contracts/      Zod schemas shared by every process
packages/runtime/        router, templates, planners, executor, policy, approvals, recovery,
                         audit, undo, checkpoints, procedures, metrics
packages/tools/          tool registry and implementations, Swift helper client
packages/providers/      OpenAI, ElevenLabs, Daytona, Anchor/Playwright, SurrealDB memory,
                         telemetry, credentials, redaction
native/CommandOSHelper/  Swift helper
fixtures/                screenshots, documents, a two-bug repo, the partner-portal site
bench/  scripts/  tests/  docs/  verification/
```

The fixture website is deployed at <https://commandos-fixtures.vercel.app> (static, `noindex`;
`?variant=b` and `?variant=c` simulate redesigns for the recovery demo).
