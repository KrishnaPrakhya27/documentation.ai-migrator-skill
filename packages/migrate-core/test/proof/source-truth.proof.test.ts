/**
 * The gates, proved against the saved source.
 *
 * The migration that lost content passed every gate, because every content gate
 * compared the output with the migrator's own snapshot of it. These tests run the
 * whole pipeline offline over the real saved source, assert the gates pass, and
 * then reintroduce each loss that actually shipped — chrome text, a deleted
 * description, merged paragraphs, a dropped card link, a renamed group, a removed
 * placement — and require the gates to fail. A gate that cannot fail proves
 * nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTruth, resolveSourceTruthDir, isNavigationGroup } from '../helpers/source-truth.js';
import { FIXTURE_SITE_ORIGIN, fixtureFetcher, offlineFetcher } from '../helpers/fixture-fetcher.js';
import { runOfflinePipeline, type OfflineRun } from '../helpers/offline-pipeline.js';
import { parseLlmsTxt } from '../../src/scrape/published-markdown.js';
import { CanonicalHosts } from '../../src/scrape/fetcher.js';
import { PROFILES, profileHostAliases } from '../../src/scrape/profiles.js';
import { pageIdFromPlatform } from '../../src/session/ids.js';
import { ensureWorkspace } from '../../src/session/workspace.js';
import { extractMintlifyNavigation } from '../../src/scrape/discovery.js';
import { runGates, type GateResult } from '../../src/verify/gates.js';
import type { SourceNavigationNode, TreePage } from '../../src/nav/tree.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const mintlify = PROFILES.mintlify;
const llmsByPath = new Map(parseLlmsTxt(readFileSync(join(dir, 'llms.txt'), 'utf8')).map((entry) => [entry.path, entry]));
const indexHtml = readFileSync(join(dir, 'html', 'index.html'), 'utf8');

const gate = (gates: GateResult[], id: string): GateResult => {
  const found = gates.find((result) => result.id === id);
  if (!found) throw new Error(`gate ${id} was not reported`);
  return found;
};

/** The site as discovery would present it: every llms.txt page, with the platform's exact metadata and navigation. */
function pipelineInput() {
  const pages: TreePage[] = truth.pages.map((page, order) => ({
    id: pageIdFromPlatform('mintlify', page.htmlUrl),
    title: page.title,
    titleSource: 'llms-txt' as const,
    sidebarTitle: page.pageMetadata?.sidebarTitle,
    description: page.description ?? undefined,
    llms: llmsByPath.get(page.path),
    source: page.htmlUrl,
    group: page.groupPath ?? [],
    order,
    oldPath: page.path,
    migrate: true,
  }));
  const byUrl = new Map(pages.map((page) => [page.source.replace(/\/$/, ''), page.id]));
  const extracted = extractMintlifyNavigation(indexHtml, FIXTURE_SITE_ORIGIN)!.navigation;
  const toSource = (items: typeof extracted): SourceNavigationNode[] => items.flatMap((node): SourceNavigationNode[] => {
    if (node.type === 'page') { const id = byUrl.get(node.url.replace(/\/$/, '')); return id ? [{ type: 'page', pageId: id, title: node.title }] : []; }
    const children = toSource(node.children);
    return children.length ? [{ type: 'group', label: node.label, children }] : [];
  });
  const recording = fixtureFetcher(dir);
  const workspace = mkdtempSync(join(tmpdir(), 'dai-proof-fetch-'));
  ensureWorkspace(workspace);
  return {
    seedUrl: `${FIXTURE_SITE_ORIGIN}/`,
    platform: 'mintlify',
    pages,
    navigation: toSource(extracted),
    navigationSource: 'platform-metadata' as const,
    platformMeta: { name: truth.site.name, colors: truth.site.colors, favicon: truth.site.favicon, logo: truth.site.logo },
    fetcher: offlineFetcher(recording, {
      workspace,
      allowHosts: [new URL(FIXTURE_SITE_ORIGIN).hostname],
      rps: 1000,
      canonicalHosts: new CanonicalHosts(FIXTURE_SITE_ORIGIN, profileHostAliases(mintlify, new URL(FIXTURE_SITE_ORIGIN).hostname)),
    }),
  };
}

/** A fresh run per mutation, so one test's damage cannot leak into another. */
const freshRun = () => runOfflinePipeline(pipelineInput());

