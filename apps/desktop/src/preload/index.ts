import { contextBridge, ipcRenderer } from 'electron';

// The renderer is sandboxed: no Node, no Electron APIs. This bridge exposes exactly three
// capabilities — invoke a validated method, stream microphone PCM, and subscribe to pushes.
const PUSH_CHANNELS = new Set(['run:event', 'voice:event', 'app:status', 'ui:command']);
const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on('commandos:push', (_event, msg: { channel?: unknown; payload?: unknown }) => {
  if (!msg || typeof msg.channel !== 'string' || !PUSH_CHANNELS.has(msg.channel)) return;
  for (const l of listeners.get(msg.channel) ?? []) l(msg.payload);
});

const api = {
  invoke(method: string, params: unknown): Promise<unknown> {
    if (typeof method !== 'string' || method.length > 64) return Promise.reject(new Error('invalid method'));
    return ipcRenderer.invoke('commandos:invoke', { method, params });
  },
  sendAudio(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > 65_536) return;
    ipcRenderer.send('commandos:audio', chunk);
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!PUSH_CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  },
};

contextBridge.exposeInMainWorld('commandos', Object.freeze(api));
