# CommandOS status

## HackBU additions — November 7, 2026

Keychain prompt-loop fix: status checks now read metadata, concurrent reads coalesce, native
Keychain operations are non-interactive, and unchanged helper builds preserve their signed
installation. Live check: ten status requests read zero secrets, ten concurrent ElevenLabs
requests made one Keychain read, and all nine required credentials were available through the
existing development fallback in 55 ms. **173 affected tests**, **13 Swift tests**, typecheck,
desktop build and **9 built-app checks** passed; two optional live-provider checks skipped.
See [verification and limitations](verification/keychain-prompt-fix.md).

Screenshot-repeat fix: repeated organization now verifies files already in their destination
instead of failing because zero moves were needed. Verified the reported command against the
actual demo folder with real Spotlight: five files already in place, zero model calls, all eight
screenshots unchanged. Undo availability reflects recorded inverse operations. **230 affected
tests in 26 files**, typecheck and desktop build passed; built-app checks: **9 passed, 2 optional
live-provider checks skipped**. See [fix and evidence](verification/screenshot-repeat-fix.md).

Added **Safety Lab** (ten rerunnable control evaluations, real local-browser checks, inspectable
scorecard and persisted evidence) and deterministic step/approval explanations showing affected
items, data sharing, permission reasons and journal-backed undo availability. The CLI and built
Electron app each completed **10/10 Safety Lab scenarios**. **226 affected tests in 25 files**,
workspace typecheck and desktop build passed. Built-app checks: **9 passed, 2 optional live-provider
checks skipped**. The exact five-screenshot demo command and undo were verified in Electron.
These are scripted control evaluations, not live-model prompt-injection measurements.
See [verification and limits](verification/hackbu-responsibility.md) and
[the HackBU demo runbook](docs/hackbu-demo.md).

The following is the earlier generated project-wide snapshot.

Generated 2026-10-16T14:29:08.311Z by `pnpm status` from test results, live provider verification, benchmarks and demo evidence. Nothing here is asserted without evidence.

## Test results

Latest website-audit fix: **190 affected tests in 21 files passed**; project
typecheck and desktop build passed. Plan validation now rejects invalid binding
and postcondition output paths before any tasks are registered. Explicit
Anchor/Daytona audits use streaming STANDARD planning and direct page reads.
A live CommandRuntime/CLI rehearsal completed **26/26 steps**, first action
**1.95 s**, task run **49.85 s**, and **60.48 s including memory persistence**.
It audited four real Daytona pages, produced four screenshots, executed the
analysis in a real network-blocked Daytona sandbox, saved reports to
`~/Desktop/Website-Audit-Verified`, and closed/deleted both cloud resources.
SurrealDB procedure/outcome saves were confirmed. Arize accepted 116 spans but
three export batches failed with server errors; a complete hosted trace is not
claimed. Text input was used, and cross-site procedure replay was not tested.
Evidence: `verification/website-audit-live.json`.

Latest photo-email fix: **178 affected unit tests in 19 files passed**; project
typecheck and desktop build passed. The reported comma-separated spoken command
now routes through FAST grammar without router/planner calls. Gmail targets the
verified Send button once and can confirm the result in a time-filtered Sent
search after a full-page compose tab closes. Uncertain sends stop without retry
or another planning turn. The original draft was recovered through CUA with one
Send action and verified in Sent with an attachment and Inbox label. This was
not a new full live CommandOS run; native actions in the new runtime regression
tests were mocked. Evidence: `verification/photo-email-fix.json`.

- Unit + integration (vitest): **177 passed**, 0 failed, 0 skipped of 177.
- Electron end-to-end (Playwright driving the built app): **8 passed**, 0 failed, 0 skipped.
- Swift helper (XCTest): run `pnpm test:swift`.

## Live provider verification

From `verification/report.json` (2026-10-16T14:03:13.786Z). Each “verified” row made a real API call; evidence ids are in the report.

| Provider | Status | Evidence / reason |
|---|---|---|
| Swift helper (macOS) | verified | helper v0.1.0: on-device OCR read 18 lines; Accessibility granted, Screen Recording granted |
| OpenAI (gpt-6-luna / gpt-6.1-sol / gpt-6-astra) | verified | gpt-6-luna routed (standard/send_email, preview required); gpt-6.1-sol and gpt-6-astra returned schema-valid plans; gpt-6.1-sol vision read the fixture receipt (“Blue Bottle Coffee”); streamed STANDARD run created and verified a file (2 tasks, 2 model calls) |
| ElevenLabs (Scribe v2 Realtime, TTS) | verified | Scribe v2 Realtime transcribed a 4.4 s utterance (WER 0.00, 4 partials, commit 352 ms after speech end); TTS returned 36823 bytes |
| Daytona | verified | sandbox 1b28d522-edcb-4b0b-8249-b8b04d73b560 ran uploaded code (node v25.9.0, exit 0); outbound probe blocked; destruction confirmed afterwards |
| Anchor Browser | verified | remote Anchor session c220554c-6b09-4574-a34f-f6c56ea61532 loaded “Catalog — Northwind Supply Co.” (6 catalog rows over CDP); session ended afterwards |
| SurrealDB Agent Memory | verified | stored a procedure verbatim in scope app/commandos/user/soulemanesow and recalled it (score 0.58); the record is marked stale so it never replays |
| Arize AX | verified | Arize OTLP endpoint accepted 28 span(s) in 8 batch(es); look up trace 45c0c714a7022b73f7ebd42a7b9f5a56 in project "commandos" to confirm in the UI |

