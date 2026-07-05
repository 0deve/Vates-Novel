/**
 * Split raw chapter HTML into clean paragraph segments — the units used for
 * display, click-to-play, and TTS synthesis (implementation.md §3D).
 */
export function segmentChapter(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = Array.from(doc.querySelectorAll("p"));
  const blocks = paragraphs.length
    ? paragraphs.map((p) => p.textContent ?? "")
    : (doc.body.textContent ?? "").split(/\n{2,}|\n/);

  return blocks
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
}
