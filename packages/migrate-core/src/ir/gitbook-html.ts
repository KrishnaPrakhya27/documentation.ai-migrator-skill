/**
 * GitBook's published Markdown writes some native blocks as HTML: cards as a
 * `<table data-view="cards">`, button links as `<a class="button">`, prompts for
 * its assistant as `<button data-action="ask">`, and layout with `align`.
 * CommonMark reads a one-line HTML block as HTML, so these reach the IR through
 * the HTML adapter; a card table becomes the `cards` and `card` source
 * components the GitBook mapping table resolves.
 */
import { findAll, htmlToIr, parseHtml, textOf, type Dom, type El, type HtmlAdapterOptions } from './from-html.js';
import { getProfile } from '../scrape/profiles.js';
import { nodeId } from '../session/ids.js';
import type { Block, ComponentNode } from './types.js';

/** Elements CommonMark reads as HTML blocks. GitBook's Liquid tags (hint, tabs, code, embed…) are deliberately absent. */
const HTML_BLOCK = new Set(['address', 'article', 'aside', 'audio', 'blockquote', 'button', 'details', 'div', 'dl', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'iframe', 'ol', 'p', 'picture', 'pre', 'section', 'table', 'ul', 'video']);
/** Inline HTML the Markdown adapter turns into inline nodes (br, kbd and img have their own handling). */
const HTML_INLINE = new Set(['a', 'abbr', 'b', 'del', 'em', 'i', 'label', 'mark', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u']);
/** Wrappers that only lay out their content; holding Markdown, they pass it through. */
export const TRANSPARENT_HTML: ReadonlySet<string> = new Set(['article', 'div', 'section']);
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr']);

/** Elements GitBook itself writes into its published Markdown, beyond the block and inline sets: table and list parts, figure captions, details, and this tool's own snippet marker. */
const HTML_OTHER = new Set(['kbd', 'code', 'figcaption', 'summary', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'li', 'dd', 'dt', 'embed', 'object', 'svg', 'path', 'snippetref', 'nav', 'main', 'span']);

/**
 * Whether GitBook would render `<name …>` as an element. GitBook's editor allows no HTML of the
 * author's: anything else in angle brackets — `gitbook integrations new <dir>`, `<num>` — is text
 * the author typed, which GitBook shows as typed and MDX would swallow as a tag.
 */
export function isGitbookHtmlTag(name: string): boolean {
  const lower = name.toLowerCase();
  return HTML_BLOCK.has(lower) || HTML_INLINE.has(lower) || VOID.has(lower) || TRANSPARENT_HTML.has(lower) || HTML_OTHER.has(lower);
}

export function isGitbookHtmlBlock(name: string): boolean {
  return HTML_BLOCK.has(name.toLowerCase());
}

export function isGitbookHtmlInline(name: string): boolean {
  return HTML_INLINE.has(name.toLowerCase());
}

/**
 * Whether a `<picture>`'s `<source srcset>` candidate addresses the file by GitBook's internal id
 * rather than a public URL. GitBook's published Markdown writes the dark-mode variant of a picture
 * as `srcset="/files/<id>"`, which it publishes nowhere: resolved against the site it answers 404,
 * and the space's own file host answers 403. It is a reference into GitBook's storage, not an asset
 * with an address, so it cannot be hosted and is not one. The `<img>` beside it carries the same
 * picture at a real URL and is what the page shows, in either colour scheme.
 */
export function isGitbookInternalFileRef(url: string): boolean {
  return /^\/files\/[A-Za-z0-9]+$/.test(url.trim());
}

function htmlOptions(file: string): HtmlAdapterOptions {
  return { platform: 'gitbook', file, recognisers: getProfile('gitbook').recognisers };
}

/** One HTML block, written without blank lines, as IR. `file` namespaces the node ids. */
/**
 * GitBook writes a row of buttons with nothing between them (`<a class="button">Quickstart</a><a
 * class="button">GitBook MCP</a>`) and renders each as its own button with a gap. As links they
 * would run together into one word ("QuickstartGitBook MCP"), so the gap is written as the space it is.
 */
function separateButtons(html: string): string {
  return html.replace(/(<\/a>)(?=<a\b[^>]*\bclass="[^"]*\bbutton\b)/g, (close, _g, offset: number) => {
    const opened = html.lastIndexOf('<a', offset);
    return /\bclass="[^"]*\bbutton\b/.test(html.slice(opened, offset)) ? `${close} ` : close;
  });
}

