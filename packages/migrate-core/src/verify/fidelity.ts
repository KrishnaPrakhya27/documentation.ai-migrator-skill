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

/**
 * Adjacent text nodes are one run of text. A source can hold several where the output holds one -
 * GitBook publishes `[Quickstart](broken://pages/d8dde99…)`, whose unusable target the conversion
 * drops, leaving the words between the text on either side. Written out and read back they are a
 * single string, so the comparison joins them before cleaning: joining cleaned values would eat the
 * space that separated them.
 */
function mergeText(nodes: Inline[]): Inline[] {
  return nodes.reduce<Inline[]>((out, node) => {
    const previous = out[out.length - 1];
    if (node.type === 'text' && previous?.type === 'text') out[out.length - 1] = { ...previous, value: previous.value + node.value };
    else out.push(node);
    return out;
  }, []);
}

function inlineShape(nodes: Inline[]): FidelityValue[] {
  return mergeText(nodes).map((node): FidelityValue => {
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
 * (icon/iconType/arrow), layout (columns/cols/horizontal) and initial state (defaultOpen). `titleType` is which
 * heading level a title renders at, and the contract offers only p/h2/h3, so a source h4 title renders h3 with the
 * same words. Losing one is a styling change, never a content change. ParamField's `type` is the one content-bearing `type`; its rule copies it and the
 * serialised-output gate proves it survives, so the comparator need not.
 */
const VISUAL_PROPS = new Set(['arrow', 'class', 'className', 'color', 'columns', 'cols', 'defaultOpen', 'horizontal', 'icon', 'iconType', 'kind', 'style', 'theme', 'titleType', 'type']);
/** Source spellings of a target prop. An alias stands in only while the canonical prop is absent, so the two can never collide. */
const PROP_ALIASES: Record<string, string> = { summary: 'title', label: 'title', date: 'title', img: 'image' };
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

/**
 * A component that states a heading and one that states the same words as its title are the same
 * page to a reader. GitBook steps carry no title and open with a heading; Documentation.AI's Step
 * requires `title`, so the conversion promotes that heading. Folding a leading heading into an
 * absent title canonicalises both spellings, on both sides of the comparison, so the words still
 * have to match and a heading the conversion simply lost still fails.
 *
 * Only a component that states no content of its own is folded. One that states anything - a title,
 * an Update's date - keeps its leading heading as a heading, which is what the author wrote: a
 * GitBook `<update date="…">` opens with an `## Product update` heading that stays a heading, and
 * folding it would have read that heading as the update's label.
 */
function titleFold(props: FidelityValue, children: Block[]): { props: FidelityValue; children: Block[] } {
  const stated = props as Record<string, FidelityValue>;
  const [first, ...rest] = children;
  if (Object.keys(stated).length || first?.type !== 'heading') return { props, children };
  const words = cleanText(inlineShape(first.children).map((node) => ((node as { value?: string }).value ?? '')).join(' '));
  if (!words) return { props, children };
  return { props: ordered({ ...stated, title: words }), children: rest };
}

/** A bare reference to a URL: the target's own address is all the author wrote. */
const URL_PROPS = ['src', 'url', 'href'];

/**
 * An embed of a host that is not allowlisted for iframes stays a link to the same address, so the
 * source's `<embed src="…"/>` and the output's paragraph-with-one-link state the same destination.
 * Canonicalising both to the link spelling keeps the address under comparison: an embed whose target
 * the conversion changed, or dropped, still fails.
 *
 * Narrow by construction: no children, and exactly one content prop, which must be an http(s) URL.
 * A component that says anything else (an Iframe's title, a caption) is left alone.
 */
function bareUrlShape(props: FidelityValue, children: Block[]): FidelityValue[] | undefined {
  const stated = Object.entries(props as Record<string, FidelityValue>);
  if (children.length || stated.length !== 1) return undefined;
  const [[key, value]] = stated;
  if (!URL_PROPS.includes(key) || typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined;
  return [{ type: 'paragraph', children: [{ type: 'link', url: value, title: '', children: [{ type: 'text', value }] }] }];
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
      case 'paragraph': {
        // A paragraph with nothing in it is not something an author wrote. GitBook publishes spacer
        // paragraphs (a lone `&#x20;`) between blocks; they serialise to a blank line and come back
        // from a re-parse as nothing, which made a page differ from its own written file. Empty
        // inline text is already dropped above, so this is the same rule one level up.
        const children = inlineShape(block.children);
        return children.length ? [{ type: 'paragraph', children }] : [];
      }
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
      case 'figure': {
        if (exactComponents) return [blocksShape([block.image], true)[0], ...(block.caption?.length ? [{ type: 'paragraph', children: [{ type: 'emphasis', children: inlineShape(block.caption) }] } as FidelityValue] : [])];
        // Without a caption a figure says exactly what its image says, so it reads as the image -
        // the same equivalence framedImageShape already applies to a component wrapping one image.
        const caption = inlineShape(block.caption ?? []);
        const image = blocksShape([block.image], false)[0];
        return caption.length ? [{ type: 'figure', image, caption }] : [image];
      }
      case 'component': case 'dai': {
        if (exactComponents) return [{ type: 'component', name: block.name, props: ordered(block.props), children: blocksShape(block.children, true) }];
        const framed = framedImageShape(block);
        if (framed) return framed;
        const bare = bareUrlShape(contentProps(block.props), block.children);
        if (bare) return bare;
        const folded = titleFold(contentProps(block.props), block.children);
        return [{ type: 'component', props: folded.props, children: blocksShape(folded.children, false) }];
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
