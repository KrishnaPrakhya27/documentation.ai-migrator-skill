/**
 * Fern docs (buildwithfern.com).
 *
 * Fern states its navigation in `fern/docs.yml` and nowhere else: only files that file references
 * are built, so the YAML is the site's structure rather than a description of it. That makes this
 * the one adapter here whose navigation needs no inference at all — order is array order, groups
 * are `section:` entries, and a page names its own title and file.
 *
 * `folder:` entries are the exception: they hand ordering back to the filesystem, so they are read
 * as the source's own statement that a directory is a section, with the page order Fern applies
 * (frontmatter `position`, then filename).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { pageIdFromPlatform } from '../session/ids.js';
import { statedFrontmatter as frontmatter } from './frontmatter.js';
import type { SourceNavigationNode, Tree, TreePage } from '../nav/tree.js';

export interface FernRepo {
  root: string;
  tree: Tree;
  /** Pages `docs.yml` names that are not in the repository. */
  missing: string[];
  /** Files under fern/ that no navigation entry reaches; Fern does not publish them either. */
  unreferenced: string[];
  /** API reference sections, which carry their own specs and are migrated by the OpenAPI capture. */
  apiSections: string[];
}

interface FernNavItem {
  page?: string;
  path?: string;
  section?: string;
  contents?: FernNavItem[];
  folder?: string;
  api?: string;
  tab?: string;
  layout?: FernNavItem[];
  slug?: string;
  hidden?: boolean;
}

interface FernDocs {
  tabs?: Record<string, { 'display-name'?: string; slug?: string; hidden?: boolean }>;
  navigation?: FernNavItem[];
  versions?: Array<{ 'display-name'?: string; path?: string }>;
}

/** Fern orders an auto-discovered folder by frontmatter `position`, then by filename. */
function folderPages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && /\.mdx?$/i.test(entry.name))
    .map((entry) => join(dir, entry.name));
  return files.sort((a, b) => {
    const position = (file: string): number => Number(frontmatter(readFileSync(file, 'utf8')).position ?? Number.MAX_SAFE_INTEGER);
    return position(a) - position(b) || a.localeCompare(b);
  });
}

export function readFernRepo(rootIn: string): FernRepo {
  const root = resolve(rootIn);
  const fernDir = join(root, 'fern');
  const configPath = ['docs.yml', 'docs.yaml'].map((name) => join(fernDir, name)).find(existsSync);
  if (!configPath) throw new Error(`no fern/docs.yml under ${root}`);
  const docs = (parseYaml(readFileSync(configPath, 'utf8')) as FernDocs | null) ?? {};

  const pages: TreePage[] = [];
  const missing: string[] = [];
  const apiSections: string[] = [];
  const referenced = new Set<string>();
  let order = 0;

  /** One page entry: its file is the identity, its stated title is the title. */
  const addPage = (title: string | undefined, path: string, group: string[]): SourceNavigationNode | undefined => {
    const file = resolve(fernDir, path);
    if (!file.startsWith(fernDir + '/') || !existsSync(file)) { missing.push(path); return undefined; }
    referenced.add(file);
    const source = relative(root, file);
    const stated = frontmatter(readFileSync(file, 'utf8'));
    const id = pageIdFromPlatform('fern', source);
    pages.push({
      id,
      title: title ?? stated.title ?? source.split('/').pop()!.replace(/\.mdx?$/i, '').replace(/[-_]+/g, ' '),
      ...(stated['sidebar-title'] ? { sidebarTitle: stated['sidebar-title'] } : {}),
      ...(stated.description ? { description: stated.description } : {}),
      source,
      group,
      order: order++,
      oldPath: `/${(stated.slug ?? source.replace(/\.mdx?$/i, '')).replace(/^\/+/, '')}`,
      migrate: true,
      reason: 'docs.yml',
    });
    return { type: 'page', pageId: id, title: title ?? stated.title ?? source };
  };

  const walk = (items: readonly FernNavItem[], group: string[]): SourceNavigationNode[] => {
    const out: SourceNavigationNode[] = [];
    for (const item of items) {
      if (item.api) { apiSections.push(item.api); continue; }
      if (item.page && item.path) {
        const node = addPage(item.page, item.path, group);
        if (node) out.push(node);
        continue;
      }
      if (item.section) {
        const children: SourceNavigationNode[] = [];
        // A section may name its own overview page, which reads first inside the section.
        if (item.path) { const node = addPage(item.section, item.path, [...group, item.section]); if (node) children.push(node); }
        children.push(...walk(item.contents ?? [], [...group, item.section]));
        if (children.length) out.push({ type: 'group', label: item.section, children });
        continue;
      }
      if (item.folder) {
        // Fern discovers the directory itself; the folder is a section named by its own path.
        const label = item.folder.replace(/^\.\//, '').replace(/\/+$/, '').split('/').pop() ?? item.folder;
        const children = folderPages(resolve(fernDir, item.folder))
          .map((file) => addPage(undefined, relative(fernDir, file), [...group, label]))
          .filter((node): node is SourceNavigationNode => !!node);
        if (children.length) out.push({ type: 'group', label, children });
      }
    }
    return out;
  };

  const navigation: SourceNavigationNode[] = [];
  for (const entry of docs.navigation ?? []) {
    if (!entry.tab) continue;
    // A tabbed site states its tabs separately and gives each one a layout.
    const label = docs.tabs?.[entry.tab]?.['display-name'] ?? entry.tab;
    const children = walk(entry.layout ?? [], [label]);
    if (children.length) navigation.push({ type: 'group', kind: 'tab', label, children });
  }
  if (!navigation.length) navigation.push(...walk(docs.navigation ?? [], []));

  const unreferenced: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.mdx?$/i.test(entry.name) && !referenced.has(path)) unreferenced.push(relative(root, path));
    }
  };
  scan(fernDir);

  return { root, tree: { scope: 'full', platform: 'fern', pages, navigation, navigationSource: 'source-config' }, missing, unreferenced, apiSections };
}
