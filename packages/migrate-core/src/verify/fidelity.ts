/** Lossless, ID-independent representations used by exact migration gates. */
import type { Block, DocIR, Inline } from '../ir/types.js';

export type FidelityValue = null | boolean | number | string | FidelityValue[] | { [key: string]: FidelityValue };

function ordered(value: unknown): FidelityValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return String(value ?? '');
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, ordered(entry)]));
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}

function inlineShape(nodes: Inline[]): FidelityValue[] {
  return nodes.map((node): FidelityValue => {
    switch (node.type) {
      case 'text': return { type: 'text', value: cleanText(node.value) };
      case 'inlineCode': return { type: 'inlineCode', value: node.value };
      case 'break': return { type: 'break' };
      case 'image': return { type: 'image', url: node.url, alt: node.alt, title: node.title ?? '', width: node.width ?? null, height: node.height ?? null };
      case 'link': return { type: 'link', url: node.url, title: node.title ?? '', children: inlineShape(node.children) };
      case 'inlineHtml': return { type: 'html', value: node.value.trim() };
      default: return { type: node.type, children: inlineShape(node.children) };
    }
  }).filter((value) => !(typeof value === 'object' && !Array.isArray(value) && value && value.type === 'text' && value.value === ''));
}

/**
 * Props that only choose how a component looks: variant selectors (kind/type/style/theme/color), decoration
 * (icon/iconType/arrow), layout (columns/cols/horizontal) and initial state (defaultOpen). Losing one is a styling
 * change, never a content change. ParamField's `type` is the one content-bearing `type`; its rule copies it and the
 * serialised-output gate proves it survives, so the comparator need not.
 */
const VISUAL_PROPS = new Set(['arrow', 'class', 'className', 'color', 'columns', 'cols', 'defaultOpen', 'horizontal', 'icon', 'iconType', 'kind', 'style', 'theme', 'type']);
/** Source spellings of a target prop. An alias stands in only while the canonical prop is absent, so the two can never collide. */
const PROP_ALIASES: Record<string, string> = { summary: 'title', label: 'title', img: 'image' };
/** HTML data-* attributes are machine metadata (Mintlify's data-path is the asset's repository path), never rendered content. */
const DATA_ATTRIBUTE = /^data-/;
/** Source components whose only job is to frame one image; without a caption they are the image. */
const FRAME_COMPONENTS = new Set(['Frame']);

function contentProps(props: Record<string, string | number | boolean | null>): FidelityValue {
  const semantic: Record<string, string | number | boolean> = {};
  const authored = (key: string) => props[key] !== null && props[key] !== undefined;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || VISUAL_PROPS.has(key) || DATA_ATTRIBUTE.test(key)) continue;
    const alias = PROP_ALIASES[key];
    const canonical = alias && !authored(alias) && !(alias in semantic) ? alias : key;
    semantic[canonical] = value;
  }
  return ordered(semantic);
}

/** A frame (or any captioned wrapper) around exactly one image, as the author sees it: a figure with a caption, or the bare image. */
function framedImageShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (block.children.length !== 1 || block.children[0].type !== 'image') return undefined;
  const caption = typeof block.props.caption === 'string' ? cleanText(block.props.caption) : '';
  const image = blocksShape(block.children, false)[0];
  if (caption) return [{ type: 'figure', image, caption: [{ type: 'text', value: caption }] }];
  return FRAME_COMPONENTS.has(block.name) ? [image] : undefined;
}

