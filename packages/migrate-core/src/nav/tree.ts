/**
 * The page tree (plan/tree.yaml) and documentation.json generation.
 * Pages are entities: identity is the entity id, URL is an attribute.
 */
import { attachHelpCenterHub } from './help-center.js';
import { specOutputPath } from '../openapi/graph.js';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../urls/slugger.js';
import type { LlmsEntry } from '../scrape/published-markdown.js';

export interface TreePage {
  id: string;
  title: string;
  /**
   * Where `title` came from. `path` means no source stated one at discovery, so it
   * is a placeholder the page's own H1 must replace at inventory; exact mode refuses
   * to migrate a page still holding one.
   */
  titleSource?: 'llms-txt' | 'platform-metadata' | 'source-config' | 'published-markdown' | 'rendered-h1' | 'rendered-heading' | 'path';
  /** Exact label shown in source navigation. It may intentionally differ from the page title. */
  sidebarTitle?: string;
  icon?: string;
  tags?: string;
  badge?: string;
  method?: string;
  /** Sidebar anchor text as the source renders it. Cross-checked against `sidebarTitle`; never used in its place. */
  domSidebarTitle?: string;
  /**
   * Whether the source navigation places this page. `unlisted` pages are published
   * but absent from the sidebar (llms.txt- or sitemap-only); they migrate as files
   * and are reported, never invented into a group.
   */
  navMembership?: 'listed' | 'unlisted';
  /**
   * Whether the source rendered a navigation sidebar on this page. A source varies this per
   * page: a landing page shows the reader no sidebar while its section pages do, and migrating
   * both with a sidebar changes the structure the source presents. `absent` is written only
   * from a page the source served; undefined means it could not be observed (a site that builds
   * its navigation in JavaScript), and then the migration asserts nothing.
   */
  sourceSidebar?: 'rendered' | 'absent';
  /** Source page description, preserved independently from the title/body. */
  description?: string;
  /** The page's llms.txt entry when the site publishes one: the exact title, description and published-Markdown URL. */
  llms?: LlmsEntry;
  /** Source location: URL or export path. */
  source: string;
  /** Group path, outermost first. */
  group: string[];
  order: number;
  /** Old public URL path when known. */
  oldPath?: string;
  /** New repo path without extension, set by the URL plan. */
  newPath?: string;
  migrate: boolean;
  locale?: string;
  version?: string;
  visibility?: 'public' | 'private';
  status?: 'published' | 'draft' | 'hidden';
  aliases?: string[];
  reason?: string;
  /** Discovery evidence retained for operator review; not emitted to documentation.json. */
  discovery?: {
    sitemap?: string;
    sitemapOrder?: number;
    lastmod?: string;
    changefreq?: string;
    priority?: number;
    groupHint?: string[];
  };
}

/** Navigation placements are separate from page entities: one page may appear in several groups. */
export type SourceNavigationNode =
  | { type: 'page'; pageId: string; title?: string; icon?: string; tags?: string; badge?: string; method?: string }
  | {
      type: 'group'; kind?: NavigationContainerKind; label: string; children: SourceNavigationNode[];
      /** The page this container itself opens, when the source gives it one (a GitBook parent page, a Flare topic with subtopics). Written as the container's `path`, never as a duplicate first entry. */
      pageId?: string;
      icon?: string; href?: string; expandable?: boolean; description?: string;
    };

export type NavigationContainerKind = 'product' | 'language' | 'version' | 'tab' | 'dropdown' | 'menu' | 'group';

/** Only authored presentation metadata crosses this boundary. Undefined fields are omitted. */
export function navigationMetadata(source: Record<string, unknown>): { icon?: string; href?: string; expandable?: boolean; description?: string; tags?: string; badge?: string; method?: string } {
  const result: ReturnType<typeof navigationMetadata> = {};
  for (const key of ['icon', 'href', 'description', 'tags', 'badge', 'method'] as const) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }
  if (typeof source.expandable === 'boolean') result.expandable = source.expandable;
  return result;
}

