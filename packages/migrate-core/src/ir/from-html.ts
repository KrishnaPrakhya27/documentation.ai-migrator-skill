/**
 * HTML → DocIR. Works on the parsed tree with classes and attributes intact
 * (never through Markdown), and lets a platform profile declare which
 * elements are components so the rules engine can map them.
 */
import { Parser } from 'htmlparser2';
import type { Block, Inline, ImageNode, ComponentNode, HeadingNode, ListItemNode, TableRowNode, Frontmatter, DocIR } from './types.js';
import { inlineText } from './types.js';
import { readPixelDimension } from './dimensions.js';
import { nodeId } from '../session/ids.js';
import { srcsetUrls } from '../assets/html-media.js';

/** Minimal DOM built from htmlparser2 events. */
export interface El { type: 'tag'; name: string; attribs: Record<string, string>; children: Dom[]; parent?: El }
export interface Txt { type: 'text'; data: string; parent?: El }
export type Dom = El | Txt;

export function parseHtml(html: string): El {
  const root: El = { type: 'tag', name: '#root', attribs: {}, children: [] };
  let cur: El = root;
  const parser = new Parser({
    onopentag(name, attribs) {
      const el: El = { type: 'tag', name: name.toLowerCase(), attribs, children: [], parent: cur };
      cur.children.push(el);
      cur = el;
    },
    ontext(data) { cur.children.push({ type: 'text', data, parent: cur }); },
    onclosetag() { if (cur.parent) cur = cur.parent; },
  }, { decodeEntities: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  return root;
}

/** Tiny selector matcher: tag, *, #id, .class, tag.class, tag[attr], tag[attr=value], descendant combinators (space), comma lists. */
export function matchesSelector(el: El, selector: string): boolean {
  return selector.split(',').some((sel) => {
    const compounds = splitDescendantCompounds(sel.trim());
    if (!compounds.length || !matchesCompound(el, compounds[compounds.length - 1])) return false;
    let ancestor = el.parent;
    for (let i = compounds.length - 2; i >= 0; i--) {
      while (ancestor && !matchesCompound(ancestor, compounds[i])) ancestor = ancestor.parent;
      if (!ancestor) return false;
      ancestor = ancestor.parent;
    }
    return true;
  });
}

/** Splits `a b[x="y z"] c` on whitespace outside attribute brackets. */
function splitDescendantCompounds(selector: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of selector) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function matchesCompound(el: El, compound: string): boolean {
  const m = compound.match(/^(\*|[a-z0-9-]+)?(#[A-Za-z0-9_-]+)?((?:\.[A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  const [, tag, idSel, classes, attrs] = m;
  if (tag && tag !== '*' && el.name !== tag.toLowerCase()) return false;
  if (idSel && el.attribs.id !== idSel.slice(1)) return false;
  const cls = (el.attribs.class ?? '').split(/\s+/).filter(Boolean);
  for (const c of classes.split('.').filter(Boolean)) if (!cls.includes(c)) return false;
  for (const a of attrs.match(/\[[^\]]+\]/g) ?? []) {
    const am = a.slice(1, -1).match(/^([^\]=~^$*|]+)(?:([~^$*|]?)=["']?([^"']*)["']?)?$/);
    if (!am) return false;
    const [, k, op, v] = am;
    const actual = el.attribs[k];
    if (actual === undefined) return false;
    if (v === undefined) continue;
    // [a=v] exact, [a^=v] starts, [a$=v] ends, [a*=v] contains, [a~=v] one whitespace-separated word
    const ok = op === '^' ? actual.startsWith(v) : op === '$' ? actual.endsWith(v) : op === '*' ? actual.includes(v)
      : op === '~' ? actual.split(/\s+/).includes(v) : op === '|' ? actual === v || actual.startsWith(`${v}-`) : actual === v;
    if (!ok) return false;
  }
  return true;
}

/** A platform profile tells the adapter which elements are components. */
export interface ComponentRecogniser {
  selector: string;
  /** Platform-native component name to assign. */
  name: string;
  /**
   * Props: literal values, or extractors: "@attr:name", "@attr-or-descendant:name", "@flag:name" (true when
   * a boolean HTML attribute such as controls is present, whatever its value), "@text:selector",
   * "@part:name" (text of the descendant with data-component-part=name, which is then removed from the
   * children so a lifted title is not also emitted as content), "@style-var:--name" (a custom property
   * from the style attribute; integers become numbers), "@count:selector", "@class-suffix:prefix".
   */
  props?: Record<string, string | number | boolean>;
  /** Child element selector whose contents become the component children (default: the element itself). */
  contentSelector?: string;
  /** Elements to strip from children before conversion (e.g. the summary of a details). */
  strip?: string[];
}

/** Whether a link is written anywhere inside this inline subtree. */
function containsLink(node: Inline): boolean {
  if (node.type === 'link') return true;
  return 'children' in node && Array.isArray(node.children) && node.children.some(containsLink);
}

/** Any inline content that renders as characters, so an anchor wrapping only an icon adds no link. */
function hasVisibleText(node: Inline): boolean {
  if (node.type === 'text') return node.value.trim().length > 0;
  if (node.type === 'inlineCode') return node.value.trim().length > 0;
  if (node.type === 'image') return true;
  return 'children' in node && Array.isArray(node.children) && node.children.some(hasVisibleText);
}

/** The same content with every nested link lifted to this level, in document order. */
function hoistLinks(nodes: Inline[]): Inline[] {
  return nodes.flatMap((node) => {
    if (node.type === 'link') return [node];
    if ('children' in node && Array.isArray(node.children) && node.children.some(containsLink)) return hoistLinks(node.children as Inline[]);
    return [node];
  });
}

/** A table wider than this is malformed markup, not a table; a bad colspan must not build an endless row. */
const MAX_TABLE_COLUMNS = 64;

export interface HtmlAdapterOptions {
  platform: string;
  file: string;
  recognisers?: ComponentRecogniser[];
  /** Selector for the article container; if given, only its contents are converted. */
  articleSelector?: string;
  /** Elements removed entirely (chrome). */
  removeSelectors?: string[];
  /** Elements the platform renders as paragraphs without a <p> tag (Mintlify: span[data-as="p"]); each becomes its own paragraph block. */
  paragraphSelectors?: string[];
  /** Extractor for a rendered code-block language (e.g. "@attr:language"), read from the <code> then the <pre>; the language-/lang- class is the fallback. */
  codeLanguage?: string;
  /** Iframe hosts allowed to become Iframe components; others become components named 'iframe' for the rules engine to quarantine. */
  iframeHosts?: string[];
}

export interface HtmlToIrResult {
  children: Block[];
  headings: HeadingNode[];
  images: ImageNode[];
  links: string[];
  /** Snippet tokens found inline; resolution happens at plan time. */
  unresolvedSnippets: string[];
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);
/**
 * The anchor a heading is linked to when it is not the heading's own `id`.
 *
 * Older HTML, and every MadCap Flare build, names a cross-reference target with an empty anchor
 * inside the heading — `<h2><a name="Member"></a>Member activity information</h2>` — and the
 * page's own links point at `#Member`. Reading only the heading's `id` leaves those links with
 * nothing to land on, so the first named anchor inside the heading counts as its source anchor.
 */
function namedAnchorIn(heading: El): string | undefined {
  for (const child of heading.children ?? []) {
    if (child.type !== 'tag' || child.name !== 'a') continue;
    const named = child.attribs.name || child.attribs.id;
    if (named) return named;
  }
  return undefined;
}

const INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'br', 'kbd', 'span', 'sup', 'sub', 'u', 'mark', 'small', 'abbr', 'img', 'time', 'label']);

