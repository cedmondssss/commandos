import { userInfo } from 'node:os';
import { AgentMemory, getContextApiPrefix, Transport } from '@surrealdb/memory';
import { z } from 'zod';
import { containsSecret, redactValue } from './redaction';

export interface MemoryConfig {
  endpoint: string;
  context: string;
  apiKey: string;
}

/** Environment fingerprint a procedure depended on; a mismatch invalidates FAST replay. */
export const FingerprintSchema = z.object({
  tools: z.record(z.string(), z.string()),
  apps: z.record(z.string(), z.string()),
  sites: z.record(z.string(), z.string()),
  os: z.string(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const ProcedureSchema = z.object({
  kind: z.literal('commandos.procedure'),
  version: z.literal(1),
  id: z.string(),
  intent: z.string(),
  command: z.string(),
  summary: z.string(),
  /** 'template' replays a FAST template with slots; 'plan' replays concrete task specs */
  mode: z.enum(['template', 'plan']),
  template: z.string().nullable(),
  slots: z.record(z.string(), z.unknown()).nullable(),
  tasks: z.array(z.record(z.string(), z.unknown())).nullable(),
  /** literal argument values the user is likely to change on replay (path → description) */
  parameters: z.array(z.object({ name: z.string(), value: z.string(), description: z.string() })),
  fingerprint: FingerprintSchema,
  stats: z.object({ successes: z.number().int(), failures: z.number().int(), avgMs: z.number(), lastVerifiedAt: z.string() }),
  runId: z.string(),
  /** stale procedures are never replayed in FAST mode; they only inform planning */
  status: z.enum(['active', 'stale']).default('active'),
  updatedAt: z.string().default(() => new Date(0).toISOString()),
});
export type Procedure = z.infer<typeof ProcedureSchema>;

export interface RecalledProcedure {
  procedure: Procedure;
  memoryId: string;
  score: number;
}

export const ProcedureSourceSchema = z.object({ procedureId: z.string().regex(/^proc_[a-zA-Z0-9_-]+$/), sessionId: z.string().min(1), memoryId: z.string().nullable() });
export type ProcedureSource = z.infer<typeof ProcedureSourceSchema>;

export class MemorySecretError extends Error {
  constructor() {
    super('refusing to store memory that contains credentials or secrets');
    this.name = 'MemorySecretError';
  }
}

const MARKER = 'COMMANDOS_PROCEDURE_V1 ';

/**
 * SurrealDB Agent Memory for CommandOS: verified procedures (stored verbatim, infer=none, so
 * replay gets exact JSON back) and run outcomes, under per-user scopes. Every write passes a
 * secret filter first; passwords and keys are never stored.
 */
export class ProcedureMemory {
  readonly client: AgentMemory;
  readonly scope: string;
  private scopesReady: Promise<void> | null = null;
  private readonly transport: Transport;
  private readonly apiPrefix: string;

  constructor(cfg: MemoryConfig, user = userInfo().username.replace(/[^a-z0-9_-]/gi, '-').toLowerCase() || 'local') {
    const options = { endpoint: cfg.endpoint.replace(/\/+$/, ''), context: cfg.context, apiKey: cfg.apiKey, timeoutMs: 20_000 };
    this.client = new AgentMemory(options);
    this.transport = new Transport(options);
    this.apiPrefix = getContextApiPrefix(cfg.context);
    this.scope = `app/commandos/user/${user}`;
  }

  ensureScopes(): Promise<void> {
    this.scopesReady ??= (async () => {
      for (const path of ['app/commandos', this.scope]) {
        try {
          await this.client.scopes.register({ path, displayName: path === this.scope ? 'CommandOS user memory' : 'CommandOS', description: 'Procedures and outcomes recorded by CommandOS' });
        } catch (e) {
          const status = (e as { status?: number }).status;
          if (status !== 409 && status !== 400) throw e;
        }
      }
    })().catch((e) => {
      this.scopesReady = null;
      throw e;
    });
    return this.scopesReady;
  }

  private guard(text: string): void {
    if (containsSecret(text)) throw new MemorySecretError();
  }

  async rememberProcedure(p: Procedure): Promise<{ memoryId: string | null; sessionId: string }> {
    // secrets are refused before anything goes over the network
    this.guard(JSON.stringify(p));
    const safe = redactValue(p) as Procedure;
    const text = `${MARKER}${JSON.stringify(safe)}`;
    await this.ensureScopes();
    const r = await this.client.remember(text, {
      infer: 'none',
      scopes: [this.scope],
      memoryCategory: 'knowledge',
      labels: ['kind=procedure', `intent=${p.intent}`, `procedure=${p.id}`],
    });
    return { memoryId: r.chunkId ?? r.turnId ?? null, sessionId: r.sessionId };
  }

  async rememberOutcome(o: { intent: string; command: string; success: boolean; summary: string; runId: string; durationMs: number; error?: string }): Promise<void> {
    const text = `CommandOS run ${o.success ? 'succeeded' : 'failed'} (${o.intent}): “${o.command}” — ${o.summary}${o.error ? ` Error: ${o.error}` : ''} [run ${o.runId}, ${Math.round(o.durationMs)} ms]`;
    this.guard(text);
    await this.ensureScopes();
    await this.client.remember(text, {
      infer: 'none',
      scopes: [this.scope],
      // Episodic turns are stored by remember(); this field classifies any working context.
      // The hosted API accepts identity, knowledge and context, not "episodic".
      memoryCategory: 'context',
      labels: ['kind=outcome', `intent=${o.intent}`, `result=${o.success ? 'success' : 'failure'}`],
    });
  }

  private async sourceTurns(sessionId: string): Promise<Array<{ id: string; content: string }>> {
    const response = await this.transport.requestJson('GET', `${this.apiPrefix}/sessions/${encodeURIComponent(sessionId)}/turns`, { query: { limit: 100 } });
    return z.object({ turns: z.array(z.object({ id: z.string(), content: z.string() })) }).parse(response).turns;
  }

  /** Read a known procedure from its original cloud source without a semantic search round trip. */
  async readProcedure(source: ProcedureSource): Promise<RecalledProcedure | null> {
    for (const turn of await this.sourceTurns(source.sessionId)) {
      const idx = turn.content.indexOf(MARKER);
      if (idx < 0) continue;
      try {
        const procedure = ProcedureSchema.parse(JSON.parse(turn.content.slice(idx + MARKER.length)));
        if (procedure.id === source.procedureId) return { procedure, memoryId: source.memoryId ?? turn.id, score: 1 };
      } catch { /* A source turn must contain a complete, validated procedure. */ }
    }
    return null;
  }

  /** Recalls stored procedures relevant to a command, newest/best first. */
  async recallProcedures(query: string, k = 5): Promise<RecalledProcedure[]> {
    await this.ensureScopes();
    const r = await this.client.recall(query, { k: Math.max(k * 3, 10), labels: ['kind=procedure'], lens: [this.scope] });
    const out: RecalledProcedure[] = [];
    const add = (text: string, memoryId: string, score: number): boolean => {
      const idx = text.indexOf(MARKER);
      if (idx < 0) return false;
      try {
        const parsed = ProcedureSchema.safeParse(JSON.parse(text.slice(idx + MARKER.length)));
        if (!parsed.success) return false;
        // several versions of one procedure may exist; keep the most recently updated
        const existing = out.findIndex((o) => o.procedure.id === parsed.data.id);
        if (existing < 0) out.push({ procedure: parsed.data, memoryId, score });
        else if ((out[existing] as RecalledProcedure).procedure.updatedAt < parsed.data.updatedAt) out[existing] = { procedure: parsed.data, memoryId, score: Math.max(score, (out[existing] as RecalledProcedure).score) };
        return true;
      } catch {
        return false;
      }
    };
    // Search passages can split a JSON record in the middle of a string. Resolve their
    // provenance to the original immutable turn instead of executing incomplete fragments.
    const sources = new Map<string, { sessionId: string; turnId: string; memoryId: string; score: number }>();
    for (const hit of [...r.hits, ...(r.contextHits ?? [])]) {
      if (add(hit.text, hit.id, hit.score)) continue;
      const ref = hit.resource;
      if (ref?.kind !== 'session' || !ref.turnId) continue;
      const key = `${ref.sessionId}/${ref.turnId}`;
      if (!sources.has(key) && sources.size < Math.max(k, 5)) sources.set(key, { sessionId: ref.sessionId, turnId: ref.turnId, memoryId: hit.id, score: hit.score });
    }
    const originals = await Promise.all([...sources.values()].map(async (source) => {
      const turns = await this.sourceTurns(source.sessionId);
      const original = turns.find((t) => t.id === source.turnId || t.id.endsWith(`:${source.turnId}`));
      return { source, text: original?.content };
    }));
    for (const { source, text } of originals) if (text) add(text, source.memoryId, source.score);
    return out.sort((a, b) => b.score - a.score).slice(0, k);
  }

  async forgetProcedure(id: string): Promise<void> {
    await this.client.forget(`CommandOS procedure ${id}`, { purge: true });
  }
}
