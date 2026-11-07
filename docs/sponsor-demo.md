# See the sponsor tools working

Prepared October 16, 2026. Sample files are ready in `~/CommandOS-Demo`.
Run the prompts below in CommandOS's own input. Open **Dashboard → Live** to see
the steps, activity log, model calls, task outputs and verification results.
Select a task in the Tasks panel to inspect its output.

## Dashboard integration activity

Open **Dashboard → Integrations**. This follows the selected run; choosing a run in
the sidebar or History changes the evidence being displayed.

- **Anchor Browser:** a read-only preview refreshes from the actual remote browser
  while its session is active. A recorded screenshot replaces it after closure.
  **Try a read-only browser task** fills the command box with a public-page example;
  press Run to execute it, or edit it for another web task. The optional external
  viewer link is separate from the dashboard preview. The preview itself does not
  depend on Anchor's external viewer connection service.
- **SurrealDB memory:** saving, saved, recalled, stale and failure events, with
  procedure/record IDs and source session details when available. The two example
  buttons fill the command box; they do not start work automatically.
- **Arize trace:** copy the selected run's trace ID, inspect its local task/model
  timeline, and open Arize. Accepted-span totals describe the current runtime;
  they do not assert that this particular trace is visible in Arize's dashboard.
- **Voice & other tools:** live ElevenLabs transcript, the selected run's model
  calls, and Daytona steps only when that run uses a sandbox.

Native Chrome/Qwen attachment tasks do not create an Anchor session. Their
SurrealDB and trace evidence can still appear in the corresponding panels.

Validation: 158 unit regressions passed in the affected suites; project typecheck
and desktop build passed. Two isolated renderer tests plus an opt-in live Anchor
test passed. The live test used a real cloud session and its actual preview and
captured page inside an isolated dashboard renderer, with session cleanup confirmed.
It did not automate the user's existing Electron window.

## Check the connections

### Real website audit: Anchor + Daytona + model planning

This workflow was rehearsed with the real CommandRuntime and cloud providers in
an isolated CLI run store: 26/26 tasks succeeded, first action 1.95 seconds,
task execution 49.85 seconds and completion with memory persistence 60.48 seconds.
The original failed files in `~/Desktop/Website-Audit` were preserved. Successful
results are in `~/Desktop/Website-Audit-Verified/results.csv` and `report.txt`.

For another rehearsal, choose a fresh output folder to avoid overwriting existing
results, then use this command (the example uses `Website-Audit-Next`):

```text
Audit https://www.daytona.io with Anchor Browser. Visit the homepage and three internal pages. Record their URLs, titles, HTTP status codes, and screenshots. Create a dependency-free Node.js audit project with a package.json in ~/Desktop/Website-Audit-Next. Use a real Daytona sandbox to execute its analysis of the collected observations. Save a CSV of the results and a plain-English report explaining the observed issues, with source URLs. Report honestly if no issues are found. Run the generated code only inside Daytona. Close the browser afterward and leave the Daytona sandbox available so I can inspect it. Do not submit forms or change the website.
```

Watch Anchor in Integrations and inspect the actual `sandbox.create` ID,
`sandbox.exec` results and the retained sandbox in Daytona. OpenAI planned the
workflow and generated the program/report; SurrealDB saved the verified procedure
and outcome. Use the microphone for ElevenLabs: the verified rehearsal was typed.
Arize accepted 116 spans but three export batches failed with server errors;
the complete hosted trace has not been inspected. The trace ID is
`f9f66e5c24bb58a4f3c8f25d306683ce`. Saving the procedure was verified; cross-site
replay is not yet demonstrated. Evidence: `verification/website-audit-live.json`.

Open **Dashboard → Diagnostics → Provider verification**. This table shows the
saved live-call report, including each check's time; **Re-check** reloads the
diagnostics and report rather than running new provider API tests. To run fresh
provider tests from the project terminal:

```bash
pnpm verify:providers openai elevenlabs daytona anchor surrealdb arize
```

The latest six-provider checks passed at approximately 11:44 AM EDT on October 16.
They use fixtures, disposable cloud resources and a stale test-memory record.
They do not capture the user's microphone or take a photo. The report is at
`verification/report.json`.

## OpenAI: organize screenshots by their contents

```text
Find my five latest screenshots in ~/CommandOS-Demo/Screenshots, sort them into categories, put them in a folder called Sorted and write a report.
```

Look for the OCR step, model-backed naming/classification, moved files and report.
The grammar route itself needs no model. The content-classification step does.

## SurrealDB: remember and reuse that workflow

After the preceding run succeeds and its activity log says **memory: saved verified
procedure**, run this immediately, before running a different workflow:

```text
Do the same for ~/CommandOS-Demo/Inbox2.
```

Look for **via procedure**, cloud memory source/recall activity, and the same
organization steps applied to the other folder. Reusing a procedure removes the
planning step; content classification may still use a model.

## Daytona: fix a broken repository in a sandbox