describe('gates over the acquired source', () => {
  let run: OfflineRun;
  let gates: GateResult[];
  beforeAll(async () => { run = await freshRun(); gates = run.gates(); });

  it('migrates every page the source publishes', () => {
    expect(run.docs.length).toBe(truth.pageCount);
    expect(gate(gates, 'pages-accounted').status).toBe('pass');
  });

  it('passes the source-truth family: content, metadata, rendered-page reconciliation and chrome', () => {
    for (const id of ['source-content-exact', 'source-metadata-exact', 'html-reconciliation', 'chrome-absent']) {
      const result = gate(gates, id);
      expect(`${id}: ${result.detail} ${JSON.stringify(result.samples ?? [])}`).toBe(`${id}: ${result.detail} ${JSON.stringify(result.samples ?? [])}`);
      expect(result.status, `${id} — ${result.detail}`).toBe('pass');
    }
  });

  it('matches the navigation re-extracted from the frozen source, not only the tree it built', () => {
    const result = gate(gates, 'navigation-exact');
    expect(result.status, result.detail).toBe('pass');
    expect(result.detail).toContain('re-extracted from the acquired source');
    const nav = JSON.parse(readFileSync(join(run.outputDir, 'documentation.json'), 'utf8')) as { name: string; navigation: Record<string, NavEntry[]> };
    expect(nav.name).toBe(truth.site.name);
    // The source mixes groups with one ungrouped page at the top level, so the written navigation does too.
    const top = topLevel(nav.navigation);
    expect(top.filter(isGroup).map((entry) => entry.group)).toEqual(truth.navigationHierarchy.filter(isNavigationGroup).map((entry) => entry.group));
    expect(top.findIndex((entry) => !isGroup(entry))).toBe(truth.navigationHierarchy.findIndex((entry) => !isNavigationGroup(entry)));
    const placements = top.flatMap((entry) => (isGroup(entry) ? entry.pages : [entry]));
    expect(placements.length).toBe(truth.navigationHierarchy.reduce((n, entry) => n + (isNavigationGroup(entry) ? entry.pages.length : 1), 0));
    expect(placements.filter((entry) => !isGroup(entry) && entry.path === 'index').length, 'the home page keeps both placements').toBe(2);
  });

  it('rejects an output the reviewed tree agrees with but the source contradicts', () => {
    // The gate this replaced compared the written file with the tree the same run produced, so it
    // passed whenever both were wrong together. Here the tree is made to agree with damaged output.
    const input = run.gateInput();
    const damaged = JSON.parse(JSON.stringify(input.expectedNavigation)) as Record<string, NavEntry[]>;
    const group = topLevel(damaged).find(isGroup)!;
    group.group = 'Renamed';
    writeFileSync(join(run.outputDir, 'documentation.json'), JSON.stringify({ name: truth.site.name, navigation: damaged }, null, 2));
    const agreeing = runGates({ ...input, expectedNavigation: damaged });
    const result = agreeing.find((entry) => entry.id === 'navigation-exact')!;
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('re-extracted from the acquired source');
  });
});

type NavEntry = { group: string; pages: NavEntry[] } | { title: string; path: string };
const isGroup = (entry: NavEntry): entry is { group: string; pages: NavEntry[] } => 'group' in entry;
/** documentation.json names the top level `groups` when every entry is a group, and `pages` when one is not. */
const topLevel = (navigation: Record<string, NavEntry[]>): NavEntry[] => navigation.groups ?? navigation.pages ?? [];

describe('each loss that shipped is caught', () => {
  const mutate = async (route: string, change: (mdx: string) => string) => {
    const run = await freshRun();
    const file = join(run.outputDir, `${route}.mdx`);
    writeFileSync(file, change(readFileSync(file, 'utf8')));
    return run.gates();
  };

  it('fails when the assistant-bar shortcut leaks into a page', async () => {
    const gates = await mutate('fan/faq', (mdx) => `${mdx}\n⌘I\n`);
    expect(gate(gates, 'chrome-absent').status).toBe('fail');
    expect(gate(gates, 'chrome-absent').samples?.join(' ')).toContain('⌘I');
    expect(gate(gates, 'source-content-exact').status).toBe('fail');
  });

  it('fails when a description is dropped', async () => {
    const gates = await mutate('quickstart', (mdx) => mdx.replace(/^description:.*$/m, ''));
    const result = gate(gates, 'source-metadata-exact');
    expect(result.status).toBe('fail');
    expect(result.samples?.join(' ')).toContain('/quickstart');
  });

  it('fails when a title is replaced by the URL-derived name', async () => {
    const gates = await mutate('characters/vegeta', (mdx) => mdx.replace(/^title:.*$/m, 'title: Vegeta'));
    expect(gate(gates, 'source-metadata-exact').status).toBe('fail');
    expect(gate(gates, 'source-metadata-exact').samples?.join(' ')).toContain('/characters/vegeta');
  });

  it('fails when two paragraphs are merged into one', async () => {
    const gates = await mutate('characters/villains', (mdx) => {
      const marker = mdx.indexOf('\n\n', mdx.indexOf('\n\n', mdx.lastIndexOf('---') + 3) + 2);
      return `${mdx.slice(0, marker)} ${mdx.slice(marker + 2)}`;
    });
    const result = gate(gates, 'source-content-exact');
    expect(result.status).toBe('fail');
    expect(result.samples?.join(' ')).toContain('$.blocks');
  });

  it('fails when a card loses its link', async () => {
    const gates = await mutate('index', (mdx) => mdx.replace(/\s+href="[^"]*"/, ''));
    expect(gate(gates, 'source-content-exact').status).toBe('fail');
  });

  it('fails when a group is renamed in documentation.json', async () => {
    const run = await freshRun();
    const file = join(run.outputDir, 'documentation.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"Movies & Specials"', '"movies"'));
    expect(gate(run.gates(), 'navigation-exact').status).toBe('fail');
  });

  it('fails when a page loses its second placement', async () => {
    const run = await freshRun();
    const file = join(run.outputDir, 'documentation.json');
    const nav = JSON.parse(readFileSync(file, 'utf8')) as { navigation: Record<string, NavEntry[]> };
    const gettingStarted = topLevel(nav.navigation).filter(isGroup).find((group) => group.group === 'Getting Started')!;
    expect(gettingStarted.pages.some((page) => !isGroup(page) && page.path === 'index')).toBe(true);
    gettingStarted.pages = gettingStarted.pages.filter((page) => isGroup(page) || page.path !== 'index');
    writeFileSync(file, JSON.stringify(nav, null, 2));
    expect(gate(run.gates(), 'navigation-exact').status).toBe('fail');
  });
});
