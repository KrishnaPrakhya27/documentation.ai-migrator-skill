/**
 * Markdown/MDX -> DocIR using micromark/mdast. Source constructs stay as
 * ComponentNodes until the rules engine resolves, reviews, or quarantines them.
 * No JavaScript expression is evaluated.
 */
import { basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { nameToEmoji } from 'gemoji';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { loadContract } from '@dai/content-contract';
import { nodeId } from '../session/ids.js';
import { sanitizeHtmlToJsx } from '../components/sanitize.js';
import type { Block, ComponentNode, DaiComponentNode, DocIR, Frontmatter, ImageNode, Inline, ListItemNode, TableCellNode, TableRowNode } from './types.js';
import { readPixelDimension } from './dimensions.js';
import { htmlToIr } from './from-html.js';
import { mapBlocks, inlineText } from './types.js';
import { gitbookHtmlBlockToIr, isGitbookHtmlBlock, isGitbookHtmlInline, isGitbookHtmlTag, TRANSPARENT_HTML, isGitbookInternalFileRef } from './gitbook-html.js';
import { gitbookOpenApiBlocks } from './gitbook-openapi.js';
import { mintlifyOperationSection, operationFrontmatter } from './mintlify-openapi.js';
import { srcsetUrls } from '../assets/html-media.js';
import { capturedSpecFile } from '../openapi/graph.js';

export interface MarkdownAdapterOptions {
  platform: string;
  file: string;
  pageId: string;
  title?: string;
  frontmatter?: Partial<Frontmatter>;
  /** Resolve a snippet import path (e.g. "/snippets/intro.mdx") to its MDX body; undefined leaves the import unresolved (quarantined). */
  resolveSnippet?: (importPath: string) => string | undefined;
  /**
   * Fence info-string directives that are the source platform's own theming rather than authored
   * content (`theme={null}`). They are removed from the emitted meta, which the target contract would
   * reject as an expression, and preserved on the node as `sourceMeta`. Declared by the scrape profile.
   */
  codeMetaStrip?: string[];
  /** Import ancestry prevents recursive snippets from exhausting the process. */
  snippetStack?: string[];
}

/** Removes the platform's theming directives from a fence info string, returning undefined when nothing authored remains. */
/** The character references fenceMeta writes, read back to the characters. */
function decodeMetaReferences(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&amp;/g, '&');
}

export function stripPlatformCodeMeta(meta: string | undefined, patterns: string[] | undefined): string | undefined {
  if (!meta || !patterns?.length) return meta;
  let out = meta;
  for (const pattern of patterns) out = out.replace(new RegExp(pattern, 'g'), ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out || undefined;
}

/** Sentinel wrapped around a custom heading id ({#id}) so it survives parsing and is lifted into heading.sourceId. */
const ANCHOR_OPEN = '\uE000';
const ANCHOR_CLOSE = '\uE001';
const SNIPPET_IMPORT = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.(?:mdx?|jsx))["'];?\s*$/;

/**
 * The theme-visibility classes of an image, in a fixed order, and nothing else it was styled with.
 * A source that pairs a light and a dark copy of one picture hides each in the other theme; these are
 * the only classes carried, because they decide which picture a reader sees at all.
 */
export function themeClassOf(value: unknown): { themeClass?: string } {
  if (typeof value !== 'string') return {};
  const tokens = new Set(value.split(/\s+/).filter((token) => /^(?:dark:)?(?:hidden|block)$/.test(token)));
  const ordered = ['block', 'hidden', 'dark:block', 'dark:hidden'].filter((token) => tokens.has(token));
  return ordered.length ? { themeClass: ordered.join(' ') } : {};
}

/**
 * Whether the source draws an image as decoration: it takes no pointer events (a hero background),
 * it is hidden from assistive technology, or it says so by role — or, read back from this tool's
 * own output, it carries the hook that said so.
 */
export function decorativeOf(attrs: { class?: unknown; className?: unknown; 'aria-hidden'?: unknown; ariaHidden?: unknown; role?: unknown }): { decorative?: true } {
  const classes = String(attrs.className ?? attrs.class ?? '').split(/\s+/);
  const hiddenFromReaders = String(attrs['aria-hidden'] ?? attrs.ariaHidden ?? '') === 'true' || /^(?:presentation|none)$/.test(String(attrs.role ?? ''));
  return classes.includes('pointer-events-none') || classes.includes('dai-mig-decorative') || hiddenFromReaders ? { decorative: true } : {};
}

/** Documentation.AI writes images as <Image />, source MDX as <img />; both are images, never components. */
function isImageElement(node: { name?: string | null }): boolean {
  return node.name === 'Image' || String(node.name).toLowerCase() === 'img';
}

/** Elements the inline serialiser owns; alone on a line they still belong to a paragraph. */
function isInlineOnlyElement(node: { name?: string | null }): boolean {
  const name = String(node.name).toLowerCase();
  return name === 'br' || name === 'kbd';
}

let contractComponentNames: Set<string> | undefined;
/** Target MDX (platform 'dai') names contract components directly; they are already resolved, so no mapping rule may run on them. */
function isContractComponentName(name: string): boolean {
  contractComponentNames ??= new Set(loadContract().components.map((component) => component.name));
  return contractComponentNames.has(name);
}

/** Snippet imports and their usages, from the ESM nodes of a document. */
function snippetImports(tree: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of tree.children ?? []) {
    if (node.type !== 'mdxjsEsm') continue;
    for (const line of String(node.value ?? '').split('\n')) { const m = line.match(SNIPPET_IMPORT); if (m) out.set(m[1], m[2]); }
  }
  return out;
}

export function splitFrontmatter(source: string, file: string): { data: Record<string, unknown>; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: source };
  try {
    const parsed = parseYaml(m[1]);
    return { data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, body: source.slice(m[0].length) };
  } catch (error) {
    // The line and column the YAML parser reports are offsets inside the frontmatter block, not the file.
    throw new Error(`${file}: invalid YAML frontmatter: ${(error as Error).message}`);
  }
}

function quoteAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\{/g, '&#123;');
}

function liquidAttrs(raw: string): string {
  const attrs: string[] = [];
  for (const m of raw.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1] === 'url' ? 'src' : m[1];
    // GitBook wraps the URL in angle brackets inside attributes: url="<https://…>". Its export
    // autolinks only the part it recognises, so a trailing `?` or an escaped `_` that belongs to the
    // address ends up after the closing bracket; the value is the two joined, with the escape undone.
    // The export escapes Markdown punctuation inside attribute values as it does in text
    // (`title="contribution\_analytics.py"`); the value is the characters, not the escapes.
    const raw = (m[2] ?? m[3] ?? '').replace(/^<([^<>\s]+)>(.*)$/, (_whole, url: string, rest: string) => url + rest.replace(/\\(.)/g, '$1'));
    attrs.push(`${name}="${quoteAttr(raw.replace(/\\([_*`~\\])/g, '$1'))}"`);
  }
  return attrs.length ? ' ' + attrs.join(' ') : '';
}

/** Convert block syntaxes that micromark intentionally treats as plain text. */
/** Apply `fn` only to text outside fenced and inline code, so documentation *about* a syntax is never rewritten. */
function outsideCode(source: string, fn: (segment: string) => string): string {
  // Fences are tracked by hand: a ```` block quoting ``` inside it is one block, which no regex
  // pairing the first two delimiters can tell. A backslash-escaped backtick is the character, not
  // a code-span delimiter, and a span opened with two backticks closes only on two.
  const parts: Array<{ code: boolean; text: string }> = [];
  const push = (code: boolean, text: string): void => {
    const last = parts[parts.length - 1];
    if (last && last.code === code) last.text += text; else parts.push({ code, text });
  };
  let fence: string | undefined;
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const newline = index < lines.length - 1 ? '\n' : '';
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      push(true, line + newline);
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)) fence = undefined;
      return;
    }
    if (delimiter) { fence = delimiter[1]; push(true, line + newline); return; }
    let at = 0;
    for (const span of line.matchAll(/(?<!\\)(`+)(?:(?!\1)[^\n])*?\1(?!`)/g)) {
      const start = span.index ?? 0;
      if (start > at) push(false, line.slice(at, start));
      push(true, span[0]);
      at = start + span[0].length;
    }
    push(false, line.slice(at) + newline);
  });
  return parts.map((part) => (part.code ? part.text : fn(part.text))).join('');
}

export function preprocessPlatformMarkdown(source: string, platform: string): string {
  const prepared = platform === 'gitbook' ? outsideCode(gitbookQuotedMarkdown(source), gitbookButtonGaps) : source;
  return outsideCode(prepared, (segment) => preprocessSegment(segment, platform));
}

/**
 * GitBook quotes an OpenAPI operation's description above its fence and escapes the Markdown the
 * description was written in (\`limit\`, \*\*deprecated\*\*). The escapes are the export's, not the
 * author's, so on quoted lines outside a fence they are read as the code and bold they encode. This
 * runs before code spans are set aside, which would otherwise take an escaped backtick as one.
 */
