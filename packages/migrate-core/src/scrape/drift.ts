/**
 * Whether the source moved underneath a run.
 *
 * Discovery reads every page, then acquisition reads it again. Between the two the customer can
 * publish an edit, and a migration that mixes the two reads is a migration of a site that never
 * existed. Nothing was comparing them: the guard in `pinAcquisition` was dead code, because the
 * manifest recorded no hash for a live page to compare against.
 *
 * Comparing raw bytes would report drift on almost every page of almost every site: a rendered
 * page carries a build id, a CSRF token, a timestamp. So both reads are reduced to the same
 * fingerprint first — the parts a reader would notice — and only a difference there is drift.
 */

/** Content that changes between two loads of an unchanged page, and says nothing to a reader. */
const VOLATILE = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<!--[\s\S]*?-->/g,
  /\snonce="[^"]*"/gi,
  /\sdata-(?:build|buildid|build-id|timestamp|reactroot|nonce|csrf)(?:="[^"]*")?/gi,
  /<meta[^>]+name=["'](?:csrf-token|csrf-param|build-id|request-id)["'][^>]*>/gi,
  // A deployment id: stamped on the root element and onto every asset URL as a cache key. It
  // changes when the platform redeploys, which it may do while a run is reading the site, and it
  // says nothing about the page — the same words, the same markup, a new build. Without this, one
  // deploy mid-run reports hundreds of unchanged pages as edited by the customer.
  /\sdata-(?:dpl|deployment)-id="[^"]*"/gi,
  /([?&])dpl=[^"'&\s>]*/gi,
  // Resource hints and stylesheets: build plumbing whose filenames carry a content hash, so every
  // one of them changes when the platform rebuilds. They point at the bundle, never at what the
  // page says, and <script> and <style> are already dropped for the same reason.
  /<link\b[^>]*\brel=["'](?:preload|modulepreload|prefetch|preconnect|dns-prefetch|stylesheet)["'][^>]*>/gi,
  // The generator meta names the platform and the build that rendered the page; the build half moves
  // with every deploy. What generated a page is not what a page says.
  /<meta[^>]+name=["']generator["'][^>]*>/gi,
];

/**
 * A stable fingerprint of what a page served. Two loads of an unchanged page share it; an edit to
 * the text, the markup structure or a link changes it.
 */
export function sourceFingerprint(body: string): string {
  // A rendered relative time ("14 hours ago") changes every hour while the page does not. The
  // element and its machine-readable datetime stay, so an actual edit still moves the fingerprint;
  // only the words counting the hours since are dropped.
  let text = body.replace(/(<time\b[^>]*>)[\s\S]*?<\/time>/gi, '$1</time>');
  for (const pattern of VOLATILE) text = text.replace(pattern, ' ');
  return text.replace(/\s+/g, ' ').trim();
}
