/**
 * Links between the pages of a migrated site. A source page links other pages by the source site's paths,
 * site-relative (`/docs/setup`) or absolute on the source's own host. A link to a page this migration writes
 * follows that page to its new route. A link to anything else is not the migration's to resolve: by default it
 * is kept as authored, and the URL plan may instead send links to pages the source is known to publish to the
 * source site, when that site stays up. Either way convert lists each one for review. Convert and the source
 * comparisons apply the same mapping, so the output is judged against the source as convert read it.
 */
import type { Tree } from '../nav/tree.js';
import { mapBlocks, type Block, type DocIR } from '../ir/types.js';

export interface SiteLinks {
  /** Source path → the route the migration writes that page at. */
  routes: Record<string, string>;
  /** Source document location/path → the base path its relative links resolve against. */
  sourceBases: Record<string, string>;
  /** Paths the source is known to publish: its page index, llms.txt, and the tree's pages and aliases. */
  sourcePages: string[];
  /** Hostnames the source site answers on; empty for repository and export sources. */
  hosts: string[];
  /** The live source's origin, where `source` sends a link to a page the migration does not write. */
  origin?: string;
  /** `keep` leaves a link to a page the migration does not write as authored; `source` points it at the source site. */
  unmigrated: 'keep' | 'source';
}

export interface SiteLinkOutcome {
  target: string;
  /** `route`: a page this migration writes. `kept`: left as authored. `source`: pointed at the source site. */
  kind: 'route' | 'kept' | 'source';
  /** Whether the source is known to publish the linked path. One it is not may never have existed. */
  knownSourcePage: boolean;
}

export type SiteLinkResolver = (url: string, source?: string) => SiteLinkOutcome | undefined;

const LINK_PROPS = new Set(['href', 'to', 'link', 'url']);

function normalisePath(path: string): string {
  let decoded = path;
  try { decoded = decodeURI(path); } catch { /* a malformed escape is kept as written */ }
  decoded = decoded.replace(/\\/g, '/');
  if (!decoded.startsWith('/')) decoded = `/${decoded}`;
  return decoded.replace(/\/+$/, '') || '/';
}

