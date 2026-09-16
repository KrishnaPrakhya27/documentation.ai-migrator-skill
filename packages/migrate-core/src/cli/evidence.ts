/**
 * The evidence a verification run reads back.
 *
 * Verification never trusts the snapshot the same run produced: it re-reads the frozen source and
 * rebuilds from it what the output claims. These helpers assemble that evidence — the frozen pages,
 * the navigation the source states, the routes that were written and how links between pages are
 * resolved — so `verify` states what it compares rather than how it gathers it.
 *
 * They report a missing input by throwing; the command turns that into the operator's error, which
 * keeps the workspace conventions and the message in one place.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { frozenRootPath, sourceManifestPath, type SourceManifest } from '../evidence/manifest.js';
import { nativeNavigationWitness } from '../evidence/native-navigation.js';
import { attachHelpCenterHub } from '../nav/help-center.js';
import { buildDocumentationNavigation, type SourceNavigationNode, type Tree } from '../nav/tree.js';
import { getProfile } from '../scrape/profiles.js';
import { CanonicalHosts } from '../scrape/fetcher.js';
import { navigationFromFrozenPages, type DiscoveredNavigationNode, type DiscoveryResult } from '../scrape/discovery.js';
import { loadRawSourcePages, type RawSourcePage } from '../verify/source-truth.js';
import { readManifest } from '../assets/manifest.js';
import { siteLinksFor, type SiteLinks } from '../urls/site-links.js';
import { readUrlPlan } from '../urls/plan.js';
import type { SourceEvidence } from '../verify/gates.js';
import type { ExpectedNavigationEntry } from '../verify/browser.js';
import { canonicalHostsPath, readJson } from './io.js';
import { readPlatformMeta } from './platform-meta.js';

/**
 * Navigation data files frozen with the capture, for a platform that publishes its sidebar as data
 * rather than rendering it (MadCap Flare). Absent for every other platform, and absent for a
 * workspace captured before the reader existed — the caller then re-derives from the HTML alone.
 */
export function frozenNavigationData(workspace: string): Map<string, string> {
  const path = join(workspace, 'source-cache', 'discovery-result.json');
  if (!existsSync(path)) return new Map();
  const discovery = readJson<DiscoveryResult>(path);
  return new Map((discovery.navigationData ?? []).map((file) => [file.url, file.body]));
}

export function siteLinksForWorkspace(workspace: string, tree: Tree): SiteLinks {
  const manifest = existsSync(sourceManifestPath(workspace)) ? readJson<SourceManifest>(sourceManifestPath(workspace)) : undefined;
  const llmsPath = join(workspace, 'inventory', 'llms.json');
  const llms = existsSync(llmsPath) ? readJson<{ entries?: Array<{ path: string }> } | null>(llmsPath) : null;
  const hosts = existsSync(canonicalHostsPath(workspace)) ? readJson<{ aliases?: string[] }>(canonicalHostsPath(workspace)).aliases ?? [] : [];
  // The sitemap declares everything the source publishes, documents and media alongside pages. A link
  // to a PDF the site serves is not a page this migration writes, but it is not an invented path
  // either: without it the link stays relative and resolves to nothing inside the migrated site.
  const sitemapPath = join(workspace, 'inventory', 'sitemaps.json');
  const sitemap = existsSync(sitemapPath) ? readJson<{ entries?: Array<{ url: string }> }>(sitemapPath).entries ?? [] : [];
  const sourcePages = [...(manifest?.pages ?? []).map((page) => page.location), ...(llms?.entries ?? []).map((entry) => entry.path), ...sitemap.map((entry) => entry.url)];
  return siteLinksFor(tree, { unmigrated: readUrlPlan(workspace)?.unmigratedLinks ?? 'keep', sourcePages, hosts });
}

/**
 * Routes the help-centre decision writes: a hub page per container carrying that label. The source
 * never published them, which is why the decision records who approved it; they are the operator's
 * pages, not pages of the source, and the source universe accounts for them as such.
 */
export function helpCenterHubRoutes(workspace: string, tree: Tree): ReadonlySet<string> {
  if (!tree.helpCenter) return new Set();
  try {
    const preview = buildDocumentationNavigation({ ...tree, helpCenter: undefined }, writtenPagePaths(workspace, tree), readPlatformMeta(workspace));
    return new Set(attachHelpCenterHub(preview.navigation, tree.helpCenter).hubs.map((hub) => hub.hubPath));
  } catch {
    return new Set();
  }
}

