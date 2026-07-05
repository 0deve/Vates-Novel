import type { DictRule } from "./db";

/**
 * Apply pronunciation/normalization rules to text before it is sent to the
 * TTS engine (implementation.md §5). Display text is left untouched.
 */
export function applyRules(text: string, rules: DictRule[]): string {
  let out = text;
  for (const r of rules) {
    if (r.is_regex) {
      try {
        out = out.replace(new RegExp(r.pattern, "gi"), r.replacement);
      } catch {
        // Invalid user regex — skip the rule rather than break playback.
      }
    } else if (r.pattern) {
      out = out.split(r.pattern).join(r.replacement);
    }
  }
  return out;
}