## Benchmarks

From `bench/results/latest.md` (2026-10-16T03:52:42.360Z); real runs, success = verified.

| Scenario | Runs | Verified | p50 total | p50 first action | Avg model calls | Notes |
|---|---|---|---|---|---|---|
| FAST screenshot organize (grammar route, 0 model calls) + undo | 20 | 100.0% | 6 ms | 1 ms | 0.00 | undoRestoredExactly: 20/20 |
| Simple native operations (mkdir → write → move, verified) + undo | 100 | 100.0% | 3 ms | 0 ms | 0.00 |  |
| Multi-branch DAG (12 tasks: OCR, 2 browser branches, documents, search): concurrency 6 vs 1 | 5 | 100.0% | 633 ms | 2 ms | 0.00 | sequentialP50Ms: 1207; parallelP50Ms: 633; speedup: 1.91; maxConcurrentTasks: 6; sequentialSuccess: 1 |
| Failure detection + selective recovery (selectors broken by redesign) | 10 | 100.0% | 478 ms | 1 ms | 0.00 |  |
| Voice: speech end → committed transcript (ElevenLabs) | — | — | — | — | — | skipped: ELEVENLABS_API_KEY not set |
| STANDARD planner: document summary (streamed tool calls) | 3 | 100.0% | 4.30 s | 1.30 s | 3.00 |  |
| Prompt → done: everyday commands (live, output-checked) | 15 | 100.0% | 2.27 s | 1.11 s | 2.67 | folder + file p50: 1.88 s; folder + 3 files p50: 2.27 s; list, then report p50: 1.96 s; question about a screenshot p50: 4.39 s; summarize documents p50: 3.63 s |

## Demo harness (`pnpm demo --run`)

Last run 2026-10-16T13:49:08.079Z.

| Workflow | Result | Detail |
|---|---|---|
| W1 organize screenshots | succeeded | Moved 5 file(s) into /var/folders/9v/l83k25t96vs20zcgl__6djsc0000gp/T/commandos-validation.PGAeuVkuqq/demo/Screenshots/Sorted. Report: /var/folders/9v/l83k25t96vs20zcgl__6djsc0000gp/T/commandos-validation.PGAeuVkuqq/demo (trace 53179757948d9b69f777ec613406c6af) |
| W4 replay procedure | succeeded | Moved 5 file(s) into /var/folders/9v/l83k25t96vs20zcgl__6djsc0000gp/T/commandos-validation.PGAeuVkuqq/demo/Inbox2/Sorted. Report: /var/folders/9v/l83k25t96vs20zcgl__6djsc0000gp/T/commandos-validation.PGAeuVkuqq/demo/Inbo (trace 6de6b656f6b2b738707e5bd674934fe4) |
| W2 repo test and fix | succeeded | All 7 steps succeeded and were verified. (trace 8a45e458a3d53b487c9216aa2bb35be9) |
| W3 web form (Anchor cloud browser) | succeeded | All 7 steps succeeded and were verified. (trace cdafa2ed31d064495bb7d74f41899c57) |
| W6 failure + recovery (layout B) | succeeded | All 7 steps succeeded and were verified. (trace 93d7823c6fa42d85f2a9be1d5353519c) |
| W5 parallel DAG | succeeded | Summarized the Docs folder into docs-summary.md, found the three latest screenshots, and listed Inbox2 contents. All 6 steps succeeded and were verified. (trace 8d852dbe8aada5329bf96b39705810c2) |

## Requirement status

