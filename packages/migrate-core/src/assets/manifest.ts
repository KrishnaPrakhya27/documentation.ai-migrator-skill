/**
 * Assets: download originals, hash-dedupe, ingest through a provider,
 * rewrite references from a manifest keyed by content hash.
 * Providers: none (keep source URL, flagged), local (copy into the workspace
 * for later ingestion), dai-api (platform dependency G7), s3 (BYO).
 * Every entry records where its URL is used (page media or site chrome), so a
 * stage that stops on an unhosted asset can name the page that needs it.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import sanitizeHtml from 'sanitize-html';
import type { DocIR, Block, Inline } from '../ir/types.js';
import { walkBlocks } from '../ir/types.js';
import { sha256 } from '../session/ids.js';
import type { Fetcher } from '../scrape/fetcher.js';

export type AssetReferenceKind = 'image' | 'video' | 'audio' | 'poster';

/** One use of an asset URL by a page: an image, video, audio file or poster. Source branding is never an asset of a migration. */
export interface AssetReference {
  kind: AssetReferenceKind;
  url: string;
  /** Referencing page. */
  page?: { id: string; source: string };
  /** Alt text of an image node; an empty string counts towards `altMissing`. */
  alt?: string;
}

export interface AssetEntry {
  hash: string;
  /** Hash of the exact source bytes; differs from hash only when SVG was sanitised. */
  sourceHash?: string;
  sourceUrls: string[];
  references: AssetReference[];
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

/** Elements whose `src` is a media file; every other component's `src` (iframe, script, embed) is a document, never fetched as an asset. */
const MEDIA_ELEMENTS: Record<string, AssetReferenceKind> = { video: 'video', Video: 'video', audio: 'audio' };

/** What a component prop refers to: `image`/`img` art on any component (Card), `src`/`poster` only on media elements. */
function componentAssetKind(componentName: string, prop: string): AssetReferenceKind | undefined {
  if (prop === 'image' || prop === 'img') return 'image';
  const media = MEDIA_ELEMENTS[componentName];
  if (!media) return undefined;
  return prop === 'src' ? media : prop === 'poster' ? 'poster' : undefined;
}

function documentAssetReferences(doc: DocIR): AssetReference[] {
  const page = { id: doc.pageId, source: doc.source };
  const out: AssetReference[] = [];
  const image = (node: { url: string; alt: string }) => { if (node.url) out.push({ kind: 'image', url: node.url, page, alt: node.alt }); };
  const inl = (nodes: Inline[]) => { for (const n of nodes) { if (n.type === 'image') image(n); else if ('children' in n) inl(n.children); } };
  walkBlocks(doc.children, (b) => {
    if (b.type === 'image') image(b);
    else if (b.type === 'figure') image(b.image);
    else if (b.type === 'component' || b.type === 'dai') {
      for (const [prop, value] of Object.entries(b.props)) {
        const kind = componentAssetKind(b.name, prop);
        if (kind && typeof value === 'string' && value) out.push({ kind, url: value, page });
      }
    }
    else if (b.type === 'paragraph' || b.type === 'heading') inl(b.children);
    else if (b.type === 'table') for (const r of b.children) for (const c of r.children) inl(c.children);
  });
  return out;
}


function missingAlt(references: AssetReference[]): number {
  return references.filter((reference) => reference.alt === '').length;
}

export interface AssetSource { kind: 'url' | 'file'; resolve: (url: string) => string | undefined }

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};
const OPAQUE_MEDIA_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

