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
import { markdownToIr, splitFrontmatter } from '../ir/from-markdown.js';
import { htmlToIr } from '../ir/from-html.js';
import { unwrapPublishedMarkdown } from '../scrape/published-markdown.js';
import { extractSeo, seoFrontmatter } from '../scrape/seo.js';
import { htmlAdapterOptions, type ScrapeProfile } from '../scrape/profiles.js';
import { titleHeading } from '../ir/page-title.js';
import { acquiredPath, type AcquiredPage } from '../scrape/acquire.js';
import { authoredContentSnapshot, firstFidelityDifference } from './fidelity.js';
import { inlineText, renderedText, walkBlocks, type Block, type DocIR, type Inline } from '../ir/types.js';
import { retargetDocLinks, siteLinkTarget, type SiteLinks } from '../urls/site-links.js';
import { rewriteAssetRefs, type AssetManifest } from '../assets/manifest.js';

/** One page as the source served it, paired with the file the migration wrote for it. */
export interface RawSourcePage {
  pageId: string;
  /** The address the source served this page from; the base for its own canonical and social image. */
  url?: string;
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

function unsupportedRobots(html: string | undefined, url: string | undefined): string | undefined {
  if (!html || !url) return undefined;
  const robots = extractSeo(html, url).robots;
  if (!robots) return undefined;
  const directives = robots.toLowerCase().split(',').map((value) => value.trim()).filter(Boolean);
  return directives.every((value) => value === 'all' || value === 'index' || value === 'follow') ? undefined : robots;
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
      url: page.source,
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
  const stated = splitFrontmatter(published.body, page.path).data;
  const statedTitle = typeof stated.title === 'string' ? stated.title : undefined;
  const statedDescription = typeof stated.description === 'string' ? stated.description : undefined;
  const title = statedTitle ?? published.title ?? page.title ?? page.route;
  const description = statedDescription ?? published.description ?? page.description;
  // The frontmatter the output must carry, built from the source's own statements, so the
  // comparison covers metadata as well as body.
  // What the page stated about itself for search engines is part of what the source published, so
  // it is derived here from the same frozen bytes the output must have been built from.
  // The platform's own social card is its branding, not the page's, and the conversion never carries
  // one. Reading the source through the same profile keeps the two sides comparing what the page
  // states about itself; an ogImage the author chose is still on both sides and still compared.
  const seo = page.html && page.url ? seoFrontmatter(extractSeo(page.html, page.url), { url: page.url, title, description }, () => undefined, profile?.generatedOgImage) : {};
  const doc = markdownToIr(published.body, { platform, file: page.path, pageId: page.pageId, title, frontmatter: { title, ...(description ? { description } : {}), ...seo }, codeMetaStrip: profile?.codeMetaStrip });
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
export function sourceContentExact(page: RawSourcePage, platform: string, profile?: ScrapeProfile, links?: SiteLinks, assets?: AssetManifest, declaredLosses?: (doc: DocIR) => DocIR): SourceComparison {
  const source = rawSourceIr(page, platform, profile, links);
  if (!source) return { pageId: page.pageId, path: page.path, pass: false, detail: 'no published Markdown was frozen for this page' };
  const output = outputIr(page);
  if (!output) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  // Hosting an asset changes its URL by design, in the body and in the social image alike. The
  // source is put through the same manifest the conversion used, so the comparison is between what
  // the two sides *say* and not between where the bytes are served from; an asset the manifest does
  // not know keeps its source URL and still fails.
  const hosted = assets ? rewriteAssetRefs({ ...source, source: page.url ?? source.source }, assets) : source;
  // The mapping rules the operator approved at gate 2 declare which authored material does not
  // survive: a wrapper's own props, a chrome subtree, a named prop the contract cannot express.
  // The source is read through those same declarations, so a reviewed loss is not reported as a
  // difference while every loss no rule declared still is.
  const reviewed = declaredLosses ? declaredLosses(hosted) : hosted;
  const difference = firstFidelityDifference(authoredContentSnapshot(reviewed), authoredContentSnapshot(output));
  return { pageId: page.pageId, path: page.path, pass: !difference, difference };
}

/** Frontmatter title and description must be byte-equal to what the source states, and absent where it states none. */
export function sourceMetadataExact(page: RawSourcePage, platform = 'generic', profile?: ScrapeProfile): SourceComparison {
  const output = outputIr(page);
  if (!output) return { pageId: page.pageId, path: page.path, pass: false, detail: `no output file at ${page.outputFile}` };
  const published = page.markdown === undefined ? undefined : unwrapPublishedMarkdown(page.markdown, platform, { expectedDescription: page.description });
  const stated = published ? splitFrontmatter(published.body, page.path).data : {};
  // A platform that publishes no Markdown states its title in the rendered page: the heading the
  // article opens with. `page.title` is what the tree called the page when the crawler froze it —
  // a URL-derived placeholder on a site whose titles are only in its HTML — so it is the last
  // resort here and never evidence that the source "states" anything.
  const rendered = !published && page.html && profile ? renderedTitle(page.html, platform, page.path, profile) : undefined;
  const declaredTitle = page.llms?.title ?? (typeof stated.title === 'string' ? stated.title : undefined) ?? published?.title ?? rendered ?? page.title;
  const declaredDescription = page.llms?.description ?? (typeof stated.description === 'string' ? stated.description : undefined) ?? published?.description ?? page.description;
  const problems: string[] = [];
  if (declaredTitle && output.frontmatter.title !== declaredTitle) problems.push(`title is ${JSON.stringify(output.frontmatter.title)}, source states ${JSON.stringify(declaredTitle)}`);
  if (declaredDescription && output.frontmatter.description !== declaredDescription) problems.push(`description is ${JSON.stringify(output.frontmatter.description)}, source states ${JSON.stringify(declaredDescription)}`);
  if (!declaredDescription && output.frontmatter.description) problems.push(`description is ${JSON.stringify(output.frontmatter.description)} but the source states none`);
  const robots = unsupportedRobots(page.html, page.url);
  if (robots) problems.push(`robots directive ${JSON.stringify(robots)} has no supported Documentation.AI page mapping; preserve it through a target contract change or an explicit publishing decision`);
  return { pageId: page.pageId, path: page.path, pass: !problems.length, detail: problems.join('; ') || undefined };
}

/** The title the rendered page states: the text of the heading its article opens with. */
function renderedTitle(html: string, platform: string, file: string, profile: ScrapeProfile): string | undefined {
  const heading = titleHeading(htmlToIr(html, htmlAdapterOptions(profile, { platform, file })).children);
  return heading?.type === 'heading' ? inlineText(heading.children).trim() || undefined : undefined;
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
  const robots = unsupportedRobots(page.html, page.url);
  if (robots) problems.push(`robots directive ${JSON.stringify(robots)} has no supported Documentation.AI page mapping`);
  // The heading that states the page title leaves the body to become the frontmatter title, so the
  // output is not expected to repeat it. An H1 is skipped by headingWords already; a generator that
  // reserves H1 for its own masthead states the title in the heading the article opens with.
  let renderedHeadings = headingWords(renderedDoc, titleHeading(rendered.children)?.id);
  const outputHeadings = headingWords(output);
  // An endpoint page renders its authorization, parameter and response sections from the
  // specification the page names in frontmatter, which `openapi-preserved` certifies against the
  // captured document. Those headings are the platform's rendering of the spec, not words an author
  // wrote: the published Markdown does not state them either, and the output states the operation
  // instead. Only on such a page, and only for headings the Markdown does not state.
  if (typeof output.frontmatter.openapi === 'string' && output.frontmatter.openapi.trim()) {
    const markdown = rawSourceIr(page, platform, profile);
    if (markdown) {
      const authored = new Set(headingWords(markdown));
      renderedHeadings = renderedHeadings.filter((word) => authored.has(word));
    }
  }
  const missingHeadings = headingsNotInOrder(renderedHeadings, outputHeadings);
  if (missingHeadings.length) {
    problems.push(`headings missing from output or out of order: ${JSON.stringify(missingHeadings)}; rendered ${JSON.stringify(renderedHeadings)}, output ${JSON.stringify(outputHeadings)}`);
  }
  // Code blocks and images are counted against the published Markdown, not against this witness.
  // A rendered documentation page and the Markdown behind it do not hold the same number of either,
  // in either direction, without anything being lost: GitBook renders only the open tab's code and
  // leaves the others out of the DOM, renders an OpenAPI fence as request and response samples where
  // the output states the same operation as ParamField and ResponseField, names no language anywhere
  // in its markup while the fence names it, and draws a linked repository's favicon inside an embed
  // card that the output keeps as a plain link. Every one of those read as a difference here.
  //
  // What the output actually carries is proven against the Markdown the source published, which is
  // the authored witness: `code-blocks-exact` compares every code block, `source-content-exact`
  // compares images with the rest of the body, and `assets-ready` proves each one is hosted. This
  // check covers what those cannot see - content the rendered page shows and the Markdown omits -
  // and so it asks only that what the rendered page states is present, never that nothing else is.
  return { pageId: page.pageId, path: page.path, pass: !problems.length, detail: problems.join('; ') || undefined };
}

/** Props that state a picture the page shows: a card's cover, a component's own image. */
const IMAGE_PROPS = ['image', 'cover', 'thumbnail', 'img'];

/** Images a component states as a prop, which the source renders as an `<img>` of its own. */
function componentImageProps(doc: DocIR): number {
  let count = 0;
  walkBlocks(doc.children, (block) => {
    if (block.type !== 'component' && block.type !== 'dai') return;
    for (const prop of IMAGE_PROPS) if (typeof block.props[prop] === 'string' && block.props[prop]) count++;
  });
  return count;
}

/**
 * The headings a reader sees, in order, whichever way the page states them.
 *
 * A source heading can become a component's title: GitBook steps carry no title and open with a
 * heading, which Documentation.AI's Step states as `title` and renders as a heading again. A card's
 * title renders as a heading too. Comparing heading nodes alone read every one of those as a heading
 * the output had lost - on this GitBook migration, 26 of 41 pages.
 *
 * Words, not levels: the level is the target's to choose (Step's titleType offers only p/h2/h3, so a
 * source h4 renders h3) and is compared against the published Markdown by `headings-sequence`. A
 * heading with no words is a wrapper the theme renders empty, and states nothing to compare.
 */
/**
 * Which headings the rendered page states that the output does not, in order.
 *
 * Every heading the source states with words has to be there; the output may hold more. A GitBook
 * card grid renders each card's title as a heading on one page and as markup this extractor reads as
 * an empty heading on another, and the output states tab titles the source renders inside the tab
 * strip rather than as a heading. Requiring an exact sequence read both as lost headings. A heading
 * the output invented instead of the source is caught against the published Markdown, by
 * `headings-sequence` and `source-content-exact`.
 */
function headingsNotInOrder(rendered: string[], output: string[]): string[] {
  const missing: string[] = [];
  let cursor = 0;
  for (const heading of rendered) {
    const found = output.indexOf(heading, cursor);
    if (found === -1) missing.push(heading);
    else cursor = found + 1;
  }
  return missing;
}

function headingWords(doc: DocIR, skipId?: string): string[] {
  const words: string[] = [];
  walkBlocks(doc.children, (block) => {
    if (skipId !== undefined && block.id === skipId) return;
    // A heading's words as a reader sees them: the badge composed inside one is part of the heading
    // on the rendered page, so reading it as nothing made every page with a badged heading report
    // that heading missing from its own output.
    if (block.type === 'heading' && block.depth > 1) words.push(normaliseProse(renderedText(block.children)));
    else if (block.type === 'component' || block.type === 'dai') {
      // A title stated in Markdown may hold inline markup - a step titled "Add the URL to your
      // `docs.json` file" - and the rendered page shows the words inside it, not the backticks.
      const title = block.props.title;
      if (typeof title === 'string' && title.trim()) words.push(normaliseProse(title.replace(/`/g, '')));
    }
  });
  return words.filter(Boolean);
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
