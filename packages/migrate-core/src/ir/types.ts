/**
 * DocIR: the intermediate representation every source is parsed into and
 * every Documentation.AI page is serialised from.
 *
 * Every node carries a stable `id` derived from its position and content in
 * the source, so the block ledger can record what happened to it.
 */
export type NodeId = string;

export interface BaseNode {
  id: NodeId;
  /** Source location: file or URL plus a span, for logs and the ledger. */
  src?: { file: string; line?: number; col?: number };
}

export interface TextNode extends BaseNode { type: 'text'; value: string }
export interface InlineCodeNode extends BaseNode { type: 'inlineCode'; value: string }
export interface StrongNode extends BaseNode { type: 'strong'; children: Inline[] }
export interface EmphasisNode extends BaseNode { type: 'emphasis'; children: Inline[] }
export interface DeleteNode extends BaseNode { type: 'delete'; children: Inline[] }
export interface LinkNode extends BaseNode { type: 'link'; url: string; title?: string; children: Inline[] }
export interface BreakNode extends BaseNode { type: 'break' }
export interface KbdNode extends BaseNode { type: 'kbd'; children: Inline[] }
export interface InlineHtmlNode extends BaseNode { type: 'inlineHtml'; value: string }
/** A GFM footnote mark, `[^id]`; the platform renders it as the numbered superscript the source shows. */
export interface FootnoteReferenceNode extends BaseNode { type: 'footnoteReference'; identifier: string }
/** `unreadableWidth`/`unreadableHeight` hold a dimension the source states that the target's integer-pixel contract cannot carry (`100%`, `2rem`), so the loss stays visible instead of being guessed at or dropped. */
/** `sources` holds the srcset candidates the source offered; the target renders one URL, so they are hosted and reported rather than dropped with the old platform. */
export interface ImageNode extends BaseNode { type: 'image'; url: string; alt: string; title?: string; width?: number; height?: number; unreadableWidth?: string; unreadableHeight?: string; sources?: string[] }

export type Inline = TextNode | InlineCodeNode | StrongNode | EmphasisNode | DeleteNode | LinkNode | BreakNode | KbdNode | InlineHtmlNode | ImageNode | FootnoteReferenceNode;

export interface ParagraphNode extends BaseNode { type: 'paragraph'; children: Inline[] }
export interface HeadingNode extends BaseNode { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[]; /** id from the source, if it had one */ sourceId?: string }
/** `sourceMeta` keeps the fence info string as authored when the target contract cannot carry all of it (platform theming directives); `meta` is what is emitted. */
export interface CodeNode extends BaseNode { type: 'code'; lang?: string; meta?: string; sourceMeta?: string; value: string; title?: string }
export interface BlockquoteNode extends BaseNode { type: 'blockquote'; children: Block[] }
export interface ListNode extends BaseNode { type: 'list'; ordered: boolean; start?: number; children: ListItemNode[] }
export interface ListItemNode extends BaseNode { type: 'listItem'; checked?: boolean; children: Block[] }
export interface TableNode extends BaseNode { type: 'table'; align?: Array<'left' | 'center' | 'right' | null>; children: TableRowNode[] }
export interface TableRowNode extends BaseNode { type: 'tableRow'; isHeader?: boolean; children: TableCellNode[] }
export interface TableCellNode extends BaseNode { type: 'tableCell'; children: Inline[] }
export interface ThematicBreakNode extends BaseNode { type: 'thematicBreak' }
export interface HtmlNode extends BaseNode { type: 'html'; value: string }
export interface FigureNode extends BaseNode { type: 'figure'; image: ImageNode; caption?: Inline[] }

/**
 * A source component: anything the source platform expresses as a component,
 * callout, tab set, accordion, embed, custom JSX, or a raw HTML element with a
 * recognisable class. The rules engine resolves these to DAI components.
 */
