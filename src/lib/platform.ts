// Coarse platform detection for hiding desktop-only affordances (the
// Android system webview always carries "Android" in its user agent).
// Layout/sizing decisions should use CSS breakpoints instead.
export const isAndroid = (): boolean => navigator.userAgent.includes("Android");
