/** Lossless, ID-independent representations used by exact migration gates. */
import type { Block, DocIR, Inline } from '../ir/types.js';
import { inlineText, blocksText } from '../ir/types.js';
import { markdownToIr } from '../ir/from-markdown.js';

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

function inlineShape(nodes: Inline[], insideLink = false): FidelityValue[] {
  return mergeText(nodes).map((node): FidelityValue => {
    switch (node.type) {
      // Left as written for now: a sentence the reader split at an address it linked is put back
      // together below, and trimming the pieces first would swallow the spaces at the seam.
      case 'text': return { type: 'text', value: node.value };
      case 'inlineCode': return { type: 'inlineCode', value: node.value };
      case 'break': return { type: 'break' };
      case 'image': return { type: 'image', url: sameAddress(node.url), alt: node.alt, title: node.title ?? '', width: node.width ?? null, height: node.height ?? null };
      case 'link': {
        // A bare address sitting in text is linked by the reader as soon as it reads the file back,
        // so the text the page wrote and the link made of it are the same address said once. A link
        // that shows nothing but its own address reads as that address; a link with a label of its
        // own is a reference the page made, and is compared as one.
        const children = inlineShape(node.children, true);
        const only = children.length === 1 ? (children[0] as { type?: string; value?: string }) : undefined;
        const url = sameAddress(node.url);
        // The label has already had its character references read; the address must be read the same
        // way before the two can be compared at all.
        const address = decodeCharacterReferences(url);
        const label = only?.type === 'text' && only.value ? decodeCharacterReferences(only.value).trim() : undefined;
        if (label && (address === label || address === `mailto:${label}` || address === `http://${label}`)) return { type: 'text', value: only!.value ?? '' };
        return { type: 'link', url, title: node.title ?? '', children };
      }
      case 'inlineHtml': return { type: 'html', value: node.value.trim() };
      case 'footnoteReference': return { type: 'footnoteReference', identifier: node.identifier };
      case 'strong': case 'emphasis': {
        // `***x***` is bold and italic together; nothing in it says which wraps which, so a re-parse
        // is free to choose the other order. Both say the same thing, so the pair is always written
        // here with the bold outside.
        const children = inlineShape(node.children, insideLink);
        const only = children.length === 1 ? (children[0] as { type?: string; children?: FidelityValue[] }) : undefined;
        if (node.type === 'emphasis' && only?.type === 'strong') return { type: 'strong', children: [{ type: 'emphasis', children: only.children ?? [] }] };
        return { type: node.type, children };
      }
      default: return { type: node.type, children: inlineShape(node.children, insideLink) };
    }
  }).reduce<FidelityValue[]>((out, value) => {
    // Collapsing a reader's autolink back to text leaves the address beside the words that followed
    // it, split where the link ended — and the braces the writer escaped are still character
    // references on that side of the split. Joining the pieces and reading the references as the
    // characters they stand for puts the sentence back the way the page states it.
    const previous = out[out.length - 1] as { type?: string; value?: string } | undefined;
    const current = value as { type?: string; value?: string };
    if (previous?.type === 'text' && current?.type === 'text') { previous.value = `${previous.value ?? ''}${current.value ?? ''}`; return out; }
    out.push(value);
    return out;
  }, []).map((value) => {
    const current = value as { type?: string; value?: string };
    return current?.type === 'text' ? { type: 'text', value: cleanText(decodeCharacterReferences(current.value ?? '')) } : value;
  }).filter((value) => {
    if (typeof value !== 'object' || Array.isArray(value) || !value) return true;
    // An `<a id="x"></a>` marking a spot mid-sentence is a link target, not something the page says.
    // It is written verbatim and comes back from a re-parse as a JSX element; neither is content.
    if (value.type === 'html' && /^<a\s+(?:id|name)=["'][^"']+["']\s*>\s*<\/a>$/i.test(String(value.value ?? ''))) return false;
    if (value.type === 'a' && Array.isArray(value.children) && !value.children.length) return false;
    return !(value.type === 'text' && value.value === '');
  });
}