/** The media type an asset is served as, or the one its extension implies; anything else (an HTML error page at an image URL) is not an asset. */
function assetMediaType(contentType: string | undefined, ext: string, url: string): string {
  const declared = contentType?.split(';')[0].trim().toLowerCase();
  if (declared && /^(?:image|video|audio)\//.test(declared)) return declared;
  const implied = MEDIA_TYPES_BY_EXTENSION[ext];
  if (implied && (!declared || OPAQUE_MEDIA_TYPES.has(declared))) return implied;
  throw new Error(`unsupported asset type ${declared || `unknown (${ext === '.bin' ? 'no media extension' : ext})`} at ${url}`);
}

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

export interface CollectAssetsOptions {
  fetcher?: Fetcher;
  localResolver?: (url: string) => string | undefined;
  provider?: string;
}

/**
 * Download every referenced asset (from the export's Media dir or the web),
 * hash, dedupe. Entries that never received bytes are retried on every run, so
 * a fixed network or provider needs no manual manifest surgery.
 */
export async function collectAssets(docs: DocIR[], workspace: string, opts: CollectAssetsOptions): Promise<AssetManifest> {
  const m = readManifest(workspace);
  m.provider = opts.provider ?? m.provider;
  const originalDir = join(workspace, 'assets-original');
  const readyDir = join(workspace, 'assets-ready');
  mkdirSync(originalDir, { recursive: true, mode: 0o700 });
  mkdirSync(readyDir, { recursive: true, mode: 0o700 });
  const referencesByUrl = new Map<string, AssetReference[]>();
  for (const reference of docs.flatMap(documentAssetReferences)) {
    referencesByUrl.set(reference.url, [...(referencesByUrl.get(reference.url) ?? []), reference]);
  }
  // an asset the snapshot no longer references is not part of this migration
  for (const [url, key] of Object.entries(m.byUrl)) if (!referencesByUrl.has(url) || !m.entries[key]?.localPath) delete m.byUrl[url];
  const live = new Set(Object.values(m.byUrl));
  for (const [key, entry] of Object.entries(m.entries)) {
    if (!live.has(key)) { delete m.entries[key]; continue; }
    entry.sourceUrls = entry.sourceUrls.filter((url) => m.byUrl[url] === key);
    entry.references = entry.sourceUrls.flatMap((url) => referencesByUrl.get(url) ?? []);
    entry.altMissing = missingAlt(entry.references);
  }
  for (const [url, references] of referencesByUrl) {
    if (m.byUrl[url]) continue;
    const altMissing = missingAlt(references);
    try {
      let buf: Buffer | undefined; let contentType: string | undefined;
      const local = opts.localResolver?.(url);
      if (local && existsSync(local)) buf = readFileSync(local);
      else if (opts.fetcher && /^https?:\/\//.test(url)) {
        const page = await opts.fetcher.get(url);
        if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
        buf = page.bodyBase64 ? Buffer.from(page.bodyBase64, 'base64') : Buffer.from(page.body, 'utf8'); contentType = page.contentType || undefined;
      }
      if (!buf) { m.byUrl[url] = url; m.entries[url] = { hash: url, sourceUrls: [url], references, status: 'kept-external', altMissing, error: 'no local file and no fetcher' }; continue; }
      const candidateExt = extname(url.split('?')[0]);
      const ext = /^\.[A-Za-z0-9]{1,10}$/.test(candidateExt) ? candidateExt.toLowerCase() : '.bin';
      const mediaType = assetMediaType(contentType, ext, url);
      const sourceHash = sha256(buf);
      const originalPath = join(originalDir, `${sourceHash}${ext}`);
      if (!existsSync(originalPath)) writeFileSync(originalPath, buf, { mode: 0o600 });
      const isSvg = mediaType === 'image/svg+xml';
      const ready = isSvg ? sanitizeSvgBytes(buf) : buf;
      const hash = sha256(ready);
      const localPath = join(readyDir, `${hash}${ext}`);
      if (!existsSync(localPath)) writeFileSync(localPath, ready, { mode: 0o600 });
      const entry = m.entries[hash] ?? { hash, sourceHash, sourceUrls: [], references: [], localPath, bytes: ready.length, contentType: mediaType, status: 'downloaded' as const, altMissing: 0, sanitized: isSvg };
      entry.sourceUrls.push(url); entry.references.push(...references); entry.altMissing = missingAlt(entry.references);
      m.entries[hash] = entry; m.byUrl[url] = hash;
    } catch (error) {
      m.byUrl[url] = url; m.entries[url] = { hash: url, sourceUrls: [url], references, status: 'failed', error: (error as Error).message, altMissing };
    }
  }
  writeManifest(workspace, m);
  return m;
}

/** Entries the output cannot reference by a hosted URL: failed downloads or uploads, assets left on their source host, and downloads no provider has ingested. */
export function unhostedAssets(m: AssetManifest): AssetEntry[] {
  return Object.values(m.entries).filter((entry) => entry.status !== 'ingested' || !entry.finalUrl);
}

/** One line per asset for stage messages: source URL, where it is used, and why it is not hosted. */
export function describeAssetEntry(entry: AssetEntry): string {
  const uses = [...new Set(entry.references.map((reference) => (reference.page ? `${reference.kind} on ${reference.page.source}` : reference.kind)))].join(', ');
  const state = entry.status === 'failed' ? `failed: ${entry.error ?? 'unknown error'}`
    : entry.status === 'kept-external' ? `kept on its source host${entry.error ? ` (${entry.error})` : ''}`
    : entry.finalUrl ? entry.status : `${entry.status}, no hosted URL`;
  return `${entry.sourceUrls[0]} (${uses}): ${state}`;
}

const REFERENCE_KIND_ORDER: AssetReferenceKind[] = ['image', 'video', 'audio', 'poster'];

/** "1 image, 1 video" for stage summaries; kinds with no references are omitted. */
export function referenceTally(m: AssetManifest): string {
  const counts = new Map<AssetReferenceKind, number>();
  for (const entry of Object.values(m.entries)) for (const reference of entry.references) counts.set(reference.kind, (counts.get(reference.kind) ?? 0) + 1);
  return REFERENCE_KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${kind}${counts.get(kind) === 1 ? '' : 's'}`).join(', ');
}

/** Provider "none": keep source URLs; "local": finalUrl stays undefined until ingestion. Others set finalUrl. */
export function finalUrlFor(m: AssetManifest, url: string): string {
  const h = m.byUrl[url];
  const e = h ? m.entries[h] : undefined;
  return e?.finalUrl ?? url;
}

export function rewriteAssetRefs(doc: DocIR, m: AssetManifest): DocIR {
  const inl = (nodes: Inline[]): Inline[] => nodes.map((n) => (n.type === 'image' ? { ...n, url: finalUrlFor(m, n.url) } : 'children' in n ? { ...n, children: inl(n.children) } : n));
  const walk = (blocks: Block[]): Block[] => blocks.map((b) => {
    switch (b.type) {
      case 'image': return { ...b, url: finalUrlFor(m, b.url) };
      case 'figure': return { ...b, image: { ...b.image, url: finalUrlFor(m, b.image.url) } };
      case 'paragraph': case 'heading': return { ...b, children: inl(b.children) } as Block;
      case 'list': return { ...b, children: b.children.map((li) => ({ ...li, children: walk(li.children) })) };
      case 'blockquote': return { ...b, children: walk(b.children) } as Block;
      case 'dai': case 'component': {
        const props = Object.fromEntries(Object.entries(b.props).map(([key, value]) => [key, componentAssetKind(b.name, key) && typeof value === 'string' ? finalUrlFor(m, value) : value]));
        return { ...b, props, children: walk(b.children) } as Block;
      }
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