export interface Tree {
  scope: 'full' | 'partial';
  platform: string;
  pages: TreePage[];
  /** Exact source navigation when the adapter can prove it. Falls back to page.group for older plans. */
  navigation?: SourceNavigationNode[];
  /** How the navigation was obtained. `manual` means an operator supplied/reviewed it. */
  navigationSource?: 'source-config' | 'platform-metadata' | 'dom-sidebar' | 'sitemap-hint' | 'url-path' | 'manual';
  /**
   * Where pages the source's own sidebar never placed go in the navigation.
   *
   * The renderer serves only routes the navigation names, so a page written as a file and left out
   * of it is not reachable at all. `source-path` places those pages under the folders the source
   * publishes them in — the source's own hierarchy, not an invented one. Recorded by an operator,
   * because it states a structure the source's sidebar does not.
   */
  unlistedPlacement?: { strategy: 'source-path'; approvedBy: string; approvedAt: string };
  /** A container the operator declared a help centre: it opens on a hub page the migration writes, rendered by the platform's own `CollectionList`. */
  helpCenter?: import('./help-center.js').HelpCenterDecision;
  /** Version and locale served at the root paths; others are prefixed. */
  defaultVersion?: string;
  defaultLocale?: string;
}

export function writeTree(workspace: string, tree: Tree): void {
  writeFileSync(join(workspace, 'plan', 'tree.yaml'), toYaml(tree), { mode: 0o600 });
}

export function readTree(workspace: string): Tree {
  return parseYaml(readFileSync(join(workspace, 'plan', 'tree.yaml'), 'utf8')) as Tree;
}

/** Nested groups → navigation for one version/locale slice. Uses `groups` at the root, `pages` inside. */
/** Every page id the source navigation places, however deeply nested. */
export function placedPageIds(nodes: SourceNavigationNode[] | undefined): Set<string> {
  const ids = new Set<string>();
  const walk = (items: SourceNavigationNode[]): void => {
    for (const node of items) {
      if (node.type === 'page') ids.add(node.pageId);
      else { if (node.pageId) ids.add(node.pageId); walk(node.children); }
    }
  };
  walk(nodes ?? []);
  return ids;
}

/**
 * In-scope pages the source navigation does not place. With no source navigation
 * every page is placed by its group path, so the answer is empty; with one, these
 * are the pages that would silently vanish from the sidebar.
 */
export function pagesWithoutPlacement(tree: Tree): TreePage[] {
  if (!tree.navigation?.length) return [];
  const placed = placedPageIds(tree.navigation);
  return tree.pages.filter((page) => page.migrate && page.newPath && !placed.has(page.id));
}