/**
 * `&#123;` and the brace it stands for are the same character, and so are `&lt;` and `<`. A file may
 * spell either way: the writer escapes what Markdown would otherwise read as syntax, and a reader
 * gives the character back. Reading both sides the same way compares the characters, not the
 * spelling — which is what the page shows.
 */
const NAMED_REFERENCES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', amp: '&' };
function decodeCharacterReferences(value: string): string {
  return value
    .replace(/&#(\d{1,7});/g, (whole, code: string) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (whole, code: string) => {
      const point = Number.parseInt(code, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    // `&amp;` last, so a reference written through it is not decoded twice into something else.
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (whole, name: string) => NAMED_REFERENCES[name] ?? whole)
    .replace(/&amp;/g, '&');
}

/**
 * One address, one spelling. A link the source wrote with a literal space comes back from a
 * re-parse percent-encoded; both name the same page, and reading that as a difference failed pages
 * whose links were right. Anything that does not parse as a URL is compared as written.
 */
function sameAddress(url: string): string {
  try { return decodeURI(url); } catch { return url; }
}

/**
 * Props that only choose how a component looks: variant selectors (kind/type/style/theme/color), decoration
 * (icon/iconType/arrow), layout (columns/cols/horizontal) and initial state (defaultOpen). `titleType` is which
 * heading level a title renders at, and the contract offers only p/h2/h3, so a source h4 title renders h3 with the
 * same words. `width`/`height` size a component's own decoration - a Mintlify Tab sizes its icon with them - and
 * are not the dimensions of an image, which the image node states itself and is compared on. Losing one is a
 * styling change, never a content change. ParamField's `type` is the one content-bearing `type`; its rule copies it and the
 * serialised-output gate proves it survives, so the comparator need not.
 */
const VISUAL_PROPS = new Set(['arrow', 'class', 'className', 'color', 'columns', 'cols', 'defaultOpen', 'height', 'horizontal', 'icon', 'iconType', 'kind', 'style', 'theme', 'titleType', 'type', 'width']);
/**
 * Attributes that grant an embed a capability rather than state content: what an iframe may do, and
 * what it may be trusted with. The sanitizer strips every one of them by policy before any rule
 * runs, because a migrated page must not carry permissions the source host granted itself. Nothing
 * a reader reads is in them.
 */
const EMBED_POLICY_PROPS = new Set(['allow', 'allowfullscreen', 'csp', 'frameborder', 'loading', 'referrerpolicy', 'sandbox', 'scrolling']);
/** Source spellings of a target prop. An alias stands in only while the canonical prop is absent, so the two can never collide. */
const PROP_ALIASES: Record<string, string> = { summary: 'title', label: 'title', date: 'title', img: 'image' };
/** HTML data-* attributes are machine metadata (Mintlify's data-path is the asset's repository path), never rendered content. */
const DATA_ATTRIBUTE = /^data-/;
/**
 * Source components whose only job is to frame one image; without a caption they are the image.
 * `div` is here because published Markdown wraps an image in a styling div, and the migration
 * unwraps it. Keyed to the name on purpose: "empty props and one image child" as a general shape
 * test would also swallow a wrapper that should have carried something and lost it upstream.
 */
const FRAME_COMPONENTS = new Set(['Frame', 'div']);

/** Wrappers that carry a published heading anchor and nothing else. Named, for the same reason. */
const ANCHOR_WRAPPERS = new Set(['div']);

/** A heading written as raw HTML. The level is in the name, so the shape can state it. */
const HTML_HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** A rule written as raw HTML: a divider with nothing in it. */
const HTML_RULES = new Set(['hr']);

/** Source components whose label prop the target spells `title`. Named, so `name` keeps its meaning on ParamField. */
const RENAMED_LABEL = new Map([['Tree.Folder', 'name']]);

/** The class the migration itself writes on a converted badge; it appears nowhere a migration did not put it. */
const BADGE_MARKER = /^<span className="dai-mig-badge">([\s\S]*)<\/span>$/;

function contentProps(props: Record<string, string | number | boolean | null>): FidelityValue {
  const semantic: Record<string, string | number | boolean> = {};
  const authored = (key: string) => props[key] !== null && props[key] !== undefined;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || VISUAL_PROPS.has(key) || EMBED_POLICY_PROPS.has(key.toLowerCase()) || DATA_ATTRIBUTE.test(key)) continue;
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
  // An embed shows its address and nothing else, which is what a link to it shows too; both read as
  // that address, the same way the reader's own autolink of it does.
  return [{ type: 'paragraph', children: [{ type: 'text', value }] }];
}