function gitbookQuotedMarkdown(source: string): string {
  let fence: string | undefined;
  return source.split('\n').map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return line;
    }
    if (fence || !/^\s*>/.test(line)) return line;
    return line.replace(/\\`([^`\n]+?)\\`/g, '`$1`').replace(/\\\*\\\*(.+?)\\\*\\\*/g, '**$1**');
  }).join('\n');
}

/**
 * GitBook writes a row of buttons with nothing between them (`<a class="button">Quickstart</a><a
 * class="button">GitBook MCP</a>`) and renders each as its own button with a gap. Read as links they
 * ran together into one word ("QuickstartGitBook MCP"), so the gap is written as the space it is.
 * Two ordinary links the author wrote together are left as written.
 */
function gitbookButtonGaps(segment: string): string {
  return segment.replace(/(<a\b[^>]*\bclass="[^"]*\bbutton\b[^"]*"[^>]*>[\s\S]*?<\/a>)(?=<a\b[^>]*\bclass="[^"]*\bbutton\b)/g, '$1 ');
}

function preprocessSegment(source: string, platform: string): string {
  let out = source.replace(/^(#{1,6}\s+.*?)\s*\{#([A-Za-z][\w:.-]*)\}\s*$/gm, (_, heading, id) => `${heading} ${ANCHOR_OPEN}${id}${ANCHOR_CLOSE}`);
  // GitBook's export states a heading's anchor itself: `## \u200bTitle <a href="#the-id" id="the-id"></a>`.
  // The empty anchor is the id the site gives the heading — and every deep link uses — and the
  // zero-width space is the editor's, not the author's. Read as text they became a heading whose
  // words ended in an empty link and whose slug matched nothing, and 345 deep links on one site
  // had nowhere to land.
  if (platform === 'gitbook') out = out.replace(/^(#{1,6}\s+)\u200b?(.*?)\s*<a href="#([^"]+)" id="\3"><\/a>\s*$/gm, (_, hashes, title, id) => `${hashes}${title} ${ANCHOR_OPEN}${id}${ANCHOR_CLOSE}`).replace(/^(#{1,6}\s+)\u200b/gm, '$1');
  out = out.replace(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g, (_, token) => `<snippetRef token="${quoteAttr(String(token).trim())}" />`);
  if (platform === 'gitbook') out = gitbookMdxCompatible(gitbookLiteralBraces(gitbookTableAsterisks(gitbookLiquidBlocks(gitbookMathBraces(gitbookHtmlCodeBlocks(gitbookLiteralAngles(gitbookEmojiShortcodes(out))))))));
  if (platform === 'readme') out = readmeMdxCompatible(out);
  if (platform === 'docusaurus') {
    out = out.replace(/^:::(note|tip|info|warning|danger|caution)(?:\s+([^\n]+))?\s*$/gm, (_, kind, title) => `<admonition kind="${kind}"${title ? ` title="${quoteAttr(String(title).trim())}"` : ''}>`);
    out = out.replace(/^::: \s*$/gm, '</admonition>');
    out = out.replace(/^:::\s*$/gm, '</admonition>');
  }
  return out;
}

const GITBOOK_BLOCK_TAGS = ['hint', 'tabs', 'tab', 'content-ref', 'stepper', 'step', 'columns', 'column', 'updates', 'update', 'code'];
/**
 * A Liquid tag alone on its line, optionally inside a blockquote, indented, or followed by a hard
 * break; quoted attribute values may hold `%` (`width="50%"`).
 *
 * Any block name is read, not only the ones with a mapping. A platform adds blocks — GitBook's
 * `{% prompt %}` is newer than this list — and a name we do not know is a block to report as
 * unmapped, which is what the ledger is for. Matching only known names left the rest as literal
 * `{`, which MDX reads as the start of an expression and refuses: one unknown block on one page of
 * 1255 failed the whole stage with "Could not parse expression with acorn" and no page named.
 */
const GITBOOK_TAG_LINE = new RegExp(String.raw`^((?:[ \t]*>)*)[ \t]*\{%\s*(end)?([A-Za-z][\w-]*)\b((?:[^%"']|"[^"]*"|'[^']*')*)%\}[ \t]*(?:\\|<br\s*\/?>)?[ \t]*$`);

/**
 * GitBook Liquid block tags become JSX flow elements, each isolated by blank lines (inside
 * the same blockquote when quoted) so MDX sees a block boundary: without them an opening tag
 * swallows the fence that follows it and a closing tag joins the paragraph before it. The
 * indentation is dropped because a GitBook block never belongs to a list item, and a hard
 * break left before a tag or on the tag line has nothing to break once the block ends there.
 */
/**
 * Braces inside a math span are TeX, not MDX.
 *
 * `$$x = e^{2 pi i}$$` is a formula GitBook renders with KaTeX; MDX sees `{2 pi i}` and tries to
 * read it as JavaScript. Escaping the braces keeps the formula exactly as written — `\\{` is a
 * literal brace to MDX — so the page parses and the text a reader sees is unchanged.
 */
function gitbookMathBraces(segment: string): string {
  return segment.replace(/\$\$[\s\S]{0,2000}?\$\$/g, (math) => math.replace(/(?<!\\)([{}])/g, '\\$1'));
}

/**
 * A code block GitBook published as HTML becomes the fence it renders as.
 *
 * `<pre class="language-js"><code class="lang-js">` is how GitBook writes a code block whose lines
 * it wants to mark up (`<strong>` on a highlighted line). Left as HTML, MDX reads it as JSX and
 * every `{` in the code starts an expression, so a page of JavaScript fails to parse at all. The
 * language is the one the class names, the inline markup is presentation around the code rather
 * than code, and the entities are written back to the characters they stand for.
 */
function gitbookHtmlCodeBlocks(segment: string): string {
  return segment.replace(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_whole, attrs: string, code: string) => {
    const language = /class="[^"]*\blang(?:uage)?-([\w+#.-]+)/i.exec(attrs)?.[1] ?? '';
    const text = code
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'").replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/^\n/, '').replace(/\s+$/, '');
    // a fence long enough that the code's own backticks cannot close it
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  });
}

/** Liquid tags GitBook never closes: the element carries everything in its attributes. */
const GITBOOK_SELF_CLOSING = new Set(['embed', 'file']);

function gitbookLiquidBlocks(segment: string): string {
  const out: string[] = [];
  // A page that documents a block writes the block's own syntax inside a fence. That is code a
  // reader is meant to see, not a block to build, so fenced lines are left exactly as they are.
  let fence: string | undefined;
  for (const line of segment.split('\n')) {
    const delimiter = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (delimiter) {
      // A fence closes only on the same character, at least as long as the one that opened it, so a
      // ```` block quoting ``` inside it stays one block.
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = undefined;
      out.push(line); continue;
    }
    if (fence) { out.push(line); continue; }
    const m = line.match(GITBOOK_TAG_LINE);
    if (!m) { out.push(line); continue; }
    // GitBook writes an embed both ways: alone, and wrapped around the caption a reader sees when
    // the embed cannot render. The element carries the URL and is self-closing either way, so the
    // closing tag is dropped rather than left behind — left behind, its `{` reads as the start of an
    // MDX expression and the page will not parse.
    if (m[2] && GITBOOK_SELF_CLOSING.has(m[3])) continue;
    const quote = Array.from({ length: (m[1].match(/>/g) ?? []).length }, () => '>').join(' ');
    const inQuote = (text: string) => (quote && text ? `${quote} ${text}` : quote || text);
    for (let i = out.length - 1; i >= 0; i--) {
      const trimmed = out[i].replace(/\\[ \t]*$/, '');
      if (trimmed === out[i]) break;
      out[i] = trimmed;
      if (trimmed.replace(/^[ \t>]*/, '')) break;
    }
    const tag = GITBOOK_SELF_CLOSING.has(m[3]) ? `<${m[3]}${liquidAttrs(m[4])} />` : m[2] ? `</${m[3]}>` : `<${m[3]}${liquidAttrs(m[4])}>`;
    out.push(inQuote(''), inQuote(tag), inQuote(''));
  }
  return out.join('\n');
}

const HTML_VOID_ELEMENT = /<(img|br|hr|input|source|col|wbr|area|track)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/gi;
// an escaped `\<` is a literal less-than, never the start of an autolink
const ANGLE_AUTOLINK = /(?<!\]\(|\\)<((?:https?|mailto|ftp):[^\s<>]*)>/g;
const EMAIL_AUTOLINK = /(?<!\]\(|\\)<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/g;
/** GitBook's export of an OpenAPI description escapes the Markdown link around an autolink: `\[label]\(<https://…>)`. */
const ESCAPED_AUTOLINK_LINK = /\\\[([^\]\n]*?)\\?\]\\\(<((?:https?|mailto):[^\s<>]*)>\)/g;
function voidElementsMdxCompatible(segment: string): string {
  return segment.replace(HTML_VOID_ELEMENT, (tag, name, attrs) => (/\/\s*$/.test(attrs) ? tag : `<${name}${attrs.replace(/\s+$/, '')} />`));
}

/** `<https://…>` and `<name@host>` autolinks become the links they render as; a `](<url>)` destination is valid MDX and stays. */
function autolinksMdxCompatible(segment: string): string {
  return segment
    .replace(ANGLE_AUTOLINK, (_, url) => `[${url}](${url})`)
    .replace(EMAIL_AUTOLINK, (_, email) => `[${email}](mailto:${email})`);
}

/**
 * CommonMark that GitBook publishes and MDX rejects: HTML void elements written without `/>`
 * and `<https://…>` autolinks. Each is rewritten to the form MDX accepts and that renders the
 * same; a `](<url>)` link destination is valid MDX and is left as written, and an escaped link
 * around an autolink is the link it stands for.
 */
