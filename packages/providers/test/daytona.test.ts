import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@daytona/sdk', () => ({ Daytona: class { create = sdk.create; } }));
import { SandboxService } from '../src/daytona';

describe('sandbox lifecycle', () => {
  beforeEach(() => vi.resetAllMocks());

  it('retains failed cleanup handles, retries, and waits for confirmed destruction', async () => {
    const remove = vi.fn().mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce(undefined);
    sdk.create.mockResolvedValue({ id: 'sandbox-1', getWorkDir: async () => '/home/daytona', delete: remove });
    const svc = new SandboxService({ apiKey: 'test' });
    await svc.create({ runId: 'r', network: 'none' });
    await expect(svc.destroyAll()).rejects.toThrow(/handles retained/);
    expect(svc.activeIds()).toEqual(['sandbox-1']);
    expect(await svc.destroyAll()).toBe(1);
    expect(remove).toHaveBeenLastCalledWith(60, true);
    expect(svc.activeIds()).toEqual([]);
  });

  it('coalesces concurrent cleanup requests for one sandbox', async () => {
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    sdk.create.mockResolvedValue({ id: 'sandbox-1', getWorkDir: async () => '/home/daytona', delete: remove });
    const svc = new SandboxService({ apiKey: 'test' });
    await svc.create({ runId: 'r', network: 'none' });
    const pending = Promise.all([svc.destroy('sandbox-1'), svc.destroy('sandbox-1')]);
    expect(remove).toHaveBeenCalledTimes(1);
    finish();
    expect(await pending).toEqual([true, true]);
    expect(await svc.destroy('sandbox-1')).toBe(false);
  });
});
