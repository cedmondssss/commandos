import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn(), connect: vi.fn(), remove: vi.fn() }));
vi.mock('anchorbrowser', () => ({ createAnchorbrowserClient: () => ({}), connectBrowser: sdk.connect, agentTask: vi.fn(), Sessions: { createSession: sdk.create, deleteSession: sdk.remove } }));
import { BrowserHub } from '../src/browser';

function fakeBrowser() {
  const page = { goto: vi.fn().mockResolvedValue(undefined), screenshot: vi.fn().mockResolvedValue(Buffer.from('preview')) };
  const context = { addInitScript: async () => {}, pages: () => [page] };
  return { page, contexts: () => [context], close: vi.fn().mockResolvedValue(undefined) };
}

describe('Anchor session lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdk.create.mockResolvedValue({ data: { id: 'remote', live_view_url: 'https://live.anchorbrowser.io/inspector.html?sessionId=remote' } });
    sdk.remove.mockResolvedValue({});
    sdk.connect.mockResolvedValue(fakeBrowser());
  });

  it('keeps a failed remote deletion tracked and retries instead of claiming it closed', async () => {
    const hub = new BrowserHub(async () => 'test');
    const session = await hub.open({ runId: 'r', kind: 'anchor' });
    expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({ body: { session: { live_view: { read_only: true } } } });
    sdk.remove.mockRejectedValueOnce(new Error('temporary outage'));
    await expect(hub.close(session.id)).rejects.toThrow(/temporary outage/);
    expect(hub.openIds()).toEqual([session.id]);
    expect(await hub.closeAll('r')).toBe(1);
    expect(hub.openIds()).toEqual([]);
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });

  it('cleans up an unconnected session, retains a failed orphan for retry, and hides the CDP URL', async () => {
    const hub = new BrowserHub(async () => 'test');
    sdk.connect.mockRejectedValue(new Error('Failed wss://connect.anchorbrowser.io?apiKey=private-value&sessionId=remote'));
    sdk.remove.mockRejectedValueOnce(new Error('temporary outage'));
    await expect(hub.open({ runId: 'r', kind: 'anchor' })).rejects.toThrow('Failed [REDACTED_ANCHOR_CDP_URL]');
    expect(await hub.closeAll('other-run')).toBe(0);
    expect(await hub.closeAll('r')).toBe(1);
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });

  it('ends a remote session if navigation fails after connecting', async () => {
    const browser = fakeBrowser();
    browser.page.goto.mockRejectedValue(new Error('navigation failed'));
    sdk.connect.mockResolvedValue(browser);
    const hub = new BrowserHub(async () => 'test');
    await expect(hub.open({ runId: 'r', kind: 'anchor', url: 'https://example.com' })).rejects.toThrow('navigation failed');
    expect(browser.close).toHaveBeenCalled();
    expect(sdk.remove).toHaveBeenCalledOnce();
    expect(hub.openIds()).toEqual([]);
  });

  it('coalesces parallel closes and explicitly requests API errors', async () => {
    const hub = new BrowserHub(async () => 'test');
    const session = await hub.open({ runId: 'r', kind: 'anchor' });
    await Promise.all([hub.close(session.id), hub.close(session.id)]);
    expect(sdk.remove).toHaveBeenCalledOnce();
    expect(sdk.remove.mock.calls[0]?.[0]).toMatchObject({ path: { session_id: 'remote' }, throwOnError: true });
  });

  it('previews only an existing Anchor session owned by the requested run', async () => {
    const browser = fakeBrowser(); sdk.connect.mockResolvedValue(browser);
    const hub = new BrowserHub(async () => 'test');
    const session = await hub.open({ runId: 'owner', kind: 'anchor' });
    await expect(hub.preview('another-run', session.id)).rejects.toThrow('does not belong');
    expect(browser.page.screenshot).not.toHaveBeenCalled();
    expect(await hub.preview('owner', session.id)).toEqual(Buffer.from('preview'));
    expect(browser.page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ type: 'jpeg', timeout: 1500 }));
    await hub.close(session.id);
    expect(await hub.preview('owner', session.id)).toBeNull();
  });
});
