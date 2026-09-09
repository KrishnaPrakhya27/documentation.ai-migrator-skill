/**
 * The page tree (plan/tree.yaml) and documentation.json generation.
 * Pages are entities: identity is the entity id, URL is an attribute.
 */
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../urls/slugger.js';

export interface TreePage {
  id: string;
  title: string;
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
}

export interface Tree { scope: 'full' | 'partial'; platform: string; pages: TreePage[]; /** Version and locale served at the root paths; others are prefixed. */ defaultVersion?: string; defaultLocale?: string }

export function writeTree(workspace: string, tree: Tree): void {
  writeFileSync(join(workspace, 'plan', 'tree.yaml'), toYaml(tree), { mode: 0o600 });
}

export function readTree(workspace: string): Tree {
  return parseYaml(readFileSync(join(workspace, 'plan', 'tree.yaml'), 'utf8')) as Tree;
}

/** Nested groups → navigation for one version/locale slice. Uses `groups` at the root, `pages` inside. */
function buildSlice(pages: TreePage[]): Record<string, unknown> {
  type Node = { group: string; pages: Array<string | Node>; _order: number };
  const roots: Array<string | Node> = [];
  const byPath = new Map<string, Node>();
  const inScope = pages.filter((p) => p.migrate && p.newPath).sort((a, b) => a.order - b.order);
  for (const p of inScope) {
    let container: Array<string | Node> = roots;
    let key = '';
    for (const g of p.group.filter((x) => x && x !== '(uncategorised)')) {
      key = key ? `${key}/${g}` : g;
      let node = byPath.get(key);
      if (!node) { node = { group: g, pages: [], _order: p.order }; byPath.set(key, node); container.push(node); }
      container = node.pages;
    }
    container.push(p.newPath!);
  }
  const clean = (items: Array<string | Node>): Array<string | { group: string; pages: unknown[] }> => items.map((it) => (typeof it === 'string' ? it : { group: it.group, pages: clean(it.pages) }));
  const top = clean(roots);
  const allGroups = top.every((t) => typeof t !== 'string');
  return allGroups && top.length ? { groups: top } : { pages: top };
}

/**
 * documentation.json navigation. Exactly one semantic key per container:
 * languages → versions → groups/pages, each level present only when the tree uses it.
 */
export function buildNavigation(pages: TreePage[], defaults: { defaultVersion?: string; defaultLocale?: string } = {}): { navigation: Record<string, unknown> } {
  const inScope = pages.filter((p) => p.migrate && p.newPath);
  const locales = [...new Set(inScope.map((p) => p.locale).filter((x): x is string => !!x))];
  const versions = [...new Set(inScope.map((p) => p.version).filter((x): x is string => !!x))];
  const orderFirst = <T,>(items: T[], first?: T) => (first && items.includes(first) ? [first, ...items.filter((x) => x !== first)] : items);
  const byVersion = (subset: TreePage[]): Record<string, unknown> => {
    const vs = orderFirst([...new Set(subset.map((p) => p.version).filter((x): x is string => !!x))], defaults.defaultVersion);
    if (vs.length < 2 && !(vs.length === 1 && subset.some((p) => !p.version))) return buildSlice(subset);
    return { versions: vs.map((v) => ({ version: v, ...(v === defaults.defaultVersion ? { default: true } : {}), ...buildSlice(subset.filter((p) => p.version === v)) })) };
  };
  if (locales.length >= 2) {
    const ls = orderFirst(locales, defaults.defaultLocale);
    return { navigation: { languages: ls.map((l) => ({ language: l, ...(l === defaults.defaultLocale ? { default: true } : {}), ...byVersion(inScope.filter((p) => p.locale === l)) })) } };
  }
  return { navigation: versions.length >= 2 ? byVersion(inScope) : buildSlice(inScope) };
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

/** Default new path from the group path and title (restructure mode). */
export function pathFromTree(p: TreePage): string {
  const parts = [...p.group.filter((g) => g && g !== '(uncategorised)').map(slugify), slugify(p.title)];
  return parts.join('/');
}
