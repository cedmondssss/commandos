// Converts the microphone stream (resampled to 16 kHz by the AudioContext) into 16-bit
// little-endian PCM chunks of `chunkSamples` samples and posts them to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunkSamples = (options && options.processorOptions && options.processorOptions.chunkSamples) || 1600;
    this.buffer = new Int16Array(this.chunkSamples);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.chunkSamples) {
        this.port.postMessage(this.buffer.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