/**
 * Angle brackets around a word GitBook does not render as an element are the author's text. Read
 * as MDX, `gitbook integrations new <dir>` lost `<dir>` from a heading and everything after it from
 * a paragraph, on a site whose readers see those characters. Runs on the raw Markdown, before Liquid
 * tags become elements, so only what the source wrote in angle brackets is judged.
 */
function gitbookLiteralAngles(segment: string): string {
  return segment.replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, (match, slash: string, name: string) => (isGitbookHtmlTag(name) ? match : `&lt;${slash}${name}`));
}

/**
 * A brace in GitBook prose is the author's character. GitBook is not MDX: `{if} blocks`, a
 * `{% openapi %}` named inside escaped backticks, `(response) => { … }` in a table cell — read as
 * MDX every one starts an expression and the page fails to parse, which is how thirty-one pages of
 * one site were excluded from a run. Runs after the block-level Liquid tags have become elements,
 * so only braces that are still text are escaped, and never inside code, a tag, or a formula
 * (`gitbookMathBraces` has already escaped those).
 *
 * A paragraph that opens with `import ` or `export ` is prose here too — MDX would read it as ESM
 * and drop it — so its first letter is written as the character reference it stands for.
 */
/**
 * GitBook writes a required parameter as `<td><code>clientId</code>*</td>` inside an HTML table.
 * Read as MDX, that `*` opens an emphasis that runs across the cells until the next one and the
 * table fails to parse. A `*` that touches a tag boundary, or is the only one in its cell, pairs
 * with nothing and is the character.
 */
function gitbookTableAsterisks(segment: string): string {
  return segment.replace(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g, (cell) => {
    const count = (cell.match(/\*/g) ?? []).length;
    // a character reference, not a backslash: the cell is read by the HTML adapter, where `\*` would stay two characters
    return cell.replace(/\*/g, (star, offset: number, whole: string) => (count === 1 || whole[offset - 1] === '>' || whole[offset + 1] === '<' ? '&#42;' : star));
  });
}

function gitbookLiteralBraces(segment: string): string {
  return outsideCode(segment, (text) => text
    .split(/(<\/?[A-Za-z][^<>]*>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/(?<!\\)([{}])/g, '\\$1')))
    .join('')
    .replace(/^(import|export)(?=\s)/gm, (_, word: string) => `&#${word.charCodeAt(0)};${word.slice(1)}`));
}

/**
 * GitBook writes an emoji as its shortcode (`:boom:`, `:frame\_photo:` with the export's escape)
 * and renders the character; left as written, the reader sees the colons. The names are GitHub's,
 * with a few GitBook spells its own way. A name nothing knows stays as written, visibly, rather
 * than becoming a guess — and a `:word:` inside an identifier (`site:metadata:read`) is not a
 * shortcode at all.
 */
const GITBOOK_EMOJI_ALIASES: Record<string, string> = { frame_photo: 'framed_picture', frame_with_picture: 'framed_picture', tada: 'tada', cross_mark: 'x', check_mark: 'heavy_check_mark', heavy_check: 'heavy_check_mark' };
function gitbookEmojiShortcodes(segment: string): string {
  return outsideCode(segment, (text) => text
    .split(/(<[A-Za-z/][^<>]*>)/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/(?<![\w:/])(?<!:):([a-z0-9][a-z0-9_+\\-]*):(?![\w:])/g, (match, name: string) => {
      const key = name.replace(/\\_/g, '_');
      const emoji = nameToEmoji[key] ?? nameToEmoji[GITBOOK_EMOJI_ALIASES[key] ?? ''];
      return emoji ?? match;
    })))
    .join(''));
}

function gitbookMdxCompatible(segment: string): string {
  return autolinksMdxCompatible(voidElementsMdxCompatible(segment).replace(ESCAPED_AUTOLINK_LINK, (_, label, url) => `[${label}](${url})`));
}

/** CommonMark that ReadMe publishes and MDX rejects by its shape alone: void elements without `/>` and angle autolinks. */
function readmeMdxCompatible(segment: string): string {
  return autolinksMdxCompatible(voidElementsMdxCompatible(segment));
}

const README_LINK_SCHEMES: Record<string, string> = { doc: 'docs', ref: 'reference', page: 'page', changelog: 'changelog' };