function buildSlice(pages: TreePage[], sourceNavigation?: SourceNavigationNode[], placeUnlisted = false): Record<string, unknown> {
  type PageRef = { title: string; path: string };
  type Node = { group: string; pages: Array<PageRef | Node>; _order: number };
  const eligible = new Map(pages.filter((p) => p.migrate && p.newPath).map((p) => [p.id, p]));
  if (sourceNavigation?.length) {
    const convert = (nodes: SourceNavigationNode[]): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      for (const node of nodes) {
      if (node.type === 'page') {
        const page = eligible.get(node.pageId);
        if (page) out.push({ ...pageMetadata(page), ...pageMetadata(node), ...pageLayout(page), title: node.title ?? page.sidebarTitle ?? page.title, path: page.newPath! });
        continue;
      }
      // A container whose first page is its own landing page — titled as the container is, or
      // sitting at the container's own route (`assistant` above `assistant/configure`, or its
      // `index`/`readme`) — opens on that page: the platform reads it from the container's `path`,
      // and listing it again as a first child would show the same name twice in the sidebar.
      const lifted = !node.pageId ? landingChild(node, eligible) : undefined;
      const remaining = lifted ? node.children.filter((child) => child !== lifted) : node.children;
      const children = convert(remaining);
      const kind = node.kind ?? 'group';
      // The container's own page, which the platform reads from the container's `path`. A container
      // with nothing left beneath it is simply that page.
      const own = node.pageId ? eligible.get(node.pageId) : lifted ? eligible.get(lifted.pageId) : undefined;
      if (own && !children.length && !node.href) { out.push({ ...pageMetadata(own), ...pageLayout(own), title: node.label, path: own.newPath! }); continue; }
      if (children.length || node.href) out.push({ [kind]: node.label, ...navigationMetadata(node), ...(own ? { path: own.newPath!, ...pageLayout(own) } : {}), ...(children.length ? collection(children, kind) : {}) });
      }
      return out;
    };
    const top = convert(sourceNavigation);
    if (placeUnlisted) {
      const placed = new Set<string>();
      const mark = (nodes: SourceNavigationNode[]): void => {
        for (const node of nodes) { if (node.type === 'page') placed.add(node.pageId); else mark(node.children); }
      };
      mark(sourceNavigation);
      const rest = pages.filter((page) => page.migrate && page.newPath && !placed.has(page.id));
      if (rest.length) top.push(...groupsBySourcePath(rest));
    }
    return collection(top, 'navigation');
  }
  const roots: Array<PageRef | Node> = [];
  const byPath = new Map<string, Node>();
  const inScope = pages.filter((p) => p.migrate && p.newPath).sort((a, b) => a.order - b.order);
  for (const p of inScope) {
    let container: Array<PageRef | Node> = roots;
    let key = '';
    for (const g of p.group.filter((x) => x && x !== '(uncategorised)')) {
      key = key ? `${key}/${g}` : g;
      let node = byPath.get(key);
      if (!node) { node = { group: g, pages: [], _order: p.order }; byPath.set(key, node); container.push(node); }
      container = node.pages;
    }
    container.push({ ...pageMetadata(p), ...pageLayout(p), title: p.sidebarTitle ?? p.title, path: p.newPath! }); // the renderer rejects bare path strings
  }
  const clean = (items: Array<PageRef | Node>): Array<PageRef | { group: string; pages: unknown[] }> => items.map((it) => ('group' in it ? { group: it.group, pages: clean(it.pages) } : it));
  const top = clean(roots);
  const allGroups = top.every((t) => 'group' in t);
  return allGroups && top.length ? { groups: top } : { pages: top };
}

/**
 * Per-page layout the renderer reads from the page's navigation entry. Only a difference the
 * source actually showed is written: `show-sidebar` defaults to true, so a page that rendered a
 * sidebar carries nothing, and a page that rendered none carries false.
 */
function pageLayout(page: { sourceSidebar?: 'rendered' | 'absent' }): Record<string, boolean> {
  return page.sourceSidebar === 'absent' ? { 'show-sidebar': false } : {};
}

