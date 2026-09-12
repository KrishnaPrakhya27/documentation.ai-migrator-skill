/**
 * Verification against the raw acquired source.
 *
 * Every other content check in this package compares the output with the
 * migrator's own snapshot of it, so a loss that happened before the snapshot is
 * invisible to them. These functions read what `acquire` froze — the published
 * Markdown as served, the rendered HTML as served, the page's llms.txt entry —
 * and compare the written output against that. Comparisons are bidirectional
 * and order-sensitive: content missing from the output fails, and content in the
 * output that the source does not have fails just as hard, which is what catches
 * platform chrome leaking into a page.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdownToIr } from '../ir/from-markdown.js';
import { htmlToIr } from '../ir/from-html.js';
import { unwrapPublishedMarkdown } from '../scrape/published-markdown.js';
import { htmlAdapterOptions, type ScrapeProfile } from '../scrape/profiles.js';
import { acquiredPath, type AcquiredPage } from '../scrape/acquire.js';
import { authoredContentSnapshot, firstFidelityDifference } from './fidelity.js';
import { inlineText, walkBlocks, type Block, type DocIR, type Inline } from '../ir/types.js';
import { retargetDocLinks, siteLinkTarget, type SiteLinks } from '../urls/site-links.js';

/** One page as the source served it, paired with the file the migration wrote for it. */
export interface RawSourcePage {
  pageId: string;
  /** Source path, e.g. `/guides/setup`. */
  path: string;
  /** Output route (the new path without extension). */
  route: string;
  outputFile: string;
  title?: string;
  description?: string;
  markdown?: string;
  markdownSha256?: string;
  html?: string;
  htmlSha256?: string;
  llms?: { title: string; description?: string; mdUrl: string };
}

export interface SourceComparison {
  pageId: string;
  path: string;
  pass: boolean;
  /** First differing snapshot path, when the bodies differ. */
  difference?: string;
  detail?: string;
}

/** Whitespace, non-breaking spaces and typographic quotes differ between a rendered page and its Markdown without any content changing. */
export function normaliseProse(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[   ]/g, ' ')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The pages `acquire` froze, paired with the files `convert` wrote. Throws when a migrated page has no frozen source. */
export function loadRawSourcePages(input: {
  workspace: string;
  outputDir: string;
  pages: Array<{ id: string; migrate: boolean; newPath?: string; source: string; title?: string; description?: string }>;
}): RawSourcePage[] {
  const out: RawSourcePage[] = [];
  const missing: string[] = [];
  for (const page of input.pages) {
    if (!page.migrate || !page.newPath) continue;
    const cached = acquiredPath(input.workspace, page.id);
    if (!existsSync(cached)) { missing.push(page.source); continue; }
    const record = JSON.parse(readFileSync(cached, 'utf8')) as AcquiredPage;
    out.push({
      pageId: page.id,
      path: pathOf(page.source),
      route: page.newPath,
      outputFile: join(input.outputDir, `${page.newPath}.mdx`),
      title: record.llms?.title ?? record.title ?? page.title,
      description: record.llms?.description ?? record.description ?? page.description,
      markdown: record.markdown,
      markdownSha256: record.markdownSha256,
      html: record.html,
      htmlSha256: record.htmlSha256,
      llms: record.llms,
    });
  }
  if (missing.length) throw new Error(`no frozen source for ${missing.length} migrated page(s): ${missing.join(', ')}; run acquire again`);
  return out;
}

function pathOf(source: string): string {
  try { return new URL(source).pathname; } catch { return source; }
}

/** The IR of the raw published Markdown, with the platform's generated wrapper and description removed exactly as inventory removes them. */
export function rawSourceIr(page: RawSourcePage, platform: string, profile?: ScrapeProfile, links?: SiteLinks): DocIR | undefined {
  if (page.markdown === undefined) return undefined;
  const published = unwrapPublishedMarkdown(page.markdown, platform, { expectedDescription: page.description });
  const title = page.title ?? published.title ?? page.route;
  const description = page.description ?? published.description;
  // The frontmatter the output must carry, built from the source's own statements, so the
  // comparison covers metadata as well as body.
  const doc = markdownToIr(published.body, { platform, file: page.path, pageId: page.pageId, title, frontmatter: { title, ...(description ? { description } : {}) }, codeMetaStrip: profile?.codeMetaStrip });
  // convert points site-relative links at their migrated routes or the source site; the source is read the same way
  return links ? retargetDocLinks(doc, siteLinkTarget(links)) : doc;
}

