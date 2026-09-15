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
import { openapiAnchors, parseOperationFrontmatter } from '../ir/mintlify-openapi.js';

/** Every id a written page offers a link: its headings, and any id written into the page itself. */
export function documentAnchors(doc: DocIR, text: string, readSpec?: (spec: string) => string | undefined): Set<string> {
  const anchors = new Set<string>();
  // The renderer slugs headings per document, so repeated titles get the -1, -2 suffixes it gives them.
  const slugger = new GithubSlugger();
  walkBlocks(doc.children, (block) => {
    if (block.type === 'heading') anchors.add(headingSlug(inlineText(block.children), slugger));
  });
  // An explicit id — an anchor shim for a renamed heading, or one the author wrote — is an anchor too.
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
  // An endpoint page renders its parameters from a spec, each with the id the platform gives it.
  const operation = parseOperationFrontmatter(doc.frontmatter.openapi);
  const spec = operation && readSpec ? readSpec(operation.spec) : undefined;
  if (operation && spec !== undefined) for (const anchor of openapiAnchors(spec, operation.method, operation.path)) anchors.add(anchor);
  return anchors;
}

/**
 * Anchors a frozen source page offers a deep link: every `id`/`name` it writes, plus the slug the
 * renderer gives each heading. Read from the bytes the site served, so it can be said whether a
 * link was already broken before the migration touched it.
 */
export function htmlAnchors(html: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of html.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
  const slugger = new GithubSlugger();
  for (const match of html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (text) anchors.add(headingSlug(text, slugger));
  }
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
/**
 * Splits fragment problems into the ones this migration caused and the ones it inherited.
 *
 * A deep link whose anchor the source page never had was already broken on the source site: the
 * output reproduces the page faithfully, and exact mode cannot invent a target that never existed.
 * Those are reported so the customer can fix their own content, and they do not fail the gate.
 * A link whose anchor the source *did* have and the output does not is a loss the migration caused,
 * and that still blocks. Where no frozen source is available for a route, nothing is excused.
 */
export function splitInheritedFragments(
  problems: readonly FragmentProblem[],
  sourceAnchorsByRoute: ReadonlyMap<string, ReadonlySet<string>>,
): { broken: FragmentProblem[]; inherited: FragmentProblem[] } {
  const broken: FragmentProblem[] = []; const inherited: FragmentProblem[] = [];
  for (const problem of problems) {
    const hash = problem.link.indexOf('#');
    const fragment = hash < 0 ? '' : decodeURIComponent(problem.link.slice(hash + 1));
    const target = problem.reason.slice(0, problem.reason.indexOf(' has no anchor'));
    const sourceAnchors = sourceAnchorsByRoute.get(target);
    if (fragment && sourceAnchors && !sourceAnchors.has(fragment)) inherited.push(problem);
    else broken.push(problem);
  }
  return { broken, inherited };
}

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
