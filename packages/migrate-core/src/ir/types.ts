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
export interface ImageNode extends BaseNode { type: 'image'; url: string; alt: string; title?: string; width?: number; height?: number }

export type Inline = TextNode | InlineCodeNode | StrongNode | EmphasisNode | DeleteNode | LinkNode | BreakNode | KbdNode | InlineHtmlNode | ImageNode;

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

export type Block =
  | ParagraphNode | HeadingNode | CodeNode | BlockquoteNode | ListNode | TableNode | ThematicBreakNode
  | HtmlNode | FigureNode | ComponentNode | DaiComponentNode | RawHtmlNode | QuarantinedNode | SnippetRefNode | ImageNode;

export interface Frontmatter {
  title: string;
  description?: string;
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  canonical?: string;
  [k: string]: unknown;
}

export interface DocIR {
  /** Stable page entity id (UUIDv5 of platform + platform page id, or identity-map id). */
  pageId: string;
  platform: string;
  /** Canonical source location: URL or export path. */
  source: string;
  frontmatter: Frontmatter;
  children: Block[];
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
      default: return inlineText((n as any).children);
    }
  }).join('');
}