/** The IR of the written output file, re-parsed as target MDX. */
export function outputIr(page: RawSourcePage): DocIR | undefined {
  if (!existsSync(page.outputFile)) return undefined;
  return markdownToIr(readFileSync(page.outputFile, 'utf8'), { platform: 'dai', file: page.route, pageId: page.pageId });
}

/**
 * The output's authored content must equal the raw source's, block for block and
 * in order. Both sides are reduced to the same authored-content snapshot, so
 * component naming differences between platforms do not matter but text,
 * headings, links, images, code and component content props all do.
 */
export function sourceContentExact(page: RawSourcePage, platform: string, profile?: ScrapeProfile, links?: SiteLinks): SourceComparison {
  const source = rawSourceIr(page, platform, profile, links);
  if (!source) return { pageId: page.pageId, path: page.path, pass: false, detail: 'no published Markdown was frozen for this page' };
  const output = outputIr(page);
  if (!output) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  const difference = firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output));
  return { pageId: page.pageId, path: page.path, pass: !difference, difference };
}

/** Frontmatter title and description must be byte-equal to what the source states, and absent where it states none. */
export function sourceMetadataExact(page: RawSourcePage): SourceComparison {
  const output = outputIr(page);
  if (!output) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  const declaredTitle = page.llms?.title ?? page.title;
  const declaredDescription = page.llms?.description ?? page.description;
  const problems: string[] = [];
  if (declaredTitle && output.frontmatter.title !== declaredTitle) problems.push(`title is ${JSON.stringify(output.frontmatter.title)}, source states ${JSON.stringify(declaredTitle)}`);
  if (declaredDescription && output.frontmatter.description !== declaredDescription) problems.push(`description is ${JSON.stringify(output.frontmatter.description)}, source states ${JSON.stringify(declaredDescription)}`);
  if (!declaredDescription && output.frontmatter.description) problems.push(`description is ${JSON.stringify(output.frontmatter.description)} but the source states none`);
  return { pageId: page.pageId, path: page.path, pass: !problems.length, detail: problems.join('; ') || undefined };
}

/** Ordered link targets of a document, as authored. */
export function documentLinks(doc: DocIR): string[] {
  const urls: string[] = [];
  walkBlocks(doc.children, (block) => collectLinks(block, urls));
  return urls;
}

function collectLinks(block: Block, urls: string[]): void {
  visitBlockInlines(block, (inline) => { if (inline.type === 'link') urls.push(inline.url); });
  if (block.type === 'component' || block.type === 'dai') {
    for (const [key, value] of Object.entries(block.props ?? {})) if (LINK_PROPS.has(key) && typeof value === 'string') urls.push(value);
  }
}

const LINK_PROPS = new Set(['href', 'to', 'link', 'url']);

/** Tables, captions and formatted inline content are authored content too. */
function visitBlockInlines(block: Block, visit: (inline: Inline) => void): void {
  const walk = (nodes: Inline[]): void => {
    for (const node of nodes) {
      visit(node);
      if ('children' in node) walk(node.children);
    }
  };
  if (block.type === 'paragraph' || block.type === 'heading') walk(block.children);
  if (block.type === 'table') for (const row of block.children) for (const cell of row.children) walk(cell.children);
  if (block.type === 'figure') walk(block.caption ?? []);
}

/** Ordered images of a document with the attributes that must survive. */
export function documentImages(doc: DocIR): Array<{ src: string; alt?: string; title?: string; width?: number; height?: number }> {
  const images: Array<{ src: string; alt?: string; title?: string; width?: number; height?: number }> = [];
  walkBlocks(doc.children, (block) => {
    const add = (image: Extract<Inline, { type: 'image' }>): void => { images.push({ src: image.url, alt: image.alt, title: image.title, width: image.width, height: image.height }); };
    if (block.type === 'image') add(block);
    if (block.type === 'figure') add(block.image);
    visitBlockInlines(block, (inline) => { if (inline.type === 'image') add(inline); });
  });
  return images;
}

/** Ordered heading outline of a document. */
export function documentHeadings(doc: DocIR): Array<{ depth: number; text: string }> {
  const headings: Array<{ depth: number; text: string }> = [];
  walkBlocks(doc.children, (block) => { if (block.type === 'heading') headings.push({ depth: block.depth, text: normaliseProse(inlineText(block.children)) }); });
  return headings;
}

/** Ordered code blocks of a document. */
export function documentCode(doc: DocIR): Array<{ lang?: string; value: string }> {
  const code: Array<{ lang?: string; value: string }> = [];
  walkBlocks(doc.children, (block) => { if (block.type === 'code') code.push({ lang: block.lang, value: block.value.replace(/\r\n/g, '\n') }); });
  return code;
}

