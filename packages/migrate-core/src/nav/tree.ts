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

export interface Tree { scope: 'full' | 'partial'; platform: string; pages: TreePage[] }

export function writeTree(workspace: string, tree: Tree): void {
  writeFileSync(join(workspace, 'plan', 'tree.yaml'), toYaml(tree), { mode: 0o600 });
}

export function readTree(workspace: string): Tree {
  return parseYaml(readFileSync(join(workspace, 'plan', 'tree.yaml'), 'utf8')) as Tree;
}

/** Nested groups → documentation.json navigation. Uses `groups` at the root, `pages` inside. */
export function buildNavigation(pages: TreePage[]): { navigation: Record<string, unknown> } {
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
  return { navigation: allGroups && top.length ? { groups: top } : { pages: top } };
}

/** Default new path from the group path and title (restructure mode). */
export function pathFromTree(p: TreePage): string {
  const parts = [...p.group.filter((g) => g && g !== '(uncategorised)').map(slugify), slugify(p.title)];
  return parts.join('/');
}
