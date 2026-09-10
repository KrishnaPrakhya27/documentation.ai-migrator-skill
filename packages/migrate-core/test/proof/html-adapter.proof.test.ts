import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTruth, resolveSourceTruthDir } from '../helpers/source-truth.js';
import { htmlToIr, parseHtml, find, findAll, type Dom } from '../../src/ir/from-html.js';
import { PROFILES, htmlAdapterOptions } from '../../src/scrape/profiles.js';
import { walkBlocks, inlineText, type Block, type CodeNode, type ComponentNode, type HeadingNode, type Inline } from '../../src/ir/types.js';

/**
 * The rendered-HTML side of the reconciliation: htmlToIr over the raw source HTML
 * with the Mintlify profile must reproduce the structure truth.json records for
 * the published .md (paragraph boundaries, Step titles, code languages, Card
 * titles and CardGroup cols) with none of the theme chrome.
 */
const dir = resolveSourceTruthDir();
const truth = loadTruth(dir);
const mintlify = PROFILES.mintlify;

const htmlFile = (path: string): string => join(dir, 'html', path === '/' ? 'index.html' : `${path.slice(1)}.html`);
const rawHtml = (path: string): string => readFileSync(htmlFile(path), 'utf8');
const irOf = (path: string) => htmlToIr(rawHtml(path), htmlAdapterOptions(mintlify, { platform: 'mintlify', file: htmlFile(path) }));

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** Text as a reader sees it: line breaks count as whitespace, everything else concatenates. */
const renderedText = (node: Dom): string => (node.type === 'text' ? node.data : node.name === 'br' ? '\n' : node.children.map(renderedText).join(''));
const contentArea = (path: string) => find(parseHtml(rawHtml(path)), '#content-area')!;

/** Paragraph texts in document order, the way truth.json counts them (list items are not paragraphs). */
const paragraphTexts = (blocks: Block[]): string[] => {
  const out: string[] = [];
  walkBlocks(blocks, (b, _depth, parent) => { if (b.type === 'paragraph' && parent?.type !== 'listItem') out.push(normalise(inlineText(b.children))); });
  return out;
};
const componentsNamed = (blocks: Block[], name: string): ComponentNode[] => {
  const out: ComponentNode[] = [];
  walkBlocks(blocks, (b) => { if (b.type === 'component' && b.name === name) out.push(b); });
  return out;
};
const componentCounts = (blocks: Block[]): Record<string, number> => {
  const out: Record<string, number> = {};
  walkBlocks(blocks, (b) => { if (b.type === 'component') out[b.name] = (out[b.name] ?? 0) + 1; });
  return out;
};
const codeBlocks = (blocks: Block[]): CodeNode[] => {
  const out: CodeNode[] = [];
  walkBlocks(blocks, (b) => { if (b.type === 'code') out.push(b); });
  return out;
};
const headings = (blocks: Block[]): HeadingNode[] => {
  const out: HeadingNode[] = [];
  walkBlocks(blocks, (b) => { if (b.type === 'heading') out.push(b); });
  return out;
};
const textNodes = (blocks: Block[]): string[] => {
  const out: string[] = [];
  const visitInline = (nodes: Inline[]) => { for (const n of nodes) { if (n.type === 'text') out.push(n.value); else if ('children' in n) visitInline(n.children); } };
  walkBlocks(blocks, (b) => { if (b.type === 'paragraph' || b.type === 'heading') visitInline(b.children); });
  return out;
};
const irText = (blocks: Block[]): string => {
  const parts: string[] = [];
  walkBlocks(blocks, (b) => {
    if (b.type === 'paragraph' || b.type === 'heading') parts.push(inlineText(b.children));
    if (b.type === 'code') parts.push(b.value);
    if (b.type === 'component') for (const v of Object.values(b.props)) if (typeof v === 'string') parts.push(v);
    if (b.type === 'table') for (const row of b.children) for (const cell of row.children) parts.push(inlineText(cell.children));
  });
  return parts.join('\n');
};
const listItemCount = (blocks: Block[]): number => {
  let count = 0;
  walkBlocks(blocks, (b) => { if (b.type === 'list') count += b.children.length; });
  return count;
};

