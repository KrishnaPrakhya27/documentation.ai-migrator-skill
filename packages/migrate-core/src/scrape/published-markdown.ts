/**
 * Published Markdown: the `.md` a platform serves next to each page and the
 * `/llms.txt` index that lists every page with its exact title and
 * description. Public Markdown endpoints often add a machine-oriented wrapper
 * around the authored page; only a positively identified wrapper is removed,
 * and a leading blockquote leaves the body only when it is provably the
 * declared description. Ordinary authored headings and blockquotes are never
 * guessed away.
 */
export interface PublishedMarkdownPage {
  body: string;
  title?: string;
  description?: string;
  wrapper: 'mintlify-documentation-index' | 'none';
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

/**
 * Entries of an llms.txt index, deduplicated by page path (an index may list
 * its root page twice). Two listings of one path that disagree on title or
 * description are an ambiguity only the source can resolve, so they are refused.
 */
export function parseLlmsTxt(body: string, sourceUrl?: string): LlmsEntry[] {
  const byPath = new Map<string, LlmsEntry>();
  for (const raw of body.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = raw.trim().match(LLMS_ENTRY);
    if (!match) continue;
    const [, title, link, description] = match;
    let mdUrl: string;
    try { mdUrl = new URL(link, sourceUrl).toString(); } catch { throw new Error(`llms.txt entry "${title.trim()}" links to an unresolvable URL ${link}`); }
    const entry: LlmsEntry = { title: title.trim(), mdUrl, path: pagePathOfMarkdownUrl(mdUrl) };
    const text = description?.trim();
    if (text) entry.description = text;
    const existing = byPath.get(entry.path);
    if (!existing) byPath.set(entry.path, entry);
    else if (existing.title !== entry.title || existing.description !== entry.description) throw new Error(`llms.txt lists ${entry.path} twice with different metadata: ${describeEntry(existing)} and ${describeEntry(entry)}`);
  }
  return [...byPath.values()];
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
    title = heading[1];
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
