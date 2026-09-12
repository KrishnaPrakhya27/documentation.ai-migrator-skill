/**
 * The migration pipeline run offline, in-process, against a saved source.
 *
 * The CLI stages are thin wrappers over these calls; running them directly lets a
 * test acquire, convert, write and verify a whole site with no network and no
 * child process, then mutate the output and re-run the gates to prove each one
 * actually catches the loss it claims to.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquirePages } from '../../src/scrape/acquire.js';
import { acquiredPath } from '../../src/scrape/acquire.js';
import type { AcquiredPage } from '../../src/scrape/acquire.js';
import { extractDomSidebarNavigation, extractMintlifyNavigation, type DiscoveredNavigationNode } from '../../src/scrape/discovery.js';
import { unwrapPublishedMarkdown } from '../../src/scrape/published-markdown.js';
import { getProfile } from '../../src/scrape/profiles.js';
import { CanonicalHosts, type Fetcher } from '../../src/scrape/fetcher.js';
import { markdownToIr } from '../../src/ir/from-markdown.js';
import { docToMdx } from '../../src/ir/to-dai-mdx.js';
import { RulesEngine, loadMappings } from '../../src/components/rules-engine.js';
import { Ledger } from '../../src/ledger/dispositions.js';
import { DecisionLog } from '../../src/log/decisions.js';
import { buildDocumentationNavigation, placedPageIds, type SourceNavigationNode, type Tree, type TreePage } from '../../src/nav/tree.js';
import { canonicalHash, runGates, type GateInput, type GateResult, type SourceEvidence } from '../../src/verify/gates.js';
import { loadRawSourcePages } from '../../src/verify/source-truth.js';
import { unconvertedFidelityRecord, writeFidelityRecords, type FidelityRecord } from '../../src/verify/fidelity-records.js';
import { authoredContentSnapshot, renderedDocSnapshot, firstFidelityDifference } from '../../src/verify/fidelity.js';
import { ensureWorkspace } from '../../src/session/workspace.js';
import { captureMigratorProvenance } from '../../src/session/provenance.js';
import { sha256 } from '../../src/session/ids.js';
import { stringify as toYaml } from 'yaml';
import { writeManifest } from '../../src/assets/manifest.js';
import { documentationSiteSettings } from '../../src/nav/site-settings.js';
import type { DocIR } from '../../src/ir/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export interface OfflineRunInput {
  /** Seed URL of the site, on the host the fetcher serves. */
  seedUrl: string;
  fetcher: Fetcher;
  platform: string;
  /** Pages to migrate, in source order, each with the metadata discovery recorded. */
  pages: TreePage[];
  /** Navigation as discovery recovered it, already mapped onto page ids. */
  navigation?: SourceNavigationNode[];
  navigationSource?: Tree['navigationSource'];
  /** Site metadata for documentation.json. */
  platformMeta?: Record<string, unknown>;
  mappingFiles?: string[];
}

export interface OfflineRun {
  workspace: string;
  outputDir: string;
  tree: Tree;
  docs: DocIR[];
  /** Re-runs the gates over the workspace as it now stands, so a test can mutate output and re-check. */
  gates: () => GateResult[];
  gateInput: () => GateInput;
}

const defaultMappings = (platform: string) => [
  ...(platform === 'generic' ? [] : [join(repoRoot, `skills/migrate-${platform}/mappings/${platform}.yaml`)]),
  join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml'),
];