export interface ComponentNode extends BaseNode {
  type: 'component';
  /** Platform-native name, e.g. Accordion, hint, infoBox, Frame. */
  name: string;
  /** Platform this came from. */
  platform: string;
  props: Record<string, string | number | boolean | null>;
  children: Block[];
  /** Where a definition was found, if the source repo had one. */
  definition?: { file: string; hash: string };
  /** Styling dependencies observed on the source (class names). */
  styleDeps?: string[];
}

/**
 * A resolved Documentation.AI component, after the rules engine has run.
 * `name` is a public contract name (Callout, Tabs, ...).
 */
export interface DaiComponentNode extends BaseNode {
  type: 'dai';
  name: string;
  props: Record<string, string | number | boolean | null>;
  children: Block[];
  /** Mapping rule id that produced it, for the ledger. */
  rule?: string;
}

/** Sanitised raw HTML that the deployment contract accepts (T7 preserve). */
export interface RawHtmlNode extends BaseNode { type: 'rawHtml'; value: string; reviewFlag: string }

/** A quarantined block: replaced in the output by a placeholder and a gate failure. */
export interface QuarantinedNode extends BaseNode { type: 'quarantined'; reason: string; original: Block }

/** Reusable content token, e.g. {{snippet.All Plans}}, <<glossary:term>>, {{ vars.x }}. */
export interface SnippetRefNode extends BaseNode { type: 'snippetRef'; token: string; platform: string; body?: Block[] }
/** A GFM footnote body, `[^id]: …`, which the platform lists at the foot of the page as the source does. */
export interface FootnoteDefinitionNode extends BaseNode { type: 'footnoteDefinition'; identifier: string; children: Block[] }

export type Block =
  | ParagraphNode | HeadingNode | CodeNode | BlockquoteNode | ListNode | TableNode | ThematicBreakNode
  | HtmlNode | FigureNode | ComponentNode | DaiComponentNode | RawHtmlNode | QuarantinedNode | SnippetRefNode | ImageNode | FootnoteDefinitionNode;

export interface Frontmatter {
  title: string;
  description?: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  canonical?: string;
  [k: string]: unknown;
}

/**
 * An API operation a page documents through a specification, as Mintlify's published Markdown
 * states it: the spec's path within the docs, the operation, and the spec text the page carried.
 */
export interface OpenApiOperationFragment {
  /** The spec's path under api-reference/ in the output. */
  spec: string;
  method: string;
  path: string;
  /** The spec text the page carried, cut to this operation; empty when the page named a URL instead. */
  document: string;
  /** The URL the page named, when the spec is to be captured rather than assembled. */
  specUrl?: string;
}

export interface DocIR {
  /** Stable page entity id (UUIDv5 of platform + platform page id, or identity-map id). */
  pageId: string;
  platform: string;
  /** Canonical source location: URL or export path. */
  source: string;
  frontmatter: Frontmatter;
  children: Block[];
  /** The operation this page documents, when the platform renders it from a spec rather than from prose. */
  openapiOperation?: OpenApiOperationFragment;
}

export function isBlockWithChildren(n: Block): n is Extract<Block, { children: Block[] }> {
  return 'children' in n && Array.isArray((n as any).children) && n.type !== 'paragraph' && n.type !== 'heading' && n.type !== 'table';
}

/** Depth-first walk over blocks; `visit` may return false to skip children. */
export function walkBlocks(nodes: Block[], visit: (n: Block, depth: number, parent?: Block | ListItemNode) => void | false, depth = 0, parent?: Block | ListItemNode): void {
  for (const n of nodes) {
    if (visit(n, depth, parent) === false) continue;
    if (isBlockWithChildren(n)) walkBlocks(n.children as Block[], visit, depth + 1, n);
    else if (n.type === 'list') for (const li of n.children) walkBlocks(li.children, visit, depth + 1, li);
    else if (n.type === 'quarantined') walkBlocks([n.original], visit, depth + 1, n);
  }
}

/**
 * The blocks rebuilt bottom-up: `inline` is applied to every inline node after its children, and `block` to every
 * block after its children. It reaches paragraphs, headings, list items, quotes, table cells, figure captions and
 * component children.
 */