function pageMetadata(page: { icon?: string; tags?: string; badge?: string; method?: string }): Record<string, string> {
  return Object.fromEntries(Object.entries({ icon: page.icon, tags: page.tags, badge: page.badge, method: page.method }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function collection(items: Record<string, unknown>[], parent: string): Record<string, unknown> {
  const kinds: NavigationContainerKind[] = ['product', 'language', 'version', 'tab', 'dropdown', 'menu', 'group'];
  const types = new Set(items.map((item) => kinds.find((kind) => kind in item) ?? 'page'));
  if (parent === 'group' || [...types].every((kind) => kind === 'page' || kind === 'group') && types.has('page')) {
    if ([...types].some((kind) => kind !== 'page' && kind !== 'group')) throw new Error(`navigation ${parent}: cannot preserve dimension containers inside pages`);
    return { pages: items };
  }
  if (types.size > 1) throw new Error(`navigation ${parent}: mixed child kinds ${[...types].join(', ')} cannot be represented without changing structure`);
  const kind = [...types][0] ?? 'page';
  return { [kind === 'page' ? 'pages' : `${kind}s`]: items };
}

/**
 * documentation.json navigation. Exactly one semantic key per container:
 * languages → versions → groups/pages, each level present only when the tree uses it.
 * The schema has no `default` flag: the default version or language is listed first.
 */
export function buildNavigation(pages: TreePage[], defaults: { defaultVersion?: string; defaultLocale?: string; sourceNavigation?: SourceNavigationNode[]; placeUnlisted?: boolean } = {}): { navigation: Record<string, unknown> } {
  const inScope = pages.filter((p) => p.migrate && p.newPath);
  const hasDimensions = (nodes: SourceNavigationNode[]): boolean => nodes.some((node) => node.type === 'group' && (node.kind === 'language' || node.kind === 'version' || hasDimensions(node.children)));
  if (hasDimensions(defaults.sourceNavigation ?? [])) return { navigation: buildSlice(inScope, defaults.sourceNavigation, defaults.placeUnlisted) };
  const locales = [...new Set(inScope.map((p) => p.locale).filter((x): x is string => !!x))];
  const versions = [...new Set(inScope.map((p) => p.version).filter((x): x is string => !!x))];
  const orderFirst = <T,>(items: T[], first?: T) => (first && items.includes(first) ? [first, ...items.filter((x) => x !== first)] : items);
  const byVersion = (subset: TreePage[]): Record<string, unknown> => {
    const vs = orderFirst([...new Set(subset.map((p) => p.version).filter((x): x is string => !!x))], defaults.defaultVersion);
    if (vs.length < 2 && !(vs.length === 1 && subset.some((p) => !p.version))) return buildSlice(subset, defaults.sourceNavigation, defaults.placeUnlisted);
    return { versions: vs.map((v) => ({ version: v, ...buildSlice(subset.filter((p) => p.version === v), defaults.sourceNavigation, defaults.placeUnlisted) })) };
  };
  if (locales.length >= 2) {
    const ls = orderFirst(locales, defaults.defaultLocale);
    return { navigation: { languages: ls.map((l) => ({ language: l, ...byVersion(inScope.filter((p) => p.locale === l)) })) } };
  }
  return { navigation: versions.length >= 2 ? byVersion(inScope) : buildSlice(inScope, defaults.sourceNavigation, defaults.placeUnlisted) };
}

/** Attach a group-level `openapi` property to the group at `groupPath` (DAI group-level OpenAPI connection). */
export function attachGroupOpenapi(nav: { navigation: Record<string, unknown> }, groupPath: string[], spec: string, version?: string, locale?: string): { navigation: Record<string, unknown> } {
  const clone = structuredClone(nav);
  const kinds = ['product', 'language', 'version', 'tab', 'dropdown', 'menu', 'group'];
  const matches: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown>, path: string[], currentVersion?: string, currentLocale?: string): void => {
    const v = typeof node.version === 'string' ? node.version : currentVersion;
    const l = typeof node.language === 'string' ? node.language : currentLocale;
    const kind = kinds.find((key) => typeof node[key] === 'string');
    const next = kind && kind !== 'version' && kind !== 'language' ? [...path, String(node[kind])] : path;
    if (kind === 'group' && next.join('\0') === groupPath.join('\0') && (version === undefined || v === version) && (locale === undefined || l === locale)) matches.push(node);
    for (const key of ['products', 'languages', 'versions', 'tabs', 'dropdowns', 'menus', 'groups', 'pages']) {
      const children = node[key];
      if (Array.isArray(children)) for (const child of children) if (child && typeof child === 'object') walk(child as Record<string, unknown>, next, v, l);
    }
  };
  walk(clone.navigation, []);
  if (!matches.length) throw new Error(`group path not found in navigation: ${groupPath.join(' / ')}`);
  if (matches.length !== 1) throw new Error(`group path ${groupPath.join(' / ')} resolves to ${matches.length} groups; specify an unambiguous version and locale`);
  matches[0].openapi = spec;
  return clone;
}

/** A group-level OpenAPI connection the source adapter recorded (inventory/platform-meta.json `openapi`). */
export interface GroupOpenapiRef { groupPath: string[]; spec: string; version?: string; locale?: string }

export interface DocumentationNavigationMeta { openapi?: GroupOpenapiRef[] }

/**
 * The navigation nav writes to documentation.json and the one verify expects back: the pages
 * whose converted file exists (`writtenPaths` holds their new paths without extension), built
 * from the reviewed tree with every group-level OpenAPI connection attached. One function for
 * both sides, so a difference between them can only come from the output itself. A connection
 * whose group is absent from the navigation is an error, never a silently skipped entry.
 */
/** Words compared as a sidebar shows them: case, surrounding space and a trailing colon or period aside. */
function sameLabel(a: string | undefined, b: string): boolean {
  const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s]+/g, ' ').replace(/[.:]+$/, '');
  return !!a && norm(a) === norm(b);
}

