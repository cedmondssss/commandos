# Providers

Every provider is optional at startup and created lazily from credentials (Keychain first, then
environment). `pnpm verify:providers` makes a live call to each one and writes evidence to
`verification/report.json`; nothing is reported as verified without a successful live result.

| Provider | Package | Used for | Live check (`pnpm verify:providers`) |
|---|---|---|---|
| OpenAI | `openai` 7.33 (Responses API) | router (`gpt-6-luna`), STANDARD planner (`gpt-6.1-sol`), DEEP planner and repairs (`gpt-6-astra`), content naming, vision | routes a command with Luna, gets schema-valid plans from Sol and Astra, runs a streamed STANDARD agent that creates and verifies a file |
| ElevenLabs | `@elevenlabs/elevenlabs-js` 2.72 | Scribe v2 Realtime speech-to-text with partials and commits; TTS of verified results | streams a `say`-generated 16 kHz utterance, checks word error rate ≤ 0.25 and commit latency; synthesizes speech |
| Daytona | `@daytona/sdk` 0.224 | isolated test runs, patch validation | creates a network-blocked sandbox, uploads and runs code, confirms outbound network is blocked, deletes it |
| Anchor Browser | `anchorbrowser` 1.0 | remote cloud browser sessions (Playwright over CDP), agent tasks | opens a remote session on the fixture catalog, counts rows over CDP, ends the session |
| SurrealDB Agent Memory | `@surrealdb/memory` 1.0.0-alpha.11 | verified procedures and outcomes | health check, stores a procedure verbatim, recalls it |
| Arize AX | OpenTelemetry + `@arizeai/openinference-instrumentation-openai` | tracing and evaluation spans | exports a span tree to `otlp.arize.com` and checks the exporter's result; confirm the trace id in the Arize UI |

## OpenAI

- `ModelGateway` (`packages/providers/src/openai.ts`) is the only entry point. `parse()` uses
  `responses.parse` + `zodTextFormat`; `stream()` streams function-calling turns with
  `store: false` and encrypted reasoning items so turns can be replayed.
- Efforts per tier are configurable (Settings → Models); defaults are Luna `low`, Sol `low`,
  Astra `medium` (an Astra deep plan measured 46 s at `high`, 25 s at `medium`, 16 s at `low`).
  Sol 6.1 and Astra do not accept `none` / `minimal`; the gateway clamps them to `low`.
- Fast mode (`service_tier: "fast"`) is on by default (Settings → Models → Processing). Measured
  on this account: router 4.2 → 3.0 s p50, Sol first token 1.73 → 1.15 s, Sol output 91 → 133
  tokens/s; Astra is served on the fast tier too. It doubles the token price; every `model_call`
  records the tier that actually served it.
- Router calls and planning streams are hedged (two identical requests, first answer or first
  output wins, the other is cancelled and logged as `cancelled: hedged…`).
- Every call emits a `model_call` event (model, effort, latency, TTFT, tokens, response id), so
  runs report exact model-call counts.

## ElevenLabs

- The renderer captures the microphone with an AudioWorklet at 16 kHz and sends 100 ms PCM chunks
  over validated IPC; the API key stays in the runtime.
- Commit strategy is VAD (hands-free) or manual (push-to-talk); one utterance per activation.
- Metrics: utterance → commit and speech end → commit.

## Daytona

- `sandbox.create` stages an explicit file set: `.git`, `node_modules`, build output, `.env*`,
  keys and certificates are excluded, and every text file is secret-scanned; staging is refused
  on any finding.
- Sandboxes get no environment variables, block all network unless an install step needs package
  registries (domain allowlist), auto-stop when idle, and remain available after the run for inspection.
  They are deleted only when an explicit `sandbox.destroy` task is requested.
- Output is treated as untrusted: tests are parsed, patches are validated by re-running the suite
  in the sandbox, and only then offered for local review.

## Anchor Browser

- `web.open` with provider `anchor` creates a **remote** browser session and drives it with
  Playwright over CDP. It never controls the browser on this Mac; local browser work uses a
  separate Playwright-controlled Chromium (`provider: "local"`).
- The submit guard is installed in every page; `web.agentTask` in `extract` mode tells the agent
  not to submit or change data, and `interact` mode always needs approval.
- Sessions get a 20-minute max duration and 3-minute idle timeout and are deleted at run end.
- Remote IDs are tracked before CDP connects. Failed connection/navigation paths request deletion;
  failed deletions retain their handles for retry and surface cleanup errors. A Playwright disconnect
  alone is not treated as proof that the Anchor session ended.
- CDP endpoints are removed from connection errors and structured output. Only the live-view URL
  is shown to users. Extra stealth and CAPTCHA solving are not enabled by the default session.

## SurrealDB Agent Memory

- Hosted service (SurrealDB Cloud context). Configure `SPECTRON_URL`, `SPECTRON_CONTEXT_ID`,
  `SPECTRON_API_KEY`.
- Records live under scope `app/commandos/user/<user>`; procedures are labelled `kind=procedure`,
  outcomes `kind=outcome`.
- Outcome writes use the supported `context` memory category. Search passages can split long
  procedure JSON; CommandOS resolves their source session/turn to read the complete record.
- Known-procedure replay reads its original cloud turn directly. Local run metadata stores source
  references, and a per-procedure pointer tracks the latest saved or stale version across restarts.
- Optional planning hints have a 350 ms wait budget; explicit replay waits for its source read.
- The SDK is an alpha. Alongside `remember`, `recall`, `forget`, `scopes.register` and `health`,
  the integration uses its authenticated `Transport` for source-turn reads.

## Arize AX

- OTLP/protobuf to `https://otlp.arize.com/v1/traces` with `arize-space-id` / `arize-api-key`
  headers; project `commandos`.
- OpenAI calls are auto-instrumented (images hidden); CommandOS adds AGENT/CHAIN/GUARDRAIL/TOOL/
  EVALUATOR/RETRIEVER spans. Each run shows its trace id in the dashboard.
- Credentials are read at runtime start; after adding them, restart the app.