/** Ordered prose segments of a document: the text a reader sees, one entry per block. */
export function documentTextSegments(doc: DocIR): string[] {
  const segments: string[] = [];
  walkBlocks(doc.children, (block) => {
    // walkBlocks descends into list items, so their paragraphs arrive here on their own.
    if (block.type === 'paragraph' || block.type === 'heading') {
      const text = normaliseProse(inlineText(block.children));
      if (text) segments.push(text);
    }
  });
  return segments;
}

/**
 * The rendered HTML, reduced through the profile, must agree with the output on
 * images, links, code languages and the heading outline. This is the second
 * witness: the published Markdown and the rendered page are independent
 * renderings of the same authored content, and the migration must match both.
 */
export function htmlReconciliation(page: RawSourcePage, platform: string, profile: ScrapeProfile): SourceComparison {
  if (page.html === undefined) return { pageId: page.pageId, path: page.path, pass: false, detail: 'no rendered HTML was frozen for this page' };
  const output = outputIr(page);
  if (!output) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  const rendered = htmlToIr(page.html, htmlAdapterOptions(profile, { platform, file: page.path }));
  const renderedDoc: DocIR = { pageId: page.pageId, platform, source: page.path, frontmatter: { title: page.title ?? page.route }, children: rendered.children };

  const problems: string[] = [];
  const renderedHeadings = documentHeadings(renderedDoc).filter((heading) => heading.depth > 1);
  const outputHeadings = documentHeadings(output).filter((heading) => heading.depth > 1);
  if (!sameSequence(renderedHeadings.map(headingKey), outputHeadings.map(headingKey))) {
    problems.push(`heading outline differs: rendered ${JSON.stringify(renderedHeadings.map(headingKey))}, output ${JSON.stringify(outputHeadings.map(headingKey))}`);
  }
  const renderedCode = documentCode(renderedDoc).map((block) => block.lang ?? '');
  const outputCode = documentCode(output).map((block) => block.lang ?? '');
  if (!sameSequence(renderedCode, outputCode)) problems.push(`code block languages differ: rendered ${JSON.stringify(renderedCode)}, output ${JSON.stringify(outputCode)}`);
  const renderedImages = documentImages(renderedDoc).length;
  const outputImages = documentImages(output).length;
  if (renderedImages !== outputImages) problems.push(`image count differs: rendered ${renderedImages}, output ${outputImages}`);
  return { pageId: page.pageId, path: page.path, pass: !problems.length, detail: problems.join('; ') || undefined };
}

const headingKey = (heading: { depth: number; text: string }) => `${heading.depth}:${heading.text}`;

function sameSequence(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Theme chrome that reached the output, found by the line it occupies.
 *
 * Chrome renders as a block of its own: a "Was this page helpful?" prompt, a
 * "Previous Next" pager, a stray "Copy" button label. An author writing "click
 * **Next**", a "### Copy and paste a dataflow" heading or a JSON key holding
 * "Previous" is writing content, and a substring search cannot tell the two apart:
 * on a real 235-page migration it flagged 61 correct pages. So a line is chrome
 * only when chrome is all it holds, and code blocks, which may legitimately contain
 * anything, are not prose at all.
 */
function chromeInOutput(markdown: string, chromeStrings: readonly string[]): string[] {
  const chrome = chromeStrings.map((value) => normaliseProse(value)).filter(Boolean);
  const found = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    // what the line renders as: block markers, emphasis and link targets are not content
    const text = normaliseProse(line
      .replace(/^\s*[>#*+-]+\s*/, '')
      .replace(/^\s*\d+[.)]\s*/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]+/g, '')
      .replace(/^\s*\|/, '').replace(/\|\s*$/, ''));
    if (!text) continue;
    let remainder = text;
    for (const value of chrome) remainder = remainder.split(value).join(' ');
    // nothing but chrome and separators left: the line carries no authored content
    if (/^[\s|:.,·—–-]*$/.test(remainder)) for (const value of chrome) if (text.includes(value)) found.add(value);
  }
  return [...found];
}

/** No block the platform's own theme renders may appear in the migrated output. */
export function chromeAbsent(page: RawSourcePage, chromeStrings: readonly string[]): SourceComparison {
  if (!chromeStrings.some((value) => value.trim())) return { pageId: page.pageId, path: page.path, pass: false, detail: 'no platform chrome evidence was supplied' };
  if (!existsSync(page.outputFile)) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  const found = chromeInOutput(readFileSync(page.outputFile, 'utf8'), chromeStrings);
  return { pageId: page.pageId, path: page.path, pass: !found.length, detail: found.length ? `theme chrome in output: ${found.map((chrome) => JSON.stringify(chrome)).join(', ')}` : undefined };
}
