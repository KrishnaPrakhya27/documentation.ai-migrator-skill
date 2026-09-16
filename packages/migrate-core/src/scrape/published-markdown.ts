/**
 * Published Markdown: the `.md` a platform serves next to each page and the
 * `/llms.txt` index that lists every page with its exact title and
 * description. Public Markdown endpoints often add a machine-oriented wrapper
 * around the authored page; only a positively identified wrapper is removed,
 * and a leading blockquote leaves the body only when it is provably the
 * declared description. Ordinary authored headings and blockquotes are never
 * guessed away.
 */
import { splitFrontmatter } from '../ir/from-markdown.js';

export interface PublishedMarkdownPage {
  body: string;
  title?: string;
  description?: string;
  wrapper: 'mintlify-documentation-index' | 'gitbook-documentation-index' | 'readme-documentation-index' | 'none';
  /** A platform-generated trailer removed from the end of the body. */
  footer?: 'gitbook-agent-instructions';
}

/** One `- [title](url): description` entry of /llms.txt. */
export interface LlmsEntry {
  title: string;
  description?: string;
  /** The link as listed, normally the page's published Markdown. */
  mdUrl: string;
  /** Site path of the page the link describes: `/index.md` \u2192 `/`, `/guides/setup.md` \u2192 `/guides/setup`. */
  path: string;
}

/** An llms.txt entry that points at another index rather than at a page. */
export interface LlmsIndexRef {
  /** The label the listing gives the index. It names a route, not a page, so two listings may label one index differently. */
  title: string;
  url: string;
}

/** What one llms.txt file states: the pages it lists, the nested indexes it points at, and the other sites it links to. */
export interface ParsedLlmsIndex {
  entries: LlmsEntry[];
  indexes: LlmsIndexRef[];
  external: Array<{ title: string; url: string }>;
}

export interface ParseLlmsOptions {
  /** Path segment marking a link as a nested index rather than a page (Mintlify publishes them under `/_llms/`). */
  indexSegment?: string;
  /** Whether a link belongs to the site being read. Links that do not are references to another site, never pages of this one. */
  isOnSite?: (url: string) => boolean;
}

export interface UnwrapOptions {
  /** The description the platform declares for the page (llms.txt or page metadata). Only a leading blockquote equal to it is lifted out of the body. */
  expectedDescription?: string;
}

const LLMS_ENTRY = /^[-*]\s+\[(.+?)\]\((\S+?)\)(?:\s*:\s*(.*))?$/;
const DOCUMENTATION_INDEX_WRAPPER = /^>\s*##\s+Documentation Index\s*$/i;
const HTML_DOCUMENT_START = /^\s*<(?:!doctype|html)\b/i;
const MARKDOWN_MEDIA_TYPE = /^text\/(?:markdown|plain)\b/i;

/** Prefer the publisher-declared Markdown representation over URL guessing. */
export function markdownAlternateUrl(html: string, pageUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? '']));
    if (/\balternate\b/i.test(attrs.rel ?? '') && /(?:text\/markdown|text\/plain)/i.test(attrs.type ?? '') && attrs.href) return new URL(attrs.href, pageUrl).toString();
  }
  return undefined;
}

/** Site path of the page a published-Markdown URL serves (`/index.md` is the root page). */
export function pagePathOfMarkdownUrl(url: string): string {
  const pathname = new URL(url).pathname.replace(/\.md$/i, '');
  return pathname === '/index' || pathname === '' ? '/' : pathname;
}

