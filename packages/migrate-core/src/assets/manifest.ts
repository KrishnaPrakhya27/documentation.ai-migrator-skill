/**
 * Assets: download originals, hash-dedupe, ingest through a provider,
 * rewrite references from a manifest keyed by content hash.
 * Providers: none (keep source URL, flagged), local (copy into the workspace
 * for later ingestion), dai-api (platform dependency G7), s3 (BYO).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import sanitizeHtml from 'sanitize-html';
import type { DocIR, Block, Inline } from '../ir/types.js';
import { walkBlocks } from '../ir/types.js';
import { sha256 } from '../session/ids.js';
import type { Fetcher } from '../scrape/fetcher.js';

export interface AssetEntry {
  hash: string;
  /** Hash of the exact source bytes; differs from hash only when SVG was sanitised. */
  sourceHash?: string;
  sourceUrls: string[];
  localPath?: string;
  bytes?: number;
  contentType?: string;
  /** Absolute URL to use in output; set by the provider. */
  finalUrl?: string;
  status: 'pending' | 'downloaded' | 'ingested' | 'kept-external' | 'failed';
  error?: string;
  altMissing: number;
  sanitized?: boolean;
}

export interface AssetManifest { provider: string; entries: Record<string, AssetEntry>; byUrl: Record<string, string> }

export function readManifest(workspace: string): AssetManifest {
  const p = join(workspace, 'plan', 'assets.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as AssetManifest) : { provider: 'none', entries: {}, byUrl: {} };
}
export function writeManifest(workspace: string, m: AssetManifest): void {
  writeFileSync(join(workspace, 'plan', 'assets.json'), JSON.stringify(m, null, 2), { mode: 0o600 });
}

function collectImageUrls(doc: DocIR): Array<{ url: string; alt: string }> {
  const out: Array<{ url: string; alt: string }> = [];
  const inl = (nodes: Inline[]) => { for (const n of nodes) { if (n.type === 'image') out.push({ url: n.url, alt: n.alt }); else if ('children' in n) inl((n as any).children); } };
  walkBlocks(doc.children, (b) => {
    if (b.type === 'image') out.push({ url: b.url, alt: b.alt });
    else if (b.type === 'figure') out.push({ url: b.image.url, alt: b.image.alt });
    else if (b.type === 'paragraph' || b.type === 'heading') inl(b.children);
    else if (b.type === 'table') for (const r of b.children) for (const c of r.children) inl(c.children);
  });
  return out;
}

export interface AssetSource { kind: 'url' | 'file'; resolve: (url: string) => string | undefined }

const SVG_TAGS = ['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur', 'feOffset', 'feColorMatrix', 'feBlend', 'feMerge', 'feMergeNode'];
const SVG_ATTRS = ['id', 'class', 'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform', 'preserveAspectRatio', 'role', 'aria-label', 'aria-labelledby', 'focusable', 'clip-path', 'mask', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'filter', 'href', 'xlink:href'];

/** Strip executable SVG content before it can be copied to a public origin. */
export function sanitizeSvgBytes(input: Buffer): Buffer {
  const source = input.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('SVG with DOCTYPE or ENTITY is refused');
  const clean = sanitizeHtml(source, {
    allowedTags: SVG_TAGS,
    allowedAttributes: { '*': SVG_ATTRS },
    allowedSchemes: ['data'],
    allowProtocolRelative: false,
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    transformTags: {
      '*': (tagName, attribs) => {
        const safe: Record<string, string> = {};
        for (const [key, value] of Object.entries(attribs)) {
          if (/^on/i.test(key) || key.toLowerCase() === 'style') continue;
          if ((key === 'href' || key === 'xlink:href') && !value.startsWith('#') && !/^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value)) continue;
          safe[key] = value;
        }
        return { tagName, attribs: safe };
      },
    },
  }).trim();
  if (!/^<svg(?:\s|>)/i.test(clean)) throw new Error('asset is not a valid standalone SVG');
  return Buffer.from(clean + '\n', 'utf8');
}

