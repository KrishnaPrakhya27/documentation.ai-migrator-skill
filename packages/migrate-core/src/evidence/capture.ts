/** Source enumeration never reads the migration tree or the conversion IR. */
import { readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { pageIdFromPlatform, sha256 } from '../session/ids.js';
import type { DiscoveryResult, DiscoveredNavigationNode } from '../scrape/discovery.js';
import { normaliseDiscoveryUrl } from '../scrape/discovery.js';
import { CanonicalHosts } from '../scrape/fetcher.js';
import { FROZEN_ROOT, assertRelativeSourcePath, type FreezeResult, type SourceManifest, type SourceManifestPage, type PageEvidence } from './manifest.js';

interface CaptureContext { location: string; platform: string; contentContractVersion: string; capturedAt: string }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function nativeSourceManifest(context: CaptureContext & { kind: 'repo' | 'export'; root: string; freeze: FreezeResult }): SourceManifest {
  const { platform, root, freeze } = context;
  const manifest: SourceManifest = {
    schemaVersion: 1, capturedAt: context.capturedAt, source: { kind: context.kind, platform, location: context.location },
    contentContractVersion: context.contentContractVersion, frozenRoot: FROZEN_ROOT, ...freeze, indexes: [], pages: [], issues: [],
  };
  const files = new Map(freeze.files.map((file) => [file.path, file]));
  const pages = new Map<string, SourceManifestPage>();
  const add = (path: string, sourceId: string, evidence: PageEvidence, published = true): void => {
    assertRelativeSourcePath(path);
    const pageId = pageIdFromPlatform(platform, sourceId);
    if (!pages.has(pageId)) pages.set(pageId, { pageId, sourceId, location: path, published, evidence: [evidence], rawSha256: files.get(path)?.sha256 });
    if (published && !files.has(path)) manifest.issues!.push(`${sourceId}: source index names missing file ${path}`);
  };
  const index = (path: string, kind: SourceManifest['indexes'][number]['kind']): string => {
    assertRelativeSourcePath(path);
    const file = files.get(path);
    if (!file) throw new Error(`source index missing: ${path}`);
    manifest.indexes.push({ kind, location: path, sha256: file.sha256, entries: 0 });
    return readFileSync(join(root, path), 'utf8');
  };
  if (platform === 'mintlify') {
    const config = object(JSON.parse(index(files.has('docs.json') ? 'docs.json' : 'mint.json', 'navigation-config')));
    const divisions = new Set(['versions', 'languages', 'tabs', 'anchors', 'dropdowns', 'products', 'menus', 'groups', 'pages', 'global']);
    const walk = (value: unknown, locale = '', version = ''): void => {
      if (typeof value === 'string') {
        const path = files.has(`${value}.mdx`) ? `${value}.mdx` : `${value}.md`;
        add(path, `${locale}|${version}|${value}`, 'config'); return;
      }
      if (Array.isArray(value)) { value.forEach((entry) => walk(entry, locale, version)); return; }
      const node = object(value);
      const language = typeof node.language === 'string' ? node.language : locale;
      const release = typeof node.version === 'string' ? node.version : version;
      const children = Object.entries(node).filter(([key]) => divisions.has(key));
      if (typeof node.path === 'string') manifest.issues!.push(`navigation object path ${node.path}: native identity mapping is not implemented`);
      if (!children.length && !node.href && Object.keys(node).length) manifest.issues!.push('navigation contains an unresolved leaf object');
      for (const [, child] of children) walk(child, language, release);
    };
    walk(config.navigation);
    if (!config.navigation) manifest.issues!.push('Mintlify config has no supported navigation index');
  } else if (platform === 'gitbook') {
    const config = files.has('.gitbook.yaml') ? object(parseYaml(index('.gitbook.yaml', 'navigation-config'))) : {};
    const contentRoot = typeof config.root === 'string' ? config.root : '.';
    const structure = object(config.structure);
    const summary = posix.normalize(posix.join(contentRoot, typeof structure.summary === 'string' ? structure.summary : 'SUMMARY.md'));
    const syntax = fromMarkdown(index(summary, 'summary'));
    const definitions = new Map<string, string>();
    for (const node of syntax.children) if (node.type === 'definition') definitions.set(node.identifier, node.url);
    const walk = (node: { type: string; url?: string; identifier?: string; children?: readonly typeof node[] }): void => {
      const url = node.type === 'linkReference' ? definitions.get(node.identifier ?? '') : node.url;
      if (node.type === 'linkReference' && !url) manifest.issues!.push(`unresolved SUMMARY link reference: ${node.identifier}`);
      if ((node.type === 'link' || node.type === 'linkReference') && url && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
        const relative = decodeURIComponent(url.split('#')[0]);
        const path = posix.normalize(posix.join(contentRoot, relative));
        // GitBook identities are relative to its configured content root.
        add(path, relative.replace(/^\.\//, ''), 'config');
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(syntax);
    const listed = new Set([...pages.values()].map((page) => page.location));
    for (const file of freeze.files) {
      const relative = posix.relative(contentRoot, file.path);
      if (!/\.md$/i.test(file.path) || file.path === summary || relative.startsWith('../') || listed.has(file.path)) continue;
      add(file.path, relative, 'filesystem', false);
    }
  } else if (platform === 'readme') {
    const docsRoot = freeze.files.some((file) => file.path.startsWith('docs/')) ? 'docs/' : '';
    for (const file of freeze.files.filter((file) => file.path.startsWith(docsRoot) && /\.mdx?$/i.test(file.path))) {
      const raw = readFileSync(join(root, file.path), 'utf8');
      const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const data = frontmatter ? object(parseYaml(frontmatter[1])) : {};
      const slug = typeof data.slug === 'string' ? data.slug : posix.basename(file.path).replace(/\.mdx?$/i, '');
      if (pages.has(pageIdFromPlatform(platform, slug))) manifest.issues!.push(`duplicate ReadMe slug: ${slug}`);
      add(file.path, slug, 'filesystem', data.hidden !== true);
    }
  } else if (platform === 'docusaurus') {
    // Docusaurus does not publish a page marked draft or unlisted, so counting it as published
    // would demand a scope decision for a page the source never served.
    for (const file of freeze.files.filter((file) => /\.mdx?$/i.test(file.path) && !file.path.startsWith('node_modules/'))) {
      const raw = readFileSync(join(root, file.path), 'utf8');
      const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const data = frontmatter ? object(parseYaml(frontmatter[1])) : {};
      add(file.path, file.path, 'filesystem', data.draft !== true && data.unlisted !== true);
    }
  } else if (platform === 'nextra') {
    const roots = ['content/', 'src/content/', 'pages/', 'src/pages/'];
    const contentRoot = roots.find((candidate) => freeze.files.some((file) => file.path.startsWith(candidate)));
    for (const file of freeze.files.filter((file) => /\.mdx?$/i.test(file.path) && (!contentRoot || file.path.startsWith(contentRoot)))) {
      add(file.path, file.path, 'filesystem');
    }
  } else if (platform === 'fern') {
    // Fern builds only what docs.yml references; anything else in the folder is not published.
    const configPath = ['fern/docs.yml', 'fern/docs.yaml'].find((candidate) => files.has(candidate));
    if (!configPath) manifest.issues!.push('no fern/docs.yml: the source universe cannot be read from the navigation it states');
    const referenced = new Set<string>();
    if (configPath) {
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(collect); return; }
        const node = object(value);
        if (typeof node.path === 'string') referenced.add(posix.normalize(posix.join('fern', node.path)));
        if (typeof node.folder === 'string') {
          const folder = posix.normalize(posix.join('fern', node.folder));
          for (const file of freeze.files) if (file.path.startsWith(`${folder}/`) && /\.mdx?$/i.test(file.path)) referenced.add(file.path);
        }
        for (const child of Object.values(node)) if (child && typeof child === 'object') collect(child);
      };
      collect(object(parseYaml(index(configPath, 'navigation-config'))));
    }
    for (const file of freeze.files.filter((file) => /\.mdx?$/i.test(file.path) && file.path.startsWith('fern/'))) {
      add(file.path, file.path, referenced.has(file.path) ? 'config' : 'filesystem', referenced.has(file.path));
    }
  } else if (context.kind === 'export') {
    // An arbitrary category shape must not be certified by reusing the tolerant conversion adapter.
    manifest.issues!.push('independent export category enumeration is not implemented; source universe cannot be certified');
  } else {
    for (const file of freeze.files.filter((file) => /\.(?:mdx?|html?)$/i.test(file.path))) add(file.path, file.path, 'filesystem');
  }
  if (!manifest.indexes.length) manifest.indexes.push({ kind: 'filesystem', location: FROZEN_ROOT, sha256: sha256(JSON.stringify(freeze.files)), entries: pages.size });
  manifest.pages = [...pages.values()];
  for (const link of freeze.skippedLinks) manifest.issues!.push(`${link}: symbolic link not frozen; published status is unproven`);
  return manifest;
}

/** Retains sitemap/llms/sidebar entries even if discovery's page list accidentally drops them. */
export function liveSourceManifest(context: CaptureContext, discovery: DiscoveryResult): SourceManifest {
  const origin = new URL(context.location).origin;
  const hosts = new CanonicalHosts(origin, discovery.canonicalHosts);
  const aliases = new Map<string, string>();
  for (const page of discovery.pages) for (const alias of page.aliases ?? []) aliases.set(alias, page.url);
  const pages = new Map<string, SourceManifestPage>();
  const add = (candidate: string, evidence: PageEvidence): void => {
    const normalized = normaliseDiscoveryUrl(candidate, context.location, origin, hosts);
    if (!normalized) return;
    const url = aliases.get(normalized) ?? normalized;
    const existing = pages.get(url);
    if (existing) { if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence); return; }
    pages.set(url, { pageId: pageIdFromPlatform(context.platform, url), sourceId: url, location: url, published: true, evidence: [evidence] });
  };
  for (const entry of discovery.sitemaps.entries) {
    add(entry.url, 'sitemap');
    for (const alternate of entry.alternates) add(alternate.href, 'sitemap');
  }
  for (const entry of discovery.llms?.entries ?? []) add(new URL(entry.path, entry.mdUrl).toString(), 'llms-txt');
  const navigation = (nodes: DiscoveredNavigationNode[]): void => {
    for (const node of nodes) if (node.type === 'page') add(node.url, 'navigation'); else navigation(node.children);
  };
  for (const nodes of Object.values(discovery.navigationCandidates ?? {})) navigation(nodes);
  navigation(discovery.navigation ?? []);
  for (const page of discovery.pages) add(page.url, 'crawl');
  // What each page served at discovery, so acquisition can tell whether the source moved.
  for (const page of discovery.pages) {
    const entry = pages.get(page.url);
    if (entry && page.contentSha256) entry.rawSha256 = page.contentSha256;
  }
  return {
    schemaVersion: 1, capturedAt: context.capturedAt, source: { kind: 'url', platform: context.platform, location: context.location }, contentContractVersion: context.contentContractVersion,
    // This is explicitly a captured discovery index; raw HTTP witnesses remain in the crawl cache.
    indexes: [{ kind: 'rendered-navigation', location: 'discovery-result.json', sha256: sha256(JSON.stringify(discovery)), entries: pages.size }],
    pages: [...pages.values()], issues: [
      ...(discovery.truncated ? ['discovery was truncated; the complete source universe is unproven'] : []),
      ...(discovery.structuralIssues ?? []),
    ],
  };
}
