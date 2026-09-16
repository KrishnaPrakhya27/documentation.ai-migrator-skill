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

/** Containers a site states above its content: the dimensions of the site, not folders within it. */
const DIMENSION_KINDS = ['product', 'language', 'version'] as const;
/** Container kinds in the order `collection` names them, so a node can be rebuilt as a sibling of its kind. */
const CONTAINER_KINDS = ['product', 'language', 'version', 'tab', 'dropdown', 'menu', 'group'] as const;

/** Every route named anywhere beneath a built navigation node. */
function routesUnder(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { for (const item of node) routesUnder(item, out); return out; }
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.path === 'string') out.push(record.path);
  for (const value of Object.values(record)) if (Array.isArray(value)) routesUnder(value, out);
  return out;
}

/** How many leading path segments two routes share. */
function sharedSegments(a: string, b: string): number {
  const left = a.split('/'); const right = b.split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

/** The key holding a built container's children, and the kind those children are. */
function childrenOf(node: Record<string, unknown>): { key: string; kind: string; items: Record<string, unknown>[] } | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (!Array.isArray(value) || !key.endsWith('s')) continue;
    const kind = CONTAINER_KINDS.find((candidate) => `${candidate}s` === key) ?? (key === 'pages' ? 'page' : undefined);
    if (kind) return { key, kind, items: value as Record<string, unknown>[] };
  }
  return undefined;
}

function containerKind(node: Record<string, unknown>): string | undefined {
  return CONTAINER_KINDS.find((kind) => typeof node[kind] === 'string');
}

/**
 * A page the sidebar never named, whose route is the route every page in a container sits under, is
 * that container's own landing page — `/docs/analytics` above `/docs/analytics/traffic`. The source
 * publishes it as the section's front page and simply does not repeat it in the sidebar, so it is
 * written where the platform reads a container's own page, rather than as a child repeating the
 * container's name. The deepest container wins, and a container that already states a page keeps it.
 */
function liftLandingPages(top: Record<string, unknown>[], rest: TreePage[]): TreePage[] {
  const remaining = new Map(rest.map((page) => [page.newPath!, page]));
  const containers: Record<string, unknown>[] = [];
  const collect = (nodes: Record<string, unknown>[]): void => {
    for (const node of nodes) {
      const children = childrenOf(node);
      if (!children) continue;
      if (containerKind(node)) containers.push(node);
      collect(children.items);
    }
  };
  collect(top);
  // The site's own root is nobody's section front page: every route sits under it, so without this
  // the first container to be considered would claim the home page as its landing page.
  const everything = routesUnder(top);
  const siteRoot = everything.length ? everything.reduce((shared, route) => Math.min(shared, sharedSegments(everything[0], route)), everything[0].split('/').length) : 0;
  // deepest first: a page is the landing page of the most specific container it leads
  for (const node of containers.sort((a, b) => routesUnder(a).length - routesUnder(b).length)) {
    if (typeof node.path === 'string') continue;
    const routes = routesUnder(node);
    if (!routes.length) continue;
    const label = containerKind(node) ? String(node[containerKind(node)!]) : '';
    let best: TreePage | undefined;
    for (const page of remaining.values()) {
      const route = page.newPath!;
      const under = routes.filter((beneath) => beneath.startsWith(`${route}/`));
      // Every page beneath the container sits under this route, or the container is named for it and
      // some of them do - the same two readings `landingChild` already applies to a listed first page.
      // A sidebar that also groups a page from elsewhere under "Analytics" does not stop
      // `/docs/analytics` being the page that section opens on.
      if (route.split('/').length <= siteRoot) continue;
      // The container is named for this page, or this is simply the folder its pages sit in: a
      // sidebar that also groups one page from elsewhere under "Analytics" does not stop
      // `/docs/analytics` being the page that section opens on. Labels are translated per locale and
      // routes are not, so the reading by route is what carries the other languages.
      const named = sameLabel(route.split('/').pop() ?? '', label);
      if (!under.length || !(named || under.length * 2 > routes.length)) continue;
      if (!best || route.length > best.newPath!.length) best = page;
    }
    if (!best) continue;
    node.path = best.newPath!;
    Object.assign(node, pageLayout(best));
    remaining.delete(best.newPath!);
  }
  return [...remaining.values()];
}

/**
 * Places a page the sidebar never named in the container the source already publishes its folder
 * in: `/docs/deploy/x` joins the container holding the other `/docs/deploy/` pages, and only a
 * folder the sidebar has no container for at all - a help centre it never links - becomes a new
 * container of its own, named for that folder and written as a sibling of the kind that level
 * holds. A level holds one kind of thing, so a group is never pushed in beside languages.
 *
 * A page in no folder, under a level that cannot hold a bare page, has no folder of the source's to
 * be placed in; it stays unlisted and is reported, rather than being given a structure the source
 * never had.
 */
