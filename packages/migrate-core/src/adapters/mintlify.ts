/**
 * Mintlify source-repository adapter: docs.json (or legacy mint.json)
 * navigation, redirects, OpenAPI references, snippets and site metadata.
 *
 * docs.json navigation is one recursive object. Division keys are
 * versions, languages, tabs, anchors, dropdowns, groups and pages; any
 * division may nest any other. Verified against the published schema on
 * 2026-09-09 (see the architecture report, §5).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { navigationMetadata, type NavigationContainerKind, type SourceNavigationNode, type Tree, type TreePage } from '../nav/tree.js';
import type { RedirectRule } from '../urls/plan.js';
import { pageIdFromPlatform } from '../session/ids.js';

export interface MintlifyOpenApiRef { groupPath: string[]; spec: string; version?: string; locale?: string }

export interface MintlifyRepo {
  root: string;
  configFile: 'docs.json' | 'mint.json';
  name?: string;
  colors?: Record<string, string>;
  logo?: unknown;
  favicon?: string;
  tree: Tree;
  redirects: { exact: RedirectRule[]; wildcard: RedirectRule[]; skipped: Array<{ source: string; reason: string }> };
  openapi: MintlifyOpenApiRef[];
  /** Pages listed in navigation whose file does not exist. */
  missing: string[];
}

const DIVISIONS = ['versions', 'languages', 'tabs', 'anchors', 'dropdowns', 'products', 'menus', 'groups', 'pages'] as const;

function pageFile(root: string, page: string): string | undefined {
  for (const ext of ['.mdx', '.md']) { const p = join(root, `${page}${ext}`); if (existsSync(p)) return p; }
  return undefined;
}

function labelOf(node: any): string | undefined {
  return node.group ?? node.tab ?? node.anchor ?? node.dropdown ?? node.product ?? node.version ?? node.language ?? node.menu;
}