/** ReadMe's own link forms: `doc:slug` and `ref:slug` name a guide or API page, and a trailing `#/` is its client router's empty route, not an anchor. */
function readmeLinkTarget(url: string): string {
  const scheme = url.match(/^([a-z]+):([^\s/#?][^\s#?]*)(.*)$/);
  const target = scheme && README_LINK_SCHEMES[scheme[1]] ? `/${README_LINK_SCHEMES[scheme[1]]}/${scheme[2]}${scheme[3]}` : url;
  return target.replace(/#\/$/, '');
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** The `<` MDX rejected with `error` because it starts no tag, so is text the source meant literally; undefined for any other failure. */
function strayLessThan(text: string, error: any): number | undefined {
  const offset = error?.place?.offset ?? error?.place?.start?.offset;
  if (typeof offset !== 'number' || error.source !== 'micromark-extension-mdx-jsx' || error.ruleId !== 'unexpected-character') return undefined;
  const open = text.lastIndexOf('<', offset - 1);
  return open >= 0 && !isEscaped(text, open) && /^[\w.:-]*$/.test(text.slice(open + 1, offset)) ? open : undefined;
}

/** Index of the quote closing the string opened at `open`, the newline that cuts it short, or -1 when the text ends inside it. */
function closingQuote(value: string, open: number): number {
  for (let i = open + 1; i < value.length; i++) {
    if (value[i] === '\\') i++;
    else if (value[i] === value[open] || value[i] === '\n') return i;
  }
  return -1;
}

/**
 * Whether `value` stops inside a string, template literal, block comment or open bracket. MDX asks acorn at each `}`
 * whether the expression is over, and reads on to the next `}` when acorn runs out of input
 * (micromark-util-events-to-acorn `swallow`), which is how `style={{ a: 1 }}` and a template holding `{` stay whole.
 */
function endsInsideJavaScript(value: string): boolean {
  const open: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (open[open.length - 1] === '`') {
      if (c === '\\') i++;
      else if (c === '`') open.pop();
      else if (c === '$' && value[i + 1] === '{') { open.push('}'); i++; }
      continue;
    }
    if (c === '"' || c === "'") { const end = closingQuote(value, i); if (end < 0) return true; i = end; }
    else if (c === '`') open.push('`');
    else if (c === '/' && value[i + 1] === '*') { const end = value.indexOf('*/', i + 2); if (end < 0) return true; i = end + 1; }
    else if (c === '/' && value[i + 1] === '/') { const end = value.indexOf('\n', i); i = end < 0 ? value.length : end; }
    else if (c === '(' || c === '[' || c === '{') open.push(c === '(' ? ')' : c === '[' ? ']' : '}');
    else if ((c === ')' || c === ']' || c === '}') && open[open.length - 1] === c) open.pop();
  }
  return open.length > 0;
}

/**
 * An acorn stand-in that locates every `{…}` in one parse without judging its JavaScript: an expression that is
 * lexically over is accepted whatever it says, and one that runs out of input asks MDX to read on, as acorn would.
 */
const LOCATING_ACORN = {
  parse: (value: string) => ({ type: 'Program', start: 0, end: value.length, body: [], sourceType: 'module', comments: [] }),
  parseExpressionAt: (value: string, pos: number) => {
    if (endsInsideJavaScript(value.slice(pos))) throw Object.assign(new SyntaxError('Unexpected end of input'), { pos: value.length, raisedAt: value.length });
    return { type: 'Identifier', name: 'expression', start: pos, end: value.length };
  },
};

/** The opening brace of every expression in prose. ReadMe renders prose braces (`{userId}`) as text; only a component's children and attributes hold expressions. MDX comments stay. */
function proseExpressionBraces(tree: any, text: string): number[] {
  const found: number[] = [];
  const visit = (node: any, inComponent: boolean): void => {
    if (node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression') {
      const offset = node.position?.start?.offset;
      if (!inComponent && !/^\s*\/\*[\s\S]*\*\/\s*$/.test(String(node.value)) && typeof offset === 'number' && text[offset] === '{' && !isEscaped(text, offset)) found.push(offset);
      return;
    }
    const component = inComponent || node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement';
    for (const child of node.children ?? []) visit(child, component);
  };
  visit(tree, false);
  return found;
}

/**
 * ReadMe's CommonMark treats a `<` that starts no tag (`>, <, >=`) and braces around prose
 * (`{host URL}`, `{userId}`) as text; MDX reads them as JSX and JavaScript.
 * - A stray `<` stops the parser, so each is found by one parse; there are never more retries than `<` characters.
 * - Every brace in prose is found by one locating parse and escaped from the last to the first, so no offset moves.
 * - The final parse judges the rest with real JavaScript: a component's expressions (an `<HTMLBlock>` template,
 *   `border={true}`) must be valid, and a tree that still reads prose as code is an error, never a result.
 */
function parseEscapingRejectedText(source: string, parse: (text: string, locating: boolean) => any): { tree: any; text: string } {
  let text = source;
  const retries = (source.match(/</g) ?? []).length;
  let located: any;
  for (let attempt = 0; located === undefined; attempt++) {
    try {
      located = parse(text, true);
    } catch (error) {
      const at = strayLessThan(text, error);
      if (at === undefined || attempt >= retries) throw error;
      text = `${text.slice(0, at)}\\${text.slice(at)}`;
    }
  }
  for (const at of proseExpressionBraces(located, text).sort((a, b) => b - a)) text = `${text.slice(0, at)}\\${text.slice(at)}`;
  const tree = parse(text, false);
  const remaining = proseExpressionBraces(tree, text);
  if (remaining.length) throw new Error(`MDX still reads ${remaining.length} brace(s) in prose as code after escaping, the first at offset ${remaining[0]}`);
  return { tree, text };
}

/**
 * Anything in a `{...}` attribute that is data rather than code. `tags={["a","b"]}`
 * and `rss={{ title: "x" }}` are values a component was given, not behaviour to run,
 * and refusing them keeps a whole component unresolved over its decoration. Code is
 * still refused: an arrow, a call, a bare identifier, a template literal or JSX has
 * no value until something evaluates it, and this never evaluates anything.
 */
const EXECUTABLE_SYNTAX = /=>|`|\bfunction\b|\bnew\b|\+\+|--|\.\.\./;

function dataLiteral(text: string): unknown {
  if (EXECUTABLE_SYNTAX.test(text)) return undefined;
  try { return JSON.parse(text) as unknown; } catch { /* JS object syntax, tried next */ }
  // A JS data literal differs from JSON only in unquoted keys and single quotes; both are
  // rewritten before parsing, and a bare identifier anywhere else still fails the parse.
  const json = text
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(json) as unknown; } catch { return undefined; }
}

function literalExpression(value: string): string | number | boolean | null | undefined {
  const v = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  // A double-quoted string may carry JSON escapes (the writer spells a value holding both quote
  // marks that way); it is read as the string it denotes. Anything JSON cannot parse keeps its text.
  if (/^"[\s\S]*"$/.test(v)) { try { return JSON.parse(v) as string; } catch { /* not JSON: read as written */ } }
  const quoted = v.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  // An array or object of literals is data the component was given, not code. It is recorded as its
  // canonical JSON text, because a prop holds a scalar here: what matters is that the component is
  // resolved rather than held back by a value no rule keeps, and the value stays exactly readable.
  if (/^[[{]/.test(v)) {
    const data = dataLiteral(v);
    return data === undefined ? undefined : JSON.stringify(data);
  }
  return undefined;
}

/** GitBook's published Markdown links a page by its `.md` file (a section by its `readme.md`) and a deleted page as `broken://pages/…`; the site links the page itself and shows a broken link as its text. */
function gitbookLinkTarget(url: string): string | undefined {
  if (/^broken:\/\//i.test(url)) return undefined;
  const page = url.match(/^(\/[^?#\s]*?)(?:\/readme)?\.md((?:[?#]\S*)?)$/i);
  return page ? `${page[1] || '/'}${page[2]}` : url;
}

function gitbookInlineLinks(nodes: Inline[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    switch (node.type) {
      case 'link': {
        const url = gitbookLinkTarget(node.url);
        return url === undefined ? gitbookInlineLinks(node.children) : [{ ...node, url, children: gitbookInlineLinks(node.children) }];
      }
      case 'strong': case 'emphasis': case 'delete': case 'kbd': return [{ ...node, children: gitbookInlineLinks(node.children) }];
      default: return [node];
    }
  });
}

function gitbookBlockLinks(block: Block): Block {
  switch (block.type) {
    case 'paragraph': case 'heading': return { ...block, children: gitbookInlineLinks(block.children) };
    case 'blockquote': return { ...block, children: block.children.map(gitbookBlockLinks) };
    case 'list': return { ...block, children: block.children.map((item) => ({ ...item, children: item.children.map(gitbookBlockLinks) })) };
    case 'table': return { ...block, children: block.children.map((row) => ({ ...row, children: row.children.map((cell) => ({ ...cell, children: gitbookInlineLinks(cell.children) })) })) };
    case 'figure': return block.caption ? { ...block, caption: gitbookInlineLinks(block.caption) } : block;
    case 'component': {
      const props = { ...block.props };
      if (typeof props.href === 'string') {
        const href = gitbookLinkTarget(props.href);
        if (href === undefined) delete props.href; else props.href = href;
      }
      return { ...block, props, children: block.children.map(gitbookBlockLinks) };
    }
    default: return block;
  }
}

function mdastText(node: any): string {
  return node.type === 'text' || node.type === 'inlineCode' ? String(node.value ?? '') : (node.children ?? []).map(mdastText).join('');
}

/** `<details><summary>Title</summary>…`: the summary is the details' title, lifted into the `summary` prop the HTML adapter also records. */
function liftSummary(node: any): any {
  if ((node.attributes ?? []).some((a: any) => a.name === 'summary')) return node;
  const meaningful = (nodes: any[]) => nodes.filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
  const isSummary = (c: any) => (c?.type === 'mdxJsxFlowElement' || c?.type === 'mdxJsxTextElement') && String(c.name).toLowerCase() === 'summary';
  const index = (node.children ?? []).findIndex((c: any) => isSummary(c) || (c.type === 'paragraph' && meaningful(c.children ?? []).length === 1 && isSummary(meaningful(c.children ?? [])[0])));
  if (index < 0) return node;
  const holder = node.children[index];
  const summary = isSummary(holder) ? holder : meaningful(holder.children)[0];
  const title = mdastText(summary).replace(/\s+/g, ' ').trim();
  return { ...node, attributes: [...(node.attributes ?? []), { type: 'mdxJsxAttribute', name: 'summary', value: title }], children: node.children.filter((_: any, i: number) => i !== index) };
}

/**
 * GitBook's block-form OpenAPI reference (`{% openapi src="…" path="/pet" method="post" %}`), read
 * as the operation it documents. The spec is a URL; the platform reads the file captured from it
 * (`acquire --openapi <url>` supplies one the capture cannot reach), and the block's own text —
 * a description the author wrote — stays on the page.
 */
function gitbookOperationBlock(children: Block[]): { children: Block[]; operation: import('./types.js').OpenApiOperationFragment } | undefined {
  const at = children.findIndex((block) => block.type === 'component' && block.name === 'openapi' && typeof block.props.src === 'string' && /^https?:\/\//i.test(block.props.src) && typeof block.props.path === 'string' && typeof block.props.method === 'string');
  if (at < 0) return undefined;
  const block = children[at] as Extract<Block, { type: 'component' }>;
  const operation = { spec: capturedSpecFile(String(block.props.src)), method: String(block.props.method).toUpperCase(), path: String(block.props.path), document: '', specUrl: String(block.props.src) };
  // What the export wrote inside the block is GitBook's own rendering of the operation — the spec
  // link, "Test it (powered by Scalar)", the parameters — which the platform renders afresh from
  // the spec the frontmatter names. Kept, the page would show the operation twice, once as chrome.
  return { children: [...children.slice(0, at), ...children.slice(at + 1)], operation };
}

export function markdownToIr(source: string, opts: MarkdownAdapterOptions): DocIR {
  const { data, body } = splitFrontmatter(source, opts.file);
  // `locating` parses with an acorn that accepts any expression; see parseEscapingRejectedText
  const parse = (text: string, locating = false): any => fromMarkdown(text, {
    extensions: [gfm(), locating ? mdxjs({ acorn: LOCATING_ACORN as any }) : mdxjs()],
    mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
  });
  const preprocessed = preprocessPlatformMarkdown(body, opts.platform);
  const { tree, text: prepared } = opts.platform === 'readme' ? parseEscapingRejectedText(preprocessed, parse) : { tree: parse(preprocessed), text: preprocessed };

  const sourceSlice = (node: any): string => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    return typeof start === 'number' && typeof end === 'number' ? prepared.slice(start, end) : String(node.value ?? node.type);
  };
  const idOf = (node: any, path: number[]) => nodeId(opts.file, path, sourceSlice(node));
  const imports = snippetImports(tree);
  const definitions = new Map<string, { url: string; title?: string }>();
  const collectDefinitions = (nodes: ReadonlyArray<{ type: string; identifier?: string; url?: string; title?: string | null; children?: typeof nodes }>): void => {
    for (const node of nodes) {
      if (node.type === 'definition' && node.identifier && node.url !== undefined && !definitions.has(node.identifier)) definitions.set(node.identifier, { url: node.url, title: node.title ?? undefined });
      if (node.children) collectDefinitions(node.children);
    }
  };
  collectDefinitions(tree.children);
  const unsupported = (node: { type: string; position?: { start?: { line?: number } } }): never => {
    throw new Error(`${opts.file}:${node.position?.start?.line ?? '?'}: unsupported Markdown node ${node.type}; add a lossless mapping before migrating this page`);
  };
  const srcOf = (node: any) => ({ file: opts.file, line: node.position?.start?.line, col: node.position?.start?.column });

  // A Markdown image has no caption syntax: what the source shows under it is nothing.
  const imageFromMarkdown = (node: any, path: number[]): ImageNode => ({ id: idOf(node, path), src: srcOf(node), type: 'image', url: node.url ?? '', alt: node.alt ?? '', title: node.title ?? undefined, ...(opts.platform !== 'dai' ? { captionless: true } : {}) });

  const imageFromMdx = (node: any, path: number[]): ImageNode => {
    const attrs: Record<string, string | number | boolean | null> = {};
    for (const attr of node.attributes ?? []) {
      if (attr.type !== 'mdxJsxAttribute' || typeof attr.name !== 'string') continue;
      if (attr.value === null) attrs[attr.name] = true;
      else if (typeof attr.value === 'string') attrs[attr.name] = attr.value;
      else attrs[attr.name] = literalExpression(String(attr.value?.value ?? '')) ?? null;
    }
    // A dimension the source states but the target's integer-pixel contract cannot carry is a loss,
    // not an absence. It is recorded verbatim on the node; the stage that knows fidelityMode decides.
    const width = readPixelDimension(attrs.width);
    const height = readPixelDimension(attrs.height);
    return {
      id: idOf(node, path), src: srcOf(node), type: 'image',
      url: typeof attrs.src === 'string' ? attrs.src : '', alt: typeof attrs.alt === 'string' ? attrs.alt : '',
      title: typeof attrs.title === 'string' ? attrs.title : undefined,
      ...themeClassOf(attrs.className ?? attrs.class),
      ...decorativeOf(attrs as Record<string, unknown>),
      ...(opts.platform !== 'dai' || String(attrs.className ?? attrs.class ?? '').split(/\s+/).includes('dai-mig-no-caption') ? { captionless: true } : {}),
      width: width.value, height: height.value,
      ...(width.unreadable !== undefined ? { unreadableWidth: width.unreadable } : {}),
      ...(height.unreadable !== undefined ? { unreadableHeight: height.unreadable } : {}),
    };
  };

  /** An `<Image caption="…">` this tool wrote is the figure it was written from; the caption is text the reader sees under it. */
  const figureOrImage = (node: any, path: number[]): Block => {
    const image = imageFromMdx(node, path);
    const caption = (node.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === 'caption');
    if (typeof caption?.value !== 'string' || !caption.value.trim()) return image;
    return { id: `${image.id}:figure`, src: image.src, type: 'figure', image, caption: [{ id: `${image.id}:caption`, src: image.src, type: 'text', value: caption.value }] };
  };

  const inline = (nodes: any[], path: number[]): Inline[] => nodes.flatMap((node, index): Inline[] => {
    const p = [...path, index];
    const base = { id: idOf(node, p), src: srcOf(node) };
    switch (node.type) {
      case 'text': return [{ ...base, type: 'text', value: node.value }];
      case 'inlineCode': return [{ ...base, type: 'inlineCode', value: node.value }];
      case 'footnoteReference': return [{ ...base, type: 'footnoteReference', identifier: String(node.identifier ?? node.label ?? '') }];
      case 'strong': return [{ ...base, type: 'strong', children: inline(node.children ?? [], p) }];
      case 'emphasis': return [{ ...base, type: 'emphasis', children: inline(node.children ?? [], p) }];
      case 'delete': return [{ ...base, type: 'delete', children: inline(node.children ?? [], p) }];
      case 'link': return [{ ...base, type: 'link', url: opts.platform === 'readme' ? readmeLinkTarget(node.url ?? '') : node.url ?? '', title: node.title ?? undefined, children: inline(node.children ?? [], p) }];
      case 'linkReference': {
        const definition = definitions.get(node.identifier);
        if (!definition) return unsupported(node);
        return [{ ...base, type: 'link', ...definition, ...(opts.platform === 'readme' ? { url: readmeLinkTarget(definition.url) } : {}), children: inline(node.children ?? [], p) }];
      }
      case 'imageReference': {
        const definition = definitions.get(node.identifier);
        if (!definition) return unsupported(node);
        return [imageFromMarkdown({ ...node, ...definition }, p)];
      }
      case 'image': return [imageFromMarkdown(node, p)];
      case 'break': return [{ ...base, type: 'break' }];
      case 'html': {
        const value = sanitizeHtmlToJsx(node.value ?? '');
        return value ? [{ ...base, type: 'inlineHtml', value }] : [];
      }
      case 'mdxTextExpression':
        return /^user\.[A-Za-z_][\w]*$/.test(String(node.value).trim())
          ? [{ ...base, type: 'inlineHtml', value: `{${String(node.value).trim()}}` }]
          : [{ ...base, type: 'inlineHtml', value: `{/* UNSUPPORTED EXPRESSION ${idOf(node, p)} */}` }];
      case 'mdxJsxTextElement': {
        const name = String(node.name).toLowerCase();
        if (isImageElement(node)) return [imageFromMdx(node, p)];
        // A responsive image: the wrapper and its sources are the theme's art direction, the img is
        // the content. GitBook wraps every picture this way; read whole, each wrapper left a marker.
        if (name === 'picture') { const picture = pictureImage(node, p); if (picture) return [picture]; }
        if (name === 'source') return [];
        if (name === 'br') return [{ ...base, type: 'break' }];
        const attribute = (key: string): string | undefined => {
          const found = (node.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === key);
          return typeof found?.value === 'string' ? found.value : undefined;
        };
        const plainText = (): string => inlineText(inline(node.children ?? [], p));
        const escapeHtmlText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        // Inline HTML any platform's Markdown may carry, read as what it renders: a link, a code
        // span, a superscript. Left as unknown components, each one was a marker in the output.
        if (name === 'a' && attribute('href') && opts.platform !== 'dai') return [{ ...base, type: 'link', url: attribute('href')!, title: attribute('title'), children: inline(node.children ?? [], p) }];
        if (name === 'code' && (node.children ?? []).every((c: any) => c.type === 'text')) return [{ ...base, type: 'inlineCode', value: (node.children ?? []).map((c: any) => String(c.value)).join('') }];
        // GitBook's inline assistant and search buttons open GitBook's own panels: platform chrome,
        // dropped here exactly as the block rule drops them when they stand alone.
        if (opts.platform === 'gitbook' && name === 'button' && ['ask', 'search'].includes(attribute('data-action') ?? '')) return [];
        if (['sup', 'sub', 'mark', 'u', 'small'].includes(name) && opts.platform !== 'dai') return [{ ...base, type: 'inlineHtml', value: `<${name}>${escapeHtmlText(plainText())}</${name}>` }];
        if (opts.platform === 'mintlify') {
          // Mintlify's inline components. An <Icon> is a glyph with no words and no target
          // equivalent: decoration the page loses. A <Badge> keeps its text as the badge span the
          // block rule writes. A <Tooltip tip="…"> keeps its text, and the tip as the title a browser
          // shows on hover, which is what the reader had.
          if (node.name === 'Icon') return [];
          if (node.name === 'Badge') return [{ ...base, type: 'inlineHtml', value: `<span className="dai-mig-badge">${escapeHtmlText(plainText())}</span>` }];
          if (node.name === 'Tooltip') {
            const tip = attribute('tip');
            return tip ? [{ ...base, type: 'inlineHtml', value: `<abbr title="${tip.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">${escapeHtmlText(plainText())}</abbr>` }] : inline(node.children ?? [], p);
          }
        }
        if (name === 'kbd') return [{ ...base, type: 'kbd', children: inline(node.children ?? [], p) }];
        if (opts.platform === 'readme' && node.name === 'Anchor') {
          // ReadMe's link component: its children are the visible text (label repeats it); target only opens a new tab
          const value = (key: string) => (node.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === key)?.value;
          const href = value('href');
          const label = value('label');
          const children = inline(node.children ?? [], p);
          if (typeof href === 'string') return [{ ...base, type: 'link', url: readmeLinkTarget(href), children: children.length || typeof label !== 'string' ? children : [{ ...base, type: 'text', value: label }] }];
        }
        // ReadMe's glossary term renders as the term, with a definition from the project's glossary on hover; the page holds only the term
        if (opts.platform === 'readme' && node.name === 'Glossary') return inline(node.children ?? [], p);
        // ReadMe's editor writes some inline formatting as HTML elements
        if ((opts.platform === 'readme' || opts.platform === 'dai') && (name === 'strong' || name === 'b')) return [{ ...base, type: 'strong', children: inline(node.children ?? [], p) }];
        if ((opts.platform === 'readme' || opts.platform === 'dai') && (name === 'em' || name === 'i')) return [{ ...base, type: 'emphasis', children: inline(node.children ?? [], p) }];
        if (opts.platform === 'dai' && (name === 'del' || name === 's')) return [{ ...base, type: 'delete', children: inline(node.children ?? [], p) }];
        if (opts.platform === 'gitbook' && isGitbookHtmlInline(name)) return htmlInline(node, p);
        // Reading back a file this tool wrote, an inline HTML element it emitted verbatim reads back
        // as what was written. The marker below exists so a *source* platform's component reaches a
        // person; an element in this tool's own output was decided when it was written, and turning
        // it into a marker made the file disagree with the IR it was serialized from.
        if (opts.platform === 'dai') {
          const attrs = (node.attributes ?? []).filter((a: any) => a.type === 'mdxJsxAttribute');
          const attrValue = (key: string): string | undefined => {
            const found = attrs.find((a: any) => a.name === key);
            return typeof found?.value === 'string' ? found.value : undefined;
          };
          const kids = node.children ?? [];
          // An empty `<a id="…">` is an anchor target kept so an address the source published still works.
          if (name === 'a' && !kids.length && !attrValue('href')) {
            const anchorId = attrValue('id') ?? attrValue('name');
            if (anchorId) return [{ ...base, type: 'inlineHtml', value: `<a id="${anchorId}"></a>` }];
          }
          // An element with no attributes wrapping plain text is rebuilt exactly as it was written.
          if (!attrs.length && kids.length && kids.every((c: any) => c.type === 'text')) {
            return [{ ...base, type: 'inlineHtml', value: `<${name}>${kids.map((c: any) => c.value).join('')}</${name}>` }];
          }
          // The two attributed inline elements this tool writes: the span it composes for a source
          // badge, and the abbr that carries a tooltip's hover text. Both are its own spelling, so
          // both read back as themselves; without this the file disagreed with the IR it came from
          // and every page carrying a badge failed the serialization gate.
          const plain = kids.length && kids.every((c: any) => c.type === 'text') ? kids.map((c: any) => c.value).join('') : undefined;
          if (plain !== undefined && name === 'span' && attrValue('className') === 'dai-mig-badge') {
            return [{ ...base, type: 'inlineHtml', value: `<span className="dai-mig-badge">${escapeHtmlText(plain)}</span>` }];
          }
          if (plain !== undefined && name === 'abbr' && attrValue('title') !== undefined) {
            const tip = attrValue('title')!;
            return [{ ...base, type: 'inlineHtml', value: `<abbr title="${tip.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">${escapeHtmlText(plain)}</abbr>` }];
          }
        }
        const text = inline(node.children ?? [], p);
        // Inline source components need a human decision; preserve their visible
        // text and leave a blocking marker rather than silently changing meaning.
        return [{ ...base, type: 'inlineHtml', value: `{/* UNSUPPORTED INLINE COMPONENT ${node.name ?? 'fragment'} */}` }, ...text];
      }
      default:
        return unsupported(node);
    }
  });

  /** GitBook writes inline HTML (button links, <strong>, Font Awesome <i>); CommonMark reads it as HTML, so each becomes the matching inline node. */
  const htmlInline = (node: any, p: number[]): Inline[] => {
    const attr = (key: string): string | undefined => {
      const found = (node.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === key);
      return typeof found?.value === 'string' ? found.value : undefined;
    };
    const base = { id: idOf(node, p), src: srcOf(node) };
    const children = () => inline(node.children ?? [], p);
    switch (String(node.name).toLowerCase()) {
      case 'a': return [{ ...base, type: 'link', url: attr('href') ?? '', title: attr('title'), children: children() }];
      case 'strong': case 'b': return [{ ...base, type: 'strong', children: children() }];
      case 'em': return [{ ...base, type: 'emphasis', children: children() }];
      // a Font Awesome icon is decoration, and its text is GitBook's :shortcode: fallback
      case 'i': return /(?:^|\s)fa-/.test(attr('class') ?? '') ? [] : [{ ...base, type: 'emphasis', children: children() }];
      case 'del': case 's': case 'strike': return [{ ...base, type: 'delete', children: children() }];
      default: return children();
    }
  };

  const component = (node: any, path: number[]): ComponentNode => {
    if (opts.platform !== 'dai' && String(node.name).toLowerCase() === 'details') node = liftSummary(node);
    const props: ComponentNode['props'] = {};
    const styleDeps: string[] = [];
    for (const attr of node.attributes ?? []) {
      if (attr.type !== 'mdxJsxAttribute' || typeof attr.name !== 'string') {
        styleDeps.push('expression:spread');
        continue;
      }
      if (attr.value === null) props[attr.name] = true;
      else if (typeof attr.value === 'string') props[attr.name] = attr.value;
      else {
        const literal = literalExpression(String(attr.value?.value ?? ''));
        if (literal === undefined) {
          props[attr.name] = null;
          styleDeps.push(`expression:${attr.name}`);
        } else props[attr.name] = literal;
      }
    }
    // A grid wrapper is a layout the platform can express, unlike every other utility class on a div:
    // the marker lets a mapping rule tell the two apart without reading class names itself.
    if (opts.platform !== 'dai' && String(node.name).toLowerCase() === 'div') {
      const classes = String(props.className ?? props.class ?? '').split(/\s+/);
      if (classes.includes('grid') && classes.some((token) => /(?:^|:)grid-cols-([2-9]|1[0-2])$/.test(token))) styleDeps.push('layout:grid');
    }
    return {
      id: idOf(node, path), src: srcOf(node), type: 'component',
      name: node.name ?? 'mdxFragment', platform: opts.platform, props,
      children: blocks(node.children ?? [], [...path, 0]),
      styleDeps: styleDeps.length ? styleDeps : undefined,
    };
  };

  /** A non-literal attribute keeps the node a source component so exact mode stops on it instead of accepting it as resolved. */
  const jsxElement = (node: any, path: number[]): Block => {
    // The badge span this tool composes, standing on its own. It was written as raw HTML and reads
    // back as the same raw HTML; read as a component it would disagree with the IR it came from.
    if (opts.platform === 'dai' && String(node.name) === 'span') {
      const attrs = (node.attributes ?? []).filter((a: any) => a.type === 'mdxJsxAttribute');
      const kids = node.children ?? [];
      const className = attrs.length === 1 && attrs[0].name === 'className' && typeof attrs[0].value === 'string' ? attrs[0].value : undefined;
      if (className === 'dai-mig-badge' && kids.length && kids.every((c: any) => c.type === 'text')) {
        const text = kids.map((c: any) => c.value).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return { id: idOf(node, path), src: srcOf(node), type: 'rawHtml', value: `<span className="dai-mig-badge">${text}</span>`, reviewFlag: 'T4 compose: badge → span (custom CSS)' };
      }
    }
    const source = component(node, path);
    if (opts.platform !== 'dai' || source.styleDeps?.length || !isContractComponentName(source.name)) return source;
    return { id: source.id, src: source.src, type: 'dai', name: source.name, props: source.props, children: source.children };
  };

  /** GitBook blocks written as HTML, or a fence wrapped in `{% code %}`; undefined leaves the element a source component. */
  const gitbookFlow = (node: any, path: number[]): Block[] | undefined => {
    const name = String(node.name ?? '').toLowerCase();
    if (name === 'code') {
      // {% code title="app.js" %} around one fence is that fence with a title; overflow, lineNumbers and expandable only style it
      const inner = (node.children ?? []).filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
      if (inner.length !== 1 || inner[0].type !== 'code') return undefined;
      const [fence] = blocks(inner, [...path, 0]);
      const title = (node.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === 'title')?.value;
      return fence?.type === 'code' ? [typeof title === 'string' && title ? { ...fence, title } : fence] : undefined;
    }
    if (!isGitbookHtmlBlock(name)) return undefined;
    const html = sourceSlice(node);
    // CommonMark reads an HTML block as HTML up to its first blank line; one holding Markdown after a blank line keeps its parsed children
    if (!/\n[ \t]*\n/.test(html)) return gitbookHtmlBlockToIr(html, `${opts.file}::${idOf(node, path)}`);
    return TRANSPARENT_HTML.has(name) ? blocks(node.children ?? [], [...path, 0]) : undefined;
  };

  /**
   * A table cell's content as one inline run: Markdown formatting stays, each further block (a second
   * paragraph, a list item) follows a line break, and a list item keeps its marker (`• `, or its number) as
   * text, since a Markdown table cell cannot hold a list. Undefined when a block has no faithful inline form.
   */
  const flowInlines = (nodes: any[], path: number[]): Inline[] | undefined => {
    const content = nodes.filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
    if (content.every((c: any) => INLINE_TYPES.has(c.type))) return inline(content, path);
    const out: Inline[] = [];
    const flatten = (block: Block, marker = ''): boolean => {
      switch (block.type) {
        case 'paragraph': case 'heading':
          if (out.length) out.push({ id: `${block.id}::break`, type: 'break' });
          if (marker) out.push({ id: `${block.id}::marker`, type: 'text', value: marker });
          out.push(...block.children);
          return true;
        case 'list':
          return block.children.every((item, index) => item.children.every((child, position) => flatten(child, position ? '' : block.ordered ? `${(block.start ?? 1) + index}. ` : '• ')));
        default: return false;
      }
    };
    return blocks(content, path).every((block) => flatten(block)) ? out : undefined;
  };

  /**
   * ReadMe's <Table align={[…]}> of thead/tbody rows of th/td cells is a table. Column alignment comes from the
   * literal `align` array, else from the header cells' literal `textAlign`. Any other attribute, element or cell
   * content without an inline form leaves the element a source component.
   */
  const readmeTable = (node: any, path: number[]): Block[] | undefined => {
    const content = (n: any): any[] => (n.children ?? []).filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
    const isElement = (c: any, names: string[]) => (c.type === 'mdxJsxFlowElement' || c.type === 'mdxJsxTextElement') && names.includes(c.name);
    const expression = (element: any, key: string) => (element.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === key)?.value?.data?.estree?.body?.[0]?.expression;
    const alignOf = (value: unknown): 'left' | 'center' | 'right' | null => (value === 'left' || value === 'center' || value === 'right' ? value : null);
    if ((node.attributes ?? []).some((a: any) => a.type !== 'mdxJsxAttribute' || a.name !== 'align')) return undefined;
    const sections = content(node);
    if (!sections.length || !sections.every((s) => isElement(s, ['thead', 'tbody']))) return undefined;
    const rows: TableRowNode[] = [];
    let headerCells: any[] | undefined;
    for (const [si, section] of sections.entries()) {
      for (const [ri, tr] of content(section).entries()) {
        if (!isElement(tr, ['tr'])) return undefined;
        const sourceCells = content(tr);
        if (!sourceCells.every((c) => isElement(c, ['th', 'td']) && (c.attributes ?? []).every((a: any) => a.type === 'mdxJsxAttribute' && a.name === 'style'))) return undefined;
        const rowPath = [...path, si, ri];
        const cells: TableCellNode[] = [];
        for (const [ci, cell] of sourceCells.entries()) {
          const children = flowInlines(cell.children ?? [], [...rowPath, ci]);
          if (!children) return undefined;
          cells.push({ id: idOf(cell, [...rowPath, ci]), src: srcOf(cell), type: 'tableCell', children });
        }
        const isHeader = section.name === 'thead' && sourceCells.length > 0 && sourceCells.every((c) => c.name === 'th');
        if (isHeader) headerCells ??= sourceCells;
        rows.push({ id: idOf(tr, rowPath), src: srcOf(tr), type: 'tableRow', isHeader, children: cells });
      }
    }
    if (!rows.length) return undefined;
    const declared = expression(node, 'align');
    const align = declared?.type === 'ArrayExpression' && declared.elements.every((e: any) => e?.type === 'Literal')
      ? declared.elements.map((e: any) => alignOf(e.value))
      : headerCells?.map((cell) => alignOf(expression(cell, 'style')?.properties?.find((p: any) => (p.key?.name ?? p.key?.value) === 'textAlign')?.value?.value));
    return [{ id: idOf(node, path), src: srcOf(node), type: 'table', ...(align?.some((a: unknown) => a) ? { align } : {}), children: rows }];
  };

  /**
   * ReadMe's <HTMLBlock>{`…`}</HTMLBlock> holds a static HTML document as a template literal. It is page content
   * (link menus, tiles), read by the HTML adapter without its <title>. Its scripts and styles, wherever they sit,
   * stay components so the rules engine records what dropping them loses (often the widget itself). An
   * interpolated template, or one with no content, stays an expression.
   */
  const readmeFlow = (node: any, path: number[]): Block[] | undefined => {
    if (node.name === 'Table') return readmeTable(node, path);
    // a <br /> alone between blocks is editor spacing with nothing to render
    if (node.name === 'br' && (node.children ?? []).every((c: any) => c.type === 'text' && !String(c.value).trim())) return [];
    if (node.name === 'Anchor') { const link = inline([{ ...node, type: 'mdxJsxTextElement' }], path); return link[0]?.type === 'link' ? [{ id: idOf(node, path), src: srcOf(node), type: 'paragraph', children: link }] : undefined; }
    if (node.name !== 'HTMLBlock') return undefined;
    const inner = (node.children ?? []).filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
    const template = inner.length === 1 && inner[0].type === 'mdxFlowExpression' ? inner[0].data?.estree?.body?.[0]?.expression : undefined;
    const html = template?.type === 'TemplateLiteral' && !template.expressions.length ? template.quasis[0]?.value?.cooked : undefined;
    if (typeof html !== 'string') return undefined;
    const converted = htmlToIr(html, { platform: opts.platform, file: `${opts.file}::${idOf(node, path)}`, removeSelectors: ['title'] }).children;
    return converted.length ? mapBlocks(converted, { inline: (n) => (n.type === 'link' ? { ...n, url: readmeLinkTarget(n.url) } : n) }) : undefined;
  };

  /**
   * A table written as raw HTML in Markdown. Published Markdown carries <table> with the usual
   * thead/tbody/tr/th/td, which otherwise reach the plan as eight separate unmapped components and
   * are preserved as fragments - keeping the look and losing the structure every later stage reads.
   * This is the same conversion from-html performs, done here because the element arrives as MDX.
   *
   * A merged cell has no expression in a Markdown table, so a table holding one is left alone for a
   * person to decide rather than silently reshaped into a grid the source does not state.
   */
  const htmlTableFlow = (node: any, path: number[]): Block[] | undefined => {
    if (String(node.name ?? '').toLowerCase() !== 'table') return undefined;
    const attr = (element: any, name: string): string | undefined =>
      (element.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && String(a.name).toLowerCase() === name)?.value;
    const named = (element: any, names: string[]): boolean =>
      (element?.type === 'mdxJsxFlowElement' || element?.type === 'mdxJsxTextElement') && names.includes(String(element.name ?? '').toLowerCase());
    let merged = false;
    const rows: TableRowNode[] = [];
    const collect = (children: any[], header: boolean, p: number[]): void => {
      children.forEach((child: any, index: number) => {
        if (named(child, ['thead'])) collect(child.children ?? [], true, [...p, index]);
        else if (named(child, ['tbody', 'tfoot'])) collect(child.children ?? [], header, [...p, index]);
        else if (named(child, ['tr'])) {
          // Cells written on adjacent lines are inline, so mdast wraps them in a paragraph inside
          // the row; cells separated by blank lines are flow. Both spellings are the same row.
          const found: any[] = [];
          const gather = (nodes: any[]): void => {
            for (const candidate of nodes) {
              if (named(candidate, ['td', 'th'])) found.push(candidate);
              else if (candidate?.children) gather(candidate.children);
            }
          };
          gather(child.children ?? []);
          let isHeader = header;
          const cells: TableCellNode[] = found.map((cell: any, cellIndex: number) => {
            if (attr(cell, 'colspan') || attr(cell, 'rowspan')) merged = true;
            if (String(cell.name).toLowerCase() === 'th') isHeader = true;
            const at = [...p, index, cellIndex];
            return { id: idOf(cell, at), type: 'tableCell' as const, children: flowInlines(cell.children ?? [], at) ?? [] };
          });
          if (cells.length) rows.push({ id: idOf(child, [...p, index]), type: 'tableRow', isHeader, children: cells });
        }
      });
    };
    collect(node.children ?? [], false, path);
    if (merged || !rows.length) return undefined;
    return [{ id: idOf(node, path), type: 'table', children: rows }];
  };

  /** The image inside a `<picture>`, carrying its `<source>` candidates, or undefined when it holds none. */
  const pictureImage = (node: any, path: number[]): ImageNode | undefined => {
    const kids: any[] = node.children ?? [];
    const img = kids.find((child) => (child.type === 'mdxJsxTextElement' || child.type === 'mdxJsxFlowElement') && String(child.name).toLowerCase() === 'img');
    if (!img) return undefined;
    const sources = kids
      .filter((child) => (child.type === 'mdxJsxTextElement' || child.type === 'mdxJsxFlowElement') && String(child.name).toLowerCase() === 'source')
      .flatMap((child) => { const value = (child.attributes ?? []).find((a: any) => a.type === 'mdxJsxAttribute' && a.name === 'srcset')?.value; return typeof value === 'string' ? srcsetUrls(value) : []; })
      // GitBook states a dark-mode variant by internal id, which it publishes at no address; the
      // <img> beside it is the picture the page shows, so the candidate is dropped, not hosted.
      .filter((url) => !(opts.platform === 'gitbook' && isGitbookInternalFileRef(url)));
    const image = imageFromMdx(img, path);
    return sources.length ? { ...image, sources: [...new Set([...(image.sources ?? []), ...sources])] } : image;
  };

  const jsxFlow = (node: any, path: number[]): Block[] => {
    if (isImageElement(node)) return [figureOrImage(node, path)];
    // An inline element alone on a line of this tool's own output — `<mark>This text is orange.</mark>` —
    // is the paragraph it was written from: MDX reads it as a flow element, but `mark` has no block
    // reading, so it is the inline it always was.
    const flowInline = String(node.name).toLowerCase();
    const phrasingOnly = (node.children ?? []).every((child: any) => child.type !== 'mdxJsxFlowElement' && !['paragraph', 'heading', 'list', 'code', 'blockquote'].includes(child.type));
    // Emphasis this tool wrote as HTML (words that begin or end in punctuation) opening a line is
    // the paragraph it was, with the emphasis it was.
    if (opts.platform === 'dai' && ['strong', 'b', 'em', 'i', 'del', 's'].includes(flowInline) && phrasingOnly) {
      const type = flowInline === 'strong' || flowInline === 'b' ? 'strong' : flowInline === 'em' || flowInline === 'i' ? 'emphasis' : 'delete';
      const id = idOf(node, path);
      return [{ id, src: srcOf(node), type: 'paragraph', children: [{ id: `${id}:${type}`, src: srcOf(node), type, children: inline(node.children ?? [], [...path, 0]) } as Inline] }];
    }
    if (opts.platform === 'dai' && ['mark', 'u', 'sup', 'sub', 'small', 'kbd'].includes(flowInline) && phrasingOnly) {
      const children = inline(node.children ?? [], [...path, 0]);
      const name = flowInline;
      const value = `<${name}>${inlineText(children).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${name}>`;
      return [{ id: idOf(node, path), src: srcOf(node), type: 'paragraph', children: [{ id: `${idOf(node, path)}:html`, src: srcOf(node), type: 'inlineHtml', value }] }];
    }
    if (String(node.name).toLowerCase() === 'picture') { const picture = pictureImage(node, path); if (picture) return [picture]; }
    if (opts.platform === 'gitbook') { const converted = gitbookFlow(node, path); if (converted) return converted; }
    if (opts.platform === 'readme') { const converted = readmeFlow(node, path); if (converted) return converted; }
    // After the platform's own reading: GitBook and ReadMe give a <table> meanings of their own
    // (a row of cards, a button), and only a table nothing else claimed is read as a plain table.
    { const converted = htmlTableFlow(node, path); if (converted) return converted; }
    const importPath = node.name ? imports.get(node.name) : undefined;
    if (importPath && /\.mdx?$/.test(importPath) && !(node.attributes ?? []).length && opts.resolveSnippet) {
      const body = opts.resolveSnippet(importPath);
      if (body !== undefined) {
        const stack = opts.snippetStack ?? [];
        if (stack.includes(importPath)) throw new Error(`${opts.file}: recursive snippet import ${[...stack, importPath].join(' -> ')}`);
        // Each occurrence needs distinct ledger identities, including reuse on one page.
        const sub = markdownToIr(body, { ...opts, file: `${opts.file}::${idOf(node, path)}::${importPath}`, snippetStack: [...stack, importPath] });
        return sub.children;
      }
    }
    const element = jsxElement(node, path);
    if (element.type === 'component' && element.name === 'snippetRef') return [{ id: element.id, src: element.src, type: 'snippetRef', token: String(element.props.token ?? ''), platform: opts.platform }];
    return [element];
  };

  const INLINE_TYPES = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'break', 'html', 'mdxTextExpression', 'mdxJsxTextElement']);
  /** JSX flow elements may hold inline nodes directly (<Note>text</Note>); wrap each run of them in a synthetic paragraph so no text is lost. */
  const groupInline = (nodes: any[]): any[] => {
    const out: any[] = []; let run: any[] = [];
    const flush = () => { if (run.length) { const text = run.map((n) => n.value ?? '').join('').trim(); if (text || run.some((n) => n.type !== 'text')) out.push({ type: 'paragraph', children: run, position: run[0].position }); run = []; } };
    for (const n of nodes) { if (INLINE_TYPES.has(n.type)) run.push(n); else { flush(); out.push(n); } }
    flush();
    return out;
  };

  const blocks = (rawNodes: any[], path: number[]): Block[] => groupInline(rawNodes).flatMap((node, index): Block[] => {
    const p = [...path, index];
    const base = { id: idOf(node, p), src: srcOf(node) };
    switch (node.type) {
      case 'paragraph': {
        const meaningful = (node.children ?? []).filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
        // <Note>text</Note> on a single line parses as an inline JSX element wrapped in a paragraph; that is a block
        // component, and adjacent single-line elements (<Card>…</Card>\n<Card>…</Card>) are that many block components in order
        const isBlockElement = (c: any) => c.type === 'mdxJsxTextElement' && c.name && !isInlineOnlyElement(c) && !(opts.platform === 'gitbook' && isGitbookHtmlInline(String(c.name)));
        if (meaningful.length && meaningful.every(isBlockElement)) return meaningful.flatMap((element: any, index: number) => jsxFlow({ ...element, type: 'mdxJsxFlowElement' }, [...p, index]));
        const only = meaningful.length === 1 ? meaningful[0] : undefined;
        // an image alone on its line is a block image whichever syntax wrote it, the normal form the HTML adapter also uses
        if (only?.type === 'image') return [imageFromMarkdown(only, p)];
        if (only?.type === 'imageReference') {
          const definition = definitions.get(only.identifier);
          if (!definition) return unsupported(only);
          return [imageFromMarkdown({ ...only, ...definition }, p)];
        }
        return [{ ...base, type: 'paragraph', children: inline(node.children ?? [], p) }];
      }
      case 'heading': {
        let sourceId: string | undefined;
        const children = inline(node.children ?? [], p).flatMap((n): Inline[] => {
          if (n.type !== 'text') return [n];
          const m = n.value.match(new RegExp(`\\s*${ANCHOR_OPEN}([^${ANCHOR_CLOSE}]+)${ANCHOR_CLOSE}`));
          if (!m) return [n];
          sourceId = m[1];
          const value = n.value.replace(m[0], '');
          return value ? [{ ...n, value }] : [];
        });
        return [{ ...base, type: 'heading', depth: node.depth, children, sourceId }];
      }
      case 'code': {
        // GitBook writes an API operation, or a models-page schema, as a fenced OpenAPI document
        if (opts.platform === 'gitbook' && (!node.lang || node.lang === 'json')) {
          const scope = `${opts.file}::${idOf(node, p)}`;
          const api = gitbookOpenApiBlocks(String(node.value ?? ''), { file: scope, markdown: (text, key) => markdownToIr(text, { platform: opts.platform, file: `${scope}:${key}`, pageId: opts.pageId, codeMetaStrip: opts.codeMetaStrip }).children });
          if (api) return api;
        }
        // Target MDX carries meta the platform could not take as props inside one quoted `meta`
        // prop (see fenceMeta); reading this tool's own output unwraps it back to the text it held.
        const wrapped = opts.platform === 'dai' ? /^meta="([^"]*)"$/.exec((node.meta ?? '').trim()) : null;
        const sourceMeta = wrapped ? decodeMetaReferences(wrapped[1]) : node.meta ?? undefined;
        const meta = stripPlatformCodeMeta(sourceMeta, opts.codeMetaStrip);
        return [{ ...base, type: 'code', lang: node.lang ?? undefined, meta, ...(sourceMeta !== undefined && sourceMeta !== meta ? { sourceMeta } : {}), value: node.value ?? '' }];
      }
      case 'blockquote': {
        const children = blocks(node.children ?? [], p);
        const first = children[0];
        if (opts.platform === 'readme' && first?.type === 'paragraph') {
          const lead = first.children[0];
          const match = lead?.type === 'text' ? lead.value.match(/^\s*(📘|👍|🚧|❗)\s*/) : null;
          if (lead?.type === 'text' && match) {
            const kind = ({ '📘': 'info', '👍': 'success', '🚧': 'alert', '❗': 'danger' } as Record<string, string>)[match[1]];
            const rest = { ...first, children: [{ ...lead, value: lead.value.slice(match[0].length) }, ...first.children.slice(1)] };
            return [{ ...base, type: 'component', name: 'Callout', platform: opts.platform, props: { kind }, children: [rest, ...children.slice(1)] }];
          }
        }
        return [{ ...base, type: 'blockquote', children }];
      }
      case 'list': {
        const children: ListItemNode[] = (node.children ?? []).map((item: any, i: number) => ({ id: idOf(item, [...p, i]), src: srcOf(item), type: 'listItem', checked: item.checked ?? undefined, children: blocks(item.children ?? [], [...p, i]) }));
        return [{ ...base, type: 'list', ordered: !!node.ordered, start: node.start ?? undefined, children }];
      }
      case 'table': {
        const rows: TableRowNode[] = (node.children ?? []).map((row: any, ri: number) => ({
          id: idOf(row, [...p, ri]), src: srcOf(row), type: 'tableRow', isHeader: ri === 0,
          children: (row.children ?? []).map((cell: any, ci: number): TableCellNode => ({ id: idOf(cell, [...p, ri, ci]), src: srcOf(cell), type: 'tableCell', children: inline(cell.children ?? [], [...p, ri, ci]) })),
        }));
        return [{ ...base, type: 'table', align: node.align ?? undefined, children: rows }];
      }
      case 'thematicBreak': return [{ ...base, type: 'thematicBreak' }];
      case 'footnoteDefinition': return [{ ...base, type: 'footnoteDefinition', identifier: String(node.identifier ?? node.label ?? ''), children: blocks(node.children ?? [], p) }];
      // Definition targets are consumed by reference nodes, never rendered independently.
      case 'definition': return [];
      case 'html': return [{ ...base, type: 'html', value: node.value ?? '' }];
      case 'mdxJsxFlowElement': return jsxFlow(node, p);
      case 'mdxjsEsm': {
        const lines = String(node.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        const onlyResolvedImports = lines.length > 0 && lines.every((l) => { const m = l.match(SNIPPET_IMPORT); return !!m && /\.mdx?$/.test(m[2]) && opts.resolveSnippet?.(m[2]) !== undefined; });
        if (onlyResolvedImports) return [];
        return [{ ...base, type: 'component', name: 'esm', platform: opts.platform, props: { contentHash: idOf(node, p) }, children: [], styleDeps: ['expression:executable'] }];
      }
      case 'mdxFlowExpression':
        return [{ ...base, type: 'component', name: node.type === 'mdxjsEsm' ? 'esm' : 'expression', platform: opts.platform, props: { contentHash: idOf(node, p) }, children: [], styleDeps: ['expression:executable'] }];
      default:
        return unsupported(node);
    }
  });

  const fallbackTitle = opts.title ?? basename(opts.file, extname(opts.file)).replace(/[-_]+/g, ' ');
  const frontmatter = { ...data, ...opts.frontmatter, title: String(opts.frontmatter?.title ?? data.title ?? fallbackTitle) } as Frontmatter;
  const children = blocks(tree.children ?? [], [0]);
  // A Mintlify endpoint page states its operation; the OpenAPI section its published Markdown
  // appends is the platform's rendering of that statement, and is read back into it.
  const endpoint = opts.platform === 'mintlify' ? mintlifyOperationSection(children) : opts.platform === 'gitbook' ? gitbookOperationBlock(children) : undefined;
  if (endpoint) {
    return { pageId: opts.pageId, platform: opts.platform, source: opts.file, frontmatter: { ...frontmatter, openapi: operationFrontmatter(endpoint.operation) }, children: endpoint.children, openapiOperation: endpoint.operation };
  }
  return { pageId: opts.pageId, platform: opts.platform, source: opts.file, frontmatter, children: opts.platform === 'gitbook' ? children.map(gitbookBlockLinks) : children };
}
