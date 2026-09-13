/**
 * Deep links, checked before anything is pushed.
 *
 * A link to `/guides/install#configure-the-agent` is how readers arrive from a support ticket, a
 * blog post or a colleague's message. Heading ids change during a migration — the source platform's
 * slug algorithm is not this one's — and a fragment that no longer matches fails silently: the page
 * loads, the reader lands at the top, and nothing reports it.
 *
 * Anchors were only ever checked against a deployed preview, which is after the push. This reads
 * the written files: every fragment an output link carries must be an id that page actually has,
 * whether from a heading or from the shim the anchor plan wrote for a renamed one.
 */
import GithubSlugger from 'github-slugger';
import { headingSlug } from '../urls/slugger.js';
import { inlineText, walkBlocks, type DocIR } from '../ir/types.js';

/** Every id a written page offers a link: its headings, and any id written into the page itself. */
export function documentAnchors(doc: DocIR, text: string): Set<string> {
  const anchors = new Set<string>();
  // The renderer slugs headings per document, so repeated titles get the -1, -2 suffixes it gives them.
  const slugger = new GithubSlugger();
  walkBlocks(doc.children, (block) => {
    if (block.type === 'heading') anchors.add(headingSlug(inlineText(block.children), slugger));
  });
  // An explicit id — an anchor shim for a renamed heading, or one the author wrote — is an anchor too.
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
  return anchors;
}

export interface FragmentProblem {
  from: string;
  link: string;
  reason: string;
}

/**
 * Fragments that will not land.
 *
 * `anchorsByRoute` holds what each written page offers; `route` resolves a link to the page it
 * points at, returning undefined for anything that leaves the site. A link to a page this
 * migration did not write is not judged here — `internal-links` already reports that — so a page
 * missing from the map is skipped rather than reported twice.
 */
export function unresolvedFragments(
  links: ReadonlyMap<string, readonly string[]>,
  anchorsByRoute: ReadonlyMap<string, ReadonlySet<string>>,
  route: (url: string, from: string) => string | undefined,
): FragmentProblem[] {
  const problems: FragmentProblem[] = [];
  for (const [from, urls] of links) {
    for (const url of urls) {
      const hash = url.indexOf('#');
      if (hash < 0 || hash === url.length - 1) continue;
      const fragment = decodeURIComponent(url.slice(hash + 1));
      if (!fragment) continue;
      // A link with no path is a link into this same page.
      const target = hash === 0 ? from : route(url.slice(0, hash), from);
      if (target === undefined) continue;
      const anchors = anchorsByRoute.get(target);
      if (!anchors) continue;
      if (!anchors.has(fragment)) problems.push({ from, link: url, reason: `${target} has no anchor "${fragment}"` });
    }
  }
  return problems.sort((a, b) => a.from.localeCompare(b.from) || a.link.localeCompare(b.link));
}
