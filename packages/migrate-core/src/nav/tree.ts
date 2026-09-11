/**
 * The page tree (plan/tree.yaml) and documentation.json generation.
 * Pages are entities: identity is the entity id, URL is an attribute.
 */
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
  titleSource?: 'llms-txt' | 'platform-metadata' | 'source-config' | 'published-markdown' | 'path';
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
  | { type: 'group'; kind?: NavigationContainerKind; label: string; children: SourceNavigationNode[]; icon?: string; href?: string; expandable?: boolean; description?: string };

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
      else walk(node.children);
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

function buildSlice(pages: TreePage[], sourceNavigation?: SourceNavigationNode[]): Record<string, unknown> {
  type PageRef = { title: string; path: string };
  type Node = { group: string; pages: Array<PageRef | Node>; _order: number };
  const eligible = new Map(pages.filter((p) => p.migrate && p.newPath).map((p) => [p.id, p]));
  if (sourceNavigation?.length) {
    const convert = (nodes: SourceNavigationNode[]): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      for (const node of nodes) {
      if (node.type === 'page') {
        const page = eligible.get(node.pageId);
        if (page) out.push({ ...pageMetadata(page), ...pageMetadata(node), title: node.title ?? page.sidebarTitle ?? page.title, path: page.newPath! });
        continue;
      }
      const children = convert(node.children);
      const kind = node.kind ?? 'group';
      if (children.length || node.href) out.push({ [kind]: node.label, ...navigationMetadata(node), ...(children.length ? collection(children, kind) : {}) });
      }
      return out;
    };
    const top = convert(sourceNavigation);
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
    container.push({ ...pageMetadata(p), title: p.sidebarTitle ?? p.title, path: p.newPath! }); // the renderer rejects bare path strings
  }
  const clean = (items: Array<PageRef | Node>): Array<PageRef | { group: string; pages: unknown[] }> => items.map((it) => ('group' in it ? { group: it.group, pages: clean(it.pages) } : it));
  const top = clean(roots);
  const allGroups = top.every((t) => 'group' in t);
  return allGroups && top.length ? { groups: top } : { pages: top };
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
export function buildNavigation(pages: TreePage[], defaults: { defaultVersion?: string; defaultLocale?: string; sourceNavigation?: SourceNavigationNode[] } = {}): { navigation: Record<string, unknown> } {
  const inScope = pages.filter((p) => p.migrate && p.newPath);
  const hasDimensions = (nodes: SourceNavigationNode[]): boolean => nodes.some((node) => node.type === 'group' && (node.kind === 'language' || node.kind === 'version' || hasDimensions(node.children)));
  if (hasDimensions(defaults.sourceNavigation ?? [])) return { navigation: buildSlice(inScope, defaults.sourceNavigation) };
  const locales = [...new Set(inScope.map((p) => p.locale).filter((x): x is string => !!x))];
  const versions = [...new Set(inScope.map((p) => p.version).filter((x): x is string => !!x))];
  const orderFirst = <T,>(items: T[], first?: T) => (first && items.includes(first) ? [first, ...items.filter((x) => x !== first)] : items);
  const byVersion = (subset: TreePage[]): Record<string, unknown> => {
    const vs = orderFirst([...new Set(subset.map((p) => p.version).filter((x): x is string => !!x))], defaults.defaultVersion);
    if (vs.length < 2 && !(vs.length === 1 && subset.some((p) => !p.version))) return buildSlice(subset, defaults.sourceNavigation);
    return { versions: vs.map((v) => ({ version: v, ...buildSlice(subset.filter((p) => p.version === v), defaults.sourceNavigation) })) };
  };
  if (locales.length >= 2) {
    const ls = orderFirst(locales, defaults.defaultLocale);
    return { navigation: { languages: ls.map((l) => ({ language: l, ...byVersion(inScope.filter((p) => p.locale === l)) })) } };
  }
  return { navigation: versions.length >= 2 ? byVersion(inScope) : buildSlice(inScope, defaults.sourceNavigation) };
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
export function buildDocumentationNavigation(tree: Tree, writtenPaths: ReadonlySet<string>, platformMeta: DocumentationNavigationMeta): { navigation: Record<string, unknown> } {
  const written = tree.pages.filter((page) => page.newPath !== undefined && writtenPaths.has(page.newPath));
  let navigation = buildNavigation(written, { defaultVersion: tree.defaultVersion, defaultLocale: tree.defaultLocale, sourceNavigation: tree.navigation });
  for (const ref of platformMeta.openapi ?? []) {
    try {
      navigation = attachGroupOpenapi(navigation, ref.groupPath, ref.spec, ref.version, ref.locale);
    } catch (error) {
      throw new Error(`openapi ${ref.spec}: ${(error as Error).message}; no written page is placed under that group, so remove the entry from inventory/platform-meta.json or migrate the group's pages`);
    }
  }
  return navigation;
}

/** Default new path from the group path and title (restructure mode). */
export function pathFromTree(p: TreePage): string {
  const parts = [...p.group.filter((g) => g && g !== '(uncategorised)').map(slugify), slugify(p.title)];
  return parts.join('/');
}
