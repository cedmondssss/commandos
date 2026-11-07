# Technical demo scenario (≈10 minutes)

Everything below runs against controlled fixtures. Nothing touches real files outside
`~/CommandOS-Demo`, and the only website is the fixture portal
(<https://commandos-fixtures.vercel.app>, `noindex`, submissions are never processed).

## 0. Setup (once, before the demo)

```bash
pnpm install
pnpm build:helper
pnpm demo --prepare        # creates ~/CommandOS-Demo: Screenshots, Inbox2, Docs, calc-lib
pnpm dev                   # or the built app
```

- Settings → API credentials: paste OpenAI, ElevenLabs, Daytona, Anchor, SurrealDB Agent Memory and
  Arize keys (stored in the Keychain). Restart once so tracing picks up the Arize keys.
- Settings → Folders: add `~/CommandOS-Demo` (already in the defaults).
- Diagnostics: grant Accessibility, Screen Recording and Microphone; run `pnpm verify:providers` and
  show the verification table (live evidence per provider).
- Open the Arize AX project `commandos` in a browser tab.

## 1. Voice → FAST workflow (Workflow 1)

Press **⌃⌥Space** and say:

> “Find my five latest screenshots in my CommandOS demo, sort them into categories, put them in a
> folder called Sorted and write a report.”

Show: partial transcripts while speaking; the route chip **FAST · via grammar** (no router call);
the DAG (find ‖ mkdir → on-device OCR → name & classify (one `gpt-6-luna` call) → organize →
report); verification checks per node; time to first action in the header; the report opening.
Then press **↺ Undo run** and show the screenshots back where they were.

## 2. Procedural memory (Workflow 4)

Type or say:

> “Do the same for ~/CommandOS-Demo/Inbox2.”

Show: route **FAST · via procedure**; narration “Reusing procedure … from SurrealDB memory
(score …); parameters bound deterministically (no model call)”; the replayed DAG. In the activity
log after the first run: “memory: saved verified procedure …”.

## 3. Repository test-and-fix in Daytona (Workflow 2)

> “Run the tests in ~/CommandOS-Demo/calc-lib and fix the failures.”

Show: approval card for staging the repo in an isolated sandbox (files filtered, secret-scanned,
network blocked); 3 failing tests parsed from TAP; `gpt-6-astra` proposes a patch; the patch is
applied **inside the sandbox** and the suite re-runs green; a second approval shows the unified
diff before anything touches the local repo; the sandbox remains in Daytona after the run for inspection. Undo restores the
original files.

## 4. Cloud browser form (Workflow 3)

> “Open the Northwind partner portal and fill a draft purchase request for Rivera Labs,
> ops@rivera.example, 40 units of the cheapest in-stock product. Don’t submit it.”

Show: route **FAST · via router** (one `gpt-6-luna` call extracted the slots); the Anchor live-view
link in the activity log (remote cloud session, not the Mac’s browser); catalog extraction →
deterministic product choice (NW-2210) → fields filled by selector → every field read back →
“form was not submitted” check → screenshot evidence → session ended.

## 5. Failure detection and recovery (Workflow 6)

Repeat step 4 on the redesigned layout:

> “…same request on layout B of the portal.”

Show: `fill` fails because every CSS selector changed; only that node is retried
(“recovering (alternative): locate fields by visible label”) — no upstream re-runs, no model call;
the run succeeds. Then layout C (labels reworded too): the deterministic alternative fails, the
model-repair tier maps the renamed labels (one `repair_node` call) and the run succeeds.

In Arize: open the run’s trace id (shown in the run header). The trace shows `tool web.fillForm`
with an error, the `verify` evaluator span, the `recover web.fillForm` chain span, the repair LLM
span and the successful attempt.

## 6. Parallel DAG (Workflow 5)

> “In parallel: summarize the documents in ~/CommandOS-Demo/Docs into a report, find my three latest
> screenshots, and list what’s in my Downloads folder.”

Show: STANDARD mode (`gpt-6.1-sol`); the first task starts while the model is still streaming the
rest of the turn; independent branches run side by side (overlapping timestamps in the activity
log and in the Arize span timeline). `pnpm bench` reports the measured speedup against
concurrency 1.

## 7. Safety moments

- “Delete the Sorted folder” → approval card (deletion, moves to Trash, risk medium) → **Deny**.
- Start any long run and press **⌃⌥Esc**: every run stops, pending approvals are denied, sandboxes
  and browser sessions are cleaned up.
- History → open an interrupted or partial run → **Resume**: verified steps are restored from
  checkpoints, only the rest runs.

## Without credentials

`pnpm demo --run` executes the offline parts (FAST organize + undo, layout-B recovery in a local
browser, a parallel DAG) and marks the rest as blocked with the missing keys. `pnpm bench` gives
the measured numbers for the offline scenarios.