/**
 * The first selector in a comma list that matches anywhere, rather than the first element in
 * document order that matches any of them. The two differ when one selector names an ancestor of
 * another's match: `#mc-main-content, [data-mc-content-body]` names the topic and then, as a
 * fallback, the wrapper around it — and document order found the wrapper first, footer and all.
 */
function firstMatching(root: El, selectors: string): El | undefined {
  for (const selector of splitSelectorList(selectors)) {
    const hit = find(root, selector);
    if (hit) return hit;
  }
  return undefined;
}

/** Comma-separated selectors, split only on the commas outside brackets, parentheses and quotes. */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0; let quote = ''; let current = '';
  for (const ch of list) {
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (current.trim()) out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function find(el: El, selector: string): El | undefined {
  for (const c of el.children) {
    if (c.type === 'tag') {
      if (matchesSelector(c, selector)) return c;
      const f = find(c, selector);
      if (f) return f;
    }
  }
  return undefined;
}

export function findAll(el: El, selector: string, out: El[] = []): El[] {
  for (const c of el.children) if (c.type === 'tag') { if (matchesSelector(c, selector)) out.push(c); findAll(c, selector, out); }
  return out;
}

export function textOf(el: Dom): string {
  if (el.type === 'text') return el.data;
  return el.children.map(textOf).join('');
}

function remove(el: El, selectors: string[]): void {
  el.children = el.children.filter((c) => !(c.type === 'tag' && selectors.some((s) => matchesSelector(c, s))));
  for (const c of el.children) if (c.type === 'tag') remove(c, selectors);
}

/** Copy of `el` with the given elements removed at any depth. */
function without(el: El, excluded: Set<El>): El {
  return {
    ...el,
    children: el.children.filter((c) => !(c.type === 'tag' && excluded.has(c))).map((c) => (c.type === 'tag' ? without(c, excluded) : c)),
  };
}

/** Value of a custom property in a style attribute ("--cols:2" → 2); integers become numbers so they compare equal to an authored `cols={2}`. */
function styleVariable(style: string | undefined, name: string): string | number | null {
  for (const declaration of (style ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0 || declaration.slice(0, colon).trim() !== name) continue;
    const value = declaration.slice(colon + 1).trim();
    return /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return null;
}

type ExtractedProp = string | number | boolean | null;

interface Extraction {
  value: ExtractedProp;
  /** The descendant lifted into the prop by "@part", to be removed from the children. */
  lifted?: El;
}

function extractProp(el: El, spec: string): Extraction {
  const [kind, arg] = spec.slice(1).split(':', 2);
  switch (kind) {
    case 'attr': return { value: el.attribs[arg] ?? null };
    case 'attr-or-descendant': return { value: el.attribs[arg] ?? find(el, `[${arg}]`)?.attribs[arg] ?? null };
    case 'flag': return { value: arg in el.attribs ? true : null };
    case 'text': { const t = arg ? find(el, arg) : el; return { value: t ? textOf(t).trim() : null }; }
    case 'part': { const part = find(el, `[data-component-part="${arg}"]`); return part ? { value: textOf(part).trim(), lifted: part } : { value: null }; }
    case 'style-var': return { value: styleVariable(el.attribs.style, arg) };
    case 'count': return { value: findAll(el, arg).length };
    case 'class-suffix': { const c = (el.attribs.class ?? '').split(/\s+/).find((x) => x.startsWith(arg)); return { value: c ? c.slice(arg.length) : null }; }
    default: return { value: null };
  }
}

/** Renderers emit their highlighter's language ids; the IR carries the fence names authors write. */
const RENDERED_CODE_LANGUAGE_ALIASES: Record<string, string> = { shellscript: 'bash', plaintext: '' };

function fenceLanguage(renderedId: string): string | undefined {
  const lang = RENDERED_CODE_LANGUAGE_ALIASES[renderedId] ?? renderedId;
  return lang || undefined;
}

export function htmlToIr(html: string, opts: HtmlAdapterOptions): HtmlToIrResult {
  const root = parseHtml(html);
  let scope: El = root;
  if (opts.articleSelector) scope = firstMatching(root, opts.articleSelector) ?? root;
  if (opts.removeSelectors?.length) remove(scope, opts.removeSelectors);

  const headings: HeadingNode[] = [];
  const images: ImageNode[] = [];
  const links: string[] = [];
  let counter = 0;
  const id = (path: number[], content: string) => nodeId(opts.file, path, content);

  const unresolvedSnippets: string[] = [];
  const inlineOf = (nodes: Dom[], path: number[]): Inline[] => {
    const out: Inline[] = [];
    nodes.forEach((n, i) => {
      const p = [...path, i];
      if (n.type === 'tag') {
        const r = (opts.recognisers ?? []).find((rr) => matchesSelector(n, rr.selector));
        if (r && r.name === 'snippetRef') {
          const token = n.attribs['data-token'] ?? textOf(n).trim();
          unresolvedSnippets.push(token);
          out.push({ id: id(p, `snippet:${token}`), type: 'inlineHtml', value: `{/* UNRESOLVED SNIPPET ${token} */}` });
          return;
        }
      }
      if (n.type === 'text') {
        const v = n.data.replace(/\s+/g, ' ');
        if (v) out.push({ id: id(p, v), type: 'text', value: v });
        return;
      }
      const kids = () => inlineOf(n.children, p);
      switch (n.name) {
        case 'strong': case 'b': out.push({ id: id(p, 'strong'), type: 'strong', children: kids() }); break;
        case 'em': case 'i': out.push({ id: id(p, 'em'), type: 'emphasis', children: kids() }); break;
        case 'del': case 's': case 'strike': out.push({ id: id(p, 'del'), type: 'delete', children: kids() }); break;
        case 'code': out.push({ id: id(p, textOf(n)), type: 'inlineCode', value: textOf(n) }); break;
        case 'kbd': out.push({ id: id(p, 'kbd'), type: 'kbd', children: kids() }); break;
        case 'br': out.push({ id: id(p, 'br'), type: 'break' }); break;
        case 'a': {
          const url = (n.attribs.href ?? '').trim();
          // An anchor with no href, one pointing at the bare fragment, or one whose href is a
          // script call goes nowhere: it is a disclosure toggle, a skip link, or a named anchor
          // marking a spot in the page. None survives as a link, and emitting one would put a dead
          // link in the output, so the text it wraps is kept and the anchor itself is dropped.
          if (!url || url === '#' || /^javascript:/i.test(url)) {
            // A named anchor marks a spot other pages link to, and Flare writes plenty of them
            // around ordinary sentences. The anchor is not a link and must not become one, but the
            // address it publishes is real: it is kept as an empty target before the text it
            // wrapped, so `page#spot` still lands where the source put it.
            const named = (n.attribs.name ?? n.attribs.id ?? '').trim();
            if (named) out.push({ id: id(p, `anchor:${named}`), type: 'inlineHtml', value: `<a id="${named}"></a>` });
            out.push(...kids());
            break;
          }
          const children = kids();
          // HTML parsing closes an open <a> when another <a> starts, so an anchor written inside
          // another is a sibling of it, never its content. Keeping the nesting would emit a link
          // inside a link, which is not expressible in Markdown and corrupts both of them.
          if (children.some(containsLink)) {
            let run: Inline[] = [];
            const flush = (): void => {
              if (run.length) { if (run.some(hasVisibleText)) { links.push(url); out.push({ id: id(p, url), type: 'link', url, title: n.attribs.title, children: run }); } else out.push(...run); run = []; }
            };
            for (const part of hoistLinks(children)) { if (part.type === 'link') { flush(); out.push(part); } else run.push(part); }
            flush();
            break;
          }
          links.push(url);
          out.push({ id: id(p, url), type: 'link', url, title: n.attribs.title, children });
          break;
        }
        case 'img': {
          const img = imageOf(n, p);
          images.push(img);
          out.push(img);
          break;
        }
        case 'sup': case 'sub': case 'mark': case 'u': case 'small': case 'abbr': case 'time': case 'label':
          out.push({ id: id(p, n.name), type: 'inlineHtml', value: `<${n.name}${n.attribs.title ? ` title="${n.attribs.title}"` : ''}>${textOf(n).replace(/</g, '&lt;')}</${n.name}>` });
          break;
        default: out.push(...kids());
      }
    });
    return out;
  };

  const imageOf = (n: El, p: number[]): ImageNode => {
    const url = n.attribs.src ?? n.attribs['data-src'] ?? '';
    // The same reader the Markdown adapter uses: `parseInt` used to turn `100%` into 100 and `2rem` into 2,
    // so one site migrated differently depending on which format the page arrived in.
    const width = readPixelDimension(n.attribs.width);
    const height = readPixelDimension(n.attribs.height);
    const sources = srcsetUrls(n.attribs.srcset ?? n.attribs['data-srcset'] ?? '');
    return {
      id: id(p, url), type: 'image', url, alt: (n.attribs.alt ?? '').trim(), title: n.attribs.title,
      ...(sources.length ? { sources } : {}),
      width: width.value, height: height.value,
      ...(width.unreadable !== undefined ? { unreadableWidth: width.unreadable } : {}),
      ...(height.unreadable !== undefined ? { unreadableHeight: height.unreadable } : {}),
    };
  };

  const isParagraphElement = (n: El) => (opts.paragraphSelectors ?? []).some((s) => matchesSelector(n, s));
  const isBlockish = (n: Dom) => n.type === 'tag' && (!INLINE.has(n.name) || isParagraphElement(n));

  const blocksOf = (nodes: Dom[], path: number[]): Block[] => {
    const out: Block[] = [];
    // group runs of inline/text into paragraphs
    let run: Dom[] = [];
    const flush = (i: number) => {
      if (!run.length) return;
      let inl = inlineOf(run, [...path, i, 0]);
      // trim whitespace-only text at the edges
      const isWs = (n: Inline | undefined) => !!n && n.type === 'text' && !n.value.trim();
      while (isWs(inl[0])) inl.shift();
      while (isWs(inl[inl.length - 1])) inl.pop();
      const first = inl[0]; const last = inl[inl.length - 1];
      if (first && first.type === 'text') inl[0] = { ...first, value: first.value.replace(/^\s+/, '') };
      if (last && last.type === 'text') inl[inl.length - 1] = { ...last, value: last.value.replace(/\s+$/, '') };
      if (inl.length === 1 && inl[0].type === 'image') { out.push(inl[0] as ImageNode); run = []; return; }
      // A run of nothing but links with not even whitespace between them is a set of separate targets
      // the source lays out as blocks of its own — a card grid, a row of buttons. Merged into one
      // paragraph their labels abut with nothing between, and the reader sees the words run together
      // ("Account ManagementAdmin and RightsAudiences"), so each link keeps its own block. A run with
      // any text in it, a space included, already reads correctly and is left as one paragraph.
      if (inl.length > 1 && inl.every((x) => x.type === 'link')) {
        inl.forEach((node, k) => {
          const text = inlineText([node]).trim();
          out.push({ id: id([...path, i, k], text), type: 'paragraph', children: [node] });
        });
        run = [];
        return;
      }
      const txt = inl.map((x) => (x.type === 'text' ? x.value : 'x')).join('').trim();
      if (txt) out.push({ id: id([...path, i], txt), type: 'paragraph', children: inl });
      run = [];
    };
    nodes.forEach((n, i) => {
      if (!isBlockish(n)) { run.push(n); return; }
      flush(i);
      out.push(...blockOf(n as El, [...path, i]));
    });
    flush(nodes.length);
    return out;
  };

  const blockOf = (n: El, p: number[]): Block[] => {
    // recognisers first, so platform components win over generic tags
    for (const r of opts.recognisers ?? []) {
      if (matchesSelector(n, r.selector)) return [componentOf(n, r, p)];
    }
    const hm = n.name.match(/^h([1-6])$/);
    if (hm) {
      // A heading records one anchor as its own source id, and the serializer writes that before the
      // heading — so keeping it in the text too would put the same address there twice. A heading
      // that names several spots (Flare writes a second when a section is linked under an older
      // name) keeps the rest as empty targets, because each is an address something links to.
      const sourceId = n.attribs.id || namedAnchorIn(n);
      const children = inlineOf(n.children, p).filter((inline) => !(inline.type === 'inlineHtml' && inline.value === `<a id="${sourceId}"></a>`));
      const node: HeadingNode = { id: id(p, textOf(n)), type: 'heading', depth: Number(hm[1]) as 1, children, sourceId };
      headings.push(node);
      return [node];
    }
    if (n.name === 'p' || isParagraphElement(n)) return paragraphOf(n, p);
    switch (n.name) {
      case 'pre': {
        const codeEl = n.children.find((c) => c.type === 'tag' && c.name === 'code') as El | undefined;
        const value = textOf(codeEl ?? n).replace(/^\n/, '').replace(/\n$/, '');
        return [{ id: id(p, value), type: 'code', lang: codeLanguageOf(n, codeEl), value }];
      }
      case 'ul': case 'ol': {
        const items: ListItemNode[] = n.children.filter((c): c is El => c.type === 'tag' && c.name === 'li').map((li, i) => ({ id: id([...p, i], textOf(li)), type: 'listItem', children: blocksOf(li.children, [...p, i]) }));
        return [{ id: id(p, n.name), type: 'list', ordered: n.name === 'ol', start: n.attribs.start ? Number(n.attribs.start) : undefined, children: items }];
      }
      case 'blockquote': return [{ id: id(p, textOf(n)), type: 'blockquote', children: blocksOf(n.children, p) }];
      case 'hr': return [{ id: id(p, 'hr'), type: 'thematicBreak' }];
      case 'img': { const img = imageOf(n, p); images.push(img); return [img]; }
      case 'figure': {
        const imgEl = find(n, 'img');
        const cap = find(n, 'figcaption');
        if (imgEl) { const img = imageOf(imgEl, p); images.push(img); return [{ id: id(p, img.url), type: 'figure', image: img, caption: cap ? inlineOf(cap.children, [...p, 1]) : undefined }]; }
        return blocksOf(n.children, p);
      }
      case 'table': {
        const trs = findAll(n, 'tr');
        // A Markdown table is a plain grid, so a cell spanning rows or columns is laid out over
        // every position it covers and its content repeated there. Dropping the span instead would
        // shift every later cell in the row one column left, silently filing values under the wrong
        // heading; leaving the covered positions blank would read as missing data.
        const span = (cell: El, attribute: string, limit: number): number => {
          const declared = Number.parseInt(cell.attribs[attribute] ?? '1', 10);
          return Number.isFinite(declared) && declared > 1 ? Math.min(declared, limit) : 1;
        };
        const covering = new Map<string, El>();
        const rowCells: El[][] = [];
        trs.forEach((tr, ri) => {
          const cells = tr.children.filter((c): c is El => c.type === 'tag' && (c.name === 'td' || c.name === 'th'));
          rowCells.push(cells);
          let column = 0;
          for (const cell of cells) {
            while (covering.has(`${ri},${column}`)) column++;
            const rows = span(cell, 'rowspan', trs.length - ri);
            const columns = span(cell, 'colspan', MAX_TABLE_COLUMNS - column);
            for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) covering.set(`${ri + r},${column + c}`, cell);
            column += columns;
          }
        });
        let width = 0;
        for (const key of covering.keys()) width = Math.max(width, Number(key.split(',')[1]) + 1);
        const rows: TableRowNode[] = trs.map((tr, ri) => {
          const cells = rowCells[ri];
          const children = Array.from({ length: width }, (unused, ci) => {
            const cell = covering.get(`${ri},${ci}`);
            return { id: id([...p, ri, ci], cell ? textOf(cell) : ''), type: 'tableCell' as const, children: cell ? inlineOf(cell.children, [...p, ri, ci]) : [] };
          });
          return { id: id([...p, ri], 'tr'), type: 'tableRow', isHeader: cells.length > 0 && cells.every((c) => c.name === 'th'), children };
        });
        // Column alignment is authored on the cells and carried per column by a Markdown table, so
        // the first row states it, and a cell spanning columns states it for every column it covers.
        const cellAlignment = (cell: El): 'left' | 'center' | 'right' | null => {
          const style = (cell.attribs.style ?? '').split(';').map((rule) => rule.split(':')).find(([name]) => name?.trim().toLowerCase() === 'text-align');
          const declared = (cell.attribs.align ?? style?.[1] ?? '').trim().toLowerCase();
          return declared === 'left' || declared === 'center' || declared === 'right' ? declared : null;
        };
        const align: Array<'left' | 'center' | 'right' | null> = [];
        for (const cell of rowCells[0] ?? []) {
          const value = cellAlignment(cell);
          for (let column = 0; column < span(cell, 'colspan', MAX_TABLE_COLUMNS); column++) align.push(value);
        }
        return [{ id: id(p, 'table'), type: 'table', ...(align.some(Boolean) ? { align } : {}), children: rows }];
      }
      case 'script': case 'style':
        // executable or styling content never becomes children; keep only a hash so the ledger can account for the node
        return [componentOf({ ...n, children: [] }, { selector: n.name, name: n.name, props: { src: '@attr:src', contentHash: nodeId(opts.file, p, textOf(n)) } }, p)];
      case 'video':
        // the media attributes are content (a video without controls cannot be played); src may sit on a <source> child
        return [componentOf(n, { selector: 'video', name: 'video', props: { src: '@attr-or-descendant:src', poster: '@attr:poster', controls: '@flag:controls', autoplay: '@flag:autoplay', loop: '@flag:loop', muted: '@flag:muted', title: '@attr:title' } }, p)];
      case 'iframe': case 'audio': case 'object': case 'embed': case 'form': case 'input': case 'button':
        return [componentOf(n, { selector: n.name, name: n.name, props: { src: '@attr:src', title: '@attr:title' } }, p)];
      case 'details': {
        const summary = find(n, 'summary');
        return [componentOf(n, { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] }, p)];
      }
      default:
        return blocksOf(n.children, p); // div, section, article, span-wrappers: transparent
    }
  };

  const paragraphOf = (n: El, p: number[]): Block[] => {
    // a paragraph element holding a platform component (a GitBook Assistant button) wraps blocks, not one run of inline text
    // (a snippet reference is inline, and inlineOf renders it in place)
    if (n.children.some((c) => c.type === 'tag' && (opts.recognisers ?? []).some((r) => r.name !== 'snippetRef' && matchesSelector(c, r.selector)))) return blocksOf(n.children, p);
    const inl = inlineOf(n.children, p);
    const onlyImg = inl.length === 1 && inl[0].type === 'image';
    if (onlyImg) return [inl[0] as ImageNode];
    return inl.length ? [{ id: id(p, textOf(n)), type: 'paragraph', children: inl }] : [];
  };

  const codeLanguageOf = (pre: El, codeEl: El | undefined): string | undefined => {
    if (opts.codeLanguage) {
      const declared = extractProp(codeEl ?? pre, opts.codeLanguage).value ?? extractProp(pre, opts.codeLanguage).value;
      if (typeof declared === 'string') return fenceLanguage(declared);
    }
    const cls = codeEl?.attribs.class ?? pre.attribs.class ?? '';
    return cls.match(/(?:language|lang)-([A-Za-z0-9+#.-]+)/)?.[1];
  };

  const componentOf = (n: El, r: ComponentRecogniser, p: number[]): ComponentNode => {
    const props: Record<string, ExtractedProp> = {};
    const lifted = new Set<El>();
    for (const [k, v] of Object.entries(r.props ?? {})) {
      if (typeof v !== 'string' || !v.startsWith('@')) { props[k] = v; continue; }
      const extraction = extractProp(n, v);
      props[k] = extraction.value;
      if (extraction.lifted) lifted.add(extraction.lifted);
    }
    let content: El = n;
    if (r.contentSelector) content = find(n, r.contentSelector) ?? n;
    if (r.strip?.length) content = { ...content, children: content.children.filter((c) => !(c.type === 'tag' && r.strip!.some((s) => matchesSelector(c, s)))) };
    if (lifted.size) content = without(content, lifted);
    const styleDeps = (n.attribs.class ?? '').split(/\s+/).filter(Boolean);
    return { id: id(p, `${r.name}:${textOf(n).slice(0, 80)}`), type: 'component', name: r.name, platform: opts.platform, props, children: blocksOf(content.children, [...p, 0]), styleDeps: styleDeps.length ? styleDeps : undefined, src: { file: opts.file } };
  };

  const children = blocksOf(scope.children, [counter++]);
  return { children, headings, images, links, unresolvedSnippets };
}

export function makeDoc(pageId: string, platform: string, source: string, frontmatter: Frontmatter, children: Block[]): DocIR {
  return { pageId, platform, source, frontmatter, children };
}
