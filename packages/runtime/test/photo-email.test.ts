import { join } from 'node:path';
import { appsLaunch, gmailCompose, gmailSend, photoBoothTakePhoto, ToolError } from '@commandos/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRuntime } from '../src/runtime';
import { tempDir } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('spoken photo-email workflow', () => {
  it.each(['approve', 'deny', 'uncertain'] as const)('keeps the exact photo bound and does no model planning: %s', async (outcome) => {
    const dir = await tempDir('commandos-photo-email-');
    const path = join(dir, 'Photo on 10-16-26 at 12.55\u202fPM.jpg');
    vi.spyOn(appsLaunch, 'run').mockResolvedValue({ bundleId: 'com.apple.PhotoBooth', pid: 42 });
    vi.spyOn(appsLaunch, 'verify').mockResolvedValue([{ label: 'Photo Booth open', ok: true }]);
    const photo = vi.spyOn(photoBoothTakePhoto, 'run').mockResolvedValue({ path, name: path.split('/').at(-1)! });
    const compose = vi.spyOn(gmailCompose, 'run').mockResolvedValue({ to: 'me@example.com', subject: 'Photo', body: '', account: 'me@example.com', windowTitle: 'Compose Mail', attached: [path] });
    const send = vi.spyOn(gmailSend, 'run');
    if (outcome === 'uncertain') send.mockRejectedValue(new ToolError('send_unverified', 'Gmail did not confirm sending. Check Sent before retrying.'));
    else send.mockResolvedValue({ sent: true, confirmation: 'Gmail confirmed the message was sent' });
    const rt = await CommandRuntime.create({ dataDir: join(dir, 'data'), helperPath: '/nonexistent', useKeychain: false,
      telemetry: false, revealResults: false, env: {}, settingsOverride: { allowedRoots: [dir, '~/Pictures/Photo Booth Library/Pictures'] },
    });
    vi.spyOn(rt, 'getModels').mockResolvedValue(null);
    let approvals = 0;
    rt.on('run', (e) => {
      if (e.type === 'approval_requested') { approvals++; rt.respondApproval(e.approval.id, outcome === 'deny' ? 'deny' : 'approve'); }
    });
    try {
      const id = await rt.submit('Open Photo Booth, take a picture, and send an email to myself.', 'text');
      const result = await rt.waitForRun(id);
      const { events } = await rt.getRun(id);
      expect(events.find((e) => e.type === 'route')).toMatchObject({ decision: { mode: 'fast', via: 'grammar' } });
      expect(events.filter((e) => e.type === 'model_call')).toHaveLength(0);
      expect(photo).toHaveBeenCalledTimes(1);
      expect(compose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: 'me', subject: 'Photo', body: '', attachments: [path] }), expect.anything());
      expect(approvals).toBe(1);
      if (outcome === 'deny') {
        expect(send).not.toHaveBeenCalled();
        expect(result.state).toBe('partial');
      } else {
        expect(send).toHaveBeenCalledExactlyOnceWith({ to: 'me@example.com', subject: 'Photo', body: '' }, expect.anything());
        expect(result.state).toBe(outcome === 'uncertain' ? 'partial' : 'succeeded');
        if (outcome === 'uncertain') expect(result.summary).toContain('Check Sent');
      }
    } finally { await rt.shutdown(); }
  });
});