/** Published-Markdown URL of a page by the `<path>.md` convention (`/` \u2192 `/index.md`). */
export function markdownUrlOfPage(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.pathname = url.pathname === '/' ? '/index.md' : `${url.pathname.replace(/\/$/, '')}.md`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function describeEntry(entry: LlmsEntry): string {
  return `"${entry.title}"${entry.description === undefined ? ' without description' : `: "${entry.description}"`}`;
}

/** Whether a URL's path contains `segment` as a whole segment (`/docs/_llms/en.md` has `_llms`). */
function hasPathSegment(url: string, segment: string): boolean {
  return new URL(url).pathname.split('/').includes(segment);
}

/**
 * What one llms.txt file states, split three ways: the pages it lists, the
 * nested indexes it points at, and the links it makes to other sites.
 *
 * `indexSegment` is the path segment under which the platform publishes nested
 * indexes (Mintlify uses `/_llms/`, and says so in the file: "Follow each
 * `/_llms/` index recursively until you reach documentation pages").
 *
 * `isOnSite` decides what is a page here. A site links out from its own index -
 * Mintlify's docs list `learn.mintlify.com`, a separate site, once per locale -
 * and another site's URL carries another site's path. Admitting one both
 * invents a page and collides with whatever this site serves at that path, so
 * these are separated before any page identity is derived from them.
 *
 * Pages are deduplicated by page path, and two listings of one path that
 * disagree on title or description are refused: only the source can say which
 * the page is. Indexes and external links are deduplicated by URL and keep the
 * first label, because a label naming a route or another site is not a page
 * title to reconcile - one index is listed as a shorthand near the top and
 * again under the file's own "Indexes" heading, with a different label each time.
 */
export function parseLlmsIndex(body: string, sourceUrl?: string, options: ParseLlmsOptions = {}): ParsedLlmsIndex {
  const byPath = new Map<string, LlmsEntry>();
  const indexes = new Map<string, LlmsIndexRef>();
  const external = new Map<string, { title: string; url: string }>();
  for (const raw of body.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = raw.trim().match(LLMS_ENTRY);
    if (!match) continue;
    const [, rawTitle, link, description] = match;
    // a label is Markdown, so a bracket in the title is written escaped; the title is the characters
    const title = unescapeMarkdown(rawTitle.trim());
    let url: string;
    try { url = new URL(link, sourceUrl).toString(); } catch { throw new Error(`llms.txt entry "${title}" links to an unresolvable URL ${link}`); }
    if (options.indexSegment && hasPathSegment(url, options.indexSegment)) {
      if (!indexes.has(url)) indexes.set(url, { title, url });
      continue;
    }
    if (options.isOnSite && !options.isOnSite(url)) {
      if (!external.has(url)) external.set(url, { title, url });
      continue;
    }
    const entry: LlmsEntry = { title, mdUrl: url, path: pagePathOfMarkdownUrl(url) };
    const text = description?.trim();
    if (text) entry.description = text;
    const existing = byPath.get(entry.path);
    if (!existing) byPath.set(entry.path, entry);
    else if (existing.title !== entry.title || existing.description !== entry.description) throw new Error(`llms.txt lists ${entry.path} twice with different metadata: ${describeEntry(existing)} and ${describeEntry(entry)}`);
  }
  return { entries: [...byPath.values()], indexes: [...indexes.values()], external: [...external.values()] };
}

/**
 * Entries of a single llms.txt index, deduplicated by page path (an index may
 * list its root page twice). Two listings of one path that disagree on title or
 * description are an ambiguity only the source can resolve, so they are refused.
 */
export function parseLlmsTxt(body: string, sourceUrl?: string): LlmsEntry[] {
  return parseLlmsIndex(body, sourceUrl).entries;
}

/** Why a response cannot stand as a page's published Markdown; undefined when it can. */
export function publishedMarkdownProblem(response: { status: number; contentType: string; body: string }): string | undefined {
  if (response.status !== 200) return `HTTP ${response.status}`;
  if (!MARKDOWN_MEDIA_TYPE.test(response.contentType)) return `content-type "${response.contentType}" is not text/markdown or text/plain`;
  const body = response.body.replace(/^\uFEFF/, '');
  if (HTML_DOCUMENT_START.test(body)) return 'body is an HTML document';
  if (!body.trim()) return 'body is empty';
  return undefined;
}

function cleanQuote(lines: string[]): string {
  return lines.map((line) => line.replace(/^> ?/, '')).join('\n').trim();
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A heading's words as written: the export escapes Markdown punctuation (`\\[updated for 2026\\]`) and a title is not Markdown. */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, '$1');
}

function skipBlankLines(lines: string[], cursor: number): number {
  while (cursor < lines.length && !lines[cursor].trim()) cursor++;
  return cursor;
}

/** The blockquote lines starting exactly at `cursor`; a blank or non-quote line ends it, so a following blockquote is never included. */
function leadingBlockquote(lines: string[], cursor: number): string[] {
  const quote: string[] = [];
  while (cursor < lines.length && lines[cursor].startsWith('>')) quote.push(lines[cursor++]);
  return quote;
}

/**
 * Mintlify's published .md is a `> ## Documentation Index` wrapper, then
 * `# <title>`, then `> <description>` when the page has one, then the authored
 * body. The H1 is lifted as the title. The blockquote after it is lifted as the
 * description only when it equals `expectedDescription` after whitespace
 * normalisation; any other blockquote is authored content and stays in the body.
 */
export function unwrapPublishedMarkdown(source: string, platform: string, options: UnwrapOptions = {}): PublishedMarkdownPage {
  if (platform === 'gitbook') return unwrapGitbookMarkdown(source, options);
  if (platform === 'readme') return unwrapReadmeMarkdown(source, options);
  if (platform !== 'mintlify') return { body: source, wrapper: 'none' };
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let cursor = skipBlankLines(lines, 0);
  let wrapper: PublishedMarkdownPage['wrapper'] = 'none';
  if (DOCUMENTATION_INDEX_WRAPPER.test(lines[cursor] ?? '')) {
    wrapper = 'mintlify-documentation-index';
    cursor = skipBlankLines(lines, cursor + leadingBlockquote(lines, cursor).length);
  }

  let title: string | undefined;
  const heading = lines[cursor]?.match(/^#\s+(.+?)\s*$/);
  if (heading) {
    title = unescapeMarkdown(heading[1]);
    cursor = skipBlankLines(lines, cursor + 1);
  }

  let description: string | undefined;
  const quote = leadingBlockquote(lines, cursor);
  if (quote.length && options.expectedDescription !== undefined && normaliseWhitespace(cleanQuote(quote)) === normaliseWhitespace(options.expectedDescription)) {
    description = cleanQuote(quote);
    cursor = skipBlankLines(lines, cursor + quote.length);
  }
  return { body: lines.slice(cursor).join('\n').replace(/\s+$/, '') + '\n', title, description, wrapper };
}

const README_INDEX_NOTICE = /^Fetch the complete documentation index at: \S+\/llms\.txt\. Use this file to discover all available pages before exploring further\./;
/**
 * ReadMe's published .md is `updatedAt` frontmatter, a plain paragraph pointing agents at
 * `/llms.txt`, then `# <title>`, then the authored body. The paragraph is removed only when it
 * is ReadMe's own notice; the frontmatter stays. The H1 is lifted as the title, and the paragraph
 * after it as the description only when it equals `expectedDescription` after whitespace normalisation.
 */
function unwrapReadmeMarkdown(source: string, options: UnwrapOptions): PublishedMarkdownPage {
  const unmarked = source.replace(/^\uFEFF/, '');
  // frontmatter of any YAML shape stays at the top; one the parser rejects stays in the body, where inventory reports it
  let frontmatter = '';
  let rest = unmarked;
  try {
    rest = splitFrontmatter(unmarked, 'published Markdown').body;
    frontmatter = unmarked.slice(0, unmarked.length - rest.length);
  } catch {
    rest = unmarked;
  }
  const lines = rest.split(/\r?\n/);
  let cursor = skipBlankLines(lines, 0);
  let wrapper: PublishedMarkdownPage['wrapper'] = 'none';
  const notice = leadingParagraph(lines, cursor);
  if (notice.length && README_INDEX_NOTICE.test(normaliseWhitespace(notice.join(' ')))) {
    wrapper = 'readme-documentation-index';
    cursor = skipBlankLines(lines, cursor + notice.length);
  }

  let title: string | undefined;
  const heading = lines[cursor]?.match(/^#\s+(.+?)\s*$/);
  if (heading) {
    title = unescapeMarkdown(heading[1]);
    cursor = skipBlankLines(lines, cursor + 1);
  }

  let description: string | undefined;
  const paragraph = leadingParagraph(lines, cursor);
  if (paragraph.length && options.expectedDescription !== undefined && normaliseWhitespace(paragraph.join('\n')) === normaliseWhitespace(options.expectedDescription)) {
    description = paragraph.join('\n').trim();
    cursor = skipBlankLines(lines, cursor + paragraph.length);
  }
  return { body: `${frontmatter ? `${frontmatter.replace(/\n*$/, '\n')}\n` : ''}${lines.slice(cursor).join('\n').replace(/\s+$/, '')}\n`, title, description, wrapper };
}

const GITBOOK_INDEX_WRAPPER = /^>\s*For the complete documentation index, see \[llms\.txt\]\([^)]*\)/i;
const GITBOOK_AGENT_HEADING = /^#\s+Agent Instructions\s*$/;
const GITBOOK_QUERY_HEADING = /^##\s+Querying This Documentation\s*$/;
const THEMATIC_BREAK = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Where GitBook's generated trailer starts: the last `# Agent Instructions` section, identified
 * by its `## Querying This Documentation` subsection and `?ask=` endpoint, together with the
 * thematic break GitBook puts before it. An authored section of the same name lacks the endpoint.
 */
function gitbookAgentFooterStart(lines: string[]): number | undefined {
  let heading = -1;
  for (let i = lines.length - 1; i >= 0 && heading < 0; i--) if (GITBOOK_AGENT_HEADING.test(lines[i])) heading = i;
  if (heading < 0) return undefined;
  const rest = lines.slice(heading + 1);
  if (!rest.some((line) => GITBOOK_QUERY_HEADING.test(line)) || !rest.some((line) => line.includes('?ask=<question>'))) return undefined;
  let before = heading - 1;
  while (before >= 0 && !lines[before].trim()) before--;
  return before >= 0 && THEMATIC_BREAK.test(lines[before]) ? before : heading;
}

/** The paragraph lines starting exactly at `cursor`, up to the next blank line. */
function leadingParagraph(lines: string[], cursor: number): string[] {
  const paragraph: string[] = [];
  while (cursor < lines.length && lines[cursor].trim()) paragraph.push(lines[cursor++]);
  return paragraph;
}

/**
 * GitBook's published .md is a `> For the complete documentation index, see [llms.txt](…)`
 * wrapper, then `# <title>`, then the description as a plain paragraph when the page has
 * one, then the authored body, then a generated `# Agent Instructions` trailer. The H1 is
 * lifted as the title; the paragraph after it is lifted as the description only when it
 * equals `expectedDescription` after whitespace normalisation.
 */
function unwrapGitbookMarkdown(source: string, options: UnwrapOptions): PublishedMarkdownPage {
  let lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const footerStart = gitbookAgentFooterStart(lines);
  if (footerStart !== undefined) lines = lines.slice(0, footerStart);
  let cursor = skipBlankLines(lines, 0);
  let wrapper: PublishedMarkdownPage['wrapper'] = 'none';
  if (GITBOOK_INDEX_WRAPPER.test(lines[cursor] ?? '')) {
    wrapper = 'gitbook-documentation-index';
    cursor = skipBlankLines(lines, cursor + leadingBlockquote(lines, cursor).length);
  }

  let title: string | undefined;
  const heading = lines[cursor]?.match(/^#\s+(.+?)\s*$/);
  if (heading) {
    title = unescapeMarkdown(heading[1]);
    cursor = skipBlankLines(lines, cursor + 1);
  }

  let description: string | undefined;
  const paragraph = leadingParagraph(lines, cursor);
  if (paragraph.length && options.expectedDescription !== undefined && normaliseWhitespace(paragraph.join('\n')) === normaliseWhitespace(options.expectedDescription)) {
    description = paragraph.join('\n').trim();
    cursor = skipBlankLines(lines, cursor + paragraph.length);
  }
  const page: PublishedMarkdownPage = { body: lines.slice(cursor).join('\n').replace(/\s+$/, '') + '\n', title, description, wrapper };
  if (footerStart !== undefined) page.footer = 'gitbook-agent-instructions';
  return page;
}
