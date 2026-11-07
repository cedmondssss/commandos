import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest } from '@commandos/contracts';

export interface ApprovalOutcome {
  decision: 'approved' | 'denied';
  by: 'user' | 'timeout' | 'policy' | 'cancel';
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalListener = {
  requested(req: ApprovalRequest): void;
  resolved(req: ApprovalRequest, outcome: ApprovalOutcome): void;
};

/** Holds pending approvals until the user answers; unanswered requests are denied on timeout. */
export class ApprovalBroker {
  private pending = new Map<string, PendingApproval>();

  constructor(private readonly listener: ApprovalListener) {}

  request(
    req: Omit<ApprovalRequest, 'id' | 'createdAt' | 'expiresAt'>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (signal?.aborted) return Promise.resolve({ decision: 'denied', by: 'cancel' });
    const now = Date.now();
    const full: ApprovalRequest = { ...req, id: `apr_${randomUUID()}`, createdAt: now, expiresAt: now + timeoutMs };
    return new Promise<ApprovalOutcome>((resolve) => {
      const finish = (o: ApprovalOutcome) => {
        const p = this.pending.get(full.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(full.id);
        signal?.removeEventListener('abort', onAbort);
        this.listener.resolved(full, o);
        resolve(o);
      };
      const onAbort = () => finish({ decision: 'denied', by: 'cancel' });
      const timer = setTimeout(() => finish({ decision: 'denied', by: 'timeout' }), timeoutMs);
      this.pending.set(full.id, { request: full, resolve: finish, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.listener.requested(full);
    });
  }

  respond(approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve({ decision: decision === 'approve' ? 'approved' : 'denied', by: 'user' });
    return true;
  }

  denyRun(runId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.request.runId === runId) p.resolve({ decision: 'denied', by: 'cancel' });
    }
  }

  denyAll(): void {
    for (const p of [...this.pending.values()]) p.resolve({ decision: 'denied', by: 'cancel' });
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get size(): number {
    return this.pending.size;
  }
}
