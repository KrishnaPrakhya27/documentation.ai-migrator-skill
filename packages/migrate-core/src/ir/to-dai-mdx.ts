/**
 * DocIR → Documentation.AI MDX. Deterministic: same IR, same bytes.
 * Only public contract names are emitted. Editor-internal nodes never appear.
 */
import type { Block, Inline, DocIR, DaiComponentNode, ListNode, TableNode, Frontmatter } from './types.js';
import { stringify as toYaml } from 'yaml';
import { isSafeUrl } from '../components/sanitize.js';

export interface SerializeOptions {
  /** heading node id → old anchor id to emit as a shim before the heading. */
  anchorShims?: Map<string, string>;
  /** Text to emit for quarantined blocks. */
  quarantinePlaceholder?: (reason: string) => string;
}

const MDX_TEXT_ESCAPES: Array<[RegExp, string]> = [
  [/\\/g, '\\\\'],
  [/\{/g, '\\{'],
  [/\}/g, '\\}'],
  [/<(?=[A-Za-z\/!])/g, '&lt;'],
  [/^(\s*)([#>+\-*]|\d+\.)(?=\s)/gm, '$1\\$2'],
  [/(\*|_)(?=\S)/g, '\\$1'],
];

export function escapeText(s: string): string {
  let out = s;
  for (const [re, rep] of MDX_TEXT_ESCAPES) out = out.replace(re, rep);
  return out;
}

export function propValue(v: string | number | boolean | null): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return `{${v}}`;
  if (typeof v === 'boolean') return v ? '{true}' : '{false}';
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '&quot;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/[\r\n]/g, ' ')}"`;
}

function markdownUrl(url: string, kind: 'link' | 'resource'): string | undefined {
  if (!isSafeUrl(url, kind)) return undefined;
  return url.trim().replace(/\\/g, '%5C').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
}

function imageToMdx(url: string, alt: string, width?: number, height?: number): string {
  const safe = markdownUrl(url, 'resource');
  return safe ? openTag('Image', { src: safe, alt, width: width ?? null, height: height ?? null }, true) : escapeText(alt);
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

export function inlineToMdx(nodes: Inline[]): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return escapeText(n.value);
      case 'inlineCode': {
        const longestRun = Math.max(0, ...Array.from(n.value.matchAll(/`+/g), (m) => m[0].length));
        const fence = '`'.repeat(longestRun + 1);
        const pad = /^[ `]|[ `]$/.test(n.value) ? ' ' : '';
        return `${fence}${pad}${n.value}${pad}${fence}`;
      }
      case 'strong': return `**${inlineToMdx(n.children)}**`;
      case 'emphasis': return `*${inlineToMdx(n.children)}*`;
      case 'delete': return `~~${inlineToMdx(n.children)}~~`;
      case 'link': {
        const url = markdownUrl(n.url, 'link');
        const label = inlineToMdx(n.children);
        const title = n.title?.replace(/["\r\n]/g, ' ').trim();
        return url ? `[${label}](${url}${title ? ` "${title}"` : ''})` : label;
      }
      case 'break': return '<br />';
      case 'kbd': return `<kbd>${inlineToMdx(n.children)}</kbd>`;
      case 'inlineHtml': return n.value;
      case 'image': return imageToMdx(n.url, n.alt, n.width, n.height);
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
  const sep = `| ${Array.from({ length: cols }, (_, i) => (t.align?.[i] === 'center' ? ':---:' : t.align?.[i] === 'right' ? '---:' : '---')).join(' | ')} |`;
  return [line(header.children), sep, ...body.map((r) => line(r.children))].join('\n');
}

export function blocksToMdx(blocks: Block[], opts: SerializeOptions = {}): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': out.push(inlineToMdx(b.children)); break;
      case 'heading': {
        const shim = opts.anchorShims?.get(b.id);
        if (shim) out.push(`<a id="${shim}"></a>`);
        out.push(`${'#'.repeat(b.depth)} ${inlineToMdx(b.children)}`);
        break;
      }
      case 'code': {
        const longestRun = Math.max(0, ...Array.from(b.value.matchAll(/`+/g), (m) => m[0].length));
        const fence = '`'.repeat(Math.max(3, longestRun + 1));
        const lang = (b.lang ?? '').replace(/[^A-Za-z0-9_+.#-]/g, '');
        const title = b.title?.replace(/["\r\n]/g, ' ').trim();
        const meta = b.meta?.replace(/[\r\n]/g, ' ').trim();
        out.push(`${fence}${lang}${title ? ` title="${title}"` : ''}${meta ? ` ${meta}` : ''}\n${b.value}\n${fence}`);
        break;
      }
      case 'blockquote': out.push(blocksToMdx(b.children, opts).split('\n').map((l) => `> ${l}`).join('\n')); break;
      case 'list': out.push(listToMdx(b, opts)); break;
      case 'table': out.push(tableToMdx(b)); break;
      case 'thematicBreak': out.push('---'); break;
      case 'image': out.push(imageToMdx(b.url, b.alt, b.width, b.height)); break;
      case 'figure': {
        out.push(imageToMdx(b.image.url, b.image.alt, b.image.width, b.image.height));
        if (b.caption?.length) out.push(`*${inlineToMdx(b.caption)}*`);
        break;
      }
      case 'html': out.push(b.value); break;
      case 'rawHtml': out.push(b.value); break;
      case 'dai': {
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
  return `---\n${toYaml(data, { lineWidth: 0 }).trimEnd()}\n---\n`;
}

export function docToMdx(doc: DocIR, opts: SerializeOptions = {}): string {
  const body = blocksToMdx(doc.children, opts);
  return `${frontmatterToYaml(doc.frontmatter)}\n${body}\n`;
}
