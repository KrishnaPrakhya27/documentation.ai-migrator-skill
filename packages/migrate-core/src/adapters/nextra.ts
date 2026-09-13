/**
 * Nextra v3 and v4.
 *
 * The pages are readable: Nextra's routes are its content tree, and a page's own title comes from
 * its frontmatter or its first heading.
 *
 * The navigation is not. Nextra states sidebar order and labels in `_meta` files, and support for
 * `_meta.json` was removed in Nextra 3 — every remaining form (`_meta.js`, `.jsx`, `.ts`, `.tsx`)
 * is an ES module whose default export may import React components, compute keys or use JSX as a
 * title. Reading it means executing a customer's code, and parsing it as if it were data would be
 * a guess dressed as a fact. So this adapter reads pages, records that the `_meta` files exist and
 * were not read, and states no navigation: `source-navigation-proven` then refuses to certify the
 * sidebar in exact mode, and the operator supplies a reviewed tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pageIdFromPlatform } from '../session/ids.js';
import { firstHeading, statedFrontmatter, titleFromFilename } from './frontmatter.js';
import type { Tree, TreePage } from '../nav/tree.js';

/** Where Nextra keeps pages: v4's content directory, then v3's pages directory. */
const CONTENT_ROOTS = ['content', join('src', 'content'), 'pages', join('src', 'pages')];
const META_FILE = /^_meta\.(?:jsx?|tsx?|json)$/;

export interface NextraRepo {
  root: string;
  contentRoot: string;
  tree: Tree;
  /** The `_meta` modules this adapter did not read, so the report can name what is unproven. */
  metaFiles: string[];
}

export function nextraContentRoot(root: string): string | undefined {
  return CONTENT_ROOTS.map((candidate) => join(root, candidate)).find(existsSync);
}

export function readNextraRepo(rootIn: string): NextraRepo {
  const root = resolve(rootIn);
  const contentRoot = nextraContentRoot(root);
  if (!contentRoot) throw new Error(`no Nextra content directory under ${root}`);

  const pages: TreePage[] = [];
  const metaFiles: string[] = [];
  let order = 0;

  const walk = (dir: string, group: string[]): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !['node_modules', 'api', 'public'].includes(entry.name)) walk(path, [...group, entry.name]);
        continue;
      }
      if (META_FILE.test(entry.name)) { metaFiles.push(relative(root, path)); continue; }
      if (!/\.mdx?$/i.test(entry.name)) continue;
      const body = readFileSync(path, 'utf8');
      const stated = statedFrontmatter(body);
      const source = relative(root, path);
      const stem = entry.name.replace(/\.mdx?$/i, '');
      // An index file names the directory holding it, the way Nextra routes it.
      const route = `/${[...group, ...(stem === 'index' ? [] : [stem])].join('/')}`;
      pages.push({
        // the frozen file is the identity, the same one the independent source enumeration counts
        id: pageIdFromPlatform('nextra', source),
        title: stated.title ?? firstHeading(body) ?? titleFromFilename(entry.name),
        ...(stated.sidebarTitle ? { sidebarTitle: stated.sidebarTitle } : {}),
        ...(stated.description ? { description: stated.description } : {}),
        source,
        group: [...group],
        order: order++,
        oldPath: route === '/' ? '/' : route,
        migrate: true,
        reason: 'content tree',
      });
    }
  };
  walk(contentRoot, []);

  // No navigation is stated here on purpose: see the note at the top of this file.
  return { root, contentRoot: relative(root, contentRoot), tree: { scope: 'full', platform: 'nextra', pages }, metaFiles };
}
