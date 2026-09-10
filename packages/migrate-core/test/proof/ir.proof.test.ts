/**
 * Serialiser round-trip proof over the saved demo site: the resolved IR of a
 * published .md page must survive docToMdx and a re-parse of the target MDX
 * unchanged. This is the comparison the serialized-output-exact gate makes, so
 * exact mode can only hold when these pages round-trip.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTruth, resolveSourceTruthDir, type SourceTruthPage } from '../helpers/source-truth.js';
import { unwrapPublishedMarkdown } from '../../src/scrape/published-markdown.js';
import { markdownToIr } from '../../src/ir/from-markdown.js';
import { docToMdx } from '../../src/ir/to-dai-mdx.js';
import { RulesEngine, loadMappings } from '../../src/components/rules-engine.js';
import { Ledger } from '../../src/ledger/dispositions.js';
import { DecisionLog } from '../../src/log/decisions.js';
import { renderedDocSnapshot } from '../../src/verify/fidelity.js';
import { walkBlocks, type Block, type CodeNode, type DaiComponentNode, type DocIR, type Frontmatter, type ImageNode } from '../../src/ir/types.js';
import { ensureWorkspace } from '../../src/session/workspace.js';

const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const mintlifyMappings = [join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml')];

interface RoundTrip { resolved: DocIR; mdx: string; reparsed: DocIR }

function publishedMarkdownFile(page: SourceTruthPage): string {
  return `${page.path === '/' ? 'index' : page.path.slice(1)}.md`;
}

/** The convert pipeline for one page: unwrap the published .md, parse, resolve components, serialise, re-parse the target MDX as the gate does. */
function roundTrip(page: SourceTruthPage): RoundTrip {
  const file = publishedMarkdownFile(page);
  const published = unwrapPublishedMarkdown(readFileSync(join(dir, 'md', file), 'utf8'), 'mintlify', { expectedDescription: page.llmsTxt.description ?? undefined });
  const frontmatter: Partial<Frontmatter> = { title: published.title };
  if (published.description !== undefined) frontmatter.description = published.description;
  const workspace = mkdtempSync(join(tmpdir(), 'dai-proof-ir-'));
  ensureWorkspace(workspace);
  const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings(mintlifyMappings), ledger: new Ledger(workspace), log: new DecisionLog(workspace) });
  const resolved = engine.resolveDoc(markdownToIr(published.body, { platform: 'mintlify', file, pageId: page.path, frontmatter }));
  const mdx = docToMdx(resolved);
  return { resolved, mdx, reparsed: markdownToIr(mdx, { platform: 'dai', file: file.replace(/\.md$/, '.mdx'), pageId: page.path }) };
}

function blocksOf<T extends Block>(doc: DocIR, pick: (block: Block) => block is T): T[] {
  const out: T[] = [];
  walkBlocks(doc.children, (block) => { if (pick(block)) out.push(block); });
  return out;
}

const isImage = (block: Block): block is ImageNode => block.type === 'image';
const isCode = (block: Block): block is CodeNode => block.type === 'code';
const isDai = (name: string) => (block: Block): block is DaiComponentNode => block.type === 'dai' && block.name === name;

describe('published .md → resolved IR → target MDX → re-parsed IR', () => {
  it('round-trips the home page exactly, keeping its one image with width and height and every Card href', () => {
    const page = truth.pageByPath('/');
    const { resolved, reparsed } = roundTrip(page);
    expect(renderedDocSnapshot(reparsed)).toEqual(renderedDocSnapshot(resolved));
    expect(reparsed.frontmatter).toEqual({ title: page.title, description: page.description });
    expect(blocksOf(reparsed, isImage).map(({ url, alt, width, height }) => ({ url, alt, width, height })))
      .toEqual(page.images.map((image) => ({ url: image.src, alt: image.alt, width: Number(image.width), height: Number(image.height) })));
    expect(blocksOf(reparsed, isDai('Card')).map((card) => card.props.href ?? null)).toEqual(page.componentDetail.Card.map((card) => card.href ?? null));
    expect(blocksOf(reparsed, isDai('Columns')).map((columns) => columns.props.cols)).toEqual(page.componentDetail.CardGroup.map((group) => Number(group.cols)));
    expect(blocksOf(reparsed, isDai('Callout'))).toHaveLength(page.components.Tip);
  });

  it('round-trips the quickstart exactly, keeping its bash fences with their theme meta and every Step title', () => {
    const page = truth.pageByPath('/quickstart');
    const { resolved, reparsed } = roundTrip(page);
    expect(renderedDocSnapshot(reparsed)).toEqual(renderedDocSnapshot(resolved));
    expect(reparsed.frontmatter).toEqual({ title: page.title, description: page.description });
    const codes = blocksOf(reparsed, isCode);
    expect(codes.map((code) => code.lang)).toEqual(page.codeBlocks.map((code) => code.language));
    expect(codes.map((code) => `${code.lang} ${code.meta}`)).toEqual(page.codeBlocks.map((code) => code.meta));
    expect(codes.map((code) => code.value.split('\n').length)).toEqual(page.codeBlocks.map((code) => code.lines));
    expect(blocksOf(reparsed, isDai('Step')).map((step) => step.props.title)).toEqual(page.componentDetail.Step.map((step) => step.title));
  });
});
