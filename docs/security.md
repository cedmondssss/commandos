# CommandOS security model

CommandOS acts on a real computer with real credentials, so every action is treated as
potentially dangerous until the policy engine, the user or verification says otherwise.

## Threats considered

| Threat | Mitigation |
|---|---|
| Prompt injection from files, OCR, web pages or sandbox output | Planners are told such content is data; repairs and replans re-enter policy; nothing a model writes is executed as a shell script or AppleScript; risky tasks need approval regardless of which turn proposed them |
| Model proposes destructive or external actions | Policy derives risk from tool contracts and arguments, never from the model; deletions, external sends, submissions, payments, privileged commands, irreversible and data-egress steps require approval |
| Path tricks | Paths are expanded and canonicalized (`realpath` of the deepest existing ancestor) before checking allowed roots; symlink escapes are denied (tested); protected locations (`~/.ssh`, Keychains, browser profiles, Mail, Messages…) are always denied |
| Compromised or buggy renderer | Sandboxed renderer, context isolation, no Node, strict CSP (no inline script, no eval), navigation/new windows/webviews blocked, sender-frame checks, Zod validation of every IPC message in main and again in the runtime; fuzzing e2e test |
| Secret leakage | Keychain storage; secrets never reach the renderer; redaction on telemetry, audit and memory writes; secret scan blocks sandbox staging; scrubbed environment for child processes; `.env*` and keys excluded from staging and git |
| Runaway execution | Per-task timeouts, run deadline, cancellation, emergency stop (⌃⌥Esc) that aborts runs, denies pending approvals, kills the helper and terminal process groups, deletes sandboxes and ends browser sessions, and hard-kills the runtime if it does not acknowledge within 2 s |
| Unintended web submissions | A guard injected into every page blocks submit events, implicit Enter submissions and `form.submit()` / `requestSubmit()`; only a click that passed approval as an external action may submit; ordinary fetch/XHR is not blocked (actions are classified by what they do, not by HTTP method) |

## Effect classes and approvals

| Class | Examples | Default policy | Undo |
|---|---|---|---|
| read | list, OCR, extract, UI read | allowed inside allowed folders; reads elsewhere need approval | n/a |
| reversible_local | move, rename, mkdir, write (with backup), move to Trash, fill a form field | allowed inside allowed folders up to the item limit; deletion (even to Trash) asks | journaled inverse operations |
| irreversible_local | quit app, run a Shortcut, typed keystrokes, screen clicks | low risk runs (e.g. “New Document”); medium+ asks | none — the UI says so |
| external | form submit, send, pay, remote writes, Anchor agent in interact mode | always asks, showing the exact arguments | **cannot be undone**; never compensated automatically |

Data egress (consent settings, default in parentheses):

- extracted text to OpenAI (`allow`) — the user asked for content understanding
- images/screenshots to OpenAI vision (`ask`)
- repository files to a Daytona sandbox (`ask` every time)

## Least privilege

- **Allowed folders** (`settings.allowedRoots`): writes outside are denied; reads outside need approval.
- **Terminal**: argv only (no shell), binary allowlist with argument checks; `sudo`, `rm`, `curl`,
  `osascript`, `security`, `launchctl`… are refused; git mutations and running project code need
  approval; scrubbed environment; process groups killed on emergency stop.
- **Apple Events**: fixed templates with escaped string parameters; the model cannot author scripts.
- **Sandboxes**: no environment variables or secrets, network blocked unless dependency installs
  need package registries (domain allowlist), ephemeral, auto-stop, deleted at run end.
- **Accessibility**: `ui.press` refuses to press an element whose label differs from the one the
  planner named; consequential labels (send, pay, delete…) are classified as external.

## Audit and undo

- `audit/audit.jsonl` is append-only and hash-chained: each record's hash covers the previous hash
  and the record; edits or deletions break `AuditLog.verify` (`pnpm cmd audit`). Data is redacted.
- Tools declaring journal-backed undo record their inverse in the run's journal; undo
  replays newest-first and checks each precondition (e.g. a created file is only removed if its
  SHA-256 is unchanged). Backups of overwritten files live in the run's artifacts.
- The effect class alone is not a promise of automatic undo: draft form filling and some UI
  actions have no journal implementation. Plain-language step explanations use the tool's
  explicit `undo: 'journaled'` declaration. Data already sent to another service cannot be recalled.

## Explanations and Safety Lab

Policy decisions include a deterministic explanation of the action, resolved paths/recipients,
data sharing, automatic undo support and the permission decision. The executor forwards the same
explanation and concrete arguments into approval requests. The dashboard and overlay render these
facts without asking a model to justify its own action. Older saved runs without explanations
remain readable.

Dashboard → **Safety Lab** and `pnpm safety` run the same ten controlled evaluations using
temporary files, production policy/execution/approval/undo/cancellation code and local Chromium.
Task proposals and approval responses are scripted. Native app calls, credentials and cloud
providers are disabled in the lab. Reports preserve per-check results and task evidence; errors
and cancellations count in the denominator. This finite suite evaluates controls, not live-model
prompt-injection resistance. See [demo and methodology](hackbu-demo.md).

## Credentials

| Store | Used for |
|---|---|
| macOS Keychain (`com.commandos.credentials`, via the helper) | primary; set from Settings |
| Environment / `.env.local` (git-ignored) | development fallback |

Keychain operations are non-interactive: the helper disallows authentication UI for each
operation and scopes the legacy login-Keychain UI flag under a lock, restoring it afterward.
If macOS cannot authorize access silently, the operation returns an error. Reads use the
existing development environment fallback where configured; the app does not automatically
change Keychain ACLs, unlock the Keychain, or grant other applications access.

Settings enumerates credential metadata without retrieving every secret. Credential reads
and index loads coalesce concurrent requests, and missing/blocked reads are cached until
explicit invalidation or replacement. Metadata marked “saved” is not a claim that the secret
has been read or its provider has been verified. Secret values remain in the runtime process.

`build:helper` preserves the signed installed helper when source, signing identity, installed
hash and signature are unchanged. A changed build is signed before atomically replacing the
executable. An optional `COMMANDOS_SIGN_IDENTITY` selects a configured signing identity;
otherwise the development build remains ad-hoc signed. A stable identifier alone does not
provide certificate-backed identity continuity across changed ad-hoc binaries.
