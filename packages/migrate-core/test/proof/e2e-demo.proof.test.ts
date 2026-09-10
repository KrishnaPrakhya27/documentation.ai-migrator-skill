/**
 * End-to-end exactness proof.
 *
 * The whole pipeline is run offline over the saved source and every assertion is
 * tied to truth.json: the page set, the metadata, the navigation with its
 * duplicate placement, the component semantics, the media, and the source's own
 * authoring defects, which an exact migration preserves rather than repairs.
 * Numbers here are the source's, never the migrator's own output read back.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadTruth, resolveSourceTruthDir, isNavigationGroup, type SourceTruthPage } from '../helpers/source-truth.js';
import { FIXTURE_SITE_ORIGIN, fixtureFetcher, offlineFetcher } from '../helpers/fixture-fetcher.js';
import { runOfflinePipeline, type OfflineRun } from '../helpers/offline-pipeline.js';
import { parseLlmsTxt } from '../../src/scrape/published-markdown.js';
import { CanonicalHosts } from '../../src/scrape/fetcher.js';
import { PROFILES, profileHostAliases } from '../../src/scrape/profiles.js';
import { extractMintlifyNavigation } from '../../src/scrape/discovery.js';
import { pageIdFromPlatform } from '../../src/session/ids.js';
import { ensureWorkspace } from '../../src/session/workspace.js';
import { canonicalHash, runGates, REQUIRED_RELEASE_GATE_IDS, type GateResult } from '../../src/verify/gates.js';
import { walkBlocks, type DaiComponentNode, type DocIR } from '../../src/ir/types.js';
import type { SourceNavigationNode, TreePage } from '../../src/nav/tree.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const mintlify = PROFILES.mintlify;
const llmsByPath = new Map(parseLlmsTxt(readFileSync(join(dir, 'llms.txt'), 'utf8')).map((entry) => [entry.path, entry]));
const indexHtml = readFileSync(join(dir, 'html', 'index.html'), 'utf8');

/** Gates that need a live preview; a local run reports them not-run. */
const PREVIEW_GATES = new Set(['preview-contract-version', 'browser-fragments', 'browser-content']);

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
  const workspace = mkdtempSync(join(tmpdir(), 'dai-e2e-fetch-'));
  ensureWorkspace(workspace);
  return {
    seedUrl: `${FIXTURE_SITE_ORIGIN}/`,
    platform: 'mintlify',
    pages,
    navigation: toSource(extracted),
    navigationSource: 'platform-metadata' as const,
    platformMeta: { name: truth.site.name, colors: truth.site.colors, favicon: truth.site.favicon, logo: truth.site.logo },
    fetcher: offlineFetcher(fixtureFetcher(dir), {
      workspace,
      allowHosts: [new URL(FIXTURE_SITE_ORIGIN).hostname],
      rps: 1000,
      canonicalHosts: new CanonicalHosts(FIXTURE_SITE_ORIGIN, profileHostAliases(mintlify, new URL(FIXTURE_SITE_ORIGIN).hostname)),
    }),
  };
}

const routeOf = (page: SourceTruthPage) => (page.path === '/' ? 'index' : page.path.slice(1));
const listMdx = (root: string, base = root): string[] => readdirSync(root).flatMap((entry) => {
  const full = join(root, entry);
  return statSync(full).isDirectory() ? listMdx(full, base) : entry.endsWith('.mdx') ? [relative(base, full)] : [];
});

function daiComponents(doc: DocIR, name: string): DaiComponentNode[] {
  const out: DaiComponentNode[] = [];
  walkBlocks(doc.children, (block) => { if (block.type === 'dai' && block.name === name) out.push(block); });
  return out;
}

