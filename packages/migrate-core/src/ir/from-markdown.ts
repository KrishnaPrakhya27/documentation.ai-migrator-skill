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

function splitFrontmatter(source: string, file: string): { data: Record<string, unknown>; body: string } {
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
const ANGLE_AUTOLINK = /(?<!\]\()<((?:https?|mailto|ftp):[^\s<>]*)>/g;
/** GitBook's export of an OpenAPI description escapes the Markdown link around an autolink: `\[label]\(<https://…>)`. */
const ESCAPED_AUTOLINK_LINK = /\\\[([^\]\n]*?)\\?\]\\\(<((?:https?|mailto):[^\s<>]*)>\)/g;

/**
 * CommonMark that GitBook publishes and MDX rejects: HTML void elements written without `/>`
 * and `<https://…>` autolinks. Each is rewritten to the form MDX accepts and that renders the
 * same; a `](<url>)` link destination is valid MDX and is left as written, and an escaped link
 * around an autolink is the link it stands for.
 */
function gitbookMdxCompatible(segment: string): string {
  return segment
    .replace(HTML_VOID_ELEMENT, (tag, name, attrs) => (/\/\s*$/.test(attrs) ? tag : `<${name}${attrs.replace(/\s+$/, '')} />`))
    .replace(ESCAPED_AUTOLINK_LINK, (_, label, url) => `[${label}](${url})`)
    .replace(ANGLE_AUTOLINK, (_, url) => `[${url}](${url})`);
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
  const prepared = preprocessPlatformMarkdown(body, opts.platform);
  const tree = fromMarkdown(prepared, {
    extensions: [gfm(), mdxjs()],
    mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
  }) as any;

  const sourceSlice = (node: any): string => {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    return typeof start === 'number' && typeof end === 'number' ? prepared.slice(start, end) : String(node.value ?? node.type);
  };
  const idOf = (node: any, path: number[]) => nodeId(opts.file, path, sourceSlice(node));
  const imports = snippetImports(tree);
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
      case 'link': return [{ ...base, type: 'link', url: node.url ?? '', title: node.title ?? undefined, children: inline(node.children ?? [], p) }];
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
        if (opts.platform === 'gitbook' && isGitbookHtmlInline(name)) return htmlInline(node, p);
        const text = inline(node.children ?? [], p);
        // Inline source components need a human decision; preserve their visible
        // text and leave a blocking marker rather than silently changing meaning.
        return [{ ...base, type: 'inlineHtml', value: `{/* UNSUPPORTED INLINE COMPONENT ${node.name ?? 'fragment'} */}` }, ...text];
      }
      default:
        return node.children ? inline(node.children, p) : [];
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

  const jsxFlow = (node: any, path: number[]): Block[] => {
    if (isImageElement(node)) return [imageFromMdx(node, path)];
    if (opts.platform === 'gitbook') { const converted = gitbookFlow(node, path); if (converted) return converted; }
    const importPath = node.name ? imports.get(node.name) : undefined;
    if (importPath && /\.mdx?$/.test(importPath) && !(node.attributes ?? []).length && opts.resolveSnippet) {
      const body = opts.resolveSnippet(importPath);
      if (body !== undefined) {
        // inline the snippet's blocks; ids are derived from the snippet file so they are stable and distinct
        const sub = markdownToIr(body, { ...opts, file: `${opts.file}::${importPath}`, resolveSnippet: opts.resolveSnippet });
        return sub.children;
      }
    }
    const element = jsxElement(node, path);
    if (element.type === 'component' && element.name === 'snippetRef') return [{ id: element.id, src: element.src, type: 'snippetRef', token: String(element.props.token ?? ''), platform: opts.platform }];
    return [element];
  };

  const INLINE_TYPES = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'link', 'image', 'break', 'html', 'mdxTextExpression', 'mdxJsxTextElement']);
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
        return node.children ? blocks(node.children, p) : [];
    }
  });

  const fallbackTitle = opts.title ?? basename(opts.file, extname(opts.file)).replace(/[-_]+/g, ' ');
  const frontmatter = { ...data, ...opts.frontmatter, title: String(opts.frontmatter?.title ?? data.title ?? fallbackTitle) } as Frontmatter;
  const children = blocks(tree.children ?? [], [0]);
  return { pageId: opts.pageId, platform: opts.platform, source: opts.file, frontmatter, children: opts.platform === 'gitbook' ? children.map(gitbookBlockLinks) : children };
}