function blocksShape(blocks: Block[], exactComponents: boolean): FidelityValue[] {
  return blocks.flatMap((block): FidelityValue[] => {
    switch (block.type) {
      case 'paragraph': return [{ type: 'paragraph', children: inlineShape(block.children) }];
      case 'heading': return [{ type: 'heading', depth: block.depth, children: inlineShape(block.children) }];
      case 'code': {
        const serializedMeta = exactComponents ? [`${block.title ? `title="${block.title.replace(/["\r\n`~]/g, ' ').trim()}"` : ''}`, block.meta ?? ''].filter(Boolean).join(' ') : block.meta ?? '';
        return [{ type: 'code', lang: block.lang ?? '', meta: serializedMeta, title: exactComponents ? '' : block.title ?? '', value: block.value.replace(/\r\n/g, '\n') }];
      }
      case 'blockquote': return [{ type: 'blockquote', children: blocksShape(block.children, exactComponents) }];
      case 'list': return [{ type: 'list', ordered: block.ordered, start: block.start ?? null, children: block.children.map((item) => ({ type: 'listItem', checked: item.checked ?? null, children: blocksShape(item.children, exactComponents) })) }];
      case 'table': return [{ type: 'table', align: ordered(block.align ?? []), children: block.children.map((row) => ({ type: 'row', header: row.isHeader ?? false, children: row.children.map((cell) => inlineShape(cell.children)) })) }];
      case 'thematicBreak': return [{ type: 'thematicBreak' }];
      case 'image': return [{ type: 'image', url: block.url, alt: block.alt, title: block.title ?? '', width: block.width ?? null, height: block.height ?? null }];
      case 'figure': return exactComponents
        ? [blocksShape([block.image], true)[0], ...(block.caption?.length ? [{ type: 'paragraph', children: [{ type: 'emphasis', children: inlineShape(block.caption) }] } as FidelityValue] : [])]
        : [{ type: 'figure', image: blocksShape([block.image], false)[0], caption: inlineShape(block.caption ?? []) }];
      case 'component': case 'dai': {
        const framed = exactComponents ? undefined : framedImageShape(block);
        if (framed) return framed;
        return [{
          type: 'component',
          ...(exactComponents ? { name: block.name, props: ordered(block.props) } : { props: contentProps(block.props) }),
          children: blocksShape(block.children, exactComponents),
        }];
      }
      case 'html': return /^\s*<a\s+id=["'][^"']+["']\s*><\/a>\s*$/i.test(block.value) ? [] : [{ type: 'html', value: block.value.trim() }];
      case 'rawHtml': return [{ type: 'html', value: block.value.trim() }];
      case 'snippetRef': return [{ type: 'snippetRef', token: block.token, children: blocksShape(block.body ?? [], exactComponents) }];
      case 'quarantined': return [{ type: 'quarantined', reason: block.reason, original: blocksShape([block.original], exactComponents) }];
    }
  });
}

/** Author-visible meaning. Platform component names and visual-only props may change. */
export function authoredContentSnapshot(doc: DocIR): FidelityValue {
  const metadata = Object.fromEntries(Object.entries(doc.frontmatter).filter(([key]) => ['title', 'description', 'metaTitle', 'metaDescription', 'canonical', 'ogImage'].includes(key)));
  return { metadata: ordered(metadata), blocks: blocksShape(doc.children, false) };
}

/** Exact target IR shape, used to prove that MDX serialization changed nothing. */
export function renderedDocSnapshot(doc: DocIR): FidelityValue {
  return { metadata: ordered(doc.frontmatter), blocks: blocksShape(doc.children, true) };
}

export function fidelityEqual(a: FidelityValue, b: FidelityValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Small actionable first-difference path for reports; snapshots remain available for a full diff. */
export function firstFidelityDifference(a: FidelityValue, b: FidelityValue, path = '$'): string | undefined {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null) return a === b ? undefined : path;
  if (typeof a !== 'object') return a === b ? undefined : path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length (${a.length} != ${b.length})`;
    for (let i = 0; i < a.length; i++) { const diff = firstFidelityDifference(a[i], b[i], `${path}[${i}]`); if (diff) return diff; }
    return undefined;
  }
  const ak = Object.keys(a as Record<string, FidelityValue>); const bk = Object.keys(b as Record<string, FidelityValue>);
  if (ak.join('\n') !== bk.join('\n')) return `${path}.keys (${ak.join(',')} != ${bk.join(',')})`;
  for (const key of ak) { const diff = firstFidelityDifference((a as Record<string, FidelityValue>)[key], (b as Record<string, FidelityValue>)[key], `${path}.${key}`); if (diff) return diff; }
  return undefined;
}