| Requirement | Status | Evidence |
|---|---|---|
| Electron shell: sandboxed renderer, context isolation, validated IPC, CSP | verified | e2e: isolation, IPC fuzzing, CSP inline-script block |
| Floating command bar, transcript, live DAG viewer, activity log, approvals, history, settings, diagnostics | implemented; dashboard verified | e2e drives the dashboard to a verified run; command bar and voice transcript need a microphone + ElevenLabs |
| Swift helper (AX, NSWorkspace, Spotlight, Vision OCR, ScreenCaptureKit, Keychain, Apple Events) over typed JSON-lines RPC | verified, including an AX write on TextEdit verified by read-back | helper RPC + Keychain + OCR + live display capture tests; AX TextEdit test: passed |
| ElevenLabs realtime transcription (partials, commits) and TTS | verified | `pnpm verify:providers elevenlabs` |
| Intent compiler: typed DAG (tool, typed args, pre/postconditions, timeouts, risk, undo), Zod-validated | verified | planner tests with scripted streams; deep-plan conversion tests |
| Local tools: files, documents, apps, accessibility, terminal allowlist, screenshot understanding | verified | tool tests: fs/undo, PDF/DOCX/RTF extraction, terminal classification/timeouts, OCR; live vision.ask read the fixture receipt |
| Direct structured execution, parallel DAG with locks and deadlines, model only when needed | verified | executor tests; bench: FAST 0 model calls, multi-branch DAG speedup |
| Daytona: isolated tests, validation, staging without secrets, untrusted output | verified | web-sandbox + cloud test suites |
| Anchor Browser remote sessions and agent tasks; local Playwright for local browsers | verified | real-browser web tests (extract, fill, submit guard, redesign) |
| SurrealDB Agent Memory: scoped procedures, success/failure, procedural reuse, no secrets | verified | procedure tests, memory guard test |
| Arize AX tracing (task, plan, model, tool, verify, retry spans) with redaction | verified | redaction test; local trace shows AGENT/CHAIN/GUARDRAIL/TOOL/EVALUATOR spans incl. recovery |
| Policy engine: deletions, external sends, payments, privileged, high impact need confirmation | verified | policy and executor approval tests |
| Emergency stop, cancellation, checkpoints/resume, dry run, reversible changes, audit chain, least privilege | verified | emergency-stop, cancel, resume, dry-run, undo, audit tamper, symlink-escape tests |
| Keychain credentials, never committed | verified | Keychain round trip through the helper; .gitignore covers .env*, keys, .vercel |
| W1 screenshots → inspect → classify → organize → report | verified, with content naming by the fast model | bench fast-organize, demo W1 (trace 53179757948d9b69f777ec613406c6af) |
| W2 repo tests in Daytona → patch → review | verified | cloud.test.ts W2 suite |
| W3 Anchor web form, verified fields, no submission | verified | web-sandbox tests, recovery tests, demo W3 |
| W4 recall and reapply a procedure | verified | procedures.test.ts |
| W5 concurrent independent steps with correct DAG dependencies | verified | bench multi-branch DAG (speedup, max concurrency), executor tests |
| W6 failure detection and recovery with trace evidence | verified locally (layout B, 0 model calls); Arize export verified; model-repair tier verified | recovery tests, bench, local trace |

## Not implemented / known limitations

- Dashboard **Integrations** now shows current-run Anchor previews and retained screenshots, structured SurrealDB save/recall activity, and an Arize trace ID with a local task/model timeline and runtime export counts. The affected suites passed 158 tests, project typecheck and desktop build passed, and three renderer checks passed (two isolated fixtures plus one real Anchor cloud session with actual preview/capture and cleanup). The Arize timeline is local evidence; hosted Arize trace rendering remains a separate manual check. See `docs/sponsor-demo.md` and `verification/dashboard-integrations.json`.
- Qwen attach-only fixes (2026-10-16): existing Photo Booth timestamp paths resolve the invisible U+202F before AM/PM; explicit existing-file commands use FAST grammar without the camera or model calls. The upload menu now recognizes Qwen's full “Upload attachment file, image, video, audio” label, reuses an already-open menu, handles the separate native Go to Folder sheet, sets the exact Unicode path through Accessibility, and accepts hidden extensions after full-path read-back. Tools + runtime: **135 tests passed**; project typecheck and desktop build passed. Direct CUA verification attached the exact 10:52 AM image to the existing Qwen tab at `https://chat.qwen.ai/`; its named preview and Remove file control were visible, the composer remained empty, and Send was not pressed. No new photo was taken. The user subsequently confirmed a successful automated CommandOS run (`607d237e9b4cc640fb2edb2d4158365b`): 1/1 task verified, FAST grammar routing in 0 ms, zero model calls, 3.86 s execution after approval (7.03 s total, including 3.17 s waiting for approval), and the message left unsent. SurrealDB saved the verified procedure afterward. See `verification/qwen-attachment-live.json`.
- No signed and notarized `.app` package yet (`pnpm build` produces the Electron bundle; run with `pnpm dev` or `electron-vite preview`).
- Voice is one utterance per activation (push-to-talk or VAD); there is no wake word.
- Daytona file transformations have no dedicated round-trip tool; transformations run via `sandbox.exec` and code changes come back through the reviewed `patch.apply` path.
- Arize evaluations are recorded as EVALUATOR spans; no Arize online-eval configuration is created automatically.
- Website fingerprints in stored procedures are enforced at run time (selector failures trigger recovery and mark the procedure stale), not checked before replay.
- In development, macOS attributes Accessibility / Screen Recording / Automation permissions to the launching app.
- Speed depends on OpenAI: everyday model-planned commands measured 1.11 s to first action and 2.27 s to done (p50, Fast mode, which doubles the token price); risky commands still wait for the router and a DEEP plan (gpt-6-astra, ~12 s), and provider latency spikes that hit both hedged requests are not hidden.
