/**
 * GitBook Git Sync repository adapter: .gitbook.yaml (root, structure,
 * redirects) and SUMMARY.md (navigation as nested lists under section
 * headings). Content is Liquid-flavoured Markdown handled by the markdown
 * adapter with platform "gitbook".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Tree, TreePage } from '../nav/tree.js';
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

  for (const raw of summary.split(/\r?\n/)) {
    const h = raw.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (h) { section = h[1].toLowerCase() === 'table of contents' ? [] : [h[1]]; stack.length = 0; continue; }
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
    pages.push({ id: pageIdFromPlatform('gitbook', rel), title, source: file.slice(root.length + 1), group, order: order++, oldPath: `/${stem}`, migrate: true, reason: 'SUMMARY.md' });
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
  return { root, contentRoot, tree: { scope: 'full', platform: 'gitbook', pages }, redirects, missing, unlisted };
}