/** acquire → inventory → convert → nav, then a gate runner bound to the finished workspace. */
export async function runOfflinePipeline(input: OfflineRunInput): Promise<OfflineRun> {
  const workspace = mkdtempSync(join(tmpdir(), 'dai-offline-'));
  ensureWorkspace(workspace);
  const outputDir = join(workspace, 'output');
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(workspace, 'snapshot', 'pages'), { recursive: true });
  const profile = getProfile(input.platform);

  await acquirePages({ workspace, pages: input.pages, fetcher: input.fetcher, profile, fidelityMode: 'exact' });

  const placed = input.navigation ? placedPageIds(input.navigation) : undefined;
  const pages: TreePage[] = input.pages.map((page) => ({
    ...page,
    newPath: page.newPath ?? routeOf(page.source, input.seedUrl),
    ...(placed ? { navMembership: placed.has(page.id) ? 'listed' as const : 'unlisted' as const } : {}),
  }));
  const tree: Tree = { scope: 'full', platform: input.platform, pages, navigation: input.navigation, navigationSource: input.navigationSource ?? 'platform-metadata' };

  const ledger = new Ledger(workspace);
  const engine = new RulesEngine({ platform: input.platform, mappings: loadMappings(input.mappingFiles ?? defaultMappings(input.platform)), ledger, log: new DecisionLog(workspace) });
  const docs: DocIR[] = [];
  const records: FidelityRecord[] = [];
  for (const page of pages) {
    const record = JSON.parse(readFileSync(acquiredPath(workspace, page.id), 'utf8')) as AcquiredPage;
    if (record.markdown === undefined) { records.push(unconvertedFidelityRecord({ pageId: page.id, source: page.source }, 'not-migrated')); continue; }
    const description = record.llms?.description ?? record.description ?? page.description;
    const published = unwrapPublishedMarkdown(record.markdown, input.platform, { expectedDescription: description });
    const title = record.llms?.title ?? published.title ?? page.title;
    const source = markdownToIr(published.body, { platform: input.platform, file: page.source, pageId: page.id, title, frontmatter: { title, ...(description ? { description } : {}) }, codeMetaStrip: profile.codeMetaStrip });
    const resolved = engine.resolveDoc(source);
    docs.push(resolved);
    const mdx = docToMdx(resolved);
    const file = join(outputDir, `${page.newPath}.mdx`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, mdx);
    writeFileSync(join(workspace, 'snapshot', 'pages', `${page.id}.json`), JSON.stringify(resolved, null, 2));
    const sourceSnapshot = authoredContentSnapshot(source);
    const resolvedSnapshot = authoredContentSnapshot(resolved);
    const difference = firstFidelityDifference(sourceSnapshot, resolvedSnapshot);
    records.push({ pageId: page.id, source: page.source, pass: difference === undefined, difference, sourceSnapshot, resolvedSnapshot, expectedOutput: renderedDocSnapshot(resolved) });
  }
  writeFidelityRecords(workspace, records);
  writeManifest(workspace, { provider: 'none', entries: {}, byUrl: {} });
  // The plan files the gates pin against; a plan is a decision that must not change after convert.
  writeFileSync(join(workspace, 'plan', 'component-plan.yaml'), toYaml({ components: [] }));
  writeFileSync(join(workspace, 'plan', 'assets.yaml'), toYaml({ assets: [] }));
  writeFileSync(join(workspace, 'plan', 'urls.yaml'), toYaml({
    mode: 'preserve', scope: 'full', preserve: { case: 'preserve' }, restructure: { strategy: 'from-nav' },
    pages: pages.map((page) => ({ id: page.id, old: page.oldPath, new: page.newPath!, reason: 'path preserved' })),
  }));
  const pinnedPlans = {
    componentPlan: sha256(readFileSync(join(workspace, 'plan', 'component-plan.yaml'))),
    urlPlan: sha256(readFileSync(join(workspace, 'plan', 'urls.yaml'))),
    assetPlan: sha256(readFileSync(join(workspace, 'plan', 'assets.yaml'))),
  };

  const written = new Set(pages.map((page) => page.newPath!));
  const meta = input.platformMeta ?? {};
  const navigation = buildDocumentationNavigation(tree, written, meta);
  // The same site settings the nav command writes, so the harness cannot carry what the CLI would not.
  writeFileSync(join(outputDir, 'documentation.json'), JSON.stringify({ ...documentationSiteSettings(meta), ...navigation }, null, 2));

  const gateInput = (): GateInput => {
    const evidence = sourceEvidence(workspace, outputDir, tree, input.seedUrl, meta);
    const hash = canonicalHash(outputDir);
    return {
      workspace, outputDir, sourceEvidence: evidence, pinnedPlans,
      sourceDocs: docs.map((doc) => ({ doc, outputFile: join(outputDir, `${pages.find((page) => page.id === doc.pageId)!.newPath}.mdx`) })),
      treePages: pages, quarantinedPages: new Set(), excludedPages: new Set(), unreviewed: 0,
      previousCanonicalHash: hash, convertOutputHash: hash,
      pinnedContractVersion: '0.1.0', fidelityMode: 'exact', sourceKind: 'url', navigationSource: tree.navigationSource,
      expectedNavigation: buildDocumentationNavigation(tree, written, meta).navigation,
      pinnedMigrator: captureMigratorProvenance({ repoRoot, packageVersion: '0.1.0' }),
      currentMigrator: captureMigratorProvenance({ repoRoot, packageVersion: '0.1.0' }),
    };
  };
  return { workspace, outputDir, tree, docs, gateInput, gates: () => runGates(gateInput()) };
}

function routeOf(source: string, seedUrl: string): string {
  const path = new URL(source, seedUrl).pathname.replace(/^\/+/, '').replace(/\/$/, '');
  return path || 'index';
}

function sourceEvidence(workspace: string, outputDir: string, tree: Tree, seedUrl: string, meta: Record<string, unknown>): SourceEvidence {
  const profile = getProfile(tree.platform);
  const pages = loadRawSourcePages({ workspace, outputDir, pages: tree.pages });
  const origin = new URL(seedUrl).origin;
  const home = pages.find((page) => page.path === '/') ?? pages[0];
  let navigation: Record<string, unknown> | undefined;
  let navigationSource: string | undefined;
  if (home?.html) {
    const extracted = tree.platform === 'mintlify' ? extractMintlifyNavigation(home.html, origin)?.navigation : undefined;
    const nodes = extracted ?? extractDomSidebarNavigation(home.html, `${origin}/`, origin, profile, new CanonicalHosts(origin));
    if (nodes) {
      navigationSource = extracted ? 'platform-metadata' : 'dom-sidebar';
      const byUrl = new Map(tree.pages.map((page) => [page.source.replace(/\/$/, ''), page.id]));
      const toSource = (items: DiscoveredNavigationNode[]): SourceNavigationNode[] => items.flatMap((node): SourceNavigationNode[] => {
        if (node.type === 'page') { const id = byUrl.get(node.url.replace(/\/$/, '')); return id ? [{ type: 'page', pageId: id, title: node.title }] : []; }
        const children = toSource(node.children);
        return children.length || node.href ? [{ ...node, children }] : [];
      });
      navigation = buildDocumentationNavigation({ ...tree, navigation: toSource(nodes) }, new Set(tree.pages.map((page) => page.newPath!)), meta).navigation;
    }
  }
  return { pages, platform: tree.platform, profile, navigation, navigationSource, indexedRoutes: pages.map((page) => page.route) };
}