/** A frame (or any captioned wrapper) around exactly one image, as the author sees it: a figure with a caption, or the bare image. */
function framedImageShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  // Published Markdown leaves blank paragraphs between blocks inside a wrapper; they are not content,
  // which is the rule the paragraph branch already applies one level down.
  const content = block.children.filter((child) => !(child.type === 'paragraph' && !inlineShape(child.children).length));
  // A frame commonly holds the light and dark spellings of one picture, so a frame whose whole
  // content is images reads as those images - which is what unwrapping it produces.
  if (!content.length || !content.every((child) => child.type === 'image')) return undefined;
  const caption = typeof block.props.caption === 'string' ? cleanText(block.props.caption) : '';
  const images = blocksShape(content, false);
  if (!caption) return FRAME_COMPONENTS.has(block.name) ? images : undefined;
  // The conversion writes the pictures and then the caption as the italic line under them, which is
  // where the reader reads it, whether the frame held one picture or the light and dark spellings of
  // one. The caption is Markdown - it may name a link - and is read as the Markdown it is.
  return FRAME_COMPONENTS.has(block.name) ? [...images, captionLine(caption)] : undefined;
}

/**
 * A caption prop is Markdown, and the conversion writes it as Markdown: a caption naming a link
 * becomes a link. Reading it as plain text made the two sides disagree on the very words they share.
 */
function captionInline(caption: string): Inline[] {
  const doc = markdownToIr(caption, { platform: 'dai', file: 'caption', pageId: 'caption' });
  const first = doc.children[0];
  return first && first.type === 'paragraph' ? first.children : [{ id: 'caption', type: 'text', value: caption } as Inline];
}

/** A caption as the conversion writes it: the italic line under the picture, Markdown and all. */
function captionLine(caption: string): FidelityValue {
  return { type: 'paragraph', children: [{ type: 'emphasis', children: inlineShape(captionInline(caption)) }] };
}

/**
 * A frame around one embed is that embed: the frame draws the border, the embed is the content. The
 * published Markdown wraps a YouTube iframe in a `<Frame>` and the conversion lifts the embed out,
 * so the two spellings state the same video.
 *
 * Narrow by construction: a named frame, no caption, no content prop of its own, and exactly one
 * child, which must be a component. A frame that wrapped anything else still has to match.
 */
function framedEmbedShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (!FRAME_COMPONENTS.has(block.name)) return undefined;
  const content = block.children.filter((child) => !(child.type === 'paragraph' && !inlineShape(child.children).length));
  if (content.length !== 1 || content[0].type !== 'component') return undefined;
  if (Object.keys(contentProps(block.props) as Record<string, unknown>).length) return undefined;
  return blocksShape(content, false);
}

/**
 * A wrapper whose whole content is one heading reads as that heading. Mintlify publishes a custom
 * heading anchor that way - `<div id="openapi-overlays">` around `## OpenAPI Overlays` - and the
 * migration lifts the heading out carrying the id. The author wrote a heading with an anchor; the
 * wrapper was how the platform spelled the anchor, so the two say the same thing.
 *
 * Narrow on purpose: a named wrapper, one heading, nothing else, and no prop that carries content.
 * A wrapper holding a heading *and* other blocks still has to match, because then it groups something.
 */
function anchorHeadingShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (!ANCHOR_WRAPPERS.has(block.name)) return undefined;
  const content = block.children.filter((child) => !(child.type === 'paragraph' && !inlineShape(child.children).length));
  const props = contentProps(block.props) as Record<string, unknown>;
  const carries = Object.keys(props).filter((key) => key !== 'id');
  if (carries.length) return undefined;
  // An id'd div with nothing in it is an anchor and only an anchor - the target an older link still
  // uses, before a heading that has since been renamed. The conversion writes it as that anchor
  // element, which holds nothing authored and shapes to nothing; so does the div it came from.
  if (!content.length) return typeof props.id === 'string' && props.id ? [] : undefined;
  if (content[0].type !== 'heading') return undefined;
  // The anchor is the platform's spelling of a heading id, so the conversion lifts the heading out
  // carrying it and leaves what followed in place. Everything the div held is still compared, in the
  // same order; only the wrapper the platform needed to name the anchor is gone.
  return blocksShape(content, false);
}

