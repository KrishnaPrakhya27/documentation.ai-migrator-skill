/**
 * Media a page addresses from inside raw HTML, and the variants an image offers.
 *
 * The block adapters see `![alt](url)` and `<img src>`, so those assets are inventoried, hosted
 * and rewritten. Three shapes were invisible to them, and each one leaves the customer's asset on
 * the platform they are leaving: the `srcset` variants of an image, media inside a raw-HTML
 * fragment the rules engine preserved verbatim, and a CSS `background-image` in a style attribute.
 * When that platform is switched off, those files stop loading on the migrated site.
 *
 * Raw HTML is preserved byte for byte, so it is never parsed and re-serialised here: attribute
 * value spans are located and rewritten in place, and everything around them is left untouched.
 */

export type HtmlMediaKind = 'image' | 'video' | 'audio' | 'poster';

export interface HtmlMediaReference {
  url: string;
  kind: HtmlMediaKind;
}

/** Every attribute in a tag, with the offsets of its value so it can be rewritten in place. */
interface AttributeSpan {
  name: string;
  value: string;
  start: number;
  end: number;
}

const TAG_NAME = /^<([a-zA-Z][\w-]*)/;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;
const BACKGROUND_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g;

/**
 * The candidate URLs of a `srcset`, in source order.
 *
 * Each candidate is a URL followed by an optional width or density descriptor. A URL containing a
 * comma must be percent-encoded to be legal here, so splitting on commas is safe.
 */
export function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((url) => url && url !== ',');
}

function attributesOf(tag: string, tagStart: number): AttributeSpan[] {
  const out: AttributeSpan[] = [];
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(tag); match; match = ATTRIBUTE.exec(tag)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const start = tagStart + match.index + match[0].length - value.length - (match[4] === undefined ? 1 : 0);
    out.push({ name: match[1].toLowerCase(), value, start, end: start + value.length });
  }
  return out;
}

/** The media kind an attribute refers to, or undefined when it refers to no media at all. */
function kindOf(tagName: string, attribute: string): HtmlMediaKind | undefined {
  const tag = tagName.toLowerCase();
  if (attribute === 'poster') return 'poster';
  if (attribute === 'src' || attribute === 'data-src' || attribute === 'srcset' || attribute === 'data-srcset') {
    // <source> carries the media of the <picture>/<video>/<audio> around it; treated as image
    // unless the tag names otherwise, which is what the asset provider needs to fetch it.
    return tag === 'video' ? 'video' : tag === 'audio' ? 'audio' : 'image';
  }
  return undefined;
}

/** Walks every media URL in the fragment, reporting where its text sits so a caller can rewrite it. */
function walkMedia(html: string, visit: (url: string, kind: HtmlMediaKind, start: number, end: number) => void): void {
  for (const { name, attributes, attributeStart } of tagsIn(html)) {
    for (const attribute of attributesOf(attributes, attributeStart)) {
      const kind = kindOf(name, attribute.name);
      if (kind && (attribute.name === 'srcset' || attribute.name === 'data-srcset')) {
        // a candidate list: each URL is rewritten where it sits, so the descriptors stay as authored
        let cursor = 0;
        for (const url of srcsetUrls(attribute.value)) {
          const offset = attribute.value.indexOf(url, cursor);
          if (offset < 0) continue;
          cursor = offset + url.length;
          visit(url, kind, attribute.start + offset, attribute.start + offset + url.length);
        }
        continue;
      }
      if (kind && attribute.value) { visit(attribute.value, kind, attribute.start, attribute.end); continue; }
      if (attribute.name !== 'style') continue;
      BACKGROUND_URL.lastIndex = 0;
      for (let url = BACKGROUND_URL.exec(attribute.value); url; url = BACKGROUND_URL.exec(attribute.value)) {
        const value = url[1] ?? url[2] ?? url[3] ?? '';
        if (!value || value.startsWith('data:')) continue;
        const offset = url.index + url[0].indexOf(value);
        visit(value, 'image', attribute.start + offset, attribute.start + offset + value.length);
      }
    }
  }
}

/**
 * The tags in a fragment, with where their attributes sit.
 *
 * A tag cannot be matched with `<[^>]*>`: `>` is legal inside an attribute value (`alt="A > B"`),
 * and stopping at it drops every attribute after it, so an image would keep the URL it had. The
 * scan therefore tracks quoting and ends a tag only at a `>` outside a quoted value.
 */
function tagsIn(html: string): Array<{ name: string; attributes: string; attributeStart: number }> {
  const out: Array<{ name: string; attributes: string; attributeStart: number }> = [];
  for (let open = html.indexOf('<'); open >= 0; open = html.indexOf('<', open + 1)) {
    const name = TAG_NAME.exec(html.slice(open, open + 64));
    if (!name) continue;
    const attributeStart = open + name[0].length;
    let end = attributeStart;
    let quote: string | undefined;
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = undefined; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '>') break;
    }
    out.push({ name: name[1], attributes: html.slice(attributeStart, end), attributeStart });
    open = end;
  }
  return out;
}

/** Every media file a raw-HTML fragment addresses, in source order, duplicates included. */
export function htmlMediaReferences(html: string): HtmlMediaReference[] {
  const out: HtmlMediaReference[] = [];
  walkMedia(html, (url, kind) => { if (url && !url.startsWith('data:')) out.push({ url, kind }); });
  return out;
}

/**
 * The same fragment with every media URL replaced by what `rewrite` returns for it. Only the URL
 * spans change: a fragment whose assets all keep their URL is returned unchanged, character for
 * character.
 */
export function rewriteHtmlMedia(html: string, rewrite: (url: string) => string): string {
  const edits: Array<{ start: number; end: number; value: string }> = [];
  walkMedia(html, (url, _kind, start, end) => {
    if (!url || url.startsWith('data:')) return;
    const replacement = rewrite(url);
    if (replacement !== url) edits.push({ start, end, value: replacement });
  });
  let out = html;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
  return out;
}
