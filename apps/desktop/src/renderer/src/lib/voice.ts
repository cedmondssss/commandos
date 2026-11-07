import { useCallback, useEffect, useRef } from 'react';
import { invoke, onPush, sendAudio } from './api';
import { MicCapture } from './mic';
import { store, useUi } from './store';

/**
 * Push-to-talk / hands-free voice: opens the ElevenLabs realtime session in the runtime, streams
 * microphone PCM through the validated IPC channel, and stops after one committed utterance.
 */
export function useVoice() {
  const voice = useUi((s) => s.voice);
  const mic = useRef<MicCapture | null>(null);
  const generation = useRef(0);
  const starting = useRef(false);
  const committedAtStart = useRef(0);

  const stop = useCallback(async (commit: boolean) => {
    ++generation.current;
    starting.current = false;
    mic.current?.stop();
    mic.current = null;
    await invoke('voice.stop', { commit }).catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (mic.current || starting.current) return;
    const current = ++generation.current;
    starting.current = true;
    try {
      store.clearVoiceError();
      const status = await invoke('microphone.status', {});
      if (current !== generation.current) return;
      if (status.status !== 'granted') {
        const r = await invoke('microphone.request', {});
        if (current !== generation.current) return;
        if (!r.granted) throw new Error('Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone.');
      }
      committedAtStart.current = store.getSnapshot().voice.transcripts.length;
      const capture = new MicCapture();
      mic.current = capture;
      try {
        await capture.start((chunk) => { if (current === generation.current) sendAudio(chunk); });
        if (current !== generation.current) { capture.stop(); return; }
        await invoke('voice.start', {});
        if (current !== generation.current) capture.stop();
      } catch (e) {
        capture.stop();
        if (mic.current === capture) mic.current = null;
        throw e;
      }
    } finally { if (current === generation.current) starting.current = false; }
  }, []);

  // Stop arrives from either window or the global shortcut, even while this window is hidden.
  useEffect(() => onPush('ui:command', (cmd) => {
    if (cmd.action === 'stop-voice') void stop(false);
  }), [stop]);
  useEffect(() => () => {
    ++generation.current;
    mic.current?.stop();
    mic.current = null;
  }, []);

  useEffect(() => {
    if (mic.current && ['idle', 'error', 'unavailable'].includes(voice.state)) void stop(false);
  }, [voice.state, stop]);

  const listening = mic.current !== null && (voice.state === 'listening' || voice.state === 'connecting' || voice.state === 'committing');

  // one utterance per activation: stop once a transcript is committed
  useEffect(() => {
    if (mic.current && voice.transcripts.length > committedAtStart.current) void stop(false);
  }, [voice.transcripts.length, stop]);

  const toggle = useCallback(async () => {
    if (mic.current) await stop(true);
    else await start();
  }, [start, stop]);

  return { voice, listening: listening || mic.current !== null, start, stop, toggle };
}
