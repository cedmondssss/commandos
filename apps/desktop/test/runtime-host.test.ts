import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }));
import { RuntimeHost } from '../src/main/runtime-host';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), postMessage: vi.fn(), kill: vi.fn() });
  mock.fork.mockReturnValue(child);
  const host = new RuntimeHost({ entry: '/fixture/runtime.js', env: {}, onPush: vi.fn(), log: vi.fn() });
  host.start();
  return { child, host };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('emergency stop watchdog', () => {
  it('kills an unresponsive runtime within two seconds even when it never becomes ready', async () => {
    vi.useFakeTimers();
    const { child, host } = fixture();
    const stop = host.emergencyStop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await stop).toBe('hard');
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('accepts a prompt stop acknowledgement without killing the runtime', async () => {
    vi.useFakeTimers();
    const { child, host } = fixture();
    child.emit('message', { kind: 'ready' });
    const stop = host.emergencyStop();
    await vi.advanceTimersByTimeAsync(0);
    const request = child.postMessage.mock.calls[0]![0];
    child.emit('message', { kind: 'response', id: request.id, result: { ok: true } });
    expect(await stop).toBe('soft');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
