// JS side of the Android notification bridge (MediaControlBridge.kt),
// injected into the webview as window.NativeMedia. Everything here is a
// silent no-op on desktop, where souvlaki provides the OS media overlay
// instead.

interface NativeMediaInterface {
  playbackUpdate(title: string, chapter: string, playing: boolean): void;
  playbackStop(): void;
  downloadUpdate(title: string, done: number, total: number): void;
  downloadEnd(): void;
}

declare global {
  interface Window {
    NativeMedia?: NativeMediaInterface;
  }
}

export const hasNativeMedia = (): boolean => !!window.NativeMedia;

// The notification only needs updating when something it shows changes —
// not on every spoken segment.
let lastPlayback = "";

export function playbackUpdate(
  title: string,
  chapter: string,
  playing: boolean,
): void {
  const key = `${title}|${chapter}|${playing}`;
  if (key === lastPlayback) return;
  lastPlayback = key;
  try {
    window.NativeMedia?.playbackUpdate(title, chapter, playing);
  } catch {
    // bridge gone (page reloading) — nothing to do
  }
}

export function playbackStop(): void {
  lastPlayback = "";
  try {
    window.NativeMedia?.playbackStop();
  } catch {
    // ignore
  }
}

export function downloadUpdate(title: string, done: number, total: number): void {
  try {
    window.NativeMedia?.downloadUpdate(title, done, total);
  } catch {
    // ignore
  }
}

export function downloadEnd(): void {
  try {
    window.NativeMedia?.downloadEnd();
  } catch {
    // ignore
  }
}

export type MediaAction = "toggle" | "next" | "prev" | "stop" | "download-stop";

/** Notification / lock-screen button presses. Returns an unsubscribe fn. */
export function onMediaAction(cb: (action: MediaAction) => void): () => void {
  const handler = (e: Event) => {
    const action = (e as CustomEvent).detail?.action as MediaAction | undefined;
    if (action) cb(action);
  };
  window.addEventListener("native-media", handler);
  return () => window.removeEventListener("native-media", handler);
}