export function mapBlocks(blocks: Block[], fns: { inline?: (node: Inline) => Inline; block?: (node: Block) => Block }): Block[] {
  const inlines = (nodes: Inline[]): Inline[] => nodes.map((node) => {
    const rebuilt = 'children' in node ? ({ ...node, children: inlines(node.children) } as Inline) : node;
    return fns.inline ? fns.inline(rebuilt) : rebuilt;
  });
  return blocks.map((block) => {
    let rebuilt: Block;
    switch (block.type) {
      case 'paragraph': case 'heading': rebuilt = { ...block, children: inlines(block.children) }; break;
      case 'list': rebuilt = { ...block, children: block.children.map((item) => ({ ...item, children: mapBlocks(item.children, fns) })) }; break;
      case 'blockquote': case 'footnoteDefinition': rebuilt = { ...block, children: mapBlocks(block.children, fns) }; break;
      case 'table': rebuilt = { ...block, children: block.children.map((row) => ({ ...row, children: row.children.map((cell) => ({ ...cell, children: inlines(cell.children) })) })) }; break;
      case 'figure': rebuilt = block.caption ? { ...block, caption: inlines(block.caption) } : block; break;
      case 'dai': case 'component': rebuilt = { ...block, children: mapBlocks(block.children, fns) }; break;
      default: rebuilt = block;
    }
    return fns.block ? fns.block(rebuilt) : rebuilt;
  });
}

/**
 * Plain text of a run of blocks, as a reader would copy it: list markers and nesting indentation
 * included, cells separated, blank line between blocks. A conversion that flattens blocks into one
 * text value uses this, and so must anything comparing against that value, or the two disagree on
 * content neither of them lost.
 */
export function blocksText(blocks: readonly Block[], indent = ''): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') parts.push(indent + inlineText(block.children));
    else if (block.type === 'code') parts.push(block.value.split('\n').map((line) => indent + line).join('\n'));
    else if (block.type === 'list') {
      parts.push(block.children.map((item, index) => {
        const marker = block.ordered ? `${(block.start ?? 1) + index}. ` : '- ';
        const body = blocksText(item.children, indent + ' '.repeat(marker.length)) ?? '';
        return indent + marker + body.trimStart();
      }).join('\n'));
    } else if (block.type === 'blockquote') parts.push((blocksText(block.children, indent) ?? '').split('\n').map((line) => `> ${line}`).join('\n'));
    else if (block.type === 'table') parts.push(block.children.map((row) => indent + row.children.map((cell) => inlineText(cell.children)).join(' | ')).join('\n'));
    else if ('children' in block && Array.isArray(block.children)) { const inner = blocksText(block.children as Block[], indent); if (inner) parts.push(inner); }
  }
  const text = parts.join('\n\n').trim();
  return text || undefined;
}

/**
 * The words a reader sees in a run of inline content, inline HTML included: a badge composed as a
 * span contributes the label inside it, not its tags. `inlineText` reads inline HTML as nothing,
 * which is right for a signature and wrong for anything comparing a heading with how it rendered.
 */
export function renderedText(nodes: Inline[] | undefined): string {
  if (!nodes) return '';
  return nodes.map((n) => (n.type === 'inlineHtml' ? n.value.replace(/<[^<>]*>/g, '') : n.type === 'text' || n.type === 'inlineCode' ? n.value : 'children' in n ? renderedText((n as { children: Inline[] }).children) : '')).join('');
}

/** Plain text of inline content, for prose matching and signatures. */
export function inlineText(nodes: Inline[] | undefined): string {
  if (!nodes) return '';
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return n.value;
      case 'inlineCode': return n.value;
      case 'break': return '\n';
      case 'image': return n.alt;
      case 'inlineHtml': return '';
      case 'footnoteReference': return '';
      default: return inlineText((n as any).children);
    }
  }).join('');
}