/**
 * A prompt is text meant to be copied, introduced by a description the source renders as visible
 * prose (`data-component-part="prompt-description"`), so it reads as that paragraph followed by the
 * text as a code block - which is what the conversion writes.
 *
 * Keyed to the component name, not to "a component with a description": promoting any description
 * prop to prose would invent text for components whose description the reader never sees.
 */
function promptShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (block.name !== 'Prompt') return undefined;
  const description = typeof block.props.description === 'string' ? block.props.description.trim() : '';
  // The conversion flattens the prompt with blocksText, so this reads it with blocksText too. Reading
  // it any other way would drop whatever that function keeps and this one does not - a prompt written
  // as a numbered list lost its steps here while the output carried them, and the page quarantined.
  const value = blocksText(block.children) ?? '';
  if (!value) return undefined;
  return [
    ...(description ? [{ type: 'paragraph', children: [{ type: 'text', value: description }] } as FidelityValue] : []),
    { type: 'code', lang: 'text', meta: '', title: '', value },
  ];
}

/**
 * A file in a file tree states one thing: its name. The target has no tree, so the conversion writes
 * the name as code in the tree's reading order, which is what a reader of the source sees in that row.
 * Keyed to the name and to a file that states nothing else, so a tree node that carried more than a
 * name still has to match.
 */
function treeFileShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (block.name !== 'Tree.File' || block.children.length) return undefined;
  const props = contentProps(block.props) as Record<string, FidelityValue>;
  const name = props.name;
  if (typeof name !== 'string' || !name || Object.keys(props).length !== 1) return undefined;
  return [{ type: 'paragraph', children: [{ type: 'inlineCode', value: name }] }];
}

/** Source components the conversion reads as a Card. Named, so this is not a licence for any component to become one. */
const CARD_SOURCES = new Set(['PreviewButton', 'GitHub.Repo', 'ThemeCard', 'HeroCard', 'Tile']);

/**
 * The card family. A themed card, a hero card, a tile, a button and a repository card are all a
 * title, a link and some supporting text, which is what the target's Card is - so the conversion
 * reads each as one, moving the description into the card's own text, an image child onto the card,
 * and a repo name to the address it always pointed at.
 *
 * This mirrors the conversion exactly rather than relaxing the comparison: every word still has to
 * match, and a card that lost its description or its link still fails. Keyed to these names, so no
 * other component may quietly become a Card.
 */
function cardSourceShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (!CARD_SOURCES.has(block.name)) return undefined;
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const repo = str(block.props.repo);
  const images = block.children.filter((child): child is Extract<Block, { type: 'image' }> => child.type === 'image');
  const rest = block.children.filter((child) => child.type !== 'image');
  const label = cleanText(rest.map((child) => (child.type === 'paragraph' || child.type === 'heading' ? inlineText(child.children) : '')).join(' '));
  const title = str(block.props.title) ?? repo ?? label ?? 'Card';
  if (!title) return undefined;
  const href = str(block.props.href) ?? (repo ? `https://github.com/${repo}` : undefined);
  const image = str(block.props.image) ?? (images[0] ? images[0].url : undefined);
  const description = str(block.props.description);
  const body = str(block.props.title) || repo ? rest : [];
  const props: Record<string, string | number | boolean> = { title };
  if (href) props.href = href;
  if (image) props.image = image;
  const children: FidelityValue[] = [
    ...(description ? [{ type: 'paragraph', children: [{ type: 'text', value: description }] } as FidelityValue] : []),
    ...blocksShape(body, false),
  ];
  return [{ type: 'component', props: ordered(props), children }];
}

