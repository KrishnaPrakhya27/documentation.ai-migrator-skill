/**
 * ReadMe adapters: the bi-directional sync repository (docs/<category>/*.md
 * with ReadMe frontmatter) and the API v2 client (categories, guides,
 * reference pages) with an injectable fetch so it is testable offline.
 *
 * API v2 shapes verified against the published upgrade guide (2026-09-09):
 * GET /branches/{branch}/categories/{section}, /branches/{branch}/guides/{slug},
 * /branches/{branch}/reference/{slug}; page body is content.body with
 * content.type "markdown" | "html".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Tree, TreePage } from '../nav/tree.js';
import { pageIdFromPlatform } from '../session/ids.js';

export interface ReadmeRepo { root: string; docsRoot: string; tree: Tree; hidden: string[] }

interface ReadmeFrontmatter { title?: string; slug?: string; excerpt?: string; hidden?: boolean; order?: number; category?: string; parentDoc?: string; parentDocSlug?: string }

function frontmatterOf(raw: string): ReadmeFrontmatter {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try { return (parseYaml(m[1]) as ReadmeFrontmatter) ?? {}; } catch { return {}; }
}

/** Sync repo: top-level docs/ folder, one folder per category, Markdown files with frontmatter. */
export function readReadmeRepo(rootIn: string): ReadmeRepo {
  const root = resolve(rootIn);
  const docsRoot = existsSync(join(root, 'docs')) ? join(root, 'docs') : root;
  const pages: TreePage[] = [];
  const hidden: string[] = [];
  let order = 0;
  const walk = (dir: string, group: string[]) => {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(p, [...group, e.name]); continue; }
      if (!/\.mdx?$/i.test(e.name)) continue;
      const raw = readFileSync(p, 'utf8');
      const fm = frontmatterOf(raw);
      const rel = p.slice(root.length + 1);
      const slug = fm.slug ?? e.name.replace(/\.mdx?$/i, '');
      if (fm.hidden) { hidden.push(rel); continue; }
      pages.push({ id: pageIdFromPlatform('readme', slug), title: fm.title ?? slug.replace(/[-_]+/g, ' '), source: rel, group: [...group, ...(fm.parentDocSlug ? [fm.parentDocSlug] : [])], order: fm.order ?? order++, oldPath: `/docs/${slug}`, migrate: true, reason: 'sync-repo' });
    }
  };
  walk(docsRoot, []);
  pages.sort((a, b) => a.order - b.order).forEach((p, i) => { p.order = i; });
  return { root, docsRoot, tree: { scope: 'full', platform: 'readme', pages }, hidden };
}

export interface ReadmeApiOptions { apiKey: string; baseUrl?: string; branch?: string; fetchImpl?: typeof fetch; version?: string }
export interface ReadmePage { slug: string; title: string; category: string; kind: 'guide' | 'reference'; body: string; bodyType: 'markdown' | 'html'; order: number; hidden?: boolean; parent?: string }

export class ReadmeApi {
  private base: string; private branch: string; private fetchImpl: typeof fetch;
  constructor(private opts: ReadmeApiOptions) {
    if (!opts.apiKey) throw new Error('README_API_KEY is required');
    this.base = (opts.baseUrl ?? 'https://api.readme.com/v2').replace(/\/$/, '');
    this.branch = opts.branch ?? 'stable';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }
  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`ReadMe ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }
  /** Every page of a paginated list ({data, paging.next}). */
  private async list<T>(path: string): Promise<T[]> {
    const out: T[] = []; let next: string | undefined = path; let guard = 0;
    while (next && guard++ < 500) {
      const page: { data?: T[]; paging?: { next?: string | null } } = await this.get(next);
      out.push(...(page.data ?? []));
      const n: string | undefined = page.paging?.next ?? undefined;
      next = n ? (n.startsWith('http') ? n.slice(this.base.length) : n) : undefined;
      if (next && !next.startsWith('/')) next = `/${next}`;
    }
    return out;
  }
  async categories(section: 'guides' | 'reference'): Promise<Array<{ title: string; uri: string; slug?: string }>> {
    return this.list(`/branches/${encodeURIComponent(this.branch)}/categories/${section}`);
  }
  async pages(section: 'guides' | 'reference'): Promise<ReadmePage[]> {
    const items = await this.list<any>(`/branches/${encodeURIComponent(this.branch)}/${section}`);
    const pages: ReadmePage[] = [];
    for (const [i, item] of items.entries()) {
      const slug = item.slug ?? item.uri?.split('/').pop();
      if (!slug) continue;
      const full = item.content?.body !== undefined ? item : await this.get<any>(`/branches/${encodeURIComponent(this.branch)}/${section}/${encodeURIComponent(slug)}`);
      const body = full.content?.body ?? '';
      pages.push({ slug, title: full.title ?? slug, category: full.category?.title ?? full.category?.uri?.split('/').pop() ?? '(uncategorised)', kind: section === 'guides' ? 'guide' : 'reference', body, bodyType: full.content?.type === 'html' ? 'html' : 'markdown', order: full.position ?? i, hidden: full.privacy?.view === 'anyone_with_link' || full.hidden === true, parent: full.parent?.uri?.split('/').pop() });
    }
    return pages;
  }
}

/** Tree from API pages, grouped by section and category. */
export function readmeApiTree(pages: ReadmePage[]): Tree {
  const sorted = [...pages].filter((p) => !p.hidden).sort((a, b) => a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category) || a.order - b.order);
  return { scope: 'full', platform: 'readme', pages: sorted.map((p, i) => ({ id: pageIdFromPlatform('readme', `${p.kind}:${p.slug}`), title: p.title, source: `readme-api://${p.kind}/${p.slug}`, group: [p.kind === 'guide' ? 'Guides' : 'Reference', p.category, ...(p.parent ? [p.parent] : [])], order: i, oldPath: `/${p.kind === 'guide' ? 'docs' : 'reference'}/${p.slug}`, migrate: true, reason: 'readme-api' })) };
}
