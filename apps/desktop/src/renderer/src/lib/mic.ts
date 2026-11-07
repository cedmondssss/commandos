/** Captures the microphone as 16 kHz mono 16-bit PCM in ~100 ms chunks via an AudioWorklet. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private generation = 0;

  async start(onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (generation !== this.generation) { for (const track of stream.getTracks()) track.stop(); return; }
    this.stream = stream;
    try {
      const ctx = new AudioContext({ sampleRate: 16_000 });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
      if (generation !== this.generation) return;
      const source = ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ctx, 'pcm-capture', { processorOptions: { chunkSamples: 1600 } });
      this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (generation === this.generation) onChunk(new Uint8Array(e.data));
      };
      source.connect(this.node);
    } catch (e) { this.stop(); throw e; }
  }

  stop(): void {
    ++this.generation;
    this.node?.port.close();
    this.node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