describe('Mintlify rendered HTML → IR (proof against the source truth)', () => {
  it('splits span[data-as="p"] paragraphs exactly as the source does, with no glued or merged text', () => {
    const path = '/characters/villains';
    const page = truth.pageByPath(path);
    const ir = irOf(path);
    const paragraphs = paragraphTexts(ir.children);
    expect(paragraphs).toHaveLength(page.counts.paragraphs);
    const renderedParagraphs = findAll(contentArea(path), 'span[data-as="p"]').map((span) => normalise(renderedText(span)));
    expect(paragraphs).toEqual(renderedParagraphs);
    // every bold label opens its own paragraph; a glued "…measured.**Motivation:**" would lose one
    let openingWithStrong = 0;
    walkBlocks(ir.children, (b) => { if (b.type === 'paragraph' && b.children[0]?.type === 'strong') openingWithStrong++; });
    expect(openingWithStrong).toBe(page.counts.boldSpans);
    expect(headings(ir.children).map((h) => [h.depth, inlineText(h.children)])).toEqual(page.headingList.filter((h) => h.level > 1).map((h) => [h.level, h.text]));
  });

  it('recovers fence languages and Step titles on the quickstart, with no step-number digits as text', () => {
    const path = '/quickstart';
    const page = truth.pageByPath(path);
    const ir = irOf(path);
    const codes = codeBlocks(ir.children);
    expect(codes.map((c) => c.lang)).toEqual(page.codeBlocks.map((c) => c.language));
    expect(codes.map((c) => c.lang)).toEqual(['bash', 'bash', 'bash']);
    for (const code of codes) expect(code.value).toMatch(/^\S[\s\S]*\S$|^\S$/);
    expect(componentsNamed(ir.children, 'Steps')).toHaveLength(page.components.Steps);
    const steps = componentsNamed(ir.children, 'Step');
    expect(steps.map((s) => s.props.title)).toEqual(page.componentDetail.Step.map((s) => s.title));
    expect(steps.map((s) => s.props.title)).toEqual(['Install', 'Configure', 'Run it']);
    expect(textNodes(ir.children).filter((t) => /^\s*\d+\s*$/.test(t))).toEqual([]);
    for (const step of steps) expect(step.children.map((b) => b.type)).toEqual(['paragraph', 'code']);
    expect(paragraphTexts(ir.children)).toHaveLength(page.counts.paragraphs);
    expect(listItemCount(ir.children)).toBe(page.counts.listItems);
    expect(ir.links).toEqual(page.links.map((l) => l.href));
  });

  it('lifts Card titles out of the card children and reads CardGroup cols from the style variable on the home page', () => {
    const path = '/';
    const page = truth.pageByPath(path);
    const ir = irOf(path);
    const cards = componentsNamed(ir.children, 'Card');
    expect(cards).toHaveLength(page.components.Card);
    const authoredCards = page.componentDetail.Card;
    expect(cards.map((c) => c.props.title)).toEqual(authoredCards.map((c) => c.title ?? null));
    for (const card of cards) walkBlocks(card.children, (b) => { expect(b.type).not.toBe('heading'); });
    expect(cards[cards.length - 1].children).toEqual([]);
    const groups = componentsNamed(ir.children, 'CardGroup');
    expect(groups.map((g) => g.props.cols)).toEqual(page.componentDetail.CardGroup.map((g) => Number(g.cols)));
    expect(groups.map((g) => componentsNamed(g.children, 'Card').length)).toEqual([4, 4]);
    expect(headings(ir.children).filter((h) => h.depth === 2)).toHaveLength(page.headings.h2 ?? 0);
    expect(ir.images.map((i) => [i.url, i.alt, i.width, i.height])).toEqual(page.images.map((i) => [i.src, i.alt, Number(i.width), Number(i.height)]));
    expect(ir.links).toEqual(page.links.map((l) => l.href));
    expect(paragraphTexts(ir.children)).toHaveLength(page.counts.paragraphs);
  });

  it('reproduces paragraph, heading, list and component counts on every page', () => {
    for (const page of truth.pages) {
      const ir = irOf(page.path);
      const paragraphs = paragraphTexts(ir.children);
      expect([page.path, paragraphs.length]).toEqual([page.path, page.counts.paragraphs]);
      expect([page.path, paragraphs]).toEqual([page.path, findAll(contentArea(page.path), 'span[data-as="p"]').map((span) => normalise(renderedText(span)))]);
      expect([page.path, listItemCount(ir.children)]).toEqual([page.path, page.counts.listItems]);
      expect([page.path, headings(ir.children).filter((h) => h.depth === 2).length]).toEqual([page.path, page.headings.h2 ?? 0]);
      const counts = componentCounts(ir.children);
      const callouts = (page.components.Tip ?? 0) + (page.components.Note ?? 0) + (page.components.Warning ?? 0);
      for (const name of ['Steps', 'Step', 'Accordion', 'AccordionGroup', 'CardGroup', 'Card'] as const) expect([page.path, name, counts[name] ?? 0]).toEqual([page.path, name, page.components[name] ?? 0]);
      expect([page.path, counts.Callout ?? 0]).toEqual([page.path, callouts]);
      if (page.componentDetail.Step) expect([page.path, componentsNamed(ir.children, 'Step').map((s) => s.props.title)]).toEqual([page.path, page.componentDetail.Step.map((s) => s.title)]);
      expect([page.path, ir.links]).toEqual([page.path, page.links.map((l) => l.href)]);
    }
  });

  it('carries no theme chrome into the IR of any page although every rendered page contains it', () => {
    const onEveryPage = ['⌘I', 'Ask Assistant', 'Powered by'];
    // the table of contents is only rendered for pages with section headings
    const onPagesWithHeadings = ['On this page'];
    const expectedChrome = [...onEveryPage, ...onPagesWithHeadings];
    for (const chrome of expectedChrome) expect(mintlify.chromeStrings).toContain(chrome);
    for (const chrome of expectedChrome) expect(truth.chromeStrings()).toContain(chrome);
    for (const page of truth.pages) {
      const rendered = renderedText(parseHtml(rawHtml(page.path)));
      const renderedChrome = (page.headings.h2 ?? 0) > 0 ? expectedChrome : onEveryPage;
      for (const chrome of renderedChrome) expect([page.path, chrome, rendered.includes(chrome)]).toEqual([page.path, chrome, true]);
      const text = irText(irOf(page.path).children);
      expect([page.path, mintlify.chromeStrings!.filter((s) => text.includes(s))]).toEqual([page.path, []]);
      expect([page.path, expectedChrome.filter((s) => text.includes(s))]).toEqual([page.path, []]);
    }
  });
});
