import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicCapture } from '../src/renderer/src/lib/mic';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(opts: { media?: Promise<unknown>; module?: Promise<void> } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const close = vi.fn(async () => {});
  const connect = vi.fn();
  const node = { port: { close: vi.fn(), onmessage: null as null | ((e: { data: ArrayBuffer }) => void) }, disconnect: vi.fn() };
  const context = vi.fn(function () { return { audioWorklet: { addModule: () => opts.module ?? Promise.resolve() }, createMediaStreamSource: () => ({ connect }), close }; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => opts.media ?? Promise.resolve(stream) } });
  vi.stubGlobal('document', { baseURI: 'https://fixture.local/' });
  vi.stubGlobal('AudioContext', context);
  vi.stubGlobal('AudioWorkletNode', vi.fn(function () { return node; }));
  return { capture: new MicCapture(), track, stream, context, close, connect, node };
}
afterEach(() => vi.unstubAllGlobals());
describe('microphone cancellation without microphone hardware', () => {
  it('closes a media stream that resolves after Stop and never creates an audio context', async () => {
    const media = deferred<unknown>();
    const h = fixture({ media: media.promise });
    const start = h.capture.start(vi.fn());
    h.capture.stop(); media.resolve(h.stream); await start;
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.context).not.toHaveBeenCalled();
  });
  it('releases the stream immediately while the worklet is still loading', async () => {
    const module = deferred<void>();
    const h = fixture({ module: module.promise });
    const start = h.capture.start(vi.fn());
    await vi.waitFor(() => expect(h.context).toHaveBeenCalled());
    h.capture.stop();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    module.resolve(); await start;
    expect(h.connect).not.toHaveBeenCalled();
  });
  it('stops active capture and discards already queued audio callbacks', async () => {
    const h = fixture(); const chunk = vi.fn();
    await h.capture.start(chunk);
    const late = h.node.port.onmessage!;
    late({ data: new ArrayBuffer(8) });
    h.capture.stop(); late({ data: new ArrayBuffer(8) });
    expect(chunk).toHaveBeenCalledOnce();
    expect(h.track.stop).toHaveBeenCalledOnce();
    expect(h.node.disconnect).toHaveBeenCalledOnce();
    expect(h.node.port.close).toHaveBeenCalledOnce();
  });
  it('releases the microphone when audio setup fails', async () => {
    const module = deferred<void>();
    const h = fixture({ module: module.promise });
    h.context.mockImplementationOnce(function () { throw new Error('Audio device unavailable'); });
    module.resolve();
    await expect(h.capture.start(vi.fn())).rejects.toThrow('Audio device unavailable');
    expect(h.track.stop).toHaveBeenCalledOnce();
  });
});