### GitHub issue → Anchor → Daytona repair

Public demo fixture: <https://github.com/Soulemane12/checkout-demo/issues/1>.
The matching local checkout is `~/CommandOS-Demo/checkout-demo`. The bugs are
intentional: the baseline has 5 passing and 3 failing tests.

```text
Read GitHub issue https://github.com/Soulemane12/checkout-demo/issues/1 with Anchor. Fix it in Daytona using ~/CommandOS-Demo/checkout-demo. Show the patch and test results. Keep the sandbox. Do not apply changes locally or push anything.
```

Issue repairs using Anchor and Daytona now route directly to the incremental
planner, without waiting for a complete DEEP plan. Issue text is read with
`web.extract` scoped to the issue body rather than a browser-agent task. Plain
Node test scripts run directly, preserving npm for other scripts and lifecycle
hooks. Patch generation receives the issue requirements as untrusted data.

A real cloud-only runtime rehearsal on October 16 completed 12/12 steps in
30.17 seconds of task execution (32.40 seconds including finalization), with the
first action at 1.99 seconds. Daytona reproduced all three failures, then passed
8/8 tests after the patch; the local source was unchanged. Retained sandbox:
`85932862-de1c-417e-bd72-d40cd855abfc`. Evidence:
`verification/github-issue-repair-live.json`.

This rehearsal supplied the exact issue URL and local path, approved only the
fixture upload automatically, and disabled telemetry. Native Chrome discovery,
microphone input, memory replay and hosted Arize trace visibility were outside
its scope.

Repository-name discovery now runs a visible, read-only `repo.locate` step before
the first planner turn. It resolves the owner and checkout from actual local Git
remotes within allowed roots, keeps multiple matches ambiguous, and excludes
protected paths and symlinks. Ownerless GitHub issue URLs are rejected before
navigation. The patch tool also exposes a string `diff` for binding directly into
a report, avoiding an extra model summary and array-to-text binding errors.

The subsequent cloud-only rehearsal supplied only “my checkout-demo GitHub repo”
and “the local copy listed in the issue”, with no username, issue URL or checkout
path in the command. It completed 11/11 steps in 23.96 seconds of task execution
(25.76 seconds including finalization), reproduced 3 failing tests, then passed
8/8 after the patch. Local source was unchanged; retained sandbox:
`bf958c85-56a8-44d1-8a6d-e0b27e4e1ed1`. Evidence:
`verification/github-repository-resolution-live.json`. This verifies local
repository discovery and the real Anchor/Daytona workflow; native Chrome opening
and physical voice input were excluded from the rehearsal.

### Local repository repair

```text
Run the tests in ~/CommandOS-Demo/calc-lib and fix the failures.
```

Review the upload approval. Watch `sandbox.create`, `sandbox.exec`, proposed changes,
passing sandbox re-tests, and local patch review. Inspect the sandbox task outputs
for its ID and test results. Local source changes wait for patch approval.
The sandbox auto-stops when idle but remains in Daytona for inspection after the
run. Delete it only if you explicitly want to remove it.

## Anchor Browser: fill a remote form and verify it

```text
Open the Northwind partner portal and fill a draft purchase request for Rivera Labs, ops@rivera.example, 40 units of the cheapest in-stock product. Do not submit it.
```

Inspect the `web.open` task for the Anchor session and live-view URL. Open its
live view while the session is active to see the remote browser. Watch extraction,
product selection and field verification. This is the controlled Northwind fixture,
with no real purchase submission. The session closes at the end, so its live-view
URL is temporary; task outputs and the captured form screenshot remain evidence.

## ElevenLabs: use your own voice

Press **Control + Option + Space**, or use the overlay microphone, and say:

```text
Open Calculator.
```

Check the partial/final transcript and the resulting action. The provider test
verified realtime transcription and speech synthesis using generated audio; the
physical microphone and venue noise need this separate test.

## Arize: inspect the execution trace

Open Arize AX at <https://app.arize.com>, select the **commandos** project, and find
the trace ID displayed in the CommandOS Dashboard run header. Inspect tool/model
timings and failed/recovered steps where present.

The latest provider check exported 30 spans in 9 batches. Its trace ID is:

```text
23d0b4f16d5093aea47fbdd5348c37fb
```

Cloud export acceptance is verified. Rendering in the signed-in Arize dashboard
and configured online evaluations have not been independently verified here.

## Current limits

- AWS has no dedicated provider integration in the current code.
- Existing-image → Qwen attach-only is now verified by the user's successful
  CommandOS run. A fresh camera-capture-and-attach sequence still needs its own
  complete live run.
- The six full demo workflows passed earlier today in controlled fixtures. The
  latest provider checks validate individual connections and capabilities; use
  the prompts above to rehearse complete visible workflows in the current app.
- After the repository is fixed or screenshots are moved, repeat demos need a
  restored baseline. Undo the corresponding run, or use a fresh demo directory.
