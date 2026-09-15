/**
 * Generic live-site discovery. The result is the union of sitemap, sidebar,
 * recursive same-origin links and an optional vendor map. Every URL retains
 * provenance so an operator can understand why it entered scope.
 */
import { findAll, parseHtml, textOf, type El } from '../ir/from-html.js';
import type { ScrapeProfile } from './profiles.js';
import type { Fetcher, FetchedPage } from './fetcher.js';
import { CanonicalHosts, discoverSitemaps, sitemapCandidatesFromRobots, type SitemapEntry } from './fetcher.js';
import { parseLlmsIndex, type LlmsEntry, type ParsedLlmsIndex } from './published-markdown.js';
import { mapConcurrent } from './concurrency.js';
import { sha256 } from '../session/ids.js';
import { sourceFingerprint } from './drift.js';
import { fetchFlareData, flareNavigationFromData, helpSystemRoot, type FlareData } from './madcap-toc.js';

export interface DiscoveredUrl {
  url: string;
  reasons: string[];
  title?: string;
  description?: string;
  /** Exact sidebar label from platform metadata only. Rendered anchor text never writes here. */
  sidebarTitle?: string;
  /**
   * The `<title>` element of the rendered page. Themes decorate it (`Page - Site`),
   * so it is evidence for reconciliation and never a page title.
   */
  htmlTitleTag?: string;
  /** Sidebar anchor text as rendered. Kept for cross-checking the exact label, never used as one. */
  domSidebarTitle?: string;
  /** The page's llms.txt entry: exact title, description and published-Markdown URL as the site lists them. */
  llms?: LlmsEntry;
  /** Sidebar order wins; sitemap order is the fallback; crawl order is last. */
  orderHint: number;
  orderSource: 'sidebar' | 'sitemap' | 'crawl';
  groupHint?: string[];
  locale?: string;
  version?: string;
  sitemap?: { source: string; order: number; lastmod?: string; changefreq?: string; priority?: number };
  /** Discovered URLs that redirect to this page; their evidence was folded into it. */
  aliases?: string[];
  /** Distinct pages listed by the sidebar this page rendered; 0 or 1 means the source showed the reader no navigation. */
  sidebarPages?: number;
  /** sha256 of the bytes this page served during discovery. */
  contentSha256?: string;
}

export type DiscoveredNavigationNode =
  | { type: 'page'; url: string; title?: string }
  | { type: 'group'; kind?: import('../nav/tree.js').NavigationContainerKind; label: string; children: DiscoveredNavigationNode[]; icon?: string; href?: string; expandable?: boolean; description?: string };

/** Site presentation as the source platform declares it. Recorded as evidence; only the name is carried into the migrated site. */
export interface SiteConfig {
  name?: string;
  theme?: string;
  colors?: Record<string, string>;
  logo?: { light?: string; dark?: string };
  favicon?: string;
}

export interface DiscoveryResult {
  pages: DiscoveredUrl[];
  failures: Array<{ url: string; error: string }>;
  /** Failures that make the page universe or source-stated structure impossible to certify. */
  structuralIssues?: string[];
  truncated: boolean;
  sitemaps: { sources: string[]; entries: SitemapEntry[]; truncated: boolean };
  /** Exact navigation recovered from platform metadata, when available. */
  navigation?: DiscoveredNavigationNode[];
  navigationSource?: 'platform-metadata' | 'dom-sidebar';
  /** Every navigation extraction that succeeded, so verification can cross-check one against another. */
  navigationCandidates?: Partial<Record<'platform-metadata' | 'dom-sidebar', DiscoveredNavigationNode[]>>;
  siteName?: string;
  /** Site-level presentation the source platform declares: name, colours, logo, favicon, theme. */
  siteConfig?: SiteConfig;
  /** The site's llms.txt index when it publishes one; entries are deduplicated by path. */
  llms?: { url: string; entries: LlmsEntry[] };
  /** llms.txt entries that link to another site, which are references rather than pages of this one. */
  externalLlmsLinks?: Array<{ title: string; url: string }>;
  /** Alias hosts treated as the seed origin: the profile's paired hosts plus those named by robots.txt Sitemap directives and llms.txt. */
  canonicalHosts: string[];
  /** The crawl policy the site published, frozen as the rules this run obeyed. */
  robots?: { url: string; body: string };
  /**
   * Data files a platform publishes its navigation in rather than rendering it into the HTML
   * (MadCap Flare builds its sidebar in the browser from these). Frozen with the capture so
   * verification re-derives the same tree offline.
   */
  navigationData?: Array<{ url: string; body: string }>;
  /**
   * The independent help systems this crawl found on the host, seed first. A host may publish
   * several; the seed's states the site's navigation and another is reported rather than merged.
   * Recorded in machine-readable form so the operator can answer the question that report asks —
   * which help system this run migrates — instead of only reading it in an error message.
   */
  helpSystems?: HelpSystem[];
}

/** One MadCap help system published on the crawled host. */
export interface HelpSystem {
  /** Directory the help system is published under; its pages are the URLs beneath it. */
  root: string;
  /** Whether this is the help system the seed URL belongs to, whose sidebar the run states. */
  seed: boolean;
  /** How many pages its own sidebar places. */
  sidebarPages: number;
  /** The structural issue this help system raised, verbatim, when it is not the seed's. */
  issue?: string;
}

/** How published MadCap Flare output declares the help system a page belongs to. */
const MADCAP_HELP_SYSTEM = /<html[^>]*\sdata-mc-path-to-help-system=/i;

