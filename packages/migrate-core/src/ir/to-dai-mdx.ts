/**
 * DocIR → Documentation.AI MDX. Deterministic: same IR, same bytes.
 * Only public contract names are emitted. Editor-internal nodes never appear.
 */
import type { Block, Inline, DocIR, DaiComponentNode, ImageNode, ListNode, TableNode, Frontmatter } from './types.js';
import { stringify as toYaml } from 'yaml';
import { isSafeUrl } from '../components/sanitize.js';

export interface SerializeOptions {
  /** heading node id → old anchor id to emit as a shim before the heading. */
  anchorShims?: Map<string, string[]>;
  /** An anchor the page's title heading published, written at the head of the body because that heading became the title. */
  leadingAnchor?: string;
  /** Text to emit for quarantined blocks. */
  quarantinePlaceholder?: (reason: string) => string;
}

const MDX_TEXT_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g, '\\\\'],
  // braces as character references, as attribute values already are: the strict validator reads any {…} on a line,
  // escaped or not, as an expression
  [/\{/g, '&#123;'],
  [/\}/g, '&#125;'],
  // every `<`, not only one before a letter: in `<<remove` the first `<` would otherwise open a tag MDX cannot parse
  [/</g, '&lt;'],
  [/^(\s*)([#>+\-*])(?=\s)/gm, '$1\\$2'],
  // a backtick in text is literal: left bare, it pairs with the next code span's backtick (even a later table row's)
  [/`/g, '\\`'],
  // text that starts a line with a fence marker would open a code block
  [/^(\s*)(~{3,})/gm, '$1\\$2'],
  // a backslash escapes punctuation only, so an ordered-list marker is escaped at its period ("\1." renders the backslash)
  [/^(\s*)(\d+)\.(?=\s)/gm, '$1$2\\.'],
  // every one of them, not only one that leads a word: a bold run whose whole text is `*` wrote
  // `*****`, which reads back as five literal asterisks. A backslash before punctuation renders as
  // the punctuation alone, so escaping one that needed nothing costs the reader nothing.
  [/(\*|_)/g, '\\$1'],
];



/**
 * Props a renderer reads as strings. The platform compiles a fence's meta as the props of `<pre>`,
 * so a bare `className` becomes `className={true}`, and its code block calls `className.match`:
 * the page answers 500. Mintlify's own `mdx className example` label did exactly that.
 */
const STRING_READ_PROPS = new Set(['className', 'class', 'style', 'children', 'key', 'ref', 'dangerouslySetInnerHTML', 'meta']);
/**
 * The attribute names of meta that is a run of JSX attributes with plain string values, or
 * undefined when it is anything else. A linear scan: the regular expression this replaced nested
 * one quantifier inside another and backtracked exponentially, so a long word followed by a
 * character it could not take hung conversion outright.
 */
function plainAttributeNames(meta: string): string[] | undefined {
  const names: string[] = [];
  let i = 0;
  const n = meta.length;
  while (i < n) {
    while (i < n && /\s/.test(meta[i])) i++;
    if (i >= n) break;
    if (!/[A-Za-z_]/.test(meta[i])) return undefined;
    const start = i;
    while (i < n && /[\w.-]/.test(meta[i])) i++;
    names.push(meta.slice(start, i));
    if (meta[i] === '=') {
      if (meta[i + 1] !== '"') return undefined;
      const close = meta.indexOf('"', i + 2);
      if (close < 0 || /[<>{}&]/.test(meta.slice(i + 2, close))) return undefined;
      i = close + 1;
    }
    if (i < n && !/\s/.test(meta[i])) return undefined;
  }
  return names;
}

/**
 * The meta a fence is written with. Meta that parses as plain attributes and names no prop the
 * renderer reads as a string is written as the source stated it. Anything else - meta that is not
 * JSX, holds an expression, or names such a prop - would fail to compile or crash the page, so it is
 * carried whole in one quoted `meta` prop, which the reader unwraps back to the same text.
 */
export function fenceMeta(meta: string): string {
  const names = plainAttributeNames(meta);
  if (names && !names.some((name) => STRING_READ_PROPS.has(name))) return meta;
  // Encoded twice: once for the JSX attribute the platform parses, and once more for the Markdown
  // info string, which decodes character references before that parse ever sees them.
  const jsx = meta.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  return `meta="${jsx.replace(/&/g, '&amp;')}"`;
}

export function escapeText(s: string): string {
  let out = s;
  for (const [re, rep] of MDX_TEXT_ESCAPES) out = out.replace(re, rep);
  return out;
}


export function propValue(v: string | number | boolean | null): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return `{${v}}`;
  if (typeof v === 'boolean') return v ? '{true}' : '{false}';
  // `<` and `>` as character references too: the platform's preprocessor reads a `<` inside a quoted
  // value as a tag opening and then mangles the next expression on the line (`required={true}`
  // became `required=&#123;true}`), and the page failed to compile. MDX decodes them to the same text.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '&quot;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ')}"`;
}

function markdownUrl(url: string, kind: 'link' | 'resource'): string | undefined {
  if (!isSafeUrl(url, kind)) return undefined;
  return url.trim().replace(/\\/g, '%5C').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
}

function imageToMdx(image: ImageNode): string {
  const safe = markdownUrl(image.url, 'resource');
  return safe ? openTag('Image', { src: safe, alt: image.alt, title: image.title ?? null, width: image.width ?? null, height: image.height ?? null, className: image.themeClass ?? null }, true) : escapeText(image.alt);
}

export function openTag(name: string, props: Record<string, string | number | boolean | null>, selfClose = false): string {
  const parts = [name];
  for (const [k, v] of Object.entries(props)) {
    const pv = propValue(v);
    if (pv === null) continue;
    parts.push(`${k}=${pv}`);
  }
  return `<${parts.join(' ')}${selfClose ? ' /' : ''}>`;
}

/**
 * Emphasis around text that starts or ends with a space. CommonMark closes a run only on a
 * non-space, so `**Create **` is not bold at all — it renders as literal asterisks, which is what
 * the reader then sees. The space belongs outside the delimiters, where it reads the same and parses.
 * Emphasis over nothing but whitespace has no run to close, so it keeps only the whitespace.
 */
function wrapEmphasis(inner: string, marker: string): string {
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner) ?? [];
  return core ? `${lead}${marker}${core}${marker}${trail}` : inner;
}

export function inlineToMdx(nodes: Inline[], insideLink = false): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return escapeText(n.value);
      case 'inlineCode': {
        const longestRun = Math.max(0, ...Array.from(n.value.matchAll(/`+/g), (m) => m[0].length));
        const fence = '`'.repeat(longestRun + 1);
        // A reader strips one space from each end of a code span only when it does not consist
        // entirely of spaces. Padding one that does turned a span holding a single space into one
        // holding three - which is what the source's own page about escaping characters writes.
        const allSpaces = n.value.length > 0 && n.value.trim() === '';
        const pad = !allSpaces && /^[ `]|[ `]$/.test(n.value) ? ' ' : '';
        return `${fence}${pad}${n.value}${pad}${fence}`;
      }
      case 'strong': return wrapEmphasis(inlineToMdx(n.children, insideLink), '**');
      case 'emphasis': return wrapEmphasis(inlineToMdx(n.children, insideLink), '*');
      case 'delete': return wrapEmphasis(inlineToMdx(n.children, insideLink), '~~');
      case 'link': {
        // A link inside a link (Mintlify's export writes `<a href="mailto:x">[x](mailto:x)</a>`) is
        // what a browser flattens to one link; Markdown cannot nest them, and writing both would put
        // literal brackets on the page. The inner one is its label.
        if (insideLink) return inlineToMdx(n.children, true);
        const url = markdownUrl(n.url, 'link');
        const label = inlineToMdx(n.children, true);
        const title = n.title?.replace(/["\r\n]/g, ' ').trim();
        return url ? `[${label}](${url}${title ? ` "${title}"` : ''})` : label;
      }
      case 'break': return '<br />';
      case 'kbd': return `<kbd>${inlineToMdx(n.children, insideLink)}</kbd>`;
      case 'inlineHtml': return n.value;
      case 'footnoteReference': return `[^${n.identifier}]`;
      case 'image': return imageToMdx(n);
    }
  }).join('');
}

function indent(s: string, pad = '  '): string {
  return s.split('\n').map((l) => (l.length ? pad + l : l)).join('\n');
}

function listToMdx(list: ListNode, opts: SerializeOptions, depth = 0): string {
  return list.children.map((li, i) => {
    const marker = list.ordered ? `${(list.start ?? 1) + i}.` : '-';
    const body = blocksToMdx(li.children, opts).trim();
    const [first, ...rest] = body.split('\n');
    const check = li.checked === undefined ? '' : li.checked ? '[x] ' : '[ ] ';
    const restText = rest.length ? '\n' + rest.map((l) => (l.length ? ' '.repeat(marker.length + 1) + l : l)).join('\n') : '';
    return `${marker} ${check}${first}${restText}`;
  }).join('\n');
}

function tableToMdx(t: TableNode): string {
  const rows = t.children;
  if (!rows.length) return '';
  const cell = (c: { children: Inline[] }) => inlineToMdx(c.children).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const header = rows[0].isHeader ? rows[0] : { ...rows[0], children: rows[0].children.map((c) => ({ ...c, children: [] })) };
  const body = rows[0].isHeader ? rows.slice(1) : rows;
  const cols = Math.max(...rows.map((r) => r.children.length));
  const pad = (r: { children: Inline[] }[]) => [...r, ...Array.from({ length: cols - r.length }, () => ({ children: [] as Inline[] }))];
  const line = (r: { children: Inline[] }[]) => `| ${pad(r).map(cell).join(' | ')} |`;
  // `:---` is a column the author aligned left, which is not the same statement as `---`, a column
  // they left alone: both render left, and only one of them says so. Writing the default for both
  // loses what the source stated and reads back as a different table.
  const marker = (align: string | null | undefined): string => (align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---');
  const sep = `| ${Array.from({ length: cols }, (_, i) => marker(t.align?.[i])).join(' | ')} |`;
  return [line(header.children), sep, ...body.map((r) => line(r.children))].join('\n');
}

/** A fence long enough to hold this code, with nothing claimed about its language. */
function fencedCode(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${value}\n${fence}`;
}

export function blocksToMdx(blocks: Block[], opts: SerializeOptions = {}): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': {
        // A code span holding several lines is a block of code. Written inline it picks up whatever
        // indentation surrounds it — inside a component, two spaces on every line of a certificate —
        // so it is written as a fence, which carries its lines exactly as they are.
        const only = b.children.length === 1 ? b.children[0] : undefined;
        if (only?.type === 'inlineCode' && only.value.includes('\n')) { out.push(fencedCode(only.value)); break; }
        // A paragraph that opens with `import` or `export` is prose (a GitBook page quoting a line of
        // code in a sentence). MDX would read it as ESM and drop it, so its first letter is written
        // as the character reference it stands for: the same word, read as text.
        out.push(inlineToMdx(b.children).replace(/^(import|export)(?=\s)/, (word) => `&#${word.charCodeAt(0)};${word.slice(1)}`));
        break;
      }
      case 'heading': {
        // A heading the source published under more than one address keeps every one of them.
        for (const shim of opts.anchorShims?.get(b.id) ?? []) out.push(`<a id="${shim}"></a>`);
        // Trailing space is not part of a heading, and writing it changes the id a renderer gives it.
        out.push(`${'#'.repeat(b.depth)} ${inlineToMdx(b.children).trim()}`);
        break;
      }
      case 'code': {
        const longestRun = Math.max(0, ...Array.from(b.value.matchAll(/`+/g), (m) => m[0].length));
        const fence = '`'.repeat(Math.max(3, longestRun + 1));
        const lang = (b.lang ?? '').replace(/[^A-Za-z0-9_+.#-]/g, '');
        const title = b.title?.replace(/["\r\n`~]/g, ' ').trim();
        const meta = b.meta?.replace(/[\r\n`~]/g, ' ').trim();
        out.push(`${fence}${lang}${title ? ` title="${title}"` : ''}${meta ? ` ${fenceMeta(meta)}` : ''}\n${b.value}\n${fence}`);
        break;
      }
      case 'blockquote': out.push(blocksToMdx(b.children, opts).split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'list': out.push(listToMdx(b, opts)); break;
      case 'table': out.push(tableToMdx(b)); break;
      case 'thematicBreak': out.push('---'); break;
      // GFM: the first line carries the label, continuation lines are indented four spaces
      case 'footnoteDefinition': {
        const body = blocksToMdx(b.children, opts).split('\n');
        out.push(`[^${b.identifier}]: ${body[0] ?? ''}${body.length > 1 ? '\n' + body.slice(1).map((line) => (line ? `    ${line}` : line)).join('\n') : ''}`);
        break;
      }
      case 'image': out.push(imageToMdx(b)); break;
      case 'figure': {
        out.push(imageToMdx(b.image));
        if (b.caption?.length) out.push(`*${inlineToMdx(b.caption)}*`);
        break;
      }
      case 'html': out.push(b.value); break;
      case 'rawHtml': out.push(b.value); break;
      case 'dai': {
        // An anchor the source published on this component, kept where something still links to it.
        for (const componentShim of opts.anchorShims?.get(b.id) ?? []) out.push(`<a id="${componentShim}"></a>`);
        const inner = blocksToMdx(b.children, opts);
        if (!inner.trim()) out.push(openTag(b.name, b.props, true));
        else out.push(`${openTag(b.name, b.props)}\n${indent(inner)}\n</${b.name}>`);
        break;
      }
      case 'quarantined': out.push((opts.quarantinePlaceholder ?? ((r) => `{/* QUARANTINED: ${r} */}`))(b.reason)); break;
      case 'snippetRef': out.push(b.body ? blocksToMdx(b.body, opts) : `{/* UNRESOLVED SNIPPET ${b.token} */}`); break;
      case 'component': throw new Error(`Unresolved source component <${b.name}> (${b.platform}) reached the serializer; the rules engine must resolve or quarantine it`);
    }
  }
  return out.join('\n\n');
}

export function frontmatterToYaml(fm: Frontmatter): string {
  const data: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'metaTitle', 'metaDescription', 'ogImage', 'canonical']) {
    if (fm[k] !== undefined && fm[k] !== null && fm[k] !== '') data[k] = fm[k];
  }
  for (const [k, v] of Object.entries(fm)) {
    if (['title', 'description', 'metaTitle', 'metaDescription', 'ogImage', 'canonical', 'jsonLd'].includes(k)) continue;
    if (v === undefined || v === null || typeof v === 'object') continue;
    data[k] = v;
  }
  if (fm.jsonLd) data.jsonLd = fm.jsonLd;
  // The platform compiles each file whole as MDX, frontmatter included, so a `{`, `}` or `<` in a value opens an
  // expression or a tag. YAML's \u escapes carry the same characters without writing them.
  const lines = Object.entries(data).map(([key, value]) => (typeof value === 'string' && /[{}<]/.test(value)
    ? `${key}: ${JSON.stringify(value).replace(/[{}<]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}`
    : toYaml({ [key]: value }, { lineWidth: 0 }).trimEnd()));
  return `---\n${lines.join('\n')}\n---\n`;
}

export function docToMdx(doc: DocIR, opts: SerializeOptions = {}): string {
  const body = blocksToMdx(doc.children, opts);
  const leading = opts.leadingAnchor ? `<a id="${opts.leadingAnchor}"></a>\n\n` : '';
  return `${frontmatterToYaml(doc.frontmatter)}\n${leading}${body}\n`;
}