function placeByRoute(top: Record<string, unknown>[], rest: TreePage[]): TreePage[] {
  interface Slot { node: Record<string, unknown>; prefix: string[]; routes: string[] }
  const slots: Slot[] = [];
  const collect = (nodes: Record<string, unknown>[]): void => {
    for (const node of nodes) {
      const children = childrenOf(node);
      if (!children) continue;
      if (containerKind(node)) {
        const routes = routesUnder(node);
        if (routes.length) {
          const shared = routes.reduce((count, route) => Math.min(count, sharedSegments(routes[0], route)), routes[0].split('/').length);
          slots.push({ node, prefix: routes[0].split('/').slice(0, shared), routes });
        }
      }
      collect(children.items);
    }
  };
  collect(top);
  const unplaced: TreePage[] = [];
  const members = new Map<Record<string, unknown>, Array<{ page: TreePage; folders: string[] }>>();
  for (const page of rest) {
    const segments = page.newPath!.split('/');
    const folder = `${segments.slice(0, -1).join('/')}/`;
    // The container the source already publishes this folder in: most of its pages are in that very
    // folder, so a seventh `/docs/ai/` page joins the six, and nothing joins a container that merely
    // happens to be small. A folder no container is built around - a help centre the sidebar never
    // links - matches nothing here and becomes a container of its own below.
    let best: Slot | undefined; let bestScore = [0, 0];
    for (const slot of slots) {
      const inFolder = slot.routes.filter((route) => route.startsWith(folder)).length;
      if (!inFolder || inFolder * 2 <= slot.routes.length) continue;
      if (inFolder > bestScore[0] || (inFolder === bestScore[0] && slot.routes.length < bestScore[1])) { best = slot; bestScore = [inFolder, slot.routes.length]; }
    }
    // Otherwise the page opens a section the sidebar has none of: it belongs at the level of the
    // widest container its route sits inside, which is the language or version the route names.
    if (!best) {
      let widest = 0;
      for (const slot of slots) {
        if (slot.prefix.length >= segments.length) continue;
        if (!slot.prefix.every((segment, index) => segment === segments[index])) continue;
        if (!best || slot.prefix.length > best.prefix.length || (slot.prefix.length === best.prefix.length && slot.routes.length > widest)) { best = slot; widest = slot.routes.length; }
      }
    }
    if (!best) { unplaced.push(page); continue; }
    // the folders the container does not already stand for
    const group = page.group.filter((name) => name && name !== '(uncategorised)');
    let drop = 0;
    while (drop < best.prefix.length && drop < group.length && slugify(group[drop]) === segments[drop]) drop++;
    members.set(best.node, [...(members.get(best.node) ?? []), { page, folders: group.slice(drop) }]);
  }
  for (const [node, entries] of members) {
    const children = childrenOf(node)!;
    const direct = entries.filter((entry) => !entry.folders.length);
    const foldered = entries.filter((entry) => entry.folders.length);
    if (direct.length) {
      // A page with no folder left sits beside the container's own pages. Where the container holds
      // groups, the two live together under `pages`, which is how `collection` writes that mixture.
      if (children.kind === 'page' || children.kind === 'group') {
        if (children.kind === 'group') { delete node[children.key]; node.pages = children.items; }
        const into = (node.pages ?? node[children.key]) as Record<string, unknown>[];
        for (const { page } of direct) into.push({ ...pageMetadata(page), ...pageLayout(page), title: page.sidebarTitle ?? page.title, path: page.newPath! });
      } else unplaced.push(...direct.map((entry) => entry.page));
    }
    if (!foldered.length) continue;
    const container = childrenOf(node)!;
    for (const built of groupsBySourcePath(foldered.map((entry) => ({ ...entry.page, group: entry.folders })))) {
      if (container.kind === 'group' || container.kind === 'page' || !('group' in built)) { container.items.push(built); continue; }
      const { group, ...body } = built as { group: string } & Record<string, unknown>;
      container.items.push({ [container.kind]: group, ...body });
    }
  }
  return unplaced;
}

