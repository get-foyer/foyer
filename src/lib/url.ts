/**
 * Shared URL sanitizer for LLM-sourced links. Research links arrive from model
 * output (citations, web_search events, self-reported sources) and end up in
 * <a href> — an unchecked `javascript:`/`data:` URL there is script execution.
 *
 * Used server-side at parse time (providers — sanitizes what gets persisted)
 * and client-side at render time (covers sessions persisted before the fix).
 */

/** Returns the trimmed URL when it parses as http/https; null otherwise. */
export function sanitizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    // No base URL on purpose: protocol-relative `//evil.com` and bare paths
    // fail to parse and are rejected. URL parsing (vs a regex) also defeats
    // `jAvAsCrIpT:` casing and embedded whitespace/control characters.
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Return the original (trimmed) string, not url.href — href normalization
  // would rewrite persisted link shapes for no security gain.
  return trimmed;
}
