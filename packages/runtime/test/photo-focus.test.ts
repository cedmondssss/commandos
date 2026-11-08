import { appsLaunch, photoBoothTakePhoto, workspaceOpen, workspaceReveal, type AnyTool } from '@commandos/tools';
import { describe, expect, it } from 'vitest';
import { makeExecutor } from './helpers';

const library = '~/Pictures/Photo Booth Library/Pictures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('photo capture owns foreground focus', () => {
  const actions = [
    { tool: appsLaunch, args: { bundleId: 'com.apple.MobileSMS' }, output: { pid: 73, bundleId: 'com.apple.MobileSMS' } },
    { tool: workspaceOpen, args: { url: 'https://github.com', bundleId: 'com.google.Chrome' }, output: { opened: true } },
    { tool: workspaceReveal, args: { paths: [library] }, output: { ok: true } },
  ];

  it.each(actions)('keeps $tool.id queued when an incremental planner opens another app during capture', async ({ tool, args, output }) => {
    const started = deferred();
    const capture = deferred();
    const order: string[] = [];
    const photo = { ...photoBoothTakePhoto, async run() {
      order.push('photo started');
      started.resolve();
      await capture.promise;
      order.push('photo saved');
      return { path: `${library}/photo.jpg`, name: 'photo.jpg' };
    } };
    const action = { ...tool, async run() { order.push('other app opened'); return output; }, async verify() { return []; } } as AnyTool;
    const h = await makeExecutor([photo, action], { settings: { allowedRoots: [library] } });
    h.executor.addTask({ id: 'photo', tool: photo.id, args: {} });
    await started.promise;
    h.executor.addTask({ id: 'open', tool: action.id, args });
    h.executor.seal();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(order).toEqual(['photo started']);
    } finally {
      capture.resolve();
      await h.executor.done();
    }
    expect(h.executor.get('photo')?.state).toBe('succeeded');
    expect(h.executor.get('open')?.state).toBe('succeeded');
    expect(order).toEqual(['photo started', 'photo saved', 'other app opened']);
  });

  it('can still launch an app in the background while capture is waiting', async () => {
    const started = deferred();
    const capture = deferred();
    const opened = deferred();
    const photo = { ...photoBoothTakePhoto, async run() {
      started.resolve();
      await capture.promise;
      return { path: `${library}/photo.jpg`, name: 'photo.jpg' };
    } };
    const launch = { ...appsLaunch, async run() { opened.resolve(); return { pid: 73, bundleId: 'com.apple.MobileSMS' }; }, async verify() { return []; } };
    const h = await makeExecutor([photo, launch], { settings: { allowedRoots: [library] } });
    h.executor.addTask({ id: 'photo', tool: photo.id, args: {} });
    await started.promise;
    h.executor.addTask({ id: 'open', tool: launch.id, args: { bundleId: 'com.apple.MobileSMS', activate: false } });
    h.executor.seal();
    try { await opened.promise; } finally { capture.resolve(); }
    expect((await h.executor.done()).succeeded).toBe(2);
  });
});
