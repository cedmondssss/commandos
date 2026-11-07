import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceState } from '@commandos/contracts';
import {
  AudioFormat,
  CommitStrategy,
  ElevenLabsClient,
  RealtimeEvents,
  type RealtimeConnection,
} from '@elevenlabs/elevenlabs-js';

export const SCRIBE_REALTIME_MODEL = 'scribe_v2_realtime';
export const SAMPLE_RATE = 16_000;

export interface TranscriberOptions {
  apiKey: string;
  commitStrategy: 'vad' | 'manual';
  vadSilenceSecs: number;
  languageCode?: string | null;
  keyterms?: string[];
}

export interface CommitMetrics {
  utteranceToCommitMs?: number;
  speechEndToCommitMs?: number;
  firstPartialMs?: number;
}

interface TranscriberEvents {
  state: [VoiceState, string | undefined];
  partial: [string];
  committed: [string, CommitMetrics];
  level: [number];
  error: [Error];
}

/** RMS of a 16-bit little-endian PCM chunk, normalized to [0, 1]. */
export function pcmRms(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const samples = Math.floor(chunk.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}

const SPEECH_RMS = 0.015;

/**
 * Streams microphone PCM to ElevenLabs Scribe v2 Realtime and emits partial and committed
 * transcripts. Tracks utterance timing so the runtime can report speech-to-transcript latency.
 */
export class RealtimeTranscriber extends EventEmitter<TranscriberEvents> {
  private connection: RealtimeConnection | null = null;
  private ready = false;
  private utteranceStartAt: number | null = null;
  private lastSpeechAt: number | null = null;
  private firstPartialAt: number | null = null;
  private pending: Uint8Array[] = [];

  constructor(private readonly opts: TranscriberOptions) {
    super();
  }

  get connected(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    if (this.connection) return;
    this.emit('state', 'connecting', undefined);
    const client = new ElevenLabsClient({ apiKey: this.opts.apiKey });
    const connection = await client.speechToText.realtime.connect({
      modelId: SCRIBE_REALTIME_MODEL,
      audioFormat: AudioFormat.PCM_16000,
      sampleRate: SAMPLE_RATE,
      commitStrategy: this.opts.commitStrategy === 'vad' ? CommitStrategy.VAD : CommitStrategy.MANUAL,
      ...(this.opts.commitStrategy === 'vad' ? { vadSilenceThresholdSecs: Math.min(3, Math.max(0.3, this.opts.vadSilenceSecs)) } : {}),
      ...(this.opts.languageCode ? { languageCode: this.opts.languageCode } : {}),
      ...(this.opts.keyterms?.length ? { keyterms: this.opts.keyterms.slice(0, 50) } : {}),
    });
    this.connection = connection;

    connection.on(RealtimeEvents.SESSION_STARTED, () => {
      this.ready = true;
      this.emit('state', 'listening', undefined);
      for (const chunk of this.pending.splice(0)) this.sendChunk(chunk);
    });
    connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (msg) => {
      if (!msg.text) return;
      if (this.firstPartialAt === null) this.firstPartialAt = performance.now();
      this.emit('partial', msg.text);
    });
    connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (msg) => {
      const now = performance.now();
      const metrics: CommitMetrics = {
        utteranceToCommitMs: this.utteranceStartAt !== null ? now - this.utteranceStartAt : undefined,
        speechEndToCommitMs: this.lastSpeechAt !== null ? now - this.lastSpeechAt : undefined,
        firstPartialMs:
          this.utteranceStartAt !== null && this.firstPartialAt !== null ? this.firstPartialAt - this.utteranceStartAt : undefined,
      };
      this.utteranceStartAt = null;
      this.lastSpeechAt = null;
      this.firstPartialAt = null;
      const text = (msg.text ?? '').trim();
      if (text) this.emit('committed', text, metrics);
    });
    connection.on(RealtimeEvents.ERROR, (err) => {
      const message = 'message_type' in err ? `${err.message_type}: ${err.error}` : err.message;
      this.emit('error', new Error(message));
    });
    connection.on(RealtimeEvents.CLOSE, () => {
      this.ready = false;
      this.connection = null;
      this.emit('state', 'idle', 'connection closed');
    });
  }

  private sendChunk(chunk: Uint8Array): void {
    if (!this.connection) return;
    this.connection.send({ audioBase64: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64'), sampleRate: SAMPLE_RATE });
  }

  pushAudio(chunk: Uint8Array): void {
    const rms = pcmRms(chunk);
    const now = performance.now();
    this.emit('level', rms);
    if (rms >= SPEECH_RMS) {
      if (this.utteranceStartAt === null) this.utteranceStartAt = now;
      this.lastSpeechAt = now;
    }
    if (!this.ready) {
      if (this.pending.length < 200) this.pending.push(chunk);
      return;
    }
    this.sendChunk(chunk);
  }

  commit(): void {
    if (this.connection && this.ready) {
      this.emit('state', 'committing', undefined);
      this.connection.commit();
    }
  }

  stop(): void {
    this.connection?.close();
    this.connection = null;
    this.ready = false;
    this.pending = [];
    this.emit('state', 'idle', undefined);
  }
}

/** Text-to-speech (ElevenLabs Flash v2.5) returning MP3 bytes. */
export async function synthesize(apiKey: string, voiceId: string, text: string): Promise<Buffer> {
  const client = new ElevenLabsClient({ apiKey });
  const stream = await client.textToSpeech.convert(voiceId, {
    text: text.slice(0, 1200),
    modelId: 'eleven_flash_v2_5',
    outputFormat: 'mp3_44100_128',
  });
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Speaks verified run summaries through macOS `afplay`. */
export async function speak(apiKey: string, voiceId: string, text: string, signal?: AbortSignal): Promise<{ bytes: number }> {
  const audio = await synthesize(apiKey, voiceId, text);
  const dir = await mkdtemp(join(tmpdir(), 'commandos-tts-'));
  const file = join(dir, 'speech.mp3');
  await writeFile(file, audio);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('/usr/bin/afplay', [file], { stdio: 'ignore' });
    const abort = () => p.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    p.on('error', reject);
    p.on('exit', () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
  return { bytes: audio.byteLength };
}

/** Transcribes a complete 16 kHz PCM buffer through the realtime API (used for verification and benchmarks). */
export async function transcribePcm(
  apiKey: string,
  pcm: Uint8Array,
  opts: { chunkMs?: number; realtime?: boolean; timeoutMs?: number } = {},
): Promise<{ text: string; partials: number; metrics: CommitMetrics; sessionMs: number }> {
  const t = new RealtimeTranscriber({ apiKey, commitStrategy: 'manual', vadSilenceSecs: 1 });
  const started = performance.now();
  let partials = 0;
  const result = new Promise<{ text: string; metrics: CommitMetrics }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('transcription timed out')), opts.timeoutMs ?? 30_000);
    t.on('partial', () => partials++);
    t.on('committed', (text, metrics) => {
      clearTimeout(timer);
      resolve({ text, metrics });
    });
    t.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  await t.start();
  const chunkBytes = Math.round((SAMPLE_RATE * 2 * (opts.chunkMs ?? 100)) / 1000);
  for (let i = 0; i < pcm.byteLength; i += chunkBytes) {
    t.pushAudio(pcm.subarray(i, Math.min(i + chunkBytes, pcm.byteLength)));
    if (opts.realtime !== false) await new Promise((r) => setTimeout(r, opts.chunkMs ?? 100));
  }
  // wait until the session is ready and buffered audio flushed, then commit
  for (let i = 0; i < 100 && !t.connected; i++) await new Promise((r) => setTimeout(r, 50));
  t.commit();
  try {
    const { text, metrics } = await result;
    return { text, partials, metrics, sessionMs: performance.now() - started };
  } finally {
    t.stop();
  }
}
