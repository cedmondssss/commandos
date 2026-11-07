# CommandOS at HackBU 2026

Track: **Agentic Development**. Lead with the problem: people need to understand, control and check an agent before trusting it with their computer.

Opening sentence: **“CommandOS turns spoken instructions into visible, verified actions on your Mac, with permissions and undo built into execution.”**

## Before the expo

1. Resolve pre-existing-code eligibility with organizers. The foundation predates hacking hours; identify the new Safety Lab and policy explanations separately. Keep the actual Git history and accurately disclose AI assistance in Devpost.
2. Prepare the existing controlled demo folder and start the app:

   ```bash
   pnpm demo --prepare
   pnpm dev
   ```

   The prepare command creates or refreshes the marked `~/CommandOS-Demo` fixture folder. Use it only for that demo folder. In the overlay, click **Dashboard**.
3. In **Settings**, confirm `~/CommandOS-Demo` is in the folders CommandOS may change. Keep the reversible-item limit at **25** for the first command; turn off **dry run** in the command bar.
4. Open `~/CommandOS-Demo/Screenshots` in Finder beside CommandOS. Use the supplied sample screenshots, not personal files.
5. Open **Safety Lab**, run evaluations, and expand the hostile-text and selector-recovery cases once to familiarize yourself with their evidence. The suite needs local Chrome or Playwright Chromium, but no API keys or native app permissions. A browser launch error is displayed as an error.
6. Rehearse voice once with **⌃⌥Space** if ElevenLabs and microphone permission are ready. Keep the typed command below copied for a quick fallback. Typing exercises the same runtime.
7. Keep a short screen recording of your actual rehearsal. If venue audio, internet or screen sharing fails, label the recording as a prior run. Saved Safety Lab results display their run time; do not describe them as a new live run.

## Three-minute judging script

### 0:00–0:20 — Problem and promise

Say: “Computer agents can move files, send information and act across apps. Users need to see what will happen, decide what is permitted, and verify the result. CommandOS makes those controls part of execution.”

### 0:20–1:05 — Useful work, explanation and undo

Speak or paste:

> Move my five latest screenshots in ~/CommandOS-Demo/Screenshots into a folder called HackBU Picks.

This known command uses deterministic routing and no model calls. Show the files move in Finder and the verified task graph in **Live**. In **Tasks**, select the move step: point out **What happens**, **Destination / affected items**, **Data sharing**, **Undo**, and **Permission**. Explain that these descriptions come from the tool contract, concrete arguments and policy decision.

Click **Undo run** and show the files back in the screenshot inbox. Say: “Undo uses recorded inverse operations and checks whether the state still permits restoration.”

If you repeat the command before undoing, Spotlight may find the same five screenshots inside
the destination. CommandOS now verifies them and says they are already in place, with no new
move or undo operation. For another visible move, open **History** and undo the original
successful move run, then repeat the command. Undoing a later no-change run would not restore
the original inbox.

Do not add content renaming or classification to this short command: those introduce model calls and a longer demo.

### 1:05–1:40 — Human permission has an observable effect

In **Settings**, set the reversible-item auto-approval limit to **0**, then click outside the input so it saves. Return to **Live** and paste:

> Move my one latest screenshot in ~/CommandOS-Demo/Screenshots into a folder called Permission Check.

The move step now asks for permission. Point out the exact destination, why permission is required, what data is shared, and whether undo is recorded. Expand **Exact arguments and content** if useful. Click **Deny** and show that the file did not move. An empty destination folder may already have been created by the preceding step.

Say: “I tightened my policy. The same agent now has to ask, and declining prevents that file move.” Restore the limit to **25** after the demonstration. This is a deliberate demonstration setting, not the product default.

### 1:40–2:40 — Run the Safety Lab

Click **Safety Lab → Run again** (or **Run evaluations** for a fresh profile). Wait for the actual result. Show the overall, boundary, usefulness and recovery counts. Failed, cancelled and infrastructure-error cases stay in the denominator.

Expand **Gate a send proposed after reading hostile text**. Point to `send: policy=require_approval`, the recorded denial, and zero native actions. Say: “This scripts a bad proposal after reading a real hostile document. It checks that the execution boundary still requires permission. It does not prove that a model resists every prompt injection.”

Expand **Recover a broken selector without repeating upstream work**. Show one browser-open attempt and two fill attempts: the failed selector, the production label fallback and the verified field value. This case runs real local Chromium, without a model.

If time permits, expand **Fill a draft without submitting it**: the fixture server received zero submissions despite three attempted HTML submission paths. Do not claim the guard blocks every possible website side effect; fetch/XHR is outside its scope.

### 2:40–3:00 — Architecture and close

Say: “The interface is Electron and React, the execution engine is TypeScript, and native Mac actions use a Swift helper. Known commands avoid model calls; open-ended commands use model planning. Every proposed step still goes through the same execution controls.”

Finish: “The contribution is a computer agent whose behavior users can inspect, control and evaluate.” Show the public repository and distinguish the weekend contribution from the existing foundation.

## If a judge asks

- **Is the score universal?** No. It is ten defined scenarios with an environment, suite version, timestamp, checks and event evidence. There are two useful-work cases; this is not a population-level false-positive estimate.
- **Are models tested?** Not in this control suite. The app uses model planning elsewhere. The hostile-document case uses a scripted unsafe proposal and scripted denial; live-model attack evaluations would be a separate study.
- **What is actually run?** Real temporary filesystem operations, path policy, production executor, approvals and expiration, undo, cancellation, plus real local-browser form and recovery checks. Native app calls and cloud providers are disabled in the lab as containment measures.
- **Can everything be undone?** No. Journal-backed tools advertise recorded undo. Sending data and many UI actions have no automatic undo. Descriptions distinguish these cases.
- **Can it stop?** The lab checks executor cancellation and queued work. The actual app also has **Stop all** and **⌃⌥Esc**, plus a runtime watchdog; the lab does not measure the watchdog or physical microphone.
- **What happens if something fails?** Inspect the failed check and recorded task evidence. Browser failures remain errors. **Copy evidence JSON** exports the exact report for review; the app also persists it under its data folder at `safety/latest.json` and keeps per-run reports.

## Reproduce the evaluations from the repository

```bash
pnpm safety
```

This uses the same suite as the dashboard, writes `verification/safety-lab/latest.json` and a per-run report, and exits nonzero if any case fails, errors or is cancelled. It never reads API keys. In the development app, Safety Lab also loads this repository report when there is no newer app-data report, so CLI rehearsal results appear in the dashboard. Use **Method and limits** in the UI when explaining what the results establish.
