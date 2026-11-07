import {
  type EffectClass,
  maxRisk,
  RISK_ORDER,
  type PolicyAction,
  type PolicyDecision,
  type RiskLevel,
  type Settings,
} from '@commandos/contracts';
import { type AnyTool, displayPath, isWithin, resolveEffectClass, resolveRisk, resolveUserPath } from '@commandos/tools';
import { explainAction } from './explain';

export interface PolicyInput {
  tool: AnyTool;
  args: unknown;
  settings: Settings;
  /** risk the planner claimed; advisory, can only raise the computed risk */
  claimedRisk?: RiskLevel;
  /** extra readable locations, e.g. the run's own artifacts (its screen captures) */
  extraReadRoots?: string[];
  /** data egress the user already approved earlier in this run */
  consents?: ReadonlySet<string>;
}

const ORDER: Record<PolicyAction, number> = { allow: 0, require_approval: 1, deny: 2 };

/**
 * Least-privilege policy. The model never authorizes its own actions: decisions come from the
 * tool contract (effects, effect class, base risk), the concrete arguments (paths, item counts)
 * and the user's settings. Deletions, external effects, irreversible local effects, privileged
 * commands, payments and data egress (per consent settings) require approval.
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { tool, args, settings } = input;
  const effectClass: EffectClass = resolveEffectClass(tool, args);
  let risk = maxRisk(resolveRisk(tool, args), input.claimedRisk);
  let action: PolicyAction = 'allow';
  const reasons: string[] = [];
  const escalate = (to: PolicyAction, reason: string, minRisk?: RiskLevel) => {
    if (ORDER[to] > ORDER[action]) action = to;
    reasons.push(reason);
    if (minRisk) risk = maxRisk(risk, minRisk);
  };

  const roots = settings.allowedRoots.map(resolveUserPath);
  const denied = settings.deniedPaths.map(resolveUserPath);
  const access = tool.paths?.(args) ?? { read: [], write: [] };
  for (const raw of [...access.read, ...access.write]) {
    const p = resolveUserPath(raw);
    const hit = denied.find((d) => isWithin(d, p));
    if (hit) escalate('deny', `${displayPath(p)} is inside a protected location (${displayPath(hit)})`, 'critical');
  }
  for (const raw of access.write) {
    const p = resolveUserPath(raw);
    if (!roots.some((r) => isWithin(r, p))) escalate('deny', `${displayPath(p)} is outside the folders CommandOS may change`, 'high');
  }
  const readRoots = [...roots, ...(input.extraReadRoots ?? []).map(resolveUserPath)];
  for (const raw of access.read) {
    const p = resolveUserPath(raw);
    if (!readRoots.some((r) => isWithin(r, p))) escalate('require_approval', `reads ${displayPath(p)}, outside the allowed folders`, 'medium');
  }

  const effects = new Set(tool.effects);
  // an email whose every recipient is the user's own saved address is not a send to anyone else
  const self = settings.userEmail?.toLowerCase();
  const recipients = tool.recipients?.(args) ?? [];
  const toSelfOnly = Boolean(self) && !settings.confirmSelfEmail && recipients.length > 0 && recipients.every((r) => r.trim().toLowerCase() === self);
  if (toSelfOnly) risk = 'low';
  if (effects.has('payment')) escalate('require_approval', 'involves a payment', 'critical');
  if (effects.has('privileged')) escalate('require_approval', 'runs a privileged command', 'high');
  if (effects.has('external_send') && !toSelfOnly) escalate('require_approval', 'sends something outside this Mac', 'high');
  if (effects.has('fs_delete')) escalate('require_approval', 'deletes files (moves them to the Trash)', 'medium');
  if (effectClass === 'external' && !toSelfOnly) escalate('require_approval', 'has external effects that cannot be undone', 'high');
  // low-impact irreversible UI actions (e.g. pressing "New Document") run without a prompt;
  // anything irreversible at medium risk or above needs confirmation
  if (effectClass === 'irreversible_local' && RISK_ORDER[risk] >= RISK_ORDER.medium) escalate('require_approval', 'cannot be undone');

  if (tool.egress) {
    const mode = tool.egress === 'content' ? settings.contentToModel : tool.egress === 'images' ? settings.imagesToModel : 'ask';
    const what =
      tool.egress === 'content' ? 'extracted text to the model provider' : tool.egress === 'images' ? 'images to the model provider' : 'files to a remote sandbox';
    if (mode === 'deny') escalate('deny', `sending ${what} is disabled in Settings`, 'medium');
    else if (mode === 'ask' && !input.consents?.has(tool.egress)) escalate('require_approval', `sends ${what}`, 'medium');
  }

  const count = tool.itemCount?.(args);
  if (effectClass === 'reversible_local' && count !== undefined && count > settings.autoApproveReversibleMax) {
    escalate('require_approval', `changes ${count} items (auto-approve limit is ${settings.autoApproveReversibleMax})`, 'medium');
  }
  if ((risk === 'high' || risk === 'critical') && action === 'allow') escalate('require_approval', `risk is ${risk}`);

  const decision: PolicyDecision = {
    action,
    effectClass,
    risk,
    irreversible: effectClass === 'irreversible_local' || effectClass === 'external',
    reasons,
  };
  decision.explanation = explainAction(tool, args, decision);
  return decision;
}