function buildSlice(pages: TreePage[], sourceNavigation?: SourceNavigationNode[], placeUnlisted = false, unplaced: TreePage[] = []): Record<string, unknown> {
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
      let rest = pages.filter((page) => page.migrate && page.newPath && !placed.has(page.id));
      if (rest.length) rest = liftLandingPages(top, rest);
      // A site that states languages, versions or products states them at the top, and a group
      // pushed in beside them is a structure the navigation cannot represent at all. Each remaining
      // page belongs to the dimension its own route sits in, so it is placed inside that container.
      if (rest.length && top.some((node) => DIMENSION_KINDS.some((kind) => typeof node[kind] === 'string'))) rest = placeByRoute(top, rest);
      else if (rest.length) { top.push(...groupsBySourcePath(rest)); rest = []; }
      unplaced.push(...rest);
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
export function buildNavigation(pages: TreePage[], defaults: { defaultVersion?: string; defaultLocale?: string; sourceNavigation?: SourceNavigationNode[]; placeUnlisted?: boolean; unplaced?: TreePage[] } = {}): { navigation: Record<string, unknown> } {
  const inScope = pages.filter((p) => p.migrate && p.newPath);
  const hasDimensions = (nodes: SourceNavigationNode[]): boolean => nodes.some((node) => node.type === 'group' && (node.kind === 'language' || node.kind === 'version' || hasDimensions(node.children)));
  if (hasDimensions(defaults.sourceNavigation ?? [])) return { navigation: buildSlice(inScope, defaults.sourceNavigation, defaults.placeUnlisted, defaults.unplaced) };
  const locales = [...new Set(inScope.map((p) => p.locale).filter((x): x is string => !!x))];
  const versions = [...new Set(inScope.map((p) => p.version).filter((x): x is string => !!x))];
  const orderFirst = <T,>(items: T[], first?: T) => (first && items.includes(first) ? [first, ...items.filter((x) => x !== first)] : items);
  const byVersion = (subset: TreePage[]): Record<string, unknown> => {
    const vs = orderFirst([...new Set(subset.map((p) => p.version).filter((x): x is string => !!x))], defaults.defaultVersion);
    if (vs.length < 2 && !(vs.length === 1 && subset.some((p) => !p.version))) return buildSlice(subset, defaults.sourceNavigation, defaults.placeUnlisted, defaults.unplaced);
    return { versions: vs.map((v) => ({ version: v, ...buildSlice(subset.filter((p) => p.version === v), defaults.sourceNavigation, defaults.placeUnlisted, defaults.unplaced) })) };
  };
  if (locales.length >= 2) {
    const ls = orderFirst(locales, defaults.defaultLocale);
    return { navigation: { languages: ls.map((l) => ({ language: l, ...byVersion(inScope.filter((p) => p.locale === l)) })) } };
  }
  return { navigation: versions.length >= 2 ? byVersion(inScope) : buildSlice(inScope, defaults.sourceNavigation, defaults.placeUnlisted, defaults.unplaced) };
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

export function buildDocumentationNavigation(tree: Tree, writtenPaths: ReadonlySet<string>, platformMeta: DocumentationNavigationMeta, unplaced: TreePage[] = []): { navigation: Record<string, unknown> } {
  const written = tree.pages.filter((page) => page.newPath !== undefined && writtenPaths.has(page.newPath));
  let navigation = buildNavigation(written, { defaultVersion: tree.defaultVersion, defaultLocale: tree.defaultLocale, sourceNavigation: tree.navigation, placeUnlisted: !!tree.unlistedPlacement, unplaced });
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
  type Node = { group: string; pages: Array<Record<string, unknown> | Node>; order: number };
  const roots: Array<Record<string, unknown> | Node> = [];
  const byPath = new Map<string, Node>();
  for (const page of [...pages].sort((a, b) => a.order - b.order)) {
    let container = roots;
    let key = '';
    for (const name of page.group.filter((value) => value && value !== '(uncategorised)')) {
      key = key ? `${key}/${name}` : name;
      let node = byPath.get(key);
      if (!node) { node = { group: name, pages: [], order: page.order }; byPath.set(key, node); container.push(node); }
      container = node.pages;
    }
    container.push({ ...pageMetadata(page), ...pageLayout(page), title: page.sidebarTitle ?? page.title, path: page.newPath! });
  }
  const clean = (items: Array<Record<string, unknown> | Node>): Record<string, unknown>[] =>
    items.map((item) => ('group' in item && Array.isArray((item as Node).pages) ? { group: (item as Node).group, pages: clean((item as Node).pages) } : item as Record<string, unknown>));
  return clean(roots);
}

/** Default new path from the group path and title (restructure mode). */
export function pathFromTree(p: TreePage): string {
  const parts = [...p.group.filter((g) => g && g !== '(uncategorised)').map(slugify), slugify(p.title)];
  return parts.join('/');
}
