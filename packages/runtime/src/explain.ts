import type { ActionExplanation, PolicyDecision } from '@commandos/contracts';
import { type AnyTool, displayPath, resolveUserPath } from '@commandos/tools';

export function explainAction(tool: AnyTool, args: unknown, decision: PolicyDecision): ActionExplanation {
  const access = tool.paths?.(args) ?? { read: [], write: [] };
  const recipients = tool.recipients?.(args) ?? [];
  const values = args as Record<string, unknown>;
  const targets = [
    ...access.read.map((p) => `Read: ${displayPath(resolveUserPath(p))}`),
    ...access.write.map((p) => `Change: ${displayPath(resolveUserPath(p))}`),
    ...recipients.map((r) => `Recipient: ${r}`),
    ...(tool.egress === 'content' || tool.egress === 'images' ? ['Service: configured model provider'] : []),
    ...(tool.egress === 'files' ? ['Service: remote sandbox provider'] : []),
    ...(typeof values.site === 'string' ? [`Site: ${values.site}`] : []),
    ...(typeof values.url === 'string' ? [`Page: ${values.url}`] : []),
    ...(typeof values.sessionId === 'string' ? [`Browser session: ${values.sessionId}`] : []),
    ...(typeof values.bundleId === 'string' ? [`App: ${values.bundleId}`] : []),
  ];
  const dataFlow = tool.egress === 'content' ? 'Extracted text goes to the model provider.'
    : tool.egress === 'images' ? 'Images go to the model provider.'
    : tool.egress === 'files' ? 'Repository files go to a remote sandbox.'
    : tool.effects.includes('external_send') || tool.effects.includes('data_egress')
      ? 'This action sends data to another app or service. Review the destination and exact arguments.'
    : tool.effects.includes('model_call') ? 'This action calls the model provider with its input.'
    : tool.effects.includes('network_read') ? 'This contacts the requested website; the service receives the request.'
    : tool.effects.includes('remote_exec') ? 'This runs inside the selected remote sandbox.'
    : tool.effects.includes('ui_input') || tool.effects.includes('app_control')
      ? 'This operates another app. That app may communicate with its own services.'
    : 'The tool contract declares no transfer to an external service.';
  return {
    what: tool.preview?.(args).summary ?? tool.title,
    targets: [...new Set(targets)],
    dataFlow,
    undo: tool.egress || tool.effects.includes('data_egress') || tool.effects.includes('external_send') || decision.effectClass === 'external'
      ? 'CommandOS cannot recall data already sent to another app or service or automatically undo this external action.'
      : decision.effectClass === 'read' ? 'No file changes to undo for this read step.'
      : tool.undo === 'journaled' ? 'Undo is recorded for successful changes. Restore checks may refuse if the state has changed.'
      : 'CommandOS has no automatic undo for this step.',
    permission: decision.action === 'deny' ? `Blocked: ${decision.reasons.join('; ')}.`
      : decision.action === 'require_approval' ? `Your approval is required: ${decision.reasons.join('; ')}.`
      : 'Allowed by your current folder, risk, and data-sharing settings.',
  };
}