function pathOf(location: string): string {
  try { return /^https?:\/\//i.test(location) ? new URL(location).pathname : location; } catch { return location; }
}

/** Public-path spellings a source repository may use for one page file. */
function pathCandidates(path: string): string[] {
  const exact = normalisePath(path);
  const withoutExtension = normalisePath(exact.replace(/\.(?:mdx?|html?)$/i, ''));
  const withoutIndex = normalisePath(withoutExtension.replace(/\/(?:index|readme)$/i, ''));
  return [...new Set([exact, withoutExtension, withoutIndex])];
}

function sourceKey(location: string): string {
  if (/^https?:\/\//i.test(location)) {
    try { const url = new URL(location); url.hash = ''; url.search = ''; return url.toString(); } catch { /* use the literal value */ }
  }
  return location.replace(/\\/g, '/');
}

function sourceBase(page: Tree['pages'][number]): string | undefined {
  if (/^https?:\/\//i.test(page.source)) {
    try { return new URL(page.source).pathname; } catch { return page.oldPath; }
  }
  // Repository links are relative to the source file, not its eventual public route.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(page.source)) return normalisePath(page.source);
  return page.oldPath ? normalisePath(page.oldPath) : undefined;
}

export function siteLinksFor(tree: Tree, options: { unmigrated?: 'keep' | 'source'; sourcePages?: string[]; hosts?: string[] } = {}): SiteLinks {
  const routes: Record<string, string> = {};
  const sourceBases: Record<string, string> = {};
  const addRoute = (path: string, route: string): void => {
    for (const candidate of pathCandidates(pathOf(path))) {
      const existing = routes[candidate];
      if (existing !== undefined && existing !== route) throw new Error(`source path ${candidate} maps to both ${existing} and ${route}`);
      routes[candidate] = route;
    }
  };
  for (const page of tree.pages) {
    const base = sourceBase(page);
    if (base) {
      sourceBases[sourceKey(page.source)] = base;
      if (page.oldPath) sourceBases[normalisePath(page.oldPath)] = base;
    }
    if (!page.migrate || !page.newPath || !page.oldPath) continue;
    addRoute(page.oldPath, page.newPath);
    for (const alias of page.aliases ?? []) addRoute(alias, page.newPath);
  }
  const live = tree.pages.find((page) => /^https?:\/\//i.test(page.source))?.source;
  const origin = live ? new URL(live).origin : undefined;
  const listed = [...(options.sourcePages ?? []), ...tree.pages.flatMap((page) => [page.oldPath, ...(page.aliases ?? [])])];
  const sourcePages = [...new Set(listed.filter((path): path is string => !!path).flatMap((path) => pathCandidates(pathOf(path))))];
  const hosts = origin ? [...new Set([new URL(origin).hostname, ...(options.hosts ?? []).map((host) => (/^https?:\/\//i.test(host) ? new URL(host).hostname : host))].map((host) => host.toLowerCase()))] : [];
  return { routes, sourceBases, sourcePages, hosts, ...(origin ? { origin } : {}), unmigrated: options.unmigrated ?? 'keep' };
}

/** How a link written in a source page resolves in the migrated site; undefined for a link that is not to the source site. */
export function siteLinkResolver(links: SiteLinks): SiteLinkResolver {
  const written = new Set(Object.values(links.routes));
  const known = new Set(links.sourcePages);
  const hosts = new Set(links.hosts.map((host) => host.toLowerCase()));
  const routeFor = (path: string): string | undefined => pathCandidates(path).map((candidate) => links.routes[candidate]).find((route) => route !== undefined);
  const knownPath = (path: string): boolean => pathCandidates(path).some((candidate) => known.has(candidate));
  const baseFor = (source: string | undefined): string | undefined => {
    if (!source) return undefined;
    const exact = links.sourceBases[sourceKey(source)];
    if (exact) return exact;
    const path = pathOf(source);
    return links.sourceBases[normalisePath(path)] ?? (/^\//.test(path) ? path : undefined);
  };
  return (url, source) => {
    let path: string;
    let suffix: string;
    let absolute = false;
    if (url.startsWith('/') && !url.startsWith('//')) {
      path = url.match(/^[^?#]*/)![0];
      suffix = url.slice(path.length);
    } else if (hosts.size && /^(?:https?:)?\/\//i.test(url)) {
      let parsed: URL;
      try { parsed = new URL(url, links.origin ?? 'https://source.invalid/'); } catch { return undefined; }
      if (!hosts.has(parsed.hostname.toLowerCase())) return undefined;
      path = parsed.pathname;
      suffix = `${parsed.search}${parsed.hash}`;
      absolute = true;
    } else if (!url.startsWith('#') && !url.startsWith('?') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
      const base = baseFor(source);
      if (!base) return undefined;
      let parsed: URL;
      try { parsed = new URL(url, `https://source.invalid${base.startsWith('/') ? base : `/${base}`}`); } catch { return undefined; }
      path = parsed.pathname;
      suffix = `${parsed.search}${parsed.hash}`;
    } else return undefined;
    const normalised = normalisePath(path);
    const route = routeFor(normalised);
    if (route !== undefined) return { target: `${route === 'index' ? '/' : `/${route}`}${suffix}`, kind: 'route', knownSourcePage: true };
    if (!absolute && written.has(normalised.replace(/^\//, ''))) return { target: `${normalised}${suffix}`, kind: 'route', knownSourcePage: true };
    const knownSourcePage = knownPath(normalised);
    if (!absolute && knownSourcePage && links.unmigrated === 'source' && links.origin) return { target: `${links.origin}${normalised}${suffix}`, kind: 'source', knownSourcePage };
    return { target: url, kind: 'kept', knownSourcePage };
  };
}

/** Where a link written in a source page lands in the migrated site. */
export function siteLinkTarget(links: SiteLinks): (url: string, source?: string) => string {
  const resolve = siteLinkResolver(links);
  return (url, source) => resolve(url, source)?.target ?? url;
}

/** The document with every link retargeted: prose, list items, quotes, table cells, captions and a component's link props. */
export function retargetDocLinks(doc: DocIR, target: (url: string, source?: string) => string): DocIR {
  return {
    ...doc,
    children: mapBlocks(doc.children, {
      inline: (node) => (node.type === 'link' ? { ...node, url: target(node.url, doc.source) } : node),
      block: (block): Block => (block.type === 'dai' || block.type === 'component'
        ? { ...block, props: Object.fromEntries(Object.entries(block.props).map(([key, value]) => [key, LINK_PROPS.has(key) && typeof value === 'string' ? target(value, doc.source) : value])) }
        : block),
    }),
  };
}