/**
 * A row of swatches is a titled group, which the conversion states as a disclosure holding the row -
 * so the row's own title survives rather than being dropped.
 */
function colorRowShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (block.name !== 'Color.Row') return undefined;
  const title = typeof block.props.title === 'string' && block.props.title.trim() ? block.props.title.trim() : undefined;
  const inner: FidelityValue = { type: 'component', props: ordered({}), children: blocksShape(block.children, false) };
  return title ? [{ type: 'component', props: ordered({ title }), children: [inner] }] : [inner];
}

/**
 * A heading written as raw HTML is a heading, and its level is its tag. The site root states its
 * own title that way - `<h1 className="…">Documentation</h1>` - and reading the wrapper as a
 * component rather than the heading it becomes left that page, and the whole site's initial route,
 * unconverted. Keyed to the tag names, and only when the wrapper carries nothing of its own.
 */
function htmlHeadingShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (!HTML_HEADINGS.has(block.name)) return undefined;
  if (Object.keys(contentProps(block.props) as Record<string, unknown>).length) return undefined;
  const content = block.children.filter((child) => !(child.type === 'paragraph' && !inlineShape(child.children).length));
  const [only] = content;
  if (content.length !== 1 || (only.type !== 'paragraph' && only.type !== 'heading')) return undefined;
  const depth = Number(block.name.slice(1));
  return [{ type: 'heading', depth, children: inlineShape(only.children) }];
}

/** A divider written as raw HTML states nothing but itself. */
function htmlRuleShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (!HTML_RULES.has(block.name) || block.children.length) return undefined;
  return Object.keys(contentProps(block.props) as Record<string, unknown>).length ? undefined : [{ type: 'thematicBreak' }];
}

/** A container whose label the target spells `title`: the same words under a different prop name. */
function renamedLabelShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  const from = RENAMED_LABEL.get(block.name);
  const label = from && block.props[from];
  if (typeof label !== 'string' || !label.trim()) return undefined;
  const rest = Object.fromEntries(Object.entries(block.props).filter(([key]) => key !== from));
  const props = contentProps({ ...rest, title: label }) as Record<string, FidelityValue>;
  return [{ type: 'component', props: ordered(props), children: blocksShape(block.children, false) }];
}

/**
 * A colour swatch is a named value. The conversion titles a card with the name and puts the value
 * in a code block the reader can copy, so the hex the swatch states is still on the page - which is
 * the whole content of a swatch, and why this is read rather than left to differ.
 */
function colorSwatchShape(block: { name: string; props: Record<string, string | number | boolean | null>; children: Block[] }): FidelityValue[] | undefined {
  if (block.name !== 'Color.Item') return undefined;
  const label = typeof block.props.name === 'string' ? block.props.name : '';
  const value = typeof block.props.value === 'string' ? block.props.value : '';
  if (!label && !value) return undefined;
  return [{
    type: 'component', props: ordered({ title: label || value }),
    children: value ? [{ type: 'code', lang: 'css', meta: '', title: '', value }] : [],
  }];
}

/** An `<a id="x"></a>` with no content: a link target, never something the page says. */
function isAnchorShim(block: Block): boolean {
  if (block.type !== 'component' && block.type !== 'dai') return false;
  if (block.name !== 'a' || block.children.length) return false;
  const keys = Object.keys(block.props ?? {});
  return keys.length > 0 && keys.every((key) => key === 'id' || key === 'name');
}

function blocksShape(blocks: Block[], exactComponents: boolean): FidelityValue[] {
  return mergeAdjacentLists(blocksShapeRaw(blocks, exactComponents));
}

/**
 * Two lists written one after another are one list when read back: Markdown has no way to end a
 * list and start another of the same kind. The items are still compared one for one, so a list
 * item that went missing still fails; only the split between two adjacent lists is let go.
 */
