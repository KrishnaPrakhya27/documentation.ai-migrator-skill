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
  | { type: 'page'; pageId: string; title?: string }
  | { type: 'group'; label: string; children: SourceNavigationNode[] };

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
    const convert = (nodes: SourceNavigationNode[]): Array<PageRef | { group: string; pages: unknown[] }> => {
      const out: Array<PageRef | { group: string; pages: unknown[] }> = [];
      for (const node of nodes) {
      if (node.type === 'page') {
        const page = eligible.get(node.pageId);
        if (page) out.push({ title: node.title ?? page.sidebarTitle ?? page.title ?? page.newPath!, path: page.newPath! });
        continue;
      }
      const children = convert(node.children);
      if (children.length) out.push({ group: node.label, pages: children });
      }
      return out;
    };
    const top = convert(sourceNavigation);
    if (top.length) return top.every((item) => 'group' in item) ? { groups: top } : { pages: top };
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
    container.push({ title: p.sidebarTitle ?? p.title ?? p.newPath!, path: p.newPath! }); // the renderer rejects bare path strings
  }
  const clean = (items: Array<PageRef | Node>): Array<PageRef | { group: string; pages: unknown[] }> => items.map((it) => ('group' in it ? { group: it.group, pages: clean(it.pages) } : it));
  const top = clean(roots);
  const allGroups = top.every((t) => 'group' in t);
  return allGroups && top.length ? { groups: top } : { pages: top };
}

/**
 * documentation.json navigation. Exactly one semantic key per container:
 * languages → versions → groups/pages, each level present only when the tree uses it.
 * The schema has no `default` flag: the default version or language is listed first.
 */
export function buildNavigation(pages: TreePage[], defaults: { defaultVersion?: string; defaultLocale?: string; sourceNavigation?: SourceNavigationNode[] } = {}): { navigation: Record<string, unknown> } {
  const inScope = pages.filter((p) => p.migrate && p.newPath);
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
  const clone = JSON.parse(JSON.stringify(nav)) as { navigation: Record<string, unknown> };
  // descend through languages/versions containers first (any of them, by name if given)
  let level: any = clone.navigation;
  const dims = ['languages', 'versions'] as const;
  for (const d of dims) if (Array.isArray(level[d])) { const wanted = d === 'versions' ? version : locale; level = level[d].find((x: any) => wanted ? x[d === 'versions' ? 'version' : 'language'] === wanted : true) ?? level[d][0]; }
  let items: any[] | undefined = (level.groups as any[]) ?? (level.pages as any[]);
  let target: any;
  for (const name of groupPath) {
    target = items?.find((it) => it && typeof it === 'object' && it.group === name);
    if (!target) throw new Error(`group path not found in navigation: ${groupPath.join(' / ')}`);
    items = target.pages;
  }
  target.openapi = spec;
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