export function gitbookHtmlBlockToIr(rawHtml: string, file: string): Block[] {
  const html = separateButtons(rawHtml);
  const element = parseHtml(html).children.find((child): child is El => child.type === 'tag');
  if (element?.name === 'table' && element.attribs['data-view'] === 'cards') return [cardTable(element, file)];
  return htmlToIr(html, htmlOptions(file)).children;
}

type CardColumn = 'content' | 'target' | 'cover' | 'hidden';

/**
 * GitBook cards as its Markdown export writes them: one row per card, with the header
 * declaring which hidden columns hold the card's target link (`data-card-target`) and cover
 * image (`data-card-cover`). The first visible cell that is only a Font Awesome icon is the
 * icon, the first that is only a heading or bold text is the title, and the rest is the body.
 */
function cardTable(table: El, file: string): ComponentNode {
  const roles = findAll(table, 'th').map((th): CardColumn => ('data-card-target' in th.attribs ? 'target' : 'data-card-cover' in th.attribs ? 'cover' : 'data-hidden' in th.attribs ? 'hidden' : 'content'));
  const props: ComponentNode['props'] = {};
  for (const [key, value] of Object.entries(table.attribs)) props[key] = value === '' ? true : value;
  const rows = findAll(table, 'tr').filter((row) => row.children.some((cell) => cell.type === 'tag' && cell.name === 'td'));
  const cards = rows.map((row, index) => card(row, roles, `${file}::card${index}`));
  // GitBook lays cards out three to a row, or two when the table asks for large cards; left to the
  // target's default of two, a row of three wrapped its third card onto a line of its own.
  if (props.cols === undefined) props.cols = table.attribs['data-card-size'] === 'large' ? 2 : 3;
  return { id: nodeId(file, [0], `cards:${textOf(table).slice(0, 80)}`), type: 'component', name: 'cards', platform: 'gitbook', props, children: cards, src: { file } };
}