export function writtenPagePaths(workspace: string, tree: Tree): Set<string> {
  return new Set(tree.pages.flatMap((page) => (page.newPath && existsSync(join(workspace, 'output', `${page.newPath}.mdx`)) ? [page.newPath] : [])));
}

/**
 * The sidebar the source states, flattened in reading order. A page placed in two groups
 * appears twice, which is what the rendered sidebar must show.
 */
export function expectedSidebar(tree: Tree): ExpectedNavigationEntry[] {
  const byId = new Map(tree.pages.map((page) => [page.id, page]));
  const out: ExpectedNavigationEntry[] = [];
  const walk = (nodes: SourceNavigationNode[], groupPath: string[]): void => {
    for (const node of nodes) {
      if (node.type === 'group') { walk(node.children, [...groupPath, node.label]); continue; }
      const page = byId.get(node.pageId);
      if (page?.migrate && page.newPath) out.push({ groupPath, label: node.title ?? page.sidebarTitle ?? page.title });
    }
  };
  walk(tree.navigation ?? [], []);
  return out;
}

/**
 * The acquisition, re-read for verification: the frozen pages, the profile that
 * describes the rendered source, and the navigation extracted afresh from the
 * frozen HTML so the written navigation is judged against the source rather than
 * against the tree this run built from it.
 */
export function buildSourceEvidence(workspace: string, tree: Tree): SourceEvidence | undefined {
  const profile = getProfile(tree.platform);
  let pages: RawSourcePage[];
  pages = loadRawSourcePages({ workspace, outputDir: join(workspace, 'output'), pages: tree.pages });
  if (!pages.length) return undefined;

  const seed = tree.pages.find((page) => page.migrate && /^https?:\/\//.test(page.source))?.source;
  const home = pages.find((page) => page.path === '/') ?? pages[0];
  let navigation: Record<string, unknown> | undefined;
  let navigationSource: string | undefined;
  if (seed && home.html) {
    const origin = new URL(seed).origin;
    const sourceById = new Map(tree.pages.map((page) => [page.id, page.source]));
    const derived = navigationFromFrozenPages(pages.map((page) => ({ url: sourceById.get(page.pageId) ?? '', html: page.html })).filter((page) => /^https?:\/\//.test(page.url)), tree.platform, seed, origin, profile, frozenNavigationData(workspace), new CanonicalHosts(origin, existsSync(canonicalHostsPath(workspace)) ? readJson<{ aliases?: string[] }>(canonicalHostsPath(workspace)).aliases ?? [] : []));
    if (derived) {
      const nodes = derived.nodes;
      navigationSource = derived.source;
      const byUrl = new Map(tree.pages.map((page) => [page.source.replace(/\/$/, ''), page.id]));
      const toSource = (items: DiscoveredNavigationNode[]): SourceNavigationNode[] => items.flatMap((node): SourceNavigationNode[] => {
        if (node.type === 'page') { const id = byUrl.get(node.url.replace(/\/$/, '')); return id ? [{ type: 'page', pageId: id, title: node.title }] : []; }
        const children = toSource(node.children);
        const { pageUrl, ...container } = node;
        const ownId = pageUrl ? byUrl.get(pageUrl.replace(/\/$/, '')) : undefined;
        return children.length || node.href || ownId ? [{ ...container, ...(ownId ? { pageId: ownId } : {}), children }] : [];
      });
      navigation = buildDocumentationNavigation({ ...tree, navigation: toSource(nodes) }, writtenPagePaths(workspace, tree), readPlatformMeta(workspace)).navigation;
    }
  } else if (!seed) {
    // A repository states its navigation in its own configuration. Reading it again with the same
    // adapter, from the frozen bytes, is the witness a live site gets from its rendered sidebar.
    const witness = nativeNavigationWitness(tree.platform, frozenRootPath(workspace));
    if (witness) {
      navigationSource = witness.source;
      navigation = buildDocumentationNavigation({ ...tree, navigation: witness.nodes }, writtenPagePaths(workspace, tree), readPlatformMeta(workspace)).navigation;
    }
  }
  return { pages, platform: tree.platform, profile, navigation, navigationSource, indexedRoutes: pages.map((page) => page.route), links: siteLinksForWorkspace(workspace, tree), assets: readManifest(workspace) };
}