/**
 * The first page beneath a container when it is the container's own landing page: it carries the
 * container's name, or its route is the directory its siblings sit in (or that directory's
 * `index`/`readme`). Anything else stays a child. Only the first page counts: an index page leads.
 */
export function landingChild(node: { label: string; children: SourceNavigationNode[] }, eligible: ReadonlyMap<string, TreePage>): Extract<SourceNavigationNode, { type: 'page' }> | undefined {
  const first = node.children[0];
  // only a first page, and only when something else stays beneath the container: a container with
  // one page is the source's structure, and lifting it would collapse the container into a page
  if (!first || first.type !== 'page' || !eligible.has(first.pageId) || node.children.length < 2) return undefined;
  const page = eligible.get(first.pageId)!;
  if (sameLabel(first.title ?? page.sidebarTitle ?? page.title, node.label)) return first;
  const isIndex = /\/(?:index|readme)$/i.test(page.newPath!);
  const route = page.newPath!.replace(/\/(?:index|readme)$/i, '');
  const siblings = node.children.slice(1).flatMap((child) => (child.type === 'page' ? [eligible.get(child.pageId)?.newPath] : []));
  const dir = (path: string): string => path.replace(/\/[^/]+$/, '');
  const underIt = siblings.length > 0 && siblings.every((sibling) => sibling && dir(sibling) === route);
  // the container's own route: named for the container (`assistant` under "Assistant"), or the
  // index of the directory its siblings sit in; a site's root page under its first group is neither
  const slug = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  const named = slug(route.split('/').pop() ?? '') === slug(node.label);
  if (underIt && (named || isIndex)) return first;
  return undefined;
}

export function buildDocumentationNavigation(tree: Tree, writtenPaths: ReadonlySet<string>, platformMeta: DocumentationNavigationMeta): { navigation: Record<string, unknown> } {
  const written = tree.pages.filter((page) => page.newPath !== undefined && writtenPaths.has(page.newPath));
  let navigation = buildNavigation(written, { defaultVersion: tree.defaultVersion, defaultLocale: tree.defaultLocale, sourceNavigation: tree.navigation, placeUnlisted: !!tree.unlistedPlacement });
  for (const ref of platformMeta.openapi ?? []) {
    try {
      navigation = attachGroupOpenapi(navigation, ref.groupPath, specOutputPath(ref.spec), ref.version, ref.locale);
    } catch (error) {
      throw new Error(`openapi ${ref.spec}: ${(error as Error).message}; no written page is placed under that group, so remove the entry from inventory/platform-meta.json or migrate the group's pages`);
    }
  }
  // Applied here, so the navigation verification re-derives carries the same hub as the one written.
  if (tree.helpCenter) navigation = { navigation: attachHelpCenterHub(navigation.navigation, tree.helpCenter).navigation };
  return navigation;
}

