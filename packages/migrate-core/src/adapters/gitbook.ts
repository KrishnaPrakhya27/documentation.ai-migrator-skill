/**
 * GitBook Git Sync repository adapter: .gitbook.yaml (root, structure,
 * redirects) and SUMMARY.md (navigation as nested lists under section
 * headings). Content is Liquid-flavoured Markdown handled by the markdown
 * adapter with platform "gitbook".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Tree, TreePage, SourceNavigationNode } from '../nav/tree.js';
import type { RedirectRule } from '../urls/plan.js';
import { pageIdFromPlatform } from '../session/ids.js';

export interface GitbookRepo {
  root: string;
  contentRoot: string;
  tree: Tree;
  redirects: RedirectRule[];
  missing: string[];
  /** Files under the content root that SUMMARY.md does not list. */
  unlisted: string[];
}

interface GitbookConfig { root?: string; structure?: { readme?: string; summary?: string }; redirects?: Record<string, string> }

export function readGitbookRepo(rootIn: string): GitbookRepo {
  const root = resolve(rootIn);
  const cfgPath = join(root, '.gitbook.yaml');
  const cfg: GitbookConfig = existsSync(cfgPath) ? (parseYaml(readFileSync(cfgPath, 'utf8')) as GitbookConfig) ?? {} : {};
  const contentRoot = resolve(root, (cfg.root ?? './').replace(/^\.\//, ''));
  if (!contentRoot.startsWith(root)) throw new Error('.gitbook.yaml root escapes the repository');
  const summaryPath = resolve(contentRoot, cfg.structure?.summary ?? 'SUMMARY.md');
  if (!existsSync(summaryPath)) throw new Error(`SUMMARY.md not found at ${summaryPath}`);
  const summary = readFileSync(summaryPath, 'utf8');

  const pages: TreePage[] = [];
  const missing: string[] = [];
  let order = 0;
  let section: string[] = [];
  const stack: Array<{ indent: number; title: string }> = [];
  const listed = new Set<string>();

  // SUMMARY.md is the navigation GitBook states, so it is kept as a graph and not only as a group
  // path per page: verification re-reads this file and compares it with what was written, and a
  // page listed in two places keeps both placements.
  const navigation: SourceNavigationNode[] = [];
  /** Where the next entry at this indent belongs, and how to give a page children when it gains one. */
  const containers: Array<{ indent: number; children: SourceNavigationNode[]; own?: { siblings: SourceNavigationNode[]; index: number; title: string } }> = [
    { indent: -1, children: navigation },
  ];
  const containerFor = (indent: number): { indent: number; children: SourceNavigationNode[]; own?: { siblings: SourceNavigationNode[]; index: number; title: string } } => {
    while (containers.length > 1 && containers[containers.length - 1].indent >= indent) containers.pop();
    const parent = containers[containers.length - 1];
    // A page that gains children becomes the group its own title names and opens as that page,
    // which is how GitBook renders a parent page: the page is the group's own, not its first entry.
    if (parent.own) {
      const page = parent.own.siblings[parent.own.index];
      const group: SourceNavigationNode = { type: 'group', label: parent.own.title, ...(page?.type === 'page' ? { pageId: page.pageId } : {}), children: [] };
      parent.own.siblings[parent.own.index] = group;
      parent.children = group.children;
      parent.own = undefined;
    }
    return parent;
  };

  for (const raw of summary.split(/\r?\n/)) {
    const h = raw.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      // A top-level heading is the file's own title ("# Table of contents", "# Summary"), not a
      // section: GitBook states sections at level two and below. Reading the title as a section
      // wraps the whole navigation in a group the source never showed.
      const isToc = h[1].length === 1 || h[2].toLowerCase() === 'table of contents';
      section = isToc ? [] : [h[2]];
      stack.length = 0;
      containers.length = 1;
      if (!isToc) {
        const group: SourceNavigationNode = { type: 'group', label: h[2], children: [] };
        navigation.push(group);
        containers.push({ indent: -1, children: group.children });
      }
      continue;
    }
    const m = raw.match(/^(\s*)[*+-]\s+\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length; const title = m[2].trim(); const href = m[3].trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const group = [...section, ...stack.map((s) => s.title)];
    stack.push({ indent, title });
    if (/^https?:\/\//.test(href)) continue; // external link entries are not pages
    const rel = decodeURIComponent(href.replace(/^\.\//, '').split('#')[0]);
    const file = resolve(contentRoot, rel);
    if (!file.startsWith(contentRoot) || !existsSync(file)) { missing.push(rel); continue; }
    listed.add(file);
    const stem = rel.replace(/\.md$/i, '').replace(/(?:^|\/)README$/i, '');
    const pageId = pageIdFromPlatform('gitbook', rel);
    pages.push({ id: pageId, title, source: file.slice(root.length + 1), group, order: order++, oldPath: `/${stem}`, migrate: true, reason: 'SUMMARY.md' });
    const parent = containerFor(indent);
    const node: SourceNavigationNode = { type: 'page', pageId, title };
    parent.children.push(node);
    containers.push({ indent, children: parent.children, own: { siblings: parent.children, index: parent.children.length - 1, title } });
  }

  const redirects: RedirectRule[] = Object.entries(cfg.redirects ?? {}).map(([from, to]) => ({ source: `/${from.replace(/^\/+/, '')}`, destination: `/${String(to).replace(/^\/+/, '').replace(/\.md$/i, '').replace(/(?:^|\/)README$/i, '')}`, statusCode: 308 }));

  const unlisted: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isSymbolicLink()) continue;
      const p = join(dir, f.name);
      if (f.isDirectory()) { if (!['node_modules', '.git', '.gitbook'].includes(f.name)) walk(p); }
      else if (/\.md$/i.test(f.name) && p !== summaryPath && !listed.has(p)) unlisted.push(p.slice(root.length + 1));
    }
  };
  walk(contentRoot);
  return { root, contentRoot, tree: { scope: 'full', platform: 'gitbook', pages, navigation, navigationSource: 'source-config' }, redirects, missing, unlisted };
}
