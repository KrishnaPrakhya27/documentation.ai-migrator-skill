/**
 * Convert-side exactness proof over the saved demo site: every published .md
 * page, parsed and resolved through the same mapping set the convert stage
 * loads, must carry exactly the authored content (the comparison the
 * conversion-fidelity gate makes) with the component semantics truth.json
 * records, and no quarantine, exclusion or unexplained loss in the ledger.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTruth, resolveSourceTruthDir, type SourceTruthPage } from '../helpers/source-truth.js';
import { unwrapPublishedMarkdown } from '../../src/scrape/published-markdown.js';
import { markdownToIr } from '../../src/ir/from-markdown.js';
import { htmlToIr } from '../../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../../src/scrape/profiles.js';
import { RulesEngine, loadMappings } from '../../src/components/rules-engine.js';
import { Ledger, type Disposition } from '../../src/ledger/dispositions.js';
import { DecisionLog } from '../../src/log/decisions.js';
import { authoredContentSnapshot, firstFidelityDifference } from '../../src/verify/fidelity.js';
import { walkBlocks, type Block, type ComponentNode, type DaiComponentNode, type DocIR, type Frontmatter } from '../../src/ir/types.js';
import { ensureWorkspace } from '../../src/session/workspace.js';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** The mapping set the convert stage loads for a Mintlify site: the platform table, then the generic table. */
const mappingFiles = ['skills/migrate-mintlify/mappings/mintlify.yaml', 'skills/migrate-generic/mappings/generic.yaml'].map((relative) => join(repoRoot, relative));

interface Conversion { source: DocIR; resolved: DocIR; dispositions: Disposition[] }

function publishedMarkdownFile(page: SourceTruthPage): string {
  return `${page.path === '/' ? 'index' : page.path.slice(1)}.md`;
}

/** The convert stage for one page: unwrap the published .md, parse, resolve every component, and keep the ledger it wrote. */
function convertPage(page: SourceTruthPage): Conversion {
  const file = publishedMarkdownFile(page);
  const published = unwrapPublishedMarkdown(readFileSync(join(dir, 'md', file), 'utf8'), 'mintlify', { expectedDescription: page.llmsTxt.description ?? undefined });
  const frontmatter: Partial<Frontmatter> = { title: published.title };
  if (published.description !== undefined) frontmatter.description = published.description;
  const workspace = mkdtempSync(join(tmpdir(), 'dai-proof-convert-'));
  ensureWorkspace(workspace);
  const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings(mappingFiles), ledger: new Ledger(workspace), log: new DecisionLog(workspace) });
  const source = markdownToIr(published.body, { platform: 'mintlify', file, pageId: page.path, frontmatter });
  return { source, resolved: engine.resolveDoc(source), dispositions: Ledger.read(workspace) };
}

function daiBlocks(doc: DocIR, name: string): DaiComponentNode[] {
  const out: DaiComponentNode[] = [];
  walkBlocks(doc.children, (block) => { if (block.type === 'dai' && block.name === name) out.push(block); });
  return out;
}

function sourceComponents(blocks: Block[], name: string): ComponentNode[] {
  const out: ComponentNode[] = [];
  walkBlocks(blocks, (block) => { if (block.type === 'component' && block.name === name) out.push(block); });
  return out;
}

function quarantinedBlocks(doc: DocIR): number {
  let count = 0;
  walkBlocks(doc.children, (block) => { if (block.type === 'quarantined') count++; });
  return count;
}

/** Column counts the source site renders, read from the --cols style variable of the raw HTML through the Mintlify profile. */
function renderedColumnCounts(page: SourceTruthPage): Array<string | number | boolean | null> {
  const file = join(dir, 'html', page.path === '/' ? 'index.html' : `${page.path.slice(1)}.html`);
  const rendered = htmlToIr(readFileSync(file, 'utf8'), htmlAdapterOptions(PROFILES.mintlify, { platform: 'mintlify', file }));
  return sourceComponents(rendered.children, 'CardGroup').map((group) => group.props.cols);
}

const authoredOrNull = (value: string | number | boolean | null | undefined): string | number | boolean | null => value ?? null;

describe('published .md → resolved IR keeps the authored content of every page', () => {
  const conversions = new Map(truth.pages.map((page): [string, Conversion] => [page.path, convertPage(page)]));

  for (const page of truth.pages) {
    it(`${page.path}: resolves without loss and with the recorded component semantics`, () => {
      const { source, resolved, dispositions } = conversions.get(page.path)!;
      expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(resolved)) ?? 'exact').toBe('exact');
      expect(quarantinedBlocks(resolved)).toBe(0);
      expect(resolved.frontmatter.title).toBe(page.title);
      expect(resolved.frontmatter.description).toBe(page.description ?? undefined);
      expect(daiBlocks(resolved, 'Step').map((step) => step.props.title)).toEqual((page.componentDetail.Step ?? []).map((step) => step.title));
      expect(daiBlocks(resolved, 'Card').map((card) => [authoredOrNull(card.props.title), authoredOrNull(card.props.href)]))
        .toEqual((page.componentDetail.Card ?? []).map((card) => [card.title ?? null, card.href ?? null]));
      expect(daiBlocks(resolved, 'Expandable').map((expandable) => expandable.props.title)).toEqual((page.componentDetail.Accordion ?? []).map((accordion) => accordion.title));
      // truth.json lists the groups that author a cols prop; every group, authored or not, must render the source's own column count
      const authoredCols = sourceComponents(source.children, 'CardGroup').map((group) => group.props.cols);
      const resolvedCols = daiBlocks(resolved, 'Columns').map((columns) => columns.props.cols);
      expect(resolvedCols.filter((_, index) => authoredCols[index] !== undefined)).toEqual((page.componentDetail.CardGroup ?? []).map((group) => Number(group.cols)));
      expect(resolvedCols).toEqual(renderedColumnCounts(page));
      expect(daiBlocks(resolved, 'Callout')).toHaveLength((page.components.Tip ?? 0) + (page.components.Note ?? 0) + (page.components.Warning ?? 0));
      expect(daiBlocks(resolved, 'Video').map((video) => [video.props.src, video.props.controls])).toEqual(page.videos.map((video) => [video.src, video.controls]));
      expect(dispositions.filter((disposition) => disposition.kind === 'excluded' || disposition.kind === 'quarantined')).toEqual([]);
    });
  }

  it('adds up to 28 Step titles and 8 Card hrefs on the home page, with only decoration or asset metadata in the lossy ledger', () => {
    const all = [...conversions.values()];
    expect(all.flatMap(({ resolved }) => daiBlocks(resolved, 'Step'))).toHaveLength(28);
    expect(daiBlocks(conversions.get('/')!.resolved, 'Card').filter((card) => typeof card.props.href === 'string')).toHaveLength(8);
    const lossy = new Set(all.flatMap(({ dispositions }) => dispositions.flatMap((disposition) => (disposition.kind === 'transformed' ? disposition.lossy : []))));
    expect([...lossy].sort()).toEqual(['data-path dropped', 'type dropped (no mapping in mint/card)']);
  });
});
