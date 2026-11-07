import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { defaultSettings, PolicyDecisionSchema, ApprovalRequestSchema } from '@commandos/contracts';
import { browserAttachFile, fsReadText, fsWriteText, gmailSend, visionAsk, webFillForm } from '@commandos/tools';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/policy';
import { makeExecutor } from './helpers';

describe('trusted action explanations', () => {
  const settings = { ...defaultSettings(), allowedRoots: ['/tmp/approved'] };

  it('explains resolved targets, permissions and actual journal support', () => {
    const decision = evaluatePolicy({ tool: fsWriteText, args: { path: '/tmp/approved/notes.txt', content: 'Hi', overwrite: false }, settings });
    expect(decision.action).toBe('allow');
    expect(decision.explanation?.targets.join()).toContain('notes.txt');
    expect(decision.explanation?.undo).toContain('Undo is recorded');
    expect(decision.explanation?.permission).toContain('Allowed by your current');
    const form = evaluatePolicy({ tool: webFillForm, args: { sessionId: 'fixture', fields: [{ selector: '#email', value: 'a' }], strategy: 'selector' }, settings });
    expect(form.effectClass).toBe('reversible_local');
    expect(form.explanation?.undo).toContain('no automatic undo');
  });

  it('foregrounds external recipients and never claims sent data can be undone', () => {
    const decision = evaluatePolicy({ tool: gmailSend, args: { to: 'judge@example.invalid', subject: 'Hello', body: 'Demo' }, settings, claimedRisk: 'none' });
    expect(decision.action).toBe('require_approval');
    expect(decision.explanation?.targets).toContain('Recipient: judge@example.invalid');
    expect(decision.explanation?.undo).toContain('cannot recall data');
    expect(decision.explanation?.permission).toContain('Your approval is required');
    const attachment = evaluatePolicy({ tool: browserAttachFile, args: { path: '/tmp/approved/photo.png', site: 'Qwen', browser: 'Google Chrome' }, settings });
    expect(attachment.explanation?.targets).toContain('Site: Qwen');
  });

  it('discloses model egress even when the effect class is read', () => {
    const decision = evaluatePolicy({ tool: visionAsk, args: { imagePath: '/tmp/approved/photo.png', question: 'Describe it', wantBox: false }, settings });
    expect(decision.effectClass).toBe('read');
    expect(decision.explanation?.dataFlow).toContain('Images go to the model provider');
    expect(decision.explanation?.undo).toContain('cannot recall data');
    const read = evaluatePolicy({ tool: fsReadText, args: { path: '/tmp/approved/a.txt', maxBytes: 100 }, settings });
    expect(read.explanation?.dataFlow).toContain('no transfer');
  });

  it('carries concrete bound arguments and the same explanation into approval IPC', async () => {
    const h = await makeExecutor([fsReadText, fsWriteText], { settings: { autoApproveReversibleMax: 0 }, onApproval: (broker, id) => broker.respond(id, 'deny') });
    const path = join(h.dir, 'specific.txt');
    const source = join(h.dir, 'source.txt');
    await writeFile(source, 'Specific content');
    h.executor.addPlan({ goal: 'Write a file', tasks: [
      { id: 'read', tool: 'fs.readText', args: { path: source } },
      { id: 'write', tool: 'fs.writeText', args: { path, content: '', overwrite: false }, bind: [{ arg: 'content', from: 'read.output.text' }] },
    ] });
    h.executor.seal(); await h.executor.done();
    const event = h.events.find((e) => e.type === 'approval_requested');
    if (!event || event.type !== 'approval_requested') throw new Error('Missing approval');
    const approval = ApprovalRequestSchema.parse(event.approval);
    expect(approval.preview.payload).toEqual({ path, content: 'Specific content', overwrite: false });
    expect(approval.explanation).toEqual(h.executor.get('write')?.policy?.explanation);
    expect(approval.explanation?.targets.join()).toContain('specific.txt');
  });

  it('continues to read policy records created before explanations existed', () => {
    expect(PolicyDecisionSchema.safeParse({ action: 'allow', effectClass: 'read', risk: 'none', irreversible: false, reasons: [] }).success).toBe(true);
  });
});
