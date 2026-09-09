/**
 * HTML → DocIR. Works on the parsed tree with classes and attributes intact
 * (never through Markdown), and lets a platform profile declare which
 * elements are components so the rules engine can map them.
 */
import { Parser } from 'htmlparser2';
import type { Block, Inline, ImageNode, ComponentNode, HeadingNode, ListItemNode, TableRowNode, Frontmatter, DocIR } from './types.js';
import { nodeId } from '../session/ids.js';

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

/** Tiny selector matcher: tag, #id, .class, tag.class, tag[attr], tag[attr=value], comma lists. */
export function matchesSelector(el: El, selector: string): boolean {
  return selector.split(',').some((sel) => {
    sel = sel.trim();
    const m = sel.match(/^([a-z0-9-]+)?(#[A-Za-z0-9_-]+)?((?:\.[A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/i);
    if (!m) return false;
    const [, tag, idSel, classes, attrs] = m;
    if (tag && el.name !== tag.toLowerCase()) return false;
    if (idSel && el.attribs.id !== idSel.slice(1)) return false;
    const cls = (el.attribs.class ?? '').split(/\s+/).filter(Boolean);
    for (const c of classes.split('.').filter(Boolean)) if (!cls.includes(c)) return false;
    for (const a of attrs.match(/\[[^\]]+\]/g) ?? []) {
      const am = a.slice(1, -1).match(/^([^=]+)(?:=["']?([^"']*)["']?)?$/);
      if (!am) return false;
      const [, k, v] = am;
      if (!(k in el.attribs)) return false;
      if (v !== undefined && el.attribs[k] !== v) return false;
    }
    return true;
  });
}

/** A platform profile tells the adapter which elements are components. */
export interface ComponentRecogniser {
  selector: string;
  /** Platform-native component name to assign. */
  name: string;
  /** Props: literal values, or extractors: "@attr:name", "@text:selector", "@count:selector", "@class-suffix:prefix". */
  props?: Record<string, string | number | boolean>;
  /** Child element selector whose contents become the component children (default: the element itself). */
  contentSelector?: string;
  /** Elements to strip from children before conversion (e.g. the summary of a details). */
  strip?: string[];
}

export interface HtmlAdapterOptions {
  platform: string;
  file: string;
  recognisers?: ComponentRecogniser[];
  /** Selector for the article container; if given, only its contents are converted. */
  articleSelector?: string;
  /** Elements removed entirely (chrome). */
  removeSelectors?: string[];
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
const INLINE = new Set(['a', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'br', 'kbd', 'span', 'sup', 'sub', 'u', 'mark', 'small', 'abbr', 'img', 'time', 'label']);

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

export function htmlToIr(html: string, opts: HtmlAdapterOptions): HtmlToIrResult {
  const root = parseHtml(html);
  let scope: El = root;
  if (opts.articleSelector) scope = find(root, opts.articleSelector) ?? root;
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
          const url = n.attribs.href ?? '';
          if (url) links.push(url);
          out.push({ id: id(p, url), type: 'link', url, title: n.attribs.title, children: kids() });
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
    const w = parseInt(n.attribs.width ?? '', 10); const h = parseInt(n.attribs.height ?? '', 10);
    return { id: id(p, url), type: 'image', url, alt: (n.attribs.alt ?? '').trim(), title: n.attribs.title, width: Number.isFinite(w) ? w : undefined, height: Number.isFinite(h) ? h : undefined };
  };

  const isBlockish = (n: Dom) => n.type === 'tag' && !INLINE.has(n.name);

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
      const children = inlineOf(n.children, p);
      const node: HeadingNode = { id: id(p, textOf(n)), type: 'heading', depth: Number(hm[1]) as 1, children, sourceId: n.attribs.id || undefined };
      headings.push(node);
      return [node];
    }
    switch (n.name) {
      case 'p': {
        const inl = inlineOf(n.children, p);
        const onlyImg = inl.length === 1 && inl[0].type === 'image';
        if (onlyImg) return [inl[0] as ImageNode];
        return inl.length ? [{ id: id(p, textOf(n)), type: 'paragraph', children: inl }] : [];
      }
      case 'pre': {
        const codeEl = n.children.find((c) => c.type === 'tag' && c.name === 'code') as El | undefined;
        const cls = (codeEl?.attribs.class ?? n.attribs.class ?? '');
        const lang = cls.match(/(?:language|lang)-([A-Za-z0-9+#.-]+)/)?.[1];
        const value = textOf(codeEl ?? n).replace(/^\n/, '').replace(/\n$/, '');
        return [{ id: id(p, value), type: 'code', lang, value }];
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
        const rows: TableRowNode[] = [];
        const trs = findAll(n, 'tr');
        trs.forEach((tr, ri) => {
          const cells = tr.children.filter((c): c is El => c.type === 'tag' && (c.name === 'td' || c.name === 'th'));
          rows.push({ id: id([...p, ri], 'tr'), type: 'tableRow', isHeader: cells.length > 0 && cells.every((c) => c.name === 'th'), children: cells.map((c, ci) => ({ id: id([...p, ri, ci], textOf(c)), type: 'tableCell', children: inlineOf(c.children, [...p, ri, ci]) })) });
        });
        return [{ id: id(p, 'table'), type: 'table', children: rows }];
      }
      case 'script': case 'style':
        // executable or styling content never becomes children; keep only a hash so the ledger can account for the node
        return [componentOf({ ...n, children: [] }, { selector: n.name, name: n.name, props: { src: '@attr:src', contentHash: nodeId(opts.file, p, textOf(n)) } }, p)];
      case 'iframe': case 'video': case 'audio': case 'object': case 'embed': case 'form': case 'input': case 'button':
        return [componentOf(n, { selector: n.name, name: n.name, props: { src: '@attr:src', title: '@attr:title' } }, p)];
      case 'details': {
        const summary = find(n, 'summary');
        return [componentOf(n, { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] }, p)];
      }
      default:
        return blocksOf(n.children, p); // div, section, article, span-wrappers: transparent
    }
  };

  const componentOf = (n: El, r: ComponentRecogniser, p: number[]): ComponentNode => {
    const props: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(r.props ?? {})) {
      if (typeof v !== 'string' || !v.startsWith('@')) { props[k] = v; continue; }
      const [kind, arg] = v.slice(1).split(':', 2);
      switch (kind) {
        case 'attr': props[k] = n.attribs[arg] ?? null; break;
        case 'text': { const t = arg ? find(n, arg) : n; props[k] = t ? textOf(t).trim() : null; break; }
        case 'count': props[k] = findAll(n, arg).length; break;
        case 'class-suffix': { const c = (n.attribs.class ?? '').split(/\s+/).find((x) => x.startsWith(arg)); props[k] = c ? c.slice(arg.length) : null; break; }
        default: props[k] = null;
      }
    }
    let content: El = n;
    if (r.contentSelector) content = find(n, r.contentSelector) ?? n;
    if (r.strip?.length) content = { ...content, children: content.children.filter((c) => !(c.type === 'tag' && r.strip!.some((s) => matchesSelector(c, s)))) };
    const styleDeps = (n.attribs.class ?? '').split(/\s+/).filter(Boolean);
    return { id: id(p, `${r.name}:${textOf(n).slice(0, 80)}`), type: 'component', name: r.name, platform: opts.platform, props, children: blocksOf(content.children, [...p, 0]), styleDeps: styleDeps.length ? styleDeps : undefined, src: { file: opts.file } };
  };

  const children = blocksOf(scope.children, [counter++]);
  return { children, headings, images, links, unresolvedSnippets };
}

export function makeDoc(pageId: string, platform: string, source: string, frontmatter: Frontmatter, children: Block[]): DocIR {
  return { pageId, platform, source, frontmatter, children };
}
