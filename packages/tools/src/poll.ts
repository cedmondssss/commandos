/** Abortable waits remove their listener when they finish, including on long polling loops. */
export async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Check immediately, then stop as soon as the real state is ready. Cancellation never retries. */
export async function pollUntil<T>(read: () => Promise<T | null>, timeoutMs: number, signal: AbortSignal, everyMs = 150, retryErrors = true): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const value = await read().catch((error: unknown) => {
      signal.throwIfAborted();
      if (!retryErrors || (error instanceof Error && error.name === 'AbortError')) throw error;
      return null;
    });
    signal.throwIfAborted();
    if (value !== null) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await delay(Math.min(everyMs, remaining), signal);
  }
}