// Every media extension the asset manifest recognises belongs here too: a sitemap that inventories
// a site's images, fonts and downloads (MadCap Flare publishes one) must not turn them into pages.
const NON_PAGE = /\.(?:aac|avif|bmp|css|csv|docx?|eot|flac|gif|ico|jfif|jpe|jpe?g|js|json|m4a|m4v|map|mcwebhelp|mp3|mp4|mov|ogg|ogv|otf|pdf|png|pptx?|rss|svg|tar|tgz|tiff?|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;
const TRACKING = /^(?:utm_(?:source|medium|campaign|term|content)|fbclid|gclid|mc_cid|mc_eid)$/i;
const GENERIC_SITEMAP_WORDS = new Set(['all', 'content', 'default', 'docs', 'index', 'main', 'page', 'pages', 'post', 'posts', 'root', 'site', 'sitemap', 'url', 'urls', 'web', 'www']);
// A deliberately conservative subset of ISO 639-1 used by documentation
// sites. Unknown two-letter filename tokens remain groups instead of becoming
// false locales (for example, `us-products.xml`).
const DOCUMENTATION_LANGUAGES = new Set(['ar', 'bg', 'bn', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th', 'tr', 'uk', 'vi', 'zh']);
const DOCUMENTATION_REGIONS = new Set(['at', 'au', 'br', 'ca', 'ch', 'cn', 'de', 'es', 'fr', 'gb', 'hk', 'in', 'jp', 'kr', 'mx', 'pt', 'tw', 'us']);

/** Canonicalise a candidate without guessing whether trailing slashes matter; a URL on an alias host is rewritten onto the seed origin. */
export function normaliseDiscoveryUrl(candidate: string, base: string, origin: string, canonicalHosts?: CanonicalHosts): string | undefined {
  try {
    const resolved = new URL(candidate, base);
    const url = canonicalHosts?.canonicalise(resolved) ?? resolved;
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    if (NON_PAGE.test(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Theme/account routes that are same-origin links but never documentation pages. */
function isDocumentCandidate(url: string, platform: string): boolean {
  const path = new URL(url).pathname;
  return platform !== 'readme' || !/^\/(?:cdn-cgi|edit|login|logout)(?:\/|$)/i.test(path);
}


/** Separators a documentation theme puts between a page's own title and the site's. */
const TITLE_SEPARATORS = [' | ', ' — ', ' – ', ' - ', ' · '];

/**
 * The site's name as its own pages state it, when the platform declares it nowhere else.
 *
 * GitBook emits no `og:site_name` and no site config a crawl can read, so a migrated site fell back
 * to the renderer's default name on every page. Its theme does decorate every `<title>` with the
 * site: "Quickstart | Documentation | demo Docs". The trailing segment is the name when every page
 * that decorates its title agrees on it.
 *
 * Unanimity is the evidence. A site whose pages disagree, or whose titles carry no separator at all
 * (where the "suffix" would just be the page's own title), states no name here and the caller keeps
 * the default rather than inventing one.
 */
export function siteNameFromTitleTags(titleTags: ReadonlyArray<string | undefined>): string | undefined {
  const suffixes = new Set<string>();
  let decorated = 0;
  for (const tag of titleTags) {
    const title = tag?.trim();
    if (!title) continue;
    const separator = TITLE_SEPARATORS.find((value) => title.includes(value));
    if (!separator) return undefined;
    decorated++;
    suffixes.add(title.slice(title.lastIndexOf(separator) + separator.length).trim());
  }
  if (decorated < 2 || suffixes.size !== 1) return undefined;
  const [name] = [...suffixes];
  return name || undefined;
}

function metaContent(html: string, selector: string): string | undefined {
  const root = parseHtml(html);
  const value = findAll(root, selector)[0]?.attribs.content?.replace(/\s+/g, ' ').trim();
  return value || undefined;
}

function pageTitle(html: string): string | undefined {
  const root = parseHtml(html);
  const title = findAll(root, 'title')[0];
  return title ? textOf(title).replace(/\s+/g, ' ').trim() || undefined : undefined;
}

/** A page's explicit canonical URL, restricted to the already-approved site origins. */
function canonicalPageUrl(html: string, base: string, origin: string, canonicalHosts: CanonicalHosts): string | undefined {
  const root = parseHtml(html);
  const canonical = findAll(root, 'link[href]').find((link) => link.attribs.rel?.toLowerCase().split(/\s+/).includes('canonical'));
  return canonical?.attribs.href ? normaliseDiscoveryUrl(canonical.attribs.href, base, origin, canonicalHosts) : undefined;
}

/** Return the balanced JSON array beginning at `start`, respecting quoted strings. */
function jsonArrayAt(source: string, start: number): string | undefined {
  if (source[start] !== '[') return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}

/**
 * The Flight payload as the browser reassembles it. A navigation larger than one
 * chunk is split mid-token across several `__next_f.push` calls, so the chunks
 * joined in document order are searched as well as each chunk on its own.
 */
function flightPayloads(html: string): string[] {
  const chunks: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[\d+,\s*("(?:\\.|[^"\\])*")\s*\]\)/g)) {
    try { chunks.push(JSON.parse(match[1]) as string); } catch { /* malformed/changed Flight chunk */ }
  }
  return chunks.length > 1 ? [html, chunks.join(''), ...chunks] : [html, ...chunks];
}

/** Keys Mintlify nests navigation under, outermost first; the same set the repository adapter walks. */
const CONTAINER_KEYS = ['versions', 'languages', 'products', 'dropdowns', 'anchors', 'tabs', 'menus', 'groups', 'pages'] as const;

/** The label a navigation container carries, whatever kind of container it is. */
function containerLabel(node: Record<string, unknown>): string | undefined {
  for (const key of ['group', 'tab', 'anchor', 'dropdown', 'product', 'version', 'language', 'menu'] as const) {
    const value = node[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

interface MintlifyNavigationExtraction {
  navigation: DiscoveredNavigationNode[];
  pages: Array<{ url: string; title?: string; sidebarTitle?: string; description?: string; groups: string[] }>;
}

/** Mintlify navigation entries are site-root paths (`quickstart`, `/quickstart`); the root page is authored as `index` and served at `/`. */
function mintlifyNavigationUrl(entry: string, origin: string): string {
  const url = new URL(entry.replace(/^\/+/, ''), origin + '/');
  if (url.origin === origin && url.pathname === '/index') url.pathname = '/';
  return url.toString();
}

const PUBLISHED_MARKDOWN = /\.md$/i;
const TEXT_MEDIA_TYPE = /^text\/(?:plain|markdown)\b/i;

/** The page an llms.txt entry describes, on the host the entry names; `add` rewrites it onto the seed origin. */
function pageUrlOfLlmsEntry(entry: LlmsEntry): string {
  const url = new URL(entry.mdUrl);
  url.pathname = entry.path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Where a site keeps its own site-level files (llms.txt, sitemaps). A site
 * published under a path prefix serves them under that prefix: the origin root
 * belongs to whatever else the host publishes, and on a real host it redirects
 * to a different site altogether. The seed's own path is the site the operator
 * named, so it is tried first, then each ancestor, always ending at the origin
 * so a site published at the root behaves exactly as before.
 */
export function siteFileBases(seedUrl: string, limit = 4): string[] {
  const seed = new URL(seedUrl);
  const segments = seed.pathname.split('/').filter(Boolean);
  const baseAt = (depth: number) => new URL(`/${segments.slice(0, depth).join('/')}${depth ? '/' : ''}`, seed.origin).toString();
  const deepest: string[] = [];
  for (let depth = segments.length; depth >= 1; depth--) deepest.push(baseAt(depth));
  const origin = baseAt(0);
  // The origin is always probed, so a deep seed spends its budget on the paths nearest the page.
  return [...new Set([...deepest.slice(0, Math.max(0, limit - 1)), origin])];
}

/**
 * Whether a URL sits inside the site's own base path. `https://acme.example/docs/`
 * contains `/docs` itself and everything under it, and nothing else the host serves.
 */
export function withinSiteBase(url: string, base: string): boolean {
  const path = new URL(url).pathname.replace(/\/$/, '');
  const basePath = new URL(base).pathname.replace(/\/$/, '');
  if (new URL(url).origin !== new URL(base).origin) return false;
  return basePath === '' || path === basePath || path.startsWith(`${basePath}/`);
}

/**
 * Whether a response still belongs to the site being migrated. A site-level
 * file that redirects to another host is that host's file, not this site's:
 * `gitbook.com/llms.txt` serves the marketing site's index, which lists
 * marketing pages that are not documentation at all.
 */
function staysOnSite(finalUrl: string, seedHost: string, canonicalHosts: CanonicalHosts): boolean {
  const host = new URL(finalUrl).hostname.toLowerCase();
  return host === seedHost || canonicalHosts.canonicalise(new URL(finalUrl)).hostname.toLowerCase() === seedHost;
}

/** How many llms.txt indexes one site may publish before discovery stops following them. */
const MAX_LLMS_INDEXES = 64;

/**
 * Whether an llms.txt entry is a page of this site rather than a link to
 * another one. A site links out from its own index (Mintlify's docs list
 * `learn.mintlify.com`, a separate site, once per locale), and such a link is
 * not a page to migrate: its path is another site's path, so admitting it both
 * invents a page and collides with whatever this site serves at that path.
 * Published Markdown on another host stays in scope, because a platform may
 * serve a page's `.md` from a companion host and `canonicalHosts` is taught
 * those hosts from these very entries.
 */
function llmsLinkIsOnSite(url: string, seedHost: string, canonicalHosts: CanonicalHosts): boolean {
  return PUBLISHED_MARKDOWN.test(new URL(url).pathname) || staysOnSite(url, seedHost, canonicalHosts);
}

/**
 * Every page a site's llms.txt states, following the nested indexes it points
 * at. A site with locales or many tabs does not list its pages in one file: the
 * root names a handful of indexes, and the pages are in those. Following them is
 * the only way to read the source's own page list; not following them silently
 * migrates the fraction that happens to be listed at the root.
 *
 * An index reached twice is read once (a locale index and the root may both
 * name it). An index that cannot be read is a structural issue rather than a
 * page failure: the pages it lists are not merely unreachable, they are unknown,
 * and exact mode refuses a source universe it cannot enumerate.
 */
async function followLlmsIndexes(
  fetcher: Fetcher,
  root: ParsedLlmsIndex,
  rootUrl: string,
  seedHost: string,
  canonicalHosts: CanonicalHosts,
  indexSegment: string | undefined,
  failures: DiscoveryResult['failures'],
  structuralIssues: string[],
): Promise<{ entries: LlmsEntry[]; external: Array<{ title: string; url: string }> }> {
  const byPath = new Map<string, LlmsEntry>();
  const external = new Map<string, { title: string; url: string }>();
  const merge = (parsed: ParsedLlmsIndex, from: string) => {
    for (const link of parsed.external) if (!external.has(link.url)) external.set(link.url, link);
    for (const entry of parsed.entries) {
      const existing = byPath.get(entry.path);
      if (!existing) byPath.set(entry.path, { ...entry });
      else if (existing.title !== entry.title || existing.description !== entry.description) {
        structuralIssues.push(`llms.txt indexes disagree about ${entry.path}: "${existing.title}" and "${entry.title}" (${from}); the source must state one title and description per page`);
      }
    }
  };
  const parseOptions = { indexSegment, isOnSite: (url: string) => llmsLinkIsOnSite(url, seedHost, canonicalHosts) };
  merge(root, rootUrl);
  const seen = new Set<string>([rootUrl]);
  const queue = root.indexes.map((index) => index.url).filter((url) => !seen.has(url));
  for (const url of queue) seen.add(url);
  let read = 0;
  while (queue.length) {
    const url = queue.shift()!;
    if (++read > MAX_LLMS_INDEXES) {
      structuralIssues.push(`llms.txt names more than ${MAX_LLMS_INDEXES} nested indexes; the source page list cannot be enumerated`);
      break;
    }
    let response: FetchedPage;
    try { response = await fetcher.get(url); }
    catch (error) { structuralIssues.push(`llms.txt index ${url} could not be read (${(error as Error).message}); the pages it lists are unknown`); continue; }
    if (response.status < 200 || response.status >= 300 || !TEXT_MEDIA_TYPE.test(response.contentType)) {
      structuralIssues.push(`llms.txt index ${url} answered HTTP ${response.status} as "${response.contentType}"; the pages it lists are unknown`);
      continue;
    }
    const sourceUrl = response.finalUrl || url;
    if (!staysOnSite(sourceUrl, seedHost, canonicalHosts)) {
      structuralIssues.push(`llms.txt index ${url} redirected to ${sourceUrl}, which is a different site; the pages it lists are unknown`);
      continue;
    }
    const nested = parseLlmsIndex(response.body, sourceUrl, parseOptions);
    merge(nested, sourceUrl);
    for (const index of nested.indexes) if (!seen.has(index.url)) { seen.add(index.url); queue.push(index.url); }
  }
  return { entries: [...byPath.values()], external: [...external.values()] };
}

/**
 * The llms.txt index when the site serves one as text, looked for under the
 * site's own base before the origin root, and read through the nested indexes it
 * names. A 200 HTML body is a
 * single-page-app stand-in for a missing file, not an index. A fetch failure
 * is recorded; a malformed index propagates because it cannot be trusted.
 */
async function fetchLlmsIndex(fetcher: Fetcher, bases: string[], seedHost: string, canonicalHosts: CanonicalHosts, indexSegment: string | undefined, failures: DiscoveryResult['failures'], structuralIssues: string[]): Promise<(NonNullable<DiscoveryResult['llms']> & { external: Array<{ title: string; url: string }> }) | undefined> {
  for (const base of bases) {
    const url = new URL('llms.txt', base).toString();
    let response: FetchedPage;
    try { response = await fetcher.get(url); }
    catch (error) { failures.push({ url, error: `llms.txt: ${(error as Error).message}` }); continue; }
    if (response.status < 200 || response.status >= 300 || !TEXT_MEDIA_TYPE.test(response.contentType)) continue;
    const sourceUrl = response.finalUrl || url;
    if (!staysOnSite(sourceUrl, seedHost, canonicalHosts)) {
      failures.push({ url, error: `llms.txt: redirected to ${sourceUrl}, which is a different site; its entries are not this site's pages` });
      continue;
    }
    const root = parseLlmsIndex(response.body, sourceUrl, { indexSegment, isOnSite: (link: string) => llmsLinkIsOnSite(link, seedHost, canonicalHosts) });
    if (!root.entries.length && !root.indexes.length && !root.external.length) continue;
    const walked = await followLlmsIndexes(fetcher, root, sourceUrl, seedHost, canonicalHosts, indexSegment, failures, structuralIssues);
    if (walked.entries.length) return { url: sourceUrl, entries: walked.entries, external: walked.external };
  }
  return undefined;
}

/**
 * Mintlify embeds its navigation model in Next Flight data. This is not used
 * as content; it is recovered only to retain exact group labels, sidebar
 * labels, descriptions, order, and repeated placements.
 */
export function extractMintlifyNavigation(html: string, baseUrl: string): MintlifyNavigationExtraction | undefined {
  const base = new URL(baseUrl);
  const arrays: unknown[][] = [];
  const payloads = flightPayloads(html);
  // `scopedNav` is what the sidebar renders. `docsConfig.navigation` is stripped server-side on
  // scoped deployments, so it is only consulted when no scoped navigation is present.
  for (const key of ['"scopedNav"', '"navigation"', '"pages"'] as const) {
    for (const payload of payloads) {
      for (const marker of payload.matchAll(new RegExp(`${key}\\s*:`, 'g'))) {
        const from = marker.index! + marker[0].length;
        const arrayStart = payload.indexOf('[', from);
        const objectStart = payload.indexOf('{', from);
        const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
        if (start < 0) continue;
        const raw = payload[start] === '[' ? jsonArrayAt(payload, start) : jsonObjectAt(payload, start);
        if (!raw) continue;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) arrays.push(parsed);
          else if (parsed && typeof parsed === 'object') arrays.push([parsed]);
        } catch { /* another embedded value, or a chunk boundary inside this one */ }
      }
    }
    if (arrays.length) break;
  }

  const score = (value: unknown): number => {
    if (Array.isArray(value)) return value.reduce((n: number, item) => n + score(item), 0);
    if (!value || typeof value !== 'object') return 0;
    const node = value as Record<string, unknown>;
    const own = (typeof node.href === 'string' ? 4 : 0) + (containerLabel(node) ? 2 : 0) + (typeof node.sidebarTitle === 'string' ? 2 : 0);
    return own + CONTAINER_KEYS.reduce((n, key) => n + score(node[key]), 0);
  };
  const candidate = arrays.sort((a, b) => score(b) - score(a))[0];
  if (!candidate || score(candidate) < 6) return undefined;

  const pages: MintlifyNavigationExtraction['pages'] = [];
  const walk = (items: unknown[], groups: string[]): DiscoveredNavigationNode[] => items.flatMap((value) => {
    if (typeof value === 'string') {
      const url = mintlifyNavigationUrl(value, base.origin);
      pages.push({ url, groups });
      return [{ type: 'page' as const, url }];
    }
    if (!value || typeof value !== 'object') return [];
    const node = value as Record<string, unknown>;
    if (typeof node.href === 'string' && !containerLabel(node)) {
      const url = mintlifyNavigationUrl(node.href, base.origin);
      const title = typeof node.title === 'string' ? node.title : undefined;
      const sidebarTitle = typeof node.sidebarTitle === 'string' ? node.sidebarTitle : undefined;
      const description = typeof node.description === 'string' ? node.description : undefined;
      pages.push({ url, title, sidebarTitle, description, groups });
      return [{ type: 'page' as const, url, title: sidebarTitle ?? title }];
    }
    // Container kinds survive discovery; flattening switchers changes source structure.
    const label = containerLabel(node);
    const children = CONTAINER_KEYS.flatMap((key) => (Array.isArray(node[key]) ? walk(node[key] as unknown[], label ? [...groups, label] : groups) : []));
    if (!children.length && typeof node.href !== 'string') return [];
    const kind = (['group', 'tab', 'dropdown', 'product', 'version', 'language', 'menu'] as const).find((key) => typeof node[key] === 'string') ?? (typeof node.anchor === 'string' ? 'menu' : undefined);
    const metadata = Object.fromEntries(['icon', 'href', 'expandable', 'description'].filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
    return label ? [{ type: 'group' as const, ...(kind && kind !== 'group' ? { kind } : {}), label, ...metadata, children }] : children;
  });
  const navigation = walk(candidate, []);
  return navigation.length ? { navigation, pages } : undefined;
}

/**
 * Navigation as the page renders it. This is the independent witness the exact
 * gates cross-check platform metadata against, and the only navigation source
 * on platforms that embed none. Group labels come from the profile's group
 * heading selector; every anchor beneath a heading belongs to that group, and
 * anchors before the first heading stay top-level. With a child-list selector,
 * a page link followed by its subpage list names a nested group led by that page.
 */
export function extractDomSidebarNavigation(html: string, baseUrl: string, origin: string, profile: ScrapeProfile, canonicalHosts?: CanonicalHosts): DiscoveredNavigationNode[] | undefined {
  return sidebarNavigationFromRoot(parseHtml(html), baseUrl, origin, profile, canonicalHosts);
}

/** The same extraction over an already-parsed page, so a crawl need not parse each page twice. */
export function sidebarNavigationFromRoot(root: El, baseUrl: string, origin: string, profile: ScrapeProfile, canonicalHosts?: CanonicalHosts): DiscoveredNavigationNode[] | undefined {
  const navSelector = profile.navSelector;
  const groupSelector = profile.navGroupSelector;
  if (!navSelector || !groupSelector) return undefined;
  // A theme may render several containers the selector matches (an assistant panel, a
  // mobile drawer, the sidebar itself). The first one holding navigation is the sidebar;
  // an empty match is chrome, not an empty sidebar.
  // The profile lists its containers in preference order, so a site header cannot stand in
  // for the sidebar just by appearing first in the document.
  for (const branch of selectorBranches(navSelector)) {
    for (const container of findAll(root, branch)) {
      const nodes = navigationInContainer(container, baseUrl, origin, profile, canonicalHosts);
      if (nodes) return nodes;
    }
  }
  return undefined;
}

/** Distinct page URLs a navigation tree places, at any depth. */
function placedPages(nodes: DiscoveredNavigationNode[], seen = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'page') seen.add(node.url);
    else placedPages(node.children, seen);
  }
  return seen;
}



function navigationInContainer(container: El, baseUrl: string, origin: string, profile: ScrapeProfile, canonicalHosts?: CanonicalHosts): DiscoveredNavigationNode[] | undefined {
  const groupSelector = profile.navGroupSelector!;
  const linkSelector = profile.navLinkSelector ?? 'a[href]';
  // A badge rendered inside an entry ("Beta") is decoration around the label, never part of it.
  const badges = new Set(profile.navBadgeSelector ? findAll(container, profile.navBadgeSelector) : []);
  const textExcluding = (element: El): string => element.children.map((child) => {
    if (child.type === 'text') return child.data;
    return child.type === 'tag' && !badges.has(child) ? textExcluding(child) : '';
  }).join('');
  const label = (element: El): string => textExcluding(element).replace(/\s+/g, ' ').trim();
  // A group label names entries; it is never one of them. A candidate that is a link, holds
  // links, or sits inside one is the entry or the wrapper around a group, not its heading:
  // taking its text would name the group after the entries inside it. Themes built on utility
  // classes ("group/button") match such selectors constantly, so this is what keeps a broad
  // profile selector usable.
  const insideLink = (element: El): boolean => {
    for (let parent = element.parent; parent && parent !== container; parent = parent.parent) if (parent.name === 'a') return true;
    return false;
  };
  const groups = new Set(findAll(container, groupSelector).filter((element) => element.name !== 'a' && !findAll(element, 'a[href]').length && !insideLink(element)));
  const links = new Set(findAll(container, linkSelector));
  const childLists = new Set(profile.navChildListSelector ? findAll(container, profile.navChildListSelector) : []);
  const out: DiscoveredNavigationNode[] = [];
  let current: { type: 'group'; label: string; children: DiscoveredNavigationNode[] } | undefined;

  // One document-order walk keeps each anchor with the heading that precedes it, which is how the sidebar reads.
  const walk = (node: ReturnType<typeof parseHtml>): void => {
    const siblings = node.children ?? [];
    for (let index = 0; index < siblings.length; index++) {
      const child = siblings[index];
      if (child.type !== 'tag') continue;
      if (groups.has(child)) {
        const text = label(child);
        // An unlabelled decoration (an icon, a chevron) is not a group boundary; it leaves the
        // entries that follow where they are instead of ending the group they belong to.
        if (text) { current = { type: 'group', label: text, children: [] }; out.push(current); }
        continue;
      }
      if (links.has(child) && child.attribs.href) {
        // A fragment-only href moves within the page the reader is already on: a skip link, a
        // disclosure toggle, "back to top". It never names another page, so it is not an entry.
        if (child.attribs.href.trim().startsWith('#')) continue;
        const url = normaliseDiscoveryUrl(child.attribs.href, baseUrl, origin, canonicalHosts);
        const text = label(child);
        // An unlabelled link is a logo or an icon, the same decoration an unlabelled group is:
        // navigation the reader can use always states where each entry goes.
        const page: DiscoveredNavigationNode | undefined = url && text && isDocumentCandidate(url, profile.platform) ? { type: 'page', url, title: text } : undefined;
        const next = childLists.size ? siblings.slice(index + 1).find((sibling) => sibling.type === 'tag') : undefined;
        if (next && childLists.has(next as typeof child) && text) {
          // A parent page leads the group its label names. When one of its subpages is the same page, wherever it sits, that placement stands alone.
          const group: { type: 'group'; label: string; children: DiscoveredNavigationNode[] } = { type: 'group', label: text, children: page ? [page] : [] };
          const parent = current;
          current = group;
          walk(next as typeof child);
          current = parent;
          const [own, ...subpages] = group.children;
          if (own?.type === 'page' && subpages.some((child) => child.type === 'page' && child.url === own.url)) group.children.shift();
          if (group.children.length) (current ? current.children : out).push(group);
          index = siblings.indexOf(next);
          continue;
        }
        if (page) (current ? current.children : out).push(page);
        continue;
      }
      walk(child);
    }
  };
  walk(container);

  const pruned = out.filter((node) => node.type === 'page' || node.children.length);
  return pruned.length ? pruned : undefined;
}

/**
 * How many distinct pages the sidebar this page rendered lists.
 *
 * A page that renders no sidebar, and a page whose sidebar lists only itself, both leave the
 * reader nothing to navigate: that is what a landing page looks like (GitBook renders its home
 * section exactly this way). Counting distinct page links is what separates the two cases from
 * a real sidebar, and it is read from the page the source served, never inferred from the URL.
 */
export function sidebarPageCount(nodes: DiscoveredNavigationNode[] | undefined): number {
  const urls = new Set<string>();
  const walk = (items: readonly DiscoveredNavigationNode[]): void => {
    for (const node of items) node.type === 'page' ? urls.add(node.url.replace(/\/$/, '')) : walk(node.children);
  };
  walk(nodes ?? []);
  return urls.size;
}

/**
 * Whether the capture ever saw a rendered sidebar, which decides if "this page has none" means
 * anything. A site that builds its navigation in the browser (MadCap Flare serves an empty
 * `data-mc-toc` skeleton) renders none in every page we hold; calling those pages sidebar-less
 * would hide navigation the reader actually has. Silence is unobserved, not absent.
 */
export function sidebarObserved(pages: ReadonlyArray<{ sidebarPages?: number }>): boolean {
  return pages.some((page) => (page.sidebarPages ?? 0) >= 2);
}

/** One frozen page: the URL it was served from and the HTML as served. */
export interface FrozenPage { url: string; html?: string }

/**
 * The navigation the source renders, read back from frozen pages.
 *
 * Discovery re-derived offline and verification both call this, so a tree rebuilt after a
 * migrator fix and the tree verify expects can differ only if the frozen bytes differ. A
 * site divided into sections renders one sidebar per section, so each section's sidebar is
 * taken from a page inside it.
 */
export function navigationFromFrozenPages(pages: readonly FrozenPage[], platform: string, seed: string, origin: string, profile: ScrapeProfile, navigationData: FlareData = new Map()): { nodes: DiscoveredNavigationNode[]; source: 'platform-metadata' | 'dom-sidebar' } | undefined {
  const path = (value: string): string => { try { return new URL(value).pathname.replace(/\/$/, ''); } catch { return ''; } };
  const home = pages.find((page) => page.html && path(page.url) === path(seed)) ?? pages.find((page) => page.html);
  if (!home?.html) return undefined;
  if (navigationData.size) {
    // The sidebar this site builds in the browser, rebuilt from the frozen data files. Read from
    // the page that declared the help system those files belong to: one host can serve several.
    for (const page of pages) {
      if (!page.html) continue;
      const read = flareNavigationFromData(page.url, page.html, navigationData);
      if (read?.nodes.length) return { nodes: read.nodes, source: 'platform-metadata' };
    }
  }
  if (platform === 'mintlify') {
    const extracted = extractMintlifyNavigation(home.html, origin)?.navigation;
    if (extracted) return { nodes: extracted, source: 'platform-metadata' };
  }
  const sections = extractSectionTabs(home.html, seed, origin, profile);
  if (sections) {
    const sidebars = new Map<string, DiscoveredNavigationNode[]>();
    for (const page of pages) {
      if (!page.html) continue;
      const section = sectionOfUrl(page.url, sections);
      if (!section || sidebars.has(section.url)) continue;
      const dom = extractDomSidebarNavigation(page.html, page.url, origin, profile);
      if (dom) sidebars.set(section.url, dom);
      if (sidebars.size === sections.length) break;
    }
    const navigation = siteSectionNavigation(sections, sidebars);
    if (navigation) return { nodes: navigation, source: 'dom-sidebar' };
  }
  const dom = extractDomSidebarNavigation(home.html, seed, origin, profile);
  return dom ? { nodes: dom, source: 'dom-sidebar' } : undefined;
}

/** Selector alternatives in the order the profile states them, splitting on commas outside brackets. */
function selectorBranches(selector: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of selector) {
    if (character === '[') depth++;
    else if (character === ']') depth--;
    if (character === ',' && depth === 0) { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += character;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** A site-level section: its own sidebar, reached from the section switcher every page renders. */
export interface SiteSection { label: string; url: string }

/**
 * The sections a site divides itself into (GitBook site sections). Read from the
 * rendered section switcher, so the labels and order are the source's own. One
 * section is not a section structure, so fewer than two reports none.
 */
export function extractSectionTabs(html: string, baseUrl: string, origin: string, profile: ScrapeProfile, canonicalHosts?: CanonicalHosts, opts: { requireSeveral?: boolean } = {}): SiteSection[] | undefined {
  if (!profile.navSectionSelector) return undefined;
  const out: SiteSection[] = [];
  const seen = new Set<string>();
  for (const anchor of findAll(parseHtml(html), profile.navSectionSelector)) {
    const href = anchor.attribs.href;
    if (!href) continue;
    const url = normaliseDiscoveryUrl(href, baseUrl, origin, canonicalHosts);
    if (!url || seen.has(url)) continue;
    const label = (anchor.attribs['aria-label'] ?? textOf(anchor)).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    seen.add(url);
    out.push({ label, url });
  }
  // One section is not a section structure for the site; a caller asking where a single page belongs
  // still needs the one root that page declares.
  return out.length >= (opts.requireSeveral === false ? 1 : 2) ? out : undefined;
}

/** The section a page belongs to: the section whose path is its longest matching prefix. */
export function sectionOfUrl(url: string, sections: readonly SiteSection[]): SiteSection | undefined {
  const path = new URL(url).pathname.replace(/\/$/, '');
  const prefixOf = (section: SiteSection): string => new URL(section.url).pathname.replace(/\/$/, '');
  let best: SiteSection | undefined;
  for (const section of sections) {
    const prefix = prefixOf(section);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > prefixOf(best).length) best = section;
  }
  return best;
}

/**
 * Sections as `tab` containers, each holding the sidebar its own pages render.
 * Discovery and verification both build the navigation with this, from the same
 * rendered HTML, so the written navigation is judged against the source structure
 * rather than against a flattened copy of it. A section whose sidebar was never
 * acquired keeps only its own landing page, and a page the tree does not hold is
 * dropped later, so an unmigrated section reports as unplaced instead of inventing
 * a tab.
 */
export function siteSectionNavigation(sections: readonly SiteSection[], sidebars: ReadonlyMap<string, DiscoveredNavigationNode[]>): DiscoveredNavigationNode[] | undefined {
  const tabs = sections.map((section) => ({
    type: 'group' as const,
    kind: 'tab' as const,
    label: section.label,
    children: sidebars.get(section.url) ?? [{ type: 'page' as const, url: section.url }],
  }));
  return tabs.length >= 2 ? tabs : undefined;
}

/** Every page URL the tree already places, at any depth. */
function pageKeysIn(nodes: DiscoveredNavigationNode[]): string[] {
  return nodes.flatMap((node) => node.type === 'page' ? [navKey(node)] : pageKeysIn(node.children));
}

/** How a navigation node is identified across two renderings of the same sidebar. */
function navKey(node: DiscoveredNavigationNode): string {
  return node.type === 'page' ? `p:${node.url ?? ''}` : `g:${node.label ?? ''}`;
}

/**
 * One sidebar merged with another rendering of the same sidebar.
 *
 * A platform that expands the sidebar around the page being read renders a different part of one
 * tree on every page: no single page states the whole structure, and taking the first rendering
 * leaves most of the site unplaced. Merging the renderings recovers the tree the source has,
 * rather than inventing one — nodes are matched by identity, their order is preserved, and a node
 * only one rendering shows is inserted where that rendering puts it.
 */
export function mergeNavigationTrees(a: DiscoveredNavigationNode[], b: DiscoveredNavigationNode[], placed?: Set<string>): DiscoveredNavigationNode[] {
  // One rendering may show a page at the top level that another shows inside a group. Keeping both
  // would place it twice, so the first placement the merge reaches stands for the whole tree.
  const seen = placed ?? new Set<string>(pageKeysIn(a));
  const out: DiscoveredNavigationNode[] = [];
  const keysOfA = new Set(a.map(navKey));
  const keysOfB = new Set(b.map(navKey));
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i]; const right = b[j];
    if (left && right && navKey(left) === navKey(right)) {
      out.push(mergeNavigationNode(left, right, seen)); i++; j++;
    } else if (left && (!right || !keysOfB.has(navKey(left)))) {
      out.push(left); i++;
    } else if (right && !keysOfA.has(navKey(right))) {
      if (right.type === 'page' && seen.has(navKey(right))) { j++; continue; }
      if (right.type === 'page') seen.add(navKey(right));
      out.push(right); j++;
    } else if (left) { out.push(left); i++; } else if (right) { out.push(right); j++; }
  }
  return out;
}

/** Two renderings of one node: children merge, and a label the other rendering states fills a gap. */
function mergeNavigationNode(a: DiscoveredNavigationNode, b: DiscoveredNavigationNode, placed?: Set<string>): DiscoveredNavigationNode {
  if (a.type === 'group' && b.type === 'group') {
    return { ...a, href: a.href ?? b.href, icon: a.icon ?? b.icon, description: a.description ?? b.description, children: mergeNavigationTrees(a.children, b.children, placed) };
  }
  if (a.type === 'page' && b.type === 'page') return { ...a, title: a.title ?? b.title };
  return a;
}

/** The balanced JSON object beginning at `start`, respecting quoted strings. */
function jsonObjectAt(source: string, start: number): string | undefined {
  if (source[start] !== '{') return undefined;
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}

function stringField(node: Record<string, unknown>, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' && value ? value : undefined;
}

/** Mintlify's `logo` is either one URL or a light/dark pair. */
function logoOf(node: Record<string, unknown>): SiteConfig['logo'] {
  const logo = node.logo;
  if (typeof logo === 'string' && logo) return { light: logo };
  if (!logo || typeof logo !== 'object') return undefined;
  const pair = logo as Record<string, unknown>;
  const light = stringField(pair, 'light') ?? stringField(pair, 'default');
  const dark = stringField(pair, 'dark');
  return light || dark ? { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } : undefined;
}

function colorsOf(node: Record<string, unknown>): SiteConfig['colors'] {
  const colors = node.colors;
  if (!colors || typeof colors !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors as Record<string, unknown>)) if (typeof value === 'string' && value) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Site presentation from the `docsConfig` object Mintlify embeds in its Flight
 * payload. The rendered `<title>` and `og:site_name` are theme-decorated; this
 * is the site's own declaration, so it is what the migrated site carries.
 */
export function extractMintlifyDocsConfig(html: string): SiteConfig | undefined {
  for (const payload of flightPayloads(html)) {
    for (const marker of payload.matchAll(/"docsConfig"\s*:/g)) {
      const start = payload.indexOf('{', marker.index! + marker[0].length);
      if (start < 0) continue;
      const raw = jsonObjectAt(payload, start);
      if (!raw) continue;
      let node: Record<string, unknown>;
      try { node = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      const config: SiteConfig = {
        ...(stringField(node, 'name') ? { name: stringField(node, 'name') } : {}),
        ...(stringField(node, 'theme') ? { theme: stringField(node, 'theme') } : {}),
        ...(colorsOf(node) ? { colors: colorsOf(node) } : {}),
        ...(logoOf(node) ? { logo: logoOf(node) } : {}),
        ...(stringField(node, 'favicon') ? { favicon: stringField(node, 'favicon') } : {}),
      };
      if (Object.keys(config).length) return config;
    }
  }
  return undefined;
}

export function sitemapStructureHint(entry: SitemapEntry): { groups: string[]; locale?: string; version?: string } {
  const files = entry.trail.length ? entry.trail : [entry.sitemap];
  const tokens = files.flatMap((source) => {
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() ?? '')
      .replace(/\.(?:xml|gz)$/gi, '').replace(/^(?:sitemap|site-map)[-_.]*/i, '').replace(/[-_.]*(?:sitemap|site-map)$/i, '');
    return name.split(/[-_.]+/).map((token) => token.trim()).filter(Boolean);
  });
  const languageIndex = tokens.findIndex((token) => DOCUMENTATION_LANGUAGES.has(token.toLowerCase()));
  const language = languageIndex >= 0 ? tokens[languageIndex].toLowerCase() : undefined;
  const region = language && DOCUMENTATION_REGIONS.has(tokens[languageIndex + 1]?.toLowerCase()) ? tokens[languageIndex + 1].toUpperCase() : undefined;
  const locale = language ? `${language}${region ? `-${region}` : ''}` : undefined;
  const version = tokens.find((token) => /^v\d+(?:\.\d+)*$/i.test(token) || /^\d+\.\d+(?:\.\d+)?$/.test(token));
  const groups = [...new Set(tokens.filter((token, index) => index !== languageIndex && index !== languageIndex + (region ? 1 : 0) && token !== version && !GENERIC_SITEMAP_WORDS.has(token.toLowerCase()))
    .map((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())))];
  return { groups, locale, version };
}

export async function discoverLiveSite(input: {
  seedUrl: string;
  /** Its `canonicalHosts`, when configured, gain the hosts the site names in robots.txt and llms.txt so later fetches admit them. */
  fetcher: Fetcher;
  profile: ScrapeProfile;
  map?: (url: string, limit: number) => Promise<string[]>;
  limit?: number;
  concurrency?: number;
}): Promise<DiscoveryResult> {
  const concurrency = input.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('discovery concurrency must be an integer from 1 to 64');
  const seed = new URL(input.seedUrl);
  const origin = seed.origin;
  const canonicalHosts = input.fetcher.canonicalHosts ?? new CanonicalHosts(origin);
  if (canonicalHosts.seedOrigin !== origin) throw new Error(`fetcher canonical hosts are bound to ${canonicalHosts.seedOrigin}, not the seed origin ${origin}`);
  const limit = Math.max(1, Math.min(input.limit ?? 5000, 50_000));
  const records = new Map<string, { reasons: Set<string>; title?: string; description?: string; sidebarTitle?: string; htmlTitleTag?: string; domSidebarTitle?: string; llms?: LlmsEntry; discoveredOrder: number; sidebarOrder?: number; platformOrder?: number; sitemap?: SitemapEntry; groupHint?: string[]; locale?: string; version?: string; sidebarPages?: number; contentSha256?: string }>();
  const queue: string[] = [];
  const crawled = new Set<string>();
  const failures: Array<{ url: string; error: string }> = [];
  let refusedByLimit = 0;
  let discoveredOrder = 0;
  let sidebarOrder = 0;
  let platformOrder = 0;
  let navigation: DiscoveredNavigationNode[] | undefined;
  const navigationCandidates: NonNullable<DiscoveryResult['navigationCandidates']> = {};
  const structuralIssues: string[] = [];
  const helpSystems: HelpSystem[] = [];
  let sections: SiteSection[] | undefined;
  const sectionSidebars = new Map<string, DiscoveredNavigationNode[]>();
  /** Each space's own label as the source states it, including variant roots that are not site sections. */
  const spaceLabels = new Map<string, string>();
  let siteName: string | undefined;
  let siteConfig: SiteConfig | undefined;
  const navigationData: NonNullable<DiscoveryResult['navigationData']> = [];
  /** Help-system roots already read: one host can publish several, each with its own sidebar. */
  const flareRoots = new Set<string>();

  /** URLs that redirect or canonically point to a discovered page, by the page they stand for. */
  const aliasesOf = new Map<string, string[]>();
  const targetOfAlias = new Map<string, string>();
  const canonicalTarget = (url: string): string => {
    const seen = new Set<string>();
    while (targetOfAlias.has(url) && !seen.has(url)) { seen.add(url); url = targetOfAlias.get(url)!; }
    return url;
  };

  /** Pages a platform states in its navigation data: the tree's order, groups and exact labels. */
  const registerNavigationPages = (nodes: readonly DiscoveredNavigationNode[], groups: string[], base: string): void => {
    for (const node of nodes) {
      if (node.type === 'page') { add(node.url, 'platform-navigation', base, { sidebarTitle: node.title, groupHint: groups }); continue; }
      registerNavigationPages(node.children, [...groups, node.label], base);
    }
  };

  /**
   * Where the site's own declarations live, which is where the site is rooted: the directory
   * serving its llms.txt or its sitemap. Derived from what answered rather than from the seed
   * path, which may be a deep page or a file and names no root. Undefined until those are read,
   * and left undefined when the site declares neither, so the crawl is never narrowed on a guess.
   */
  let siteBase: string | undefined;
  const add = (candidate: string, reason: string, base = input.seedUrl, meta: { sitemap?: SitemapEntry; locale?: string; title?: string; description?: string; sidebarTitle?: string; domSidebarTitle?: string; llms?: LlmsEntry; groupHint?: string[] } = {}) => {
    const normalised = normaliseDiscoveryUrl(candidate, base, origin, canonicalHosts);
    if (!normalised || !isDocumentCandidate(normalised, input.profile.platform)) return;
    // GitBook and other themes link to a page's published-Markdown representation.
    // It is acquisition evidence for the extensionless page, never another page entity,
    // and admitting it here wastes the crawl budget before it can be discarded.
    if (PUBLISHED_MARKDOWN.test(new URL(normalised).pathname)) return;
    const url = canonicalTarget(normalised);
    // A page the crawl only reached by following a link, lying outside the site's own base path,
    // belongs to whatever else the host publishes rather than to this site: one host serves a
    // marketing site at its root and the documentation under /docs. What the site declares for
    // itself — its sitemap, its llms.txt — is admitted wherever it lives.
    if (reason === 'link-graph' && siteBase && !records.has(url) && !withinSiteBase(url, siteBase)) return;
    let record = records.get(url);
    if (!record) {
      if (records.size >= limit) { refusedByLimit++; return; }
      record = { reasons: new Set(), discoveredOrder: discoveredOrder++ };
      records.set(url, record);
      queue.push(url);
    }
    record.reasons.add(reason);
    if (reason === 'sidebar') record.sidebarOrder = Math.min(record.sidebarOrder ?? Number.MAX_SAFE_INTEGER, sidebarOrder++);
    if (reason === 'platform-navigation') record.platformOrder = Math.min(record.platformOrder ?? Number.MAX_SAFE_INTEGER, platformOrder++);
    // Sources are consulted in order of authority (llms.txt, platform metadata, rendered HTML): the first title and description stand.
    if (meta.title) record.title ??= meta.title;
    if (meta.description) record.description ??= meta.description;
    if (meta.llms) record.llms ??= meta.llms;
    // Only platform metadata states the exact sidebar label; rendered anchor text is recorded separately and never overwrites it.
    if (meta.sidebarTitle) record.sidebarTitle ??= meta.sidebarTitle;
    if (meta.domSidebarTitle) record.domSidebarTitle ??= meta.domSidebarTitle;
    // A page may be placed in several groups. The first placement is the page's own group; later ones are extra placements the navigation tree carries.
    if (meta.groupHint?.length) record.groupHint ??= meta.groupHint;
    if (meta.sitemap && (!record.sitemap || meta.sitemap.order < record.sitemap.order)) {
      const hint = sitemapStructureHint(meta.sitemap);
      record.sitemap = meta.sitemap;
      // A sitemap filename is a weaker signal than platform metadata, so it fills a gap and never replaces a recorded group.
      if (hint.groups.length) record.groupHint ??= hint.groups;
      record.locale = meta.locale ?? hint.locale;
      record.version = hint.version;
    } else if (meta.locale && !record.locale) record.locale = meta.locale;
  };

  add(input.seedUrl, 'seed');
  // The site's own statements of where it lives come first: a Sitemap directive may name another host the site
  // owns, and llms.txt links the published Markdown. Both must be known before any fetch the allowlist would refuse.
  // The reader fetches through this run's own fetcher, so the crawl policy, rate limit and
  // host checks that govern every other request govern these too.
  const flareFetch = async (target: string): Promise<{ status: number; body: string }> => {
    const fetched = await input.fetcher.get(target);
    return { status: fetched.status, body: fetched.body };
  };

  let robots: DiscoveryResult['robots'];
  try {
    const document = await input.fetcher.robotsDocument(origin);
    // The policy the site published is what the crawl was allowed under, so it is frozen with the
    // pages rather than read and dropped: a later reviewer can see the rules this run obeyed.
    robots = { url: new URL('/robots.txt', origin).toString(), body: document };
    // A Sitemap directive names another host of the same site only when the site itself published the
    // document. A host serving a marketing site at its root redirects robots.txt there, and adopting
    // that document's hosts would pull the marketing site's whole inventory in as documentation.
    const servedFrom = input.fetcher.robotsFinalUrl?.(origin);
    if (!servedFrom || new URL(servedFrom).hostname.toLowerCase() === seed.hostname.toLowerCase()) {
      for (const candidate of sitemapCandidatesFromRobots(document, origin)) canonicalHosts.add(new URL(candidate).hostname);
    } else failures.push({ url: robots.url, error: `robots.txt: served by ${new URL(servedFrom).hostname}, a different site; its Sitemap directives do not name this site's hosts` });
  }
  catch { /* discoverSitemaps and page acquisition report an unverifiable robots policy */ }
  const walkedLlms = await fetchLlmsIndex(input.fetcher, siteFileBases(input.seedUrl), seed.hostname.toLowerCase(), canonicalHosts, input.profile.llmsIndexSegment, failures, structuralIssues);
  const llms = walkedLlms ? { url: walkedLlms.url, entries: walkedLlms.entries } : undefined;
  const externalLlmsLinks = walkedLlms?.external ?? [];
  if (llms) {
    for (const entry of llms.entries) if (PUBLISHED_MARKDOWN.test(new URL(entry.mdUrl).pathname)) canonicalHosts.add(new URL(entry.mdUrl).hostname);
    for (const entry of llms.entries) add(pageUrlOfLlmsEntry(entry), 'llms-txt', llms.url, { title: entry.title, description: entry.description, llms: entry });
  }
  const sitemaps = await discoverSitemaps(input.fetcher, origin, { maxUrls: limit, bases: siteFileBases(input.seedUrl) });
  // The shallowest directory that served a declaration is the site root; when two levels both answer,
  // the shallower wins so the crawl is widened rather than narrowed.
  const declarationDirs = [
    ...(llms ? [llms.url] : []),
    ...sitemaps.sources.filter((source) => new URL(source).hostname.toLowerCase() === seed.hostname.toLowerCase()),
  ].map((source) => new URL('.', source).toString());
  siteBase = declarationDirs.sort((a, b) => new URL(a).pathname.split('/').length - new URL(b).pathname.split('/').length)[0];
  failures.push(...sitemaps.failures.map((failure) => ({ ...failure, error: `sitemap: ${failure.error}` })));
  for (const entry of sitemaps.entries) {
    add(entry.url, 'sitemap', input.seedUrl, { sitemap: entry });
    for (const alternate of entry.alternates) add(alternate.href, 'sitemap-hreflang', entry.url, { sitemap: entry, locale: alternate.hreflang === 'x-default' ? undefined : alternate.hreflang });
  }
  if (input.map) {
    try {
      for (const url of await input.map(input.seedUrl, limit)) add(url, 'firecrawl-map');
    } catch (error) {
      failures.push({ url: input.seedUrl, error: `map: ${(error as Error).message}` });
    }
  }

  /** A URL that redirects to another page of the site is that page under another name: its evidence moves onto the target, which is crawled in its place. */
  const foldAlias = (alias: string, requestedTarget: string) => {
    const target = canonicalTarget(requestedTarget);
    const from = records.get(alias)!;
    records.delete(alias);
    let to = records.get(target);
    if (!to) {
      to = { reasons: new Set(), discoveredOrder: from.discoveredOrder };
      records.set(target, to);
      if (!crawled.has(target)) queue.push(target);
    }
    for (const reason of from.reasons) to.reasons.add(reason);
    to.discoveredOrder = Math.min(to.discoveredOrder, from.discoveredOrder);
    if (from.sidebarOrder !== undefined) to.sidebarOrder = Math.min(to.sidebarOrder ?? Number.MAX_SAFE_INTEGER, from.sidebarOrder);
    if (from.platformOrder !== undefined) to.platformOrder = Math.min(to.platformOrder ?? Number.MAX_SAFE_INTEGER, from.platformOrder);
    to.title ??= from.title;
    to.description ??= from.description;
    to.llms ??= from.llms;
    to.sidebarTitle ??= from.sidebarTitle;
    to.domSidebarTitle ??= from.domSidebarTitle;
    to.groupHint ??= from.groupHint;
    if (from.sitemap && (!to.sitemap || from.sitemap.order < to.sitemap.order)) to.sitemap = from.sitemap;
    to.locale ??= from.locale;
    to.version ??= from.version;
    const aliases = [...(aliasesOf.get(alias) ?? []), alias];
    for (const knownAlias of aliases) targetOfAlias.set(knownAlias, target);
    aliasesOf.set(target, [...new Set([...(aliasesOf.get(target) ?? []), ...aliases])]);
    aliasesOf.delete(alias);
  };

  while (queue.length && crawled.size < limit) {
    const batch = queue.splice(0, Math.min(concurrency, limit - crawled.size)).filter((url) => !crawled.has(url));
    for (const url of batch) crawled.add(url);
    const responses = await mapConcurrent(batch, concurrency, async (url) => {
      try { return { url, response: await input.fetcher.get(url) }; }
      catch (error) { return { url, error: (error as Error).message }; }
    });
    // Apply results in queue order so timing never changes sidebar precedence or discovered order.
    for (const { url, response, error } of responses) {
    try {
      if (!response) throw new Error(error);
      // A page's published Markdown (`/page.md`) is that page in another format, never a page of its own.
      if (response.status >= 200 && response.status < 300 && PUBLISHED_MARKDOWN.test(new URL(url).pathname) && /^text\/(?:markdown|plain)\b/i.test(response.contentType)) { records.delete(url); continue; }
      const finalUrl = response.finalUrl ? normaliseDiscoveryUrl(response.finalUrl, url, origin, canonicalHosts) : undefined;
      if (finalUrl && finalUrl !== url) { foldAlias(url, finalUrl); continue; }
      // An unreachable page the site itself declares — in a sitemap, in llms.txt, in its own
      // navigation — stays in the tree: the declaration is the site's statement that the page
      // exists, and acquisition is where an exact run refuses it. A URL reached only by following
      // a link carries no such statement; a stale link is the ordinary way a site points at a page
      // it no longer serves, so it leaves the scope here rather than becoming a 404 in the
      // migration, with its reason recorded for the scope review.
      const linkOnly = [...(records.get(url)?.reasons ?? [])].every((reason) => reason === 'link-graph');
      const unusable = response.status < 200 || response.status >= 300 ? `HTTP ${response.status}`
        : !/html|xhtml/i.test(response.contentType || 'text/html') ? `not an HTML document: ${response.contentType || 'no content type'}`
        : undefined;
      if (unusable) {
        if (linkOnly) { records.delete(url); failures.push({ url, error: unusable }); }
        continue;
      }
      // Successful HTTP responses can still be aliases (notably Mintlify's `/index`).
      // Trust the document's explicit same-site canonical URL before treating the alias as another page.
      const canonicalUrl = canonicalPageUrl(response.body, response.finalUrl || url, origin, canonicalHosts);
      if (canonicalUrl && canonicalUrl !== url) { foldAlias(url, canonicalUrl); continue; }
      const root = parseHtml(response.body);
      // The theme decorates <title> ("Page - Site"), so it is recorded as evidence and never becomes the page title.
      records.get(url)!.htmlTitleTag ??= pageTitle(response.body);
      records.get(url)!.description ??= metaContent(response.body, 'meta[name=description]') ?? metaContent(response.body, 'meta[property=og:description]');
      // What this page showed the reader: a sidebar listing only this page is no navigation at all,
      // which is how a landing page renders. Read per page, because a site varies it per page.
      records.get(url)!.sidebarPages ??= sidebarPageCount(sidebarNavigationFromRoot(root, response.finalUrl || url, origin, input.profile, canonicalHosts));
      // The bytes this page served at discovery. Acquisition fetches it again, and comparing the
      // two is how a source that changes mid-run is noticed instead of silently mixed.
      records.get(url)!.contentSha256 ??= sha256(sourceFingerprint(response.body));
      siteName ??= metaContent(response.body, 'meta[property=og:site_name]');
      if (input.profile.platform === 'mintlify') {
        siteConfig ??= extractMintlifyDocsConfig(response.body);
        if (!navigation) {
          const extracted = extractMintlifyNavigation(response.body, input.seedUrl);
          if (extracted) {
            navigation = extracted.navigation;
            navigationCandidates['platform-metadata'] = extracted.navigation;
            for (const page of extracted.pages) add(page.url, 'platform-navigation', input.seedUrl, { title: page.title, description: page.description, sidebarTitle: page.sidebarTitle, groupHint: page.groups });
          }
        }
      }
      // MadCap Flare builds its sidebar in the browser from published data files, so a crawl of
      // the served HTML finds no navigation at all. Those files are static: this reads them, and
      // freezes them with the capture so verification re-derives the same tree with no network.
      //
      // The page's own declaration is the detection, not the profile: Flare output is recognised
      // by the attribute wherever it is served, including under the generic profile, and a page
      // that does not carry it costs one regex and no request.
      if (MADCAP_HELP_SYSTEM.test(response.body)) {
        const page = response.finalUrl || url;
        // One host can serve several independent help systems, each with its own sidebar — the
        // site this was written against serves 438 pages under one and 13 under another. Each is
        // read once, and the seed's is the site's navigation; a second one is reported rather than
        // merged, because concatenating two sidebars would state a structure the source does not.
        const flareRoot = helpSystemRoot(response.body, page);
        if (flareRoot && !flareRoots.has(flareRoot)) {
          flareRoots.add(flareRoot);
          try {
            const data = await fetchFlareData(page, response.body, flareFetch);
            const read = data && flareNavigationFromData(page, response.body, data);
            if (data && read?.nodes.length) {
              for (const [dataUrl, body] of data) if (!navigationData.some((file) => file.url === dataUrl)) navigationData.push({ url: dataUrl, body });
              if (!navigation) {
                navigation = read.nodes;
                navigationCandidates['platform-metadata'] = read.nodes;
                helpSystems.push({ root: flareRoot, seed: true, sidebarPages: placedPages(read.nodes).size });
              } else {
                const error = `a second MadCap help system is published here, with its own ${placedPages(read.nodes).size}-page sidebar; the navigation this run states is the one at ${[...flareRoots][0]}, and the pages under this one are placed by neither`;
                failures.push({ url: flareRoot, error });
                // The manifest issue is recorded verbatim on the help system, so a decision about
                // this system can be matched to the issue it answers without parsing the message.
                const issue = `${flareRoot}: ${error}`;
                structuralIssues.push(issue);
                helpSystems.push({ root: flareRoot, seed: false, sidebarPages: placedPages(read.nodes).size, issue });
              }
              // Its pages are discovered either way: a page the first sidebar never names is still
              // part of the site, and leaving it out of the crawl would hide it entirely.
              registerNavigationPages(read.nodes, [], page);
              // A node the chunks never supplied is a hole in the sidebar, not a page that moved.
              if (read.unresolved) {
                const error = `${read.unresolved} navigation entr(ies) name a node no chunk supplies; the sidebar read from this site is incomplete`;
                failures.push({ url: read.toc, error });
                structuralIssues.push(`${read.toc}: ${error}`);
              }
            }
          } catch (error) {
            failures.push({ url: page, error: (error as Error).message });
          }
        }
      }
      // A site that divides itself into sections renders one sidebar per section, so each
      // section's own sidebar is read from the first crawled page inside it.
      const pageUrl = response.finalUrl || url;
      const declared = extractSectionTabs(response.body, pageUrl, origin, input.profile, canonicalHosts, { requireSeveral: false });
      sections ??= declared && declared.length >= 2 ? declared : undefined;
      // Where this page says it belongs. A page whose switcher names several sections belongs to the
      // one containing it; a page whose switcher names a single root — a language variant — belongs
      // to that root, which its own path would otherwise hide under the section above it.
      // Resolved against the sections this page declares, not the site's: a translated page names its
      // own variant of each section, and matching against the default variant's paths would file every
      // translated page under the section whose path prefix it happens to share.
      const space = (declared ? sectionOfUrl(pageUrl, declared) : undefined) ?? (sections ? sectionOfUrl(pageUrl, sections) : undefined);
      const dom = extractDomSidebarNavigation(response.body, pageUrl, origin, input.profile, canonicalHosts);
      if (dom) {
        navigationCandidates['dom-sidebar'] ??= dom;
        if (space) {
          const seen = sectionSidebars.get(space.url);
          sectionSidebars.set(space.url, seen ? mergeNavigationTrees(seen, dom) : dom);
          spaceLabels.set(space.url, space.label);
        }
      }
      for (const anchor of findAll(root, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'link-graph', response.finalUrl || url);
      const navSelector = input.profile.navSelector ?? 'nav, aside, .sidebar, [role=navigation]';
      const linkSelector = input.profile.navLinkSelector ?? 'a[href]';
      for (const container of findAll(root, navSelector)) {
        for (const anchor of findAll(container, linkSelector)) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url, { domSidebarTitle: textOf(anchor).replace(/\s+/g, ' ').trim() || undefined });
        // Some platform-specific selectors are rooted at the document. The
        // fallback ensures links inside a matched navigation container survive.
        for (const anchor of findAll(container, 'a[href]')) if (anchor.attribs.href) add(anchor.attribs.href, 'sidebar', response.finalUrl || url, { domSidebarTitle: textOf(anchor).replace(/\s+/g, ' ').trim() || undefined });
      }
    } catch (error) {
      failures.push({ url, error: (error as Error).message });
    }
    }
  }

  // Every space that stated a sidebar becomes a container: the site's own sections first, in the
  // order the source lists them, then any variant root the sections do not already cover.
  const spaces: SiteSection[] = [
    ...(sections ?? []),
    ...[...spaceLabels].filter(([url]) => !(sections ?? []).some((section) => section.url === url)).map(([url, label]) => ({ url, label })),
  ];
  const sectionNavigation = spaces.length ? siteSectionNavigation(spaces, sectionSidebars) : undefined;
  if (sectionNavigation) navigationCandidates['dom-sidebar'] = sectionNavigation;

  // A theme renders link clusters that look like navigation in isolation: an account menu, a
  // mobile drawer, the "related topics" strip beside a topic. A sidebar is how the whole site
  // is read, so it places a real share of the site's pages; a cluster places a handful. A site
  // that builds its sidebar in JavaScript (MadCap Flare, and any other help system rendered by
  // a script) leaves only such clusters in the served HTML, and adopting one as the navigation
  // would file every other page under a heading that names none of them. The rendered candidate
  // is still recorded as an independent witness for verification; it just does not stand as the
  // site's navigation. Judged here because this is where the site's page count is known.
  const domSidebar = navigationCandidates['dom-sidebar'];
  const domSidebarPlaces = domSidebar ? placedPages(domSidebar).size : 0;
  const domSidebarIsNavigation = domSidebarPlaces >= 2 && domSidebarPlaces >= records.size * 0.02;

  return {
    pages: [...records.entries()].map(([url, value]) => ({
      url, title: value.title, description: value.description, sidebarTitle: value.sidebarTitle, htmlTitleTag: value.htmlTitleTag, domSidebarTitle: value.domSidebarTitle, llms: value.llms, reasons: [...value.reasons].sort(),
      orderHint: value.platformOrder ?? value.sidebarOrder ?? value.sitemap?.order ?? value.discoveredOrder,
      orderSource: value.platformOrder !== undefined || value.sidebarOrder !== undefined ? 'sidebar' : value.sitemap ? 'sitemap' : 'crawl',
      groupHint: value.groupHint?.length ? value.groupHint : undefined,
      locale: value.locale, version: value.version, sidebarPages: value.sidebarPages, contentSha256: value.contentSha256,
      sitemap: value.sitemap ? { source: value.sitemap.sitemap, order: value.sitemap.order, lastmod: value.sitemap.lastmod, changefreq: value.sitemap.changefreq, priority: value.sitemap.priority } : undefined,
      ...(aliasesOf.get(url)?.length ? { aliases: aliasesOf.get(url) } : {}),
    })),
    failures,
    ...(structuralIssues.length ? { structuralIssues: [...new Set(structuralIssues)].sort() } : {}),
    ...(helpSystems.length ? { helpSystems } : {}),
    sitemaps: { sources: sitemaps.sources, entries: sitemaps.entries, truncated: sitemaps.truncated },
    navigation: navigation ?? (domSidebarIsNavigation ? domSidebar : undefined),
    navigationSource: navigation ? 'platform-metadata' : domSidebarIsNavigation ? 'dom-sidebar' : undefined,
    navigationCandidates: Object.keys(navigationCandidates).length ? navigationCandidates : undefined,
    siteName: siteName ?? siteNameFromTitleTags([...records.values()].map((value) => value.htmlTitleTag)),
    siteConfig,
    llms,
    ...(externalLlmsLinks.length ? { externalLlmsLinks } : {}),
    canonicalHosts: canonicalHosts.list(),
    robots,
    ...(navigationData.length ? { navigationData } : {}),
    // true whenever a candidate was dropped because of the limit, even if the queue later drained
    truncated: sitemaps.truncated || refusedByLimit > 0 || (records.size >= limit && queue.length > 0),
  };
}