function card(row: El, roles: CardColumn[], file: string): ComponentNode {
  const props: ComponentNode['props'] = {};
  const body: El[] = [];
  const cells = row.children.filter((cell): cell is El => cell.type === 'tag' && (cell.name === 'td' || cell.name === 'th'));
  cells.forEach((cell, column) => {
    const role = roles[column] ?? 'content';
    const link = findAll(cell, 'a').find((a) => a.attribs.href)?.attribs.href;
    if (role === 'target') { if (link) props.href = link; return; }
    if (role === 'cover') {
      const cover = link ?? findAll(cell, 'img').find((img) => img.attribs.src)?.attribs.src;
      if (cover) props.image = cover;
      return;
    }
    // GitBook renders no other hidden column
    if (role === 'hidden' || isEmpty(cell)) return;
    const icons = iconsOf(cell);
    if (icons && props.icon === undefined && props.title === undefined) {
      // GitBook may show several icons (`:claude: :chatgpt: :cursor:`); a card has one. The cell is
      // the card's icon either way and never its title. A name with no Lucide equivalent (a brand
      // logo) leaves the card without an icon rather than a broken one.
      const lucide = icons.length === 1 ? lucideIcon(icons[0]) : undefined;
      if (lucide) props.icon = lucide;
      return;
    }
    if (props.title === undefined && isTitleCell(cell)) { props.title = cleanText(textOf(cell)); return; }
    // A cell that opens with a heading and goes on (`<h4>Title</h4><p>Blurb</p>`) titles the card
    // with the heading; the rest is the card's body, not part of its title.
    const lead = cell.children.find((child): child is El => child.type === 'tag');
    if (props.title === undefined && lead && /^h[1-6]$/.test(lead.name) && cell.children.some((child) => child !== lead && !(child.type === 'text' && !child.data.trim()))) {
      props.title = cleanText(textOf(lead));
      body.push({ ...cell, children: cell.children.filter((child) => child !== lead) });
      return;
    }
    body.push(cell);
  });
  if (props.title === undefined) {
    const first = body.shift();
    props.title = first ? cleanText(textOf(first)) : '';
  }
  const children = body.flatMap((cell, index) => htmlToIr(cell.children.map(htmlOf).join(''), htmlOptions(`${file}.${index}`)).children);
  return { id: nodeId(file, [1], `card:${String(props.title)}`), type: 'component', name: 'card', platform: 'gitbook', props, children, src: { file } };
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isEmpty(cell: El): boolean {
  return !cleanText(textOf(cell)) && !findAll(cell, 'img').length;
}

/** A cell holding one heading or one run of bold text. */
function isTitleCell(cell: El): boolean {
  const content = cell.children.filter((child) => child.type === 'tag' || child.data.trim());
  return content.length === 1 && content[0].type === 'tag' && /^(?:h[1-6]|strong|b)$/.test(content[0].name);
}

/** The Font Awesome names of a cell holding only icons (`<h4><i class="fa-leaf">:leaf:</i></h4>`), in order. */
function iconsOf(cell: El): string[] | undefined {
  const icons = findAll(cell, 'i').filter((i) => /(?:^|\s)fa-[\w-]+/.test(i.attribs.class ?? ''));
  if (!icons.length || cleanText(textOf(cell)) !== cleanText(icons.map((icon) => textOf(icon)).join(' '))) return undefined;
  return icons.map((icon) => (icon.attribs.class ?? '').match(/(?:^|\s)fa-([\w-]+)/)![1]);
}

/**
 * Font Awesome names GitBook uses whose Lucide icon (what Documentation.AI renders) is spelled
 * differently, matched by what the icon shows. A name Lucide shares is used as it is; a brand logo
 * Lucide does not carry has no entry and yields no icon.
 */
const FONT_AWESOME_TO_LUCIDE: Record<string, string> = {
  'wand-magic-sparkles': 'wand-sparkles', 'code-branch': 'git-branch', 'pen-to-square': 'square-pen',
  'magnifying-glass-chart': 'chart-column', 'pen-ruler': 'pencil-ruler', 'file-import': 'file-input',
  'magnifying-glass': 'search', 'hand-pointer': 'pointer', 'clock-rotate-left': 'history', 'life-ring': 'life-buoy',
  'table-columns': 'columns-3', 'layer-group': 'layers', language: 'languages', 'code-pull-request': 'git-pull-request',
  'puzzle-piece': 'puzzle', gears: 'cog', robot: 'bot', 'file-lines': 'file-text', 'globe-pointer': 'globe',
  'window-restore': 'app-window', 'clipboard-list-check': 'clipboard-check', 'rectangle-terminal': 'square-terminal',
  'chart-line-up': 'chart-line', 'octagon-check': 'circle-check',
};
const BRAND_ICONS = new Set(['claude', 'chatgpt', 'cursor', 'react', 'google', 'github', 'gitlab', 'slack', 'discord', 'figma', 'openai', 'x-twitter', 'linkedin', 'youtube']);

function lucideIcon(fontAwesome: string): string | undefined {
  if (BRAND_ICONS.has(fontAwesome)) return undefined;
  return FONT_AWESOME_TO_LUCIDE[fontAwesome] ?? fontAwesome;
}

/** A parsed fragment as HTML again; the parser decoded entities, so text and attribute values are escaped anew. */
function htmlOf(node: Dom): string {
  if (node.type === 'text') return node.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrs = Object.entries(node.attribs).map(([key, value]) => ` ${key}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  return VOID.has(node.name) ? `<${node.name}${attrs} />` : `<${node.name}${attrs}>${node.children.map(htmlOf).join('')}</${node.name}>`;
}