function mergeAdjacentLists(values: FidelityValue[]): FidelityValue[] {
  const out: FidelityValue[] = [];
  for (const value of values) {
    const previous = out[out.length - 1] as { type?: string; ordered?: boolean; start?: unknown; children?: FidelityValue[] } | undefined;
    const current = value as { type?: string; ordered?: boolean; start?: unknown; children?: FidelityValue[] };
    // A list written after another of the same kind continues it, whatever number it says it starts
    // at: Flare writes `<ol start="2">` to resume after an interruption, and Markdown has no way to
    // say that except by carrying on. The items are still compared one for one.
    if (previous?.type === 'list' && current?.type === 'list' && previous.ordered === current.ordered) {
      previous.children = [...(previous.children ?? []), ...(current.children ?? [])];
      continue;
    }
    out.push(value);
  }
  return out;
}

function blocksShapeRaw(blocks: Block[], exactComponents: boolean): FidelityValue[] {
  return blocks.flatMap((block): FidelityValue[] => {
    switch (block.type) {
      case 'paragraph': {
        // A paragraph with nothing in it is not something an author wrote. GitBook publishes spacer
        // paragraphs (a lone `&#x20;`) between blocks; they serialise to a blank line and come back
        // from a re-parse as nothing, which made a page differ from its own written file. Empty
        // inline text is already dropped above, so this is the same rule one level up.
        const children = inlineShape(block.children);
        // A code span that runs over several lines is a block of code, not a phrase: it is written
        // as a fence, and a fence reads back as a code block. Comparing it either way as the block
        // it is keeps the two spellings equal.
        const loneCode = children.length === 1 ? (children[0] as { type?: string; value?: string }) : undefined;
        if (loneCode?.type === 'inlineCode' && loneCode.value?.includes('\n')) return [{ type: 'code', lang: '', meta: '', title: '', value: loneCode.value.replace(/\r\n/g, '\n') }];
        // A paragraph holding only line breaks is blank space, not something the page says: written
        // out it is a `<br />` on its own line, which reads back as a bare element rather than a
        // paragraph around one.
        if (children.length && children.every((child) => (child as { type?: string }).type === 'break')) return [];
        // An image alone in a paragraph is written as a line holding only that image, and comes back
        // from a re-parse as a block image: Markdown has no way to say "this image is wrapped". The
        // paragraph is the wrapper, not the content, so a lone image reads as the image either way.
        // A paragraph with an image *and* text keeps its shape, because that text is content.
        if (children.length === 1 && (children[0] as { type?: string }).type === 'image') return [children[0]];
        return children.length ? [{ type: 'paragraph', children }] : [];
      }
      case 'heading': return [{ type: 'heading', depth: block.depth, children: inlineShape(block.children) }];
      case 'code': {
        // A code block's title is the filename label the source shows above it. GitBook states it in
        // the rendered page but not on the Markdown fence, so the published-Markdown witness cannot
        // speak to it and reading its silence as a difference failed a page whose output was right.
        // Like ParamField's `type`, it is proven elsewhere: the snapshot reads it from the rendered
        // source, `conversion-fidelity` proves conversion kept it, and `serialized-output-exact`
        // proves the written file still carries it.
        const serializedMeta = exactComponents ? [`${block.title ? `title="${block.title.replace(/["\r\n`~]/g, ' ').trim()}"` : ''}`, block.meta ?? ''].filter(Boolean).join(' ') : (block.meta ?? '').replace(/\btitle="[^"]*"/g, '').trim();
        return [{ type: 'code', lang: block.lang ?? '', meta: serializedMeta, title: '', value: block.value.replace(/\r\n/g, '\n') }];
      }
      case 'blockquote': return [{ type: 'blockquote', children: blocksShape(block.children, exactComponents) }];
      case 'list': {
        // Markdown cannot write an ordered list that does not start somewhere, so `1. ` re-parses as
        // start 1 where the source stated no start at all. They are the same list. A start the source
        // *did* state is still compared, so a list that begins at 5 and loses it still fails.
        const start = block.ordered && block.start !== undefined && block.start !== 1 ? block.start : null;
        // A list with no items writes no lines at all, so it cannot come back from a re-parse. It
        // states nothing either; a list that *lost* its items fails on the items, not on the list.
        if (!block.children.length) return [];
        return [{ type: 'list', ordered: block.ordered, start, children: block.children.map((item) => ({ type: 'listItem', checked: item.checked ?? null, children: blocksShape(item.children, exactComponents) })) }];
      }
      case 'table': {
        // A GFM table must write a delimiter row, which re-parses as one unaligned entry per column
        // where the source stated no alignment. A table that aligns nothing and a table whose every
        // column takes the default are the same table; any column the source did align is compared.
        const stated = (block.align ?? []).map((value) => value ?? null);
        const align = stated.some((value) => value !== null) ? stated : [];
        // GFM cannot write a table without a header row, so a source table that has none grows an
        // empty one on the way out and back. An empty header states nothing; a header with words in
        // it is content and is compared like any other row.
        const rows = block.children
          .map((row) => ({ type: 'row', header: row.isHeader ?? false, children: row.children.map((cell) => inlineShape(cell.children)) }))
          .filter((row, index) => !(index === 0 && row.header && row.children.every((cell) => !cell.length)));
        return [{ type: 'table', align: ordered(align), children: rows }];
      }
      case 'thematicBreak': return [{ type: 'thematicBreak' }];
      case 'footnoteDefinition': return [{ type: 'footnoteDefinition', identifier: block.identifier, children: blocksShape(block.children, exactComponents) }];
      case 'image': return [{ type: 'image', url: sameAddress(block.url), alt: block.alt, title: block.title ?? '', width: block.width ?? null, height: block.height ?? null }];
      case 'figure': {
        if (exactComponents) return [blocksShape([block.image], true)[0], ...(block.caption?.length ? [{ type: 'paragraph', children: [{ type: 'emphasis', children: inlineShape(block.caption) }] } as FidelityValue] : [])];
        // Without a caption a figure says exactly what its image says, so it reads as the image -
        // the same equivalence framedImageShape already applies to a component wrapping one image.
        // With one it reads as the picture and the italic line under it, which is what the file
        // holds: a figure is a node this IR has and target MDX does not, so a comparison that kept
        // it here could never agree with the same page read back from disk.
        const caption = inlineShape(block.caption ?? []);
        const image = blocksShape([block.image], false)[0];
        return caption.length ? [image, { type: 'paragraph', children: [{ type: 'emphasis', children: caption }] }] : [image];
      }
      case 'component': case 'dai': {
        // An empty `<a id="...">` is an anchor shim the migrator wrote so a renamed heading keeps the
        // link target the source gave it. It holds nothing an author wrote, and the resolved IR does
        // not carry it, so counting it as a block made every page with a shim differ from its own file.
        if (isAnchorShim(block)) return [];
        // The same blank space, read back from the file as a bare `br` element.
        if (block.name === 'br' && !block.children.length) return [];
        if (exactComponents) return [{ type: 'component', name: block.name, props: ordered(block.props), children: blocksShape(block.children, true) }];
        const framed = framedImageShape(block);
        if (framed) return framed;
        const anchored = anchorHeadingShape(block);
        if (anchored) return anchored;
        const prompt = promptShape(block);
        if (prompt) return prompt;
        const embed = framedEmbedShape(block);
        if (embed) return embed;
        for (const read of [treeFileShape, cardSourceShape, colorRowShape, htmlHeadingShape, htmlRuleShape, renamedLabelShape, colorSwatchShape]) {
          const shaped = read(block);
          if (shaped) return shaped;
        }
        const bare = bareUrlShape(contentProps(block.props), block.children);
        if (bare) return bare;
        const folded = titleFold(contentProps(block.props), block.children);
        return [{ type: 'component', props: folded.props, children: blocksShape(folded.children, false) }];
      }
      case 'html': return /^\s*<a\s+id=["'][^"']+["']\s*><\/a>\s*$/i.test(block.value) ? [] : [{ type: 'html', value: block.value.trim() }];
      case 'rawHtml': {
        // The migration writes this class itself, so matching it cannot let an unrelated
        // component-to-HTML conversion pass: the marker appears only where the migration put it.
        const badge = exactComponents ? null : BADGE_MARKER.exec(block.value.trim());
        if (badge) return [{ type: 'component', props: ordered({}), children: [{ type: 'paragraph', children: [{ type: 'text', value: badge[1] }] }] }];
        return [{ type: 'html', value: block.value.trim() }];
      }
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
