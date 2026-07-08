// Local TTS engines, for reading offline where the Edge voices can't:
//  - Android: the system TTS engine via NativeTtsBridge.kt, injected into
//    the webview as window.NativeTTS.
//  - Desktop: the webview's speechSynthesis (WebView2 exposes the Windows
//    system voices; WebKit/macOS likewise).
// Both are addressed through the same functions here, and voices are named
// "device:<engine voice name>" so they can live in the same per-novel
// tts_voice column and the same dropdowns as the Edge voices.

interface NativeTtsInterface {
  isReady(): boolean;
  getVoices(): string;
  speak(
    text: string,
    voiceName: string,
    rate: number,
    pitch: number,
    id: string,
  ): boolean;
  stop(): void;
}

declare global {
  interface Window {
    NativeTTS?: NativeTtsInterface;
  }
}

/** The webview speech engine, used only where the Android bridge is absent. */
function webSpeech(): SpeechSynthesis | null {
  if (window.NativeTTS) return null;
  return typeof window.speechSynthesis !== "undefined"
    ? window.speechSynthesis
    : null;
}

export const DEVICE_VOICE_PREFIX = "device:";

export const hasDeviceTts = (): boolean =>
  !!window.NativeTTS || !!webSpeech();

export const isDeviceVoice = (name: string): boolean =>
  name.startsWith(DEVICE_VOICE_PREFIX);

/** "device:en-us-x-sfg#male_1" -> "en-us-x-sfg#male_1" */
export const deviceVoiceName = (name: string): string =>
  name.slice(DEVICE_VOICE_PREFIX.length);

export interface DeviceVoice {
  /** Engine voice name, WITHOUT the "device:" prefix. */
  name: string;
  locale: string;
  /** True for voices that themselves need a network connection. */
  network: boolean;
}

export function listDeviceVoices(): DeviceVoice[] {
  if (window.NativeTTS) {
    try {
      return JSON.parse(window.NativeTTS.getVoices()) as DeviceVoice[];
    } catch {
      return [];
    }
  }
  const synth = webSpeech();
  if (!synth) return [];
  return synth.getVoices().map((v) => ({
    name: v.name,
    locale: v.lang,
    network: !v.localService,
  }));
}

/**
 * Both engines load their voice lists asynchronously; if a screen asked for
 * voices before they were available, this fires `cb` once they are.
 */
export function onDeviceTtsReady(cb: () => void): () => void {
  const offs: (() => void)[] = [];

  const nativeHandler = (e: Event) => {
    const d = (e as CustomEvent).detail;
    if (d?.kind === "ready" && d.ok) cb();
  };
  window.addEventListener("native-tts", nativeHandler);
  offs.push(() => window.removeEventListener("native-tts", nativeHandler));

  const synth = webSpeech();
  if (synth) {
    const changed = () => cb();
    synth.addEventListener("voiceschanged", changed);
    offs.push(() => synth.removeEventListener("voiceschanged", changed));
  }

  return () => offs.forEach((f) => f());
}

export interface SpeakHandle {
  stop(): void;
}

let utteranceCounter = 0;

/**
 * Speak one segment on the local engine. `rate` (-50..200) and `pitch`
 * (-50..50) use the same scales as the Edge synthesis commands and are
 * mapped to engine multipliers here. Returns null if the engine refused.
 *
 * Note: neither engine supports a real pause here — callers implement
 * pause as stop + re-speak of the current segment.
 */
export function speakDevice(
  text: string,
  voiceName: string,
  rate: number,
  pitch: number,
  cb: {
    /** Character offset (into `text`) of the word being spoken. */
    onRange?: (charStart: number) => void;
    onDone?: () => void;
    onError?: (message: string) => void;
  },
): SpeakHandle | null {
  const bridge = window.NativeTTS;
  if (bridge) {
    const id = `u${++utteranceCounter}`;
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || d.id !== id) return;
      if (d.kind === "range") {
        cb.onRange?.(d.start as number);
      } else if (d.kind === "done") {
        cleanup();
        cb.onDone?.();
      } else if (d.kind === "error") {
        cleanup();
        cb.onError?.(
          `Device TTS error${d.code != null ? ` (code ${d.code})` : ""}`,
        );
      }
    };
    const cleanup = () => window.removeEventListener("native-tts", onEvent);
    window.addEventListener("native-tts", onEvent);

    const ok = bridge.speak(
      text,
      voiceName,
      1 + rate / 100,
      1 + pitch / 100,
      id,
    );
    if (!ok) {
      cleanup();
      return null;
    }
    return {
      stop() {
        cleanup();
        bridge.stop();
      },
    };
  }

  const synth = webSpeech();
  if (!synth) return null;

  const u = new SpeechSynthesisUtterance(text);
  const match = synth.getVoices().find((v) => v.name === voiceName);
  if (match) u.voice = match;
  u.rate = Math.min(10, Math.max(0.1, 1 + rate / 100));
  u.pitch = Math.min(2, Math.max(0, 1 + pitch / 100));

  // cancel() fires end/error("interrupted") on some engines — the stopped
  // flag keeps a deliberate stop from being reported as completion/failure.
  let stopped = false;
  u.onboundary = (e) => {
    if (!stopped) cb.onRange?.(e.charIndex);
  };
  u.onend = () => {
    if (!stopped) cb.onDone?.();
  };
  u.onerror = (e) => {
    if (stopped || e.error === "interrupted" || e.error === "canceled") return;
    cb.onError?.(`Speech synthesis error (${e.error})`);
  };

  synth.cancel();
  synth.speak(u);
  return {
    stop() {
      stopped = true;
      synth.cancel();
    },
  };
}

/** Non-whitespace runs with their character offsets, for word highlighting. */
export function splitWords(
  text: string,
): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], offset: m.index });
  return out;
}