/** Download every referenced asset (from the export's Media dir or the web), hash, dedupe. */
export async function collectAssets(docs: DocIR[], workspace: string, opts: { fetcher?: Fetcher; localResolver?: (url: string) => string | undefined; provider?: string }): Promise<AssetManifest> {
  const m = readManifest(workspace);
  m.provider = opts.provider ?? m.provider;
  const originalDir = join(workspace, 'assets-original');
  const readyDir = join(workspace, 'assets-ready');
  mkdirSync(originalDir, { recursive: true, mode: 0o700 });
  mkdirSync(readyDir, { recursive: true, mode: 0o700 });
  const urls = new Map<string, number>();
  for (const d of docs) for (const { url, alt } of collectImageUrls(d)) if (url) urls.set(url, (urls.get(url) ?? 0) + (alt ? 0 : 1));
  for (const [url, altMissing] of urls) {
    if (m.byUrl[url]) continue;
    try {
      let buf: Buffer | undefined; let contentType: string | undefined;
      const local = opts.localResolver?.(url);
      if (local && existsSync(local)) buf = readFileSync(local);
      else if (opts.fetcher && /^https?:\/\//.test(url)) {
        const page = await opts.fetcher.get(url);
        if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
        buf = page.bodyBase64 ? Buffer.from(page.bodyBase64, 'base64') : Buffer.from(page.body, 'utf8'); contentType = page.contentType;
      }
      if (!buf) { m.byUrl[url] = url; m.entries[url] = { hash: url, sourceUrls: [url], status: 'kept-external', altMissing, error: 'no local file and no fetcher' }; continue; }
      const candidateExt = extname(url.split('?')[0]);
      const ext = /^\.[A-Za-z0-9]{1,10}$/.test(candidateExt) ? candidateExt.toLowerCase() : '.bin';
      const sourceHash = sha256(buf);
      const originalPath = join(originalDir, `${sourceHash}${ext}`);
      if (!existsSync(originalPath)) writeFileSync(originalPath, buf, { mode: 0o600 });
      const isSvg = ext === '.svg' || /^image\/svg\+xml(?:;|$)/i.test(contentType ?? '');
      const ready = isSvg ? sanitizeSvgBytes(buf) : buf;
      const hash = sha256(ready);
      const localPath = join(readyDir, `${hash}${ext}`);
      if (!existsSync(localPath)) writeFileSync(localPath, ready, { mode: 0o600 });
      const e = m.entries[hash] ?? { hash, sourceHash, sourceUrls: [], localPath, bytes: ready.length, contentType: contentType || (isSvg ? 'image/svg+xml' : undefined), status: 'downloaded' as const, altMissing: 0, sanitized: isSvg };
      e.sourceUrls.push(url); e.altMissing += altMissing;
      m.entries[hash] = e; m.byUrl[url] = hash;
    } catch (e) {
      m.byUrl[url] = url; m.entries[url] = { hash: url, sourceUrls: [url], status: 'failed', error: (e as Error).message, altMissing };
    }
  }
  writeManifest(workspace, m);
  return m;
}

/** Provider "none": keep source URLs; "local": finalUrl stays undefined until ingestion. Others set finalUrl. */
export function finalUrlFor(m: AssetManifest, url: string): string {
  const h = m.byUrl[url];
  const e = h ? m.entries[h] : undefined;
  return e?.finalUrl ?? url;
}

export function rewriteAssetRefs(doc: DocIR, m: AssetManifest): DocIR {
  const inl = (nodes: Inline[]): Inline[] => nodes.map((n) => (n.type === 'image' ? { ...n, url: finalUrlFor(m, n.url) } : 'children' in n ? ({ ...n, children: inl((n as any).children) } as Inline) : n));
  const walk = (blocks: Block[]): Block[] => blocks.map((b) => {
    switch (b.type) {
      case 'image': return { ...b, url: finalUrlFor(m, b.url) };
      case 'figure': return { ...b, image: { ...b.image, url: finalUrlFor(m, b.image.url) } };
      case 'paragraph': case 'heading': return { ...b, children: inl(b.children) } as Block;
      case 'list': return { ...b, children: b.children.map((li) => ({ ...li, children: walk(li.children) })) };
      case 'blockquote': case 'dai': case 'component': return { ...b, children: walk(b.children) } as Block;
      default: return b;
    }
  });
  return { ...doc, children: walk(doc.children) };
}

/** Document360 Media/ resolver: cdn.document360.io/.../Documentation/X.png → Media/X.png (unescaped, %20 decoded). */
export function d360MediaResolver(mediaDir: string | undefined): (url: string) => string | undefined {
  if (!mediaDir) return () => undefined;
  return (url) => {
    const name = decodeURIComponent(basename(url.split('?')[0]).replace(/&amp;/g, '&'));
    const p = join(mediaDir, name);
    return existsSync(p) ? p : undefined;
  };
}
