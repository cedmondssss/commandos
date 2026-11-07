import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSettings, type Settings } from '@commandos/contracts';
import { type AnyTool, HelperClient, ToolRegistry } from '@commandos/tools';
import { ApprovalBroker } from '../src/approvals';
import { type ExecutorEvent, RunExecutor } from '../src/executor';
import { UndoJournal } from '../src/journal';

export async function tempDir(prefix = 'commandos-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export interface Harness {
  executor: RunExecutor;
  registry: ToolRegistry;
  events: ExecutorEvent[];
  approvals: ApprovalBroker;
  controller: AbortController;
  settings: Settings;
  dir: string;
}

/** Real executor wired to a registry of the given tools (no helper process needed). */
export async function makeExecutor(
  tools: AnyTool[],
  opts: { settings?: Partial<Settings>; dryRun?: boolean; onApproval?: (b: ApprovalBroker, id: string) => void } = {},
): Promise<Harness> {
  const dir = await tempDir();
  const settings: Settings = { ...defaultSettings(), allowedRoots: [dir], ...opts.settings };
  const events: ExecutorEvent[] = [];
  const controller = new AbortController();
  // biome-ignore lint/style/useConst: assigned after construction
  let approvals: ApprovalBroker;
  approvals = new ApprovalBroker({
    requested: (req) => {
      events.push({ type: 'approval_requested', approval: req });
      opts.onApproval?.(approvals, req.id);
    },
    resolved: (req, o) => events.push({ type: 'approval_resolved', approvalId: req.id, decision: o.decision, by: o.by }),
  });
  const registry = new ToolRegistry().register(...tools);
  const executor = new RunExecutor(
    {
      registry,
      settings: () => settings,
      helper: new HelperClient('/nonexistent/helper'),
      models: () => null,
      providers: { get: async () => Promise.reject(new Error('no providers in tests')) },
      approvals,
      emit: (e) => events.push(e),
      audit: () => {},
    },
    {
      runId: 'run_test',
      artifactsDir: join(dir, 'artifacts'),
      journal: new UndoJournal(join(dir, 'journal.jsonl'), 'run_test'),
      dryRun: opts.dryRun ?? false,
      signal: controller.signal,
      deadlineAt: Date.now() + 60_000,
    },
  );
  return { executor, registry, events, approvals, controller, settings, dir };
}

export function statesOf(events: ExecutorEvent[], taskId: string): string[] {
  return events.flatMap((e) => (e.type === 'task_state' && e.taskId === taskId ? [e.state] : []));
}
