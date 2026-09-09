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
import { nodeId } from '../session/ids.js';
import { sanitizeHtmlToJsx } from '../components/sanitize.js';
import type { Block, ComponentNode, DocIR, Frontmatter, Inline, ListItemNode, TableCellNode, TableRowNode } from './types.js';

export interface MarkdownAdapterOptions {
  platform: string;
  file: string;
  pageId: string;
  title?: string;
  frontmatter?: Partial<Frontmatter>;
  /** Resolve a snippet import path (e.g. "/snippets/intro.mdx") to its MDX body; undefined leaves the import unresolved (quarantined). */
  resolveSnippet?: (importPath: string) => string | undefined;
}

/** Sentinel wrapped around a custom heading id ({#id}) so it survives parsing and is lifted into heading.sourceId. */
const ANCHOR_OPEN = '\uE000';
const ANCHOR_CLOSE = '\uE001';
const SNIPPET_IMPORT = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.(?:mdx?|jsx))["'];?\s*$/;

/** Snippet imports and their usages, from the ESM nodes of a document. */
function snippetImports(tree: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of tree.children ?? []) {
    if (node.type !== 'mdxjsEsm') continue;
    for (const line of String(node.value ?? '').split('\n')) { const m = line.match(SNIPPET_IMPORT); if (m) out.set(m[1], m[2]); }
  }
  return out;
}

function splitFrontmatter(source: string): { data: Record<string, unknown>; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: source };
  try {
    const parsed = parseYaml(m[1]);
    return { data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, body: source.slice(m[0].length) };
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter in migration source ${(error as Error).message}`);
  }
}

function quoteAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\{/g, '&#123;');
}

function liquidAttrs(raw: string): string {
  const attrs: string[] = [];
  for (const m of raw.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1] === 'url' ? 'src' : m[1];
    attrs.push(`${name}="${quoteAttr(m[2] ?? m[3] ?? '')}"`);
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
  return outsideCode(source, (segment) => preprocessSegment(segment, platform));
}

function preprocessSegment(source: string, platform: string): string {
  let out = source.replace(/^(#{1,6}\s+.*?)\s*\{#([A-Za-z][\w:.-]*)\}\s*$/gm, (_, heading, id) => `${heading} ${ANCHOR_OPEN}${id}${ANCHOR_CLOSE}`);
  out = out.replace(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g, (_, token) => `<snippetRef token="${quoteAttr(String(token).trim())}" />`);
  if (platform === 'gitbook') {
    out = out.replace(/^\s*\{%\s*(hint|tabs|tab|content-ref|stepper|step)\b([^%]*)%\}\s*$/gm, (_, name, attrs) => `<${name}${liquidAttrs(attrs)}>`);
    out = out.replace(/^\s*\{%\s*end(hint|tabs|tab|content-ref|stepper|step)\s*%\}\s*$/gm, (_, name) => `</${name}>`);
    out = out.replace(/^\s*\{%\s*embed\b([^%]*)%\}\s*$/gm, (_, attrs) => `<embed${liquidAttrs(attrs)} />`);
  }
  if (platform === 'docusaurus') {
    out = out.replace(/^:::(note|tip|info|warning|danger|caution)(?:\s+([^\n]+))?\s*$/gm, (_, kind, title) => `<admonition kind="${kind}"${title ? ` title="${quoteAttr(String(title).trim())}"` : ''}>`);
    out = out.replace(/^::: \s*$/gm, '</admonition>');
    out = out.replace(/^:::\s*$/gm, '</admonition>');
  }
  return out;
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

export function markdownToIr(source: string, opts: MarkdownAdapterOptions): DocIR {
  const { data, body } = splitFrontmatter(source);
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
      case 'image': return [{ ...base, type: 'image', url: node.url ?? '', alt: node.alt ?? '', title: node.title ?? undefined }];
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
        const text = inline(node.children ?? [], p);
        // Inline source components need a human decision; preserve their visible
        // text and leave a blocking marker rather than silently changing meaning.
        return [{ ...base, type: 'inlineHtml', value: `{/* UNSUPPORTED INLINE COMPONENT ${node.name ?? 'fragment'} */}` }, ...text];
      }
      default:
        return node.children ? inline(node.children, p) : [];
    }
  });

  const component = (node: any, path: number[]): ComponentNode => {
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
        // <Note>text</Note> on a single line parses as an inline JSX element wrapped in a paragraph; that is a block component
        const meaningful = (node.children ?? []).filter((c: any) => !(c.type === 'text' && !String(c.value).trim()));
        if (meaningful.length === 1 && meaningful[0].type === 'mdxJsxTextElement' && meaningful[0].name) {
          const el = { ...meaningful[0], type: 'mdxJsxFlowElement' };
          const c = component(el, p);
          return [c];
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
      case 'code': return [{ ...base, type: 'code', lang: node.lang ?? undefined, meta: node.meta ?? undefined, value: node.value ?? '' }];
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
      case 'mdxJsxFlowElement': {
        const importPath = node.name ? imports.get(node.name) : undefined;
        if (importPath && /\.mdx?$/.test(importPath) && !(node.attributes ?? []).length && opts.resolveSnippet) {
          const body = opts.resolveSnippet(importPath);
          if (body !== undefined) {
            // inline the snippet's blocks; ids are derived from the snippet file so they are stable and distinct
            const sub = markdownToIr(body, { ...opts, file: `${opts.file}::${importPath}`, resolveSnippet: opts.resolveSnippet });
            return sub.children;
          }
        }
        const c = component(node, p);
        if (c.name === 'snippetRef') return [{ id: c.id, src: c.src, type: 'snippetRef', token: String(c.props.token ?? ''), platform: opts.platform }];
        return [c];
      }
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
  return { pageId: opts.pageId, platform: opts.platform, source: opts.file, frontmatter, children: blocks(tree.children ?? [], [0]) };
}