/**
 * Pages the source's sidebar never named, grouped under the folders the source publishes them in.
 *
 * The renderer serves only what the navigation names, so these pages exist as files and nothing
 * more until they are placed. Their groups are read from the source's own URL hierarchy — the
 * structure the site already has — rather than composed here.
 */
function groupsBySourcePath(pages: TreePage[]): Record<string, unknown>[] {
  type Node = { group: string; key: string; pages: Array<Record<string, unknown> | Node>; order: number; route: string; members: number; own?: TreePage };
  const roots: Array<Record<string, unknown> | Node> = [];
  const byPath = new Map<string, Node>();
  const named = (value: string): boolean => !!value && value !== '(uncategorised)';
  const sorted = [...pages].sort((a, b) => a.order - b.order);
  const folders = (page: TreePage): string[] => page.group.filter(named);
  // The route a folder covers is the leading segments of its pages' routes, one per folder name.
  const folderRoute = (page: TreePage, depth: number): string => page.newPath!.split('/').slice(0, depth).join('/');
  const keyOf = (page: TreePage): string => folders(page).join('/');

  // Every folder these pages sit in, with the route it covers and how many pages it holds.
  for (const page of sorted) {
    let container = roots;
    let key = '';
    let depth = 0;
    for (const name of folders(page)) {
      key = key ? `${key}/${name}` : name;
      depth++;
      let node = byPath.get(key);
      if (!node) { node = { group: name, key, pages: [], order: page.order, route: folderRoute(page, depth), members: 0 }; byPath.set(key, node); container.push(node); }
      // every page beneath this folder, at any depth: a folder whose pages all sit in subfolders
      // still holds them
      node.members++;
      container = node.pages;
    }
  }

  const byRoute = new Map<string, Node>();
  for (const node of byPath.values()) if (node.route) byRoute.set(node.route, node);
  /**
   * The folder a page is the landing page of: the one whose own route the page sits at. A MadCap
   * site publishes `/Explainers.htm` beside `/Explainers/`, and most static generators publish
   * `/Explainers/index`; either way the page opens the section. The platform reads it from the
   * container's `path`, so listing it separately showed the section twice — once as a group, once
   * as a page under whatever title the source gave it, which on this Flare site was the same
   * "SessionM Help Center" on every section. A folder left with nothing else beneath it is simply
   * that page, so it stays where it is.
   */
  const landingFolder = (page: TreePage): Node | undefined => {
    const node = byRoute.get(page.newPath!.replace(/\/(?:index|readme)$/i, ''));
    if (!node || node.own) return undefined;
    const beneath = keyOf(page) === node.key || keyOf(page).startsWith(`${node.key}/`);
    const others = node.members - (beneath ? 1 : 0);
    return others > 0 ? node : undefined;
  };

  for (const page of sorted) {
    const landing = landingFolder(page);
    if (landing) { landing.own = page; continue; }
    let container = roots;
    let key = '';
    for (const name of folders(page)) {
      key = key ? `${key}/${name}` : name;
      container = byPath.get(key)!.pages;
    }
    container.push({ ...pageMetadata(page), ...pageLayout(page), title: page.sidebarTitle ?? page.title, path: page.newPath! });
  }

  const clean = (items: Array<Record<string, unknown> | Node>): Record<string, unknown>[] =>
    items.map((item) => ('group' in item && Array.isArray((item as Node).pages)
      ? { group: (item as Node).group, ...((item as Node).own ? { path: (item as Node).own!.newPath!, ...pageLayout((item as Node).own!) } : {}), pages: clean((item as Node).pages) }
      : item as Record<string, unknown>));
  return clean(roots);
}

/** Default new path from the group path and title (restructure mode). */
export function pathFromTree(p: TreePage): string {
  const parts = [...p.group.filter((g) => g && g !== '(uncategorised)').map(slugify), slugify(p.title)];
  return parts.join('/');
}