export function readMintlifyRepo(rootIn: string): MintlifyRepo {
  const root = resolve(rootIn);
  const configFile = existsSync(join(root, 'docs.json')) ? 'docs.json' : existsSync(join(root, 'mint.json')) ? 'mint.json' : undefined;
  if (!configFile) throw new Error(`no docs.json or mint.json under ${root}`);
  const cfg = JSON.parse(readFileSync(join(root, configFile), 'utf8')) as Record<string, any>;

  const pages: TreePage[] = [];
  const pageById = new Map<string, TreePage>();
  const openapi: MintlifyOpenApiRef[] = [];
  const missing: string[] = [];
  let order = 0;
  let defaultVersion: string | undefined; let defaultLocale: string | undefined;

  const walk = (node: any, ctx: { group: string[]; version?: string; locale?: string; openapi?: string }): SourceNavigationNode[] => {
    if (typeof node === 'string') {
      const file = pageFile(root, node);
      if (!file) { missing.push(node); return []; }
      const id = pageIdFromPlatform('mintlify', `${ctx.locale ?? ''}|${ctx.version ?? ''}|${node}`);
      let page = pageById.get(id);
      if (!page) {
        page = { id, title: node.split('/').pop()!.replace(/[-_]+/g, ' '), source: file.slice(root.length + 1), group: ctx.group, order: order++, oldPath: `/${node}`, migrate: true, version: ctx.version, locale: ctx.locale, reason: configFile };
        pageById.set(id, page); pages.push(page);
      }
      return [{ type: 'page', pageId: id }];
    }
    if (Array.isArray(node)) return node.flatMap((n) => walk(n, ctx));
    if (!node || typeof node !== 'object') return [];
    const next = { ...ctx };
    if (typeof node.version === 'string') { next.version = node.version; if (node.default === true || defaultVersion === undefined) defaultVersion = node.version; }
    if (typeof node.language === 'string') { next.locale = node.language; if (node.default === true || defaultLocale === undefined) defaultLocale = node.language; }
    const label = labelOf(node);
    if (label && !node.version && !node.language) next.group = [...ctx.group, String(label)];
    if (typeof node.openapi === 'string') { next.openapi = node.openapi; openapi.push({ groupPath: next.group, spec: node.openapi, version: next.version, locale: next.locale }); }
    else if (node.openapi && typeof node.openapi === 'object' && typeof node.openapi.source === 'string') { openapi.push({ groupPath: next.group, spec: node.openapi.source, version: next.version, locale: next.locale }); }
    const kind = (['group', 'tab', 'dropdown', 'product', 'version', 'language', 'menu'] as const).find((key) => typeof node[key] === 'string') ?? (typeof node.anchor === 'string' ? 'menu' : undefined);
    if (typeof node.href === 'string' && !DIVISIONS.some((k) => k in node)) {
      if (!label || !kind) throw new Error(`${configFile}: external navigation entry ${node.href} has no supported container label`);
      return [{ type: 'group', kind, label, ...navigationMetadata(node), children: [] }];
    }
    const children: SourceNavigationNode[] = [];
    for (const k of DIVISIONS) if (k in node) children.push(...walk(node[k], next));
    if (node.global && typeof node.global === 'object') children.push(...walk(node.global, next));
    return label && children.length ? [{ type: 'group', kind: kind as NavigationContainerKind, label: String(label), ...navigationMetadata(node), children }] : children;
  };
  const navigation = walk(cfg.navigation ?? {}, { group: [] });

  // page titles from frontmatter when present
  for (const p of pages) {
    const raw = readFileSync(join(root, p.source), 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const data = parseYaml(match[1]) as Record<string, unknown> | undefined;
    if (typeof data?.title === 'string') p.title = data.title;
    if (typeof data?.sidebarTitle === 'string') p.sidebarTitle = data.sidebarTitle;
    if (typeof data?.description === 'string') p.description = data.description;
    for (const key of ['icon', 'tags', 'badge', 'method'] as const) if (typeof data?.[key] === 'string') p[key] = data[key];
  }

  // redirects: Mintlify supports :slug, :slug* and a trailing *; the platform supports exact and :param only
  const exact: RedirectRule[] = []; const wildcard: RedirectRule[] = []; const skipped: Array<{ source: string; reason: string }> = [];
  for (const r of (cfg.redirects ?? []) as Array<{ source: string; destination: string; permanent?: boolean }>) {
    if (!r?.source || !r?.destination) continue;
    const status = r.permanent === false ? 307 : 308;
    if (/\*/.test(r.source)) {
      const src = r.source.replace(/:(\w+)\*$/, '*').replace(/\*+$/, '*');
      const dst = r.destination.replace(/:(\w+)\*$/, ':splat').replace(/\*$/, ':splat');
      if (!/\*$/.test(src)) { skipped.push({ source: r.source, reason: 'wildcard not at the end' }); continue; }
      wildcard.push({ source: src, destination: dst, statusCode: status });
    } else exact.push({ source: r.source, destination: r.destination, statusCode: status });
  }

  return { root, configFile, name: cfg.name, colors: cfg.colors, logo: cfg.logo, favicon: cfg.favicon, tree: { scope: 'full', platform: 'mintlify', pages, navigation, navigationSource: 'source-config', defaultVersion, defaultLocale }, redirects: { exact, wildcard, skipped }, openapi, missing };
}

/** Snippet resolver for Mintlify: imports are absolute from the repo root ("/snippets/x.mdx"). */
export function mintlifySnippetResolver(root: string): (importPath: string) => string | undefined {
  const base = resolve(root);
  return (importPath) => {
    const rel = importPath.replace(/^\/+/, '');
    if (!rel.startsWith('snippets/') || rel.includes('..')) return undefined;
    const p = resolve(base, rel);
    if (!p.startsWith(base + '/') || !existsSync(p)) return undefined;
    const raw = readFileSync(p, 'utf8');
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); // snippet frontmatter never renders
  };
}
