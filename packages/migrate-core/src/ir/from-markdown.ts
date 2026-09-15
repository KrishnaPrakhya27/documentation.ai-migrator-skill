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
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';
import { loadContract } from '@dai/content-contract';
import { nodeId } from '../session/ids.js';
import { sanitizeHtmlToJsx } from '../components/sanitize.js';
import type { Block, ComponentNode, DaiComponentNode, DocIR, Frontmatter, ImageNode, Inline, ListItemNode, TableCellNode, TableRowNode } from './types.js';
import { readPixelDimension } from './dimensions.js';
import { htmlToIr } from './from-html.js';
import { mapBlocks } from './types.js';
import { gitbookHtmlBlockToIr, isGitbookHtmlBlock, isGitbookHtmlInline, TRANSPARENT_HTML } from './gitbook-html.js';
import { gitbookOpenApiBlocks } from './gitbook-openapi.js';

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
    // GitBook wraps URLs in angle brackets inside attributes: url="<https://…>"
    attrs.push(`${name}="${quoteAttr((m[2] ?? m[3] ?? '').replace(/^<([^<>\s]+)>$/, '$1'))}"`);
  }
  return attrs.length ? ' ' + attrs.join(' ') : '';
}

/** Convert block syntaxes that micromark intentionally treats as plain text. */
/** Apply `fn` only to text outside fenced and inline code, so documentation *about* a syntax is never rewritten. */
function outsideCode(source: string, fn: (segment: string) => string): string {
  const parts = source.split(/(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}(?:`{3,}|~{3,})[ \t]*$|`[^`\n]+`)/m);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join('');
}

export function preprocessPlatformMarkdown(source: string, platform: string): string {
  const prepared = platform === 'gitbook' ? gitbookQuotedMarkdown(source) : source;
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

function preprocessSegment(source: string, platform: string): string {
  let out = source.replace(/^(#{1,6}\s+.*?)\s*\{#([A-Za-z][\w:.-]*)\}\s*$/gm, (_, heading, id) => `${heading} ${ANCHOR_OPEN}${id}${ANCHOR_CLOSE}`);
  out = out.replace(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g, (_, token) => `<snippetRef token="${quoteAttr(String(token).trim())}" />`);
  if (platform === 'gitbook') out = gitbookMdxCompatible(gitbookLiquidBlocks(out));
  if (platform === 'readme') out = readmeMdxCompatible(out);
  if (platform === 'docusaurus') {
    out = out.replace(/^:::(note|tip|info|warning|danger|caution)(?:\s+([^\n]+))?\s*$/gm, (_, kind, title) => `<admonition kind="${kind}"${title ? ` title="${quoteAttr(String(title).trim())}"` : ''}>`);
    out = out.replace(/^::: \s*$/gm, '</admonition>');
    out = out.replace(/^:::\s*$/gm, '</admonition>');
  }
  return out;
}

const GITBOOK_BLOCK_TAGS = ['hint', 'tabs', 'tab', 'content-ref', 'stepper', 'step', 'columns', 'column', 'updates', 'update', 'code'];
/** A Liquid tag alone on its line, optionally inside a blockquote, indented, or followed by a hard break; quoted attribute values may hold `%` (`width="50%"`). */
const GITBOOK_TAG_LINE = new RegExp(String.raw`^((?:[ \t]*>)*)[ \t]*\{%\s*(end)?(${GITBOOK_BLOCK_TAGS.join('|')}|embed)\b((?:[^%"']|"[^"]*"|'[^']*')*)%\}[ \t]*(?:\\|<br\s*\/?>)?[ \t]*$`);

/**
 * GitBook Liquid block tags become JSX flow elements, each isolated by blank lines (inside
 * the same blockquote when quoted) so MDX sees a block boundary: without them an opening tag
 * swallows the fence that follows it and a closing tag joins the paragraph before it. The
 * indentation is dropped because a GitBook block never belongs to a list item, and a hard
 * break left before a tag or on the tag line has nothing to break once the block ends there.
 */
function gitbookLiquidBlocks(segment: string): string {
  const out: string[] = [];
  for (const line of segment.split('\n')) {
    const m = line.match(GITBOOK_TAG_LINE);
    if (!m || (m[2] && m[3] === 'embed')) { out.push(line); continue; }
    const quote = Array.from({ length: (m[1].match(/>/g) ?? []).length }, () => '>').join(' ');
    const inQuote = (text: string) => (quote && text ? `${quote} ${text}` : quote || text);
    for (let i = out.length - 1; i >= 0; i--) {
      const trimmed = out[i].replace(/\\[ \t]*$/, '');
      if (trimmed === out[i]) break;
      out[i] = trimmed;
      if (trimmed.replace(/^[ \t>]*/, '')) break;
    }
    const tag = m[3] === 'embed' ? `<embed${liquidAttrs(m[4])} />` : m[2] ? `</${m[3]}>` : `<${m[3]}${liquidAttrs(m[4])}>`;
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

function literalExpression(value: string): string | number | boolean | null | undefined {
  const v = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  const quoted = v.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
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

  const imageFromMarkdown = (node: any, path: number[]): ImageNode => ({ id: idOf(node, path), src: srcOf(node), type: 'image', url: node.url ?? '', alt: node.alt ?? '', title: node.title ?? undefined });

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
      width: width.value, height: height.value,
      ...(width.unreadable !== undefined ? { unreadableWidth: width.unreadable } : {}),
      ...(height.unreadable !== undefined ? { unreadableHeight: height.unreadable } : {}),
    };
  };

  const inline = (nodes: any[], path: number[]): Inline[] => nodes.flatMap((node, index): Inline[] => {
    const p = [...path, index];
    const base = { id: idOf(node, p), src: srcOf(node) };
    switch (node.type) {
      case 'text': return [{ ...base, type: 'text', value: node.value }];
      case 'inlineCode': return [{ ...base, type: 'inlineCode', value: node.value }];
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
        if (name === 'br') return [{ ...base, type: 'break' }];
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
        if (opts.platform === 'readme' && (name === 'strong' || name === 'b')) return [{ ...base, type: 'strong', children: inline(node.children ?? [], p) }];
        if (opts.platform === 'readme' && (name === 'em' || name === 'i')) return [{ ...base, type: 'emphasis', children: inline(node.children ?? [], p) }];
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
    return {
      id: idOf(node, path), src: srcOf(node), type: 'component',
      name: node.name ?? 'mdxFragment', platform: opts.platform, props,
      children: blocks(node.children ?? [], [...path, 0]),
      styleDeps: styleDeps.length ? styleDeps : undefined,
    };
  };

  /** A non-literal attribute keeps the node a source component so exact mode stops on it instead of accepting it as resolved. */
  const jsxElement = (node: any, path: number[]): ComponentNode | DaiComponentNode => {
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

  const jsxFlow = (node: any, path: number[]): Block[] => {
    if (isImageElement(node)) return [imageFromMdx(node, path)];
    if (opts.platform === 'gitbook') { const converted = gitbookFlow(node, path); if (converted) return converted; }
    if (opts.platform === 'readme') { const converted = readmeFlow(node, path); if (converted) return converted; }
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
        const sourceMeta = node.meta ?? undefined;
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
  return { pageId: opts.pageId, platform: opts.platform, source: opts.file, frontmatter, children: opts.platform === 'gitbook' ? children.map(gitbookBlockLinks) : children };
}