describe('end-to-end migration of the saved source', () => {
  let run: OfflineRun;
  let gates: GateResult[];
  let outputs: Map<string, string>;
  beforeAll(async () => {
    run = await runOfflinePipeline(pipelineInput());
    gates = run.gates();
    outputs = new Map(truth.pages.map((page) => [page.path, readFileSync(join(run.outputDir, `${routeOf(page)}.mdx`), 'utf8')]));
  }, 60_000);

  it('writes one file per source page and nothing else', () => {
    expect(listMdx(run.outputDir).sort()).toEqual(truth.pages.map((page) => `${routeOf(page)}.mdx`).sort());
    expect(listMdx(run.outputDir).length).toBe(truth.pageCount);
  });

  it('passes every required gate that a local run can judge', () => {
    for (const id of REQUIRED_RELEASE_GATE_IDS) {
      const result = gates.find((entry) => entry.id === id);
      expect(result, `gate ${id} was not reported`).toBeDefined();
      const expected = PREVIEW_GATES.has(id) ? 'not-run' : 'pass';
      expect(result!.status, `${id} — ${result!.detail} ${JSON.stringify(result!.samples ?? [])}`).toBe(expected);
    }
  });

  it('carries the exact title and description of every page into frontmatter', () => {
    let described = 0;
    for (const page of truth.pages) {
      const mdx = outputs.get(page.path)!;
      expect(mdx.startsWith('---\n'), page.path).toBe(true);
      const frontmatter = mdx.slice(4, mdx.indexOf('\n---', 4));
      expect(frontmatter, `title of ${page.path}`).toContain(page.title);
      if (page.description) { described++; expect(frontmatter, `description of ${page.path}`).toContain(page.description); }
      else expect(frontmatter, `${page.path} has no source description`).not.toContain('description:');
    }
    expect(described).toBe(13);
  });

  it('reproduces the site name, groups, order and the page placed in two groups', () => {
    const nav = JSON.parse(readFileSync(join(run.outputDir, 'documentation.json'), 'utf8')) as { name: string; colors: Record<string, string>; navigation: Record<string, NavEntry[]> };
    expect(nav.name).toBe(truth.site.name);
    expect(nav.colors).toEqual(truth.site.colors);
    const top = nav.navigation.groups ?? nav.navigation.pages ?? [];
    expect(top.filter(isGroup).map((entry) => entry.group)).toEqual(truth.navigationHierarchy.filter(isNavigationGroup).map((entry) => entry.group));
    const placements = top.flatMap((entry) => (isGroup(entry) ? entry.pages : [entry]));
    expect(placements.length).toBe(15);
    expect(placements.filter((entry) => !isGroup(entry) && entry.path === 'index').length).toBe(2);
    // Labels are the source's sidebar labels, which differ from the page titles.
    const label = (path: string) => placements.filter((entry): entry is { title: string; path: string } => !isGroup(entry) && entry.path === path).map((entry) => entry.title);
    expect(label('characters/vegeta')).toEqual(['Vegeta CP']);
    expect(label('index')).toEqual(['Home', 'Home']);
    expect(label('quickstart')).toEqual(['Quickstart']);
  });

  it('keeps the component semantics the source states', () => {
    const stepTitles = run.docs.flatMap((doc) => daiComponents(doc, 'Step').map((step) => step.props.title));
    const expectedSteps = truth.pages.flatMap((page) => (page.componentDetail?.Step ?? []).map((step) => step.title));
    expect(stepTitles).toEqual(expectedSteps);
    expect(stepTitles.length).toBe(28);

    const home = run.docs.find((doc) => doc.pageId === pageIdFromPlatform('mintlify', truth.pages.find((page) => page.path === '/')!.htmlUrl))!;
    const cardHrefs = daiComponents(home, 'Card').map((card) => card.props.href).filter((href): href is string => typeof href === 'string');
    expect(cardHrefs).toEqual((truth.pages.find((page) => page.path === '/')!.componentDetail?.Card ?? []).map((card) => card.href).filter(Boolean));
    expect(cardHrefs.length).toBe(8);
    // The source's own empty card carries no link and is preserved rather than repaired.
    expect(daiComponents(home, 'Card').length).toBe(9);
  });

  it('keeps every code fence with its language and body', () => {
    const quickstart = truth.pages.find((page) => page.path === '/quickstart')!;
    // The fences sit inside <Step> components, so they are indented in the output.
    const fences = [...outputs.get('/quickstart')!.matchAll(/^[ \t]*```(\w+)/gm)].map((match) => match[1]);
    expect(fences).toEqual(quickstart.codeBlocks.map((block) => block.language));
    expect(fences).toEqual(['bash', 'bash', 'bash']);
  });

  it('keeps the one image with its alt text and dimensions', () => {
    const image = truth.pages.find((page) => page.path === '/')!.images[0];
    const mdx = outputs.get('/')!;
    expect(mdx).toContain(`alt="${image.alt}"`);
    expect(mdx).toContain(`width={${image.width}}`);
    expect(mdx).toContain(`height={${image.height}}`);
    const images = truth.pages.reduce((n, page) => n + page.images.length, 0);
    expect(images).toBe(1);
  });

  it('preserves the source’s own authoring defects instead of repairing them', () => {
    // A corrupted word, a duplicated block and a stray line: all authored, all kept verbatim.
    expect(outputs.get('/')!).toContain('serieselcome');
    expect(outputs.get('/characters/goku')!).toContain('缺失的眉毛');
    expect(outputs.get('/movies/best-movies')!).toContain('act.Still');
    // A page whose only content is the H1 that states its title: the title carries it and the body is empty,
    // which is what the source itself renders. Nothing is invented to fill it.
    const untitled = outputs.get('/untitled-page')!;
    expect(untitled).toContain('title: Untitled page');
    expect(untitled.slice(untitled.indexOf('\n---', 4) + 4).trim()).toBe('');
    expect(truth.pages.find((page) => page.path === '/untitled-page')!.counts.paragraphs).toBe(0);
  });

  it('lets no platform chrome into any file', () => {
    const chrome = truth.chromeStrings();
    expect(chrome.length).toBeGreaterThan(5);
    for (const [path, mdx] of outputs) {
      for (const string of chrome) expect(mdx.includes(string), `${path} contains ${JSON.stringify(string)}`).toBe(false);
    }
  });

  it('produces byte-identical output when the same source is converted again', async () => {
    const first = canonicalHash(run.outputDir);
    const again = await runOfflinePipeline(pipelineInput());
    expect(canonicalHash(again.outputDir)).toBe(first);
    expect(again.gates().find((gate) => gate.id === 'deterministic-rerun')!.status).toBe('pass');
  }, 60_000);

  it('records which migrator build produced the output', () => {
    const input = run.gateInput();
    expect(input.pinnedMigrator!.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(gates.find((gate) => gate.id === 'migrator-pinned')!.status).toBe('pass');
    // A different build must not be able to certify this output.
    const drifted = { ...input, currentMigrator: { ...input.currentMigrator!, gitSha: 'f'.repeat(40) } };
    expect(runGates(drifted).find((gate) => gate.id === 'migrator-pinned')!.status).toBe('fail');
  });
});

type NavEntry = { group: string; pages: NavEntry[] } | { title: string; path: string };
const isGroup = (entry: NavEntry): entry is { group: string; pages: NavEntry[] } => 'group' in entry;
