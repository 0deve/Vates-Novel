// Highlight alignment: the player reports the active word as a bare token (Edge
// strips its surrounding punctuation), so we find it back in the original
// paragraph and highlight it in place, keeping quotes/dashes/spacing on screen.

/** True when there's anything for a TTS engine to pronounce. */
export function hasSpeakableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** [start, end) range in `text` to highlight for the active word, widened to
 * the whole token so attached punctuation lights up. Null if nothing to show. */
export function activeWordRange(
  text: string,
  boundaries: { text: string }[],
  activeWord: number,
): [number, number] | null {
  if (activeWord < 0 || activeWord >= boundaries.length) return null;

  // Match each bare word against the original in order, so repeats line up.
  let cursor = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i <= activeWord; i++) {
    const w = boundaries[i].text;
    if (!w) continue;
    let idx = text.indexOf(w, cursor);
    if (idx < 0) idx = text.indexOf(w);
    if (idx < 0) continue; // not found (e.g. a dictionary rule changed it)
    cursor = idx + w.length;
    if (i === activeWord) {
      start = idx;
      end = cursor;
    }
  }
  if (start < 0) return null;

  // Widen to the whole whitespace-delimited token.
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return [start, end];
}
