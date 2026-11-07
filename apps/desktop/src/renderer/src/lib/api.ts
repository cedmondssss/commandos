import type { MainApi, PushSchemas, RuntimeApi } from '@commandos/contracts';
import type { z } from 'zod';

type Api = typeof RuntimeApi & typeof MainApi;
export type Method = keyof Api;
export type Req<M extends Method> = z.input<Api[M]['req']>;
export type Res<M extends Method> = z.output<Api[M]['res']>;
export type PushChannel = keyof typeof PushSchemas;
export type Push<C extends PushChannel> = z.output<(typeof PushSchemas)[C]>;

interface Bridge {
  invoke(method: string, params: unknown): Promise<unknown>;
  sendAudio(chunk: Uint8Array): void;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    commandos: Bridge;
  }
}

function cleanError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  return new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}

export async function invoke<M extends Method>(method: M, params: Req<M>): Promise<Res<M>> {
  try {
    return (await window.commandos.invoke(method, params)) as Res<M>;
  } catch (e) {
    throw cleanError(e);
  }
}

export function onPush<C extends PushChannel>(channel: C, listener: (payload: Push<C>) => void): () => void {
  return window.commandos.on(channel, listener as (p: unknown) => void);
}

export function sendAudio(chunk: Uint8Array): void {
  window.commandos.sendAudio(chunk);
}
