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
import { htmlMediaReferences, rewriteHtmlMedia } from './html-media.js';
import { mapBlocks, walkBlocks } from '../ir/types.js';
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
  /** Object key in Documentation.AI media storage (`org-<org>/doc-<doc>/<file>`); set by the s3 provider. */
  storagePath?: string;
  status: 'pending' | 'downloaded' | 'ingested' | 'kept-external' | 'failed';
  error?: string;
  altMissing: number;
  sanitized?: boolean;
  /**
   * A named person accepted that this asset is not carried (plan/scope-decisions.yaml `assets`).
   * The entry stays in the manifest so the decision is visible and reported; its references are
   * removed from the pages rather than left pointing at the source host.
   */
  excluded?: { reason: string; approvedBy: string; approvedAt?: string };
}

export interface AssetManifest {
  provider: string; entries: Record<string, AssetEntry>; byUrl: Record<string, string>;
  /**
   * A named person decided the pictures stay at the addresses they are served from today, because
   * no image hosting is configured for this migration (no Documentation.AI API key, no storage
   * bucket). The pages are whole and the pictures show, for as long as those addresses stay online:
   * the report says so, and says what to do before the old site is switched off.
   */
  keptExternal?: { by: string; at: string };
}

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

/**
 * Where an asset actually lives. A page fetched over HTTP addresses its images the way the browser
 * reading that page does: relative to the page's own URL. Recording the reference as written would
 * make the same file reached from two directory depths look like two assets, leave a provider with
 * nothing it can fetch, and emit a path that resolves against the migrated site instead of the
 * source. A repository or export source has no such base and is left exactly as authored.
 */
export function resolveAssetUrl(url: string, source: string | undefined): string {
  const proxied = gitbookImageProxyTarget(url);
  if (proxied) return proxied;
  if (!url || !source || !/^https?:\/\//i.test(source)) return url;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return url;
  try { return new URL(url, source).toString(); } catch { return url; }
}

/**
 * The real file behind GitBook's resizing proxy. A page may address an image as
 * `<host>/~gitbook/image?url=<encoded>&width=…`, and the host serving that proxy is not always one
 * that answers: this site proxies through `sites.gitbook.com`, which times out (HTTP 522) and will
 * not serve robots.txt, while the file in its `url` parameter is served normally. The proxy is the
 * old platform's delivery, not the asset — the asset is what it points at, at full size.
 */
export function gitbookImageProxyTarget(url: string): string | undefined {
  if (!url || !/^https?:\/\//i.test(url) || !url.includes('/~gitbook/image')) return undefined;
  try {
    const parsed = new URL(url);
    if (!/\/~gitbook\/image\/?$/.test(parsed.pathname)) return undefined;
    const target = parsed.searchParams.get('url');
    return target && /^https?:\/\//i.test(target) ? target : undefined;
  } catch { return undefined; }
}

function documentAssetReferences(doc: DocIR): AssetReference[] {
  const page = { id: doc.pageId, source: doc.source };
  const out: AssetReference[] = [];
  const locate = (url: string): string => resolveAssetUrl(url, doc.source);
  // The social image is served to every link preview of this page; leaving it on the old platform
  // breaks those previews the day it is switched off.
  if (typeof doc.frontmatter?.ogImage === 'string' && doc.frontmatter.ogImage) out.push({ kind: 'image', url: locate(doc.frontmatter.ogImage), page });
  const image = (node: { url: string; alt: string; sources?: string[] }) => {
    if (node.url) out.push({ kind: 'image', url: locate(node.url), page, alt: node.alt });
    for (const variant of node.sources ?? []) out.push({ kind: 'image', url: locate(variant), page, alt: node.alt });
  };
  const inl = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.type === 'image') image(n);
      else if (n.type === 'inlineHtml') { for (const media of htmlMediaReferences(n.value)) out.push({ kind: media.kind, url: locate(media.url), page }); }
      else if ('children' in n) inl(n.children);
    }
  };
  walkBlocks(doc.children, (b) => {
    if (b.type === 'image') image(b);
    else if (b.type === 'figure') image(b.image);
    else if (b.type === 'component' || b.type === 'dai') {
      for (const [prop, value] of Object.entries(b.props)) {
        const kind = componentAssetKind(b.name, prop);
        if (kind && typeof value === 'string' && value) out.push({ kind, url: locate(value), page });
      }
    }
    else if (b.type === 'paragraph' || b.type === 'heading') inl(b.children);
    else if (b.type === 'table') for (const r of b.children) for (const c of r.children) inl(c.children);
    // A fragment the rules engine preserved verbatim still addresses the customer's files; they
    // die with the platform being left unless they are hosted like any other asset.
    else if (b.type === 'rawHtml') for (const media of htmlMediaReferences(b.value)) out.push({ kind: media.kind, url: locate(media.url), page });
  });
  return out;
}


function missingAlt(references: AssetReference[]): number {
  return references.filter((reference) => reference.alt === '').length;
}

export interface AssetSource { kind: 'url' | 'file'; resolve: (url: string) => string | undefined }

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.jfif': 'image/jpeg', '.jpe': 'image/jpeg',
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
/** The synthetic page the site plan's logo and favicon are collected under, so they are hosted with the pages' media. */
export const SITE_BRANDING_PAGE = 'site-branding';

/** An image only the site plan shows (a logo, a favicon): presentation, never a page's content. */
export function isSiteBrandingOnly(entry: AssetEntry): boolean {
  return entry.references.length > 0 && entry.references.every((reference) => reference.page?.id === SITE_BRANDING_PAGE);
}

/**
 * Assets a page needs that nobody hosts. A logo or favicon the site plan carries is not among them:
 * it is presentation, so one that cannot be hosted is left out of documentation.json and said so at
 * `nav`, rather than stopping a migration whose every page is whole.
 */
export function unhostedAssets(m: AssetManifest): AssetEntry[] {
  return Object.values(m.entries).filter((entry) => !entry.excluded && !isSiteBrandingOnly(entry) && (entry.status !== 'ingested' || !entry.finalUrl)
    // left where it is served today by a named person's decision, not for want of trying
    && !(m.keptExternal && entry.status === 'kept-external'));
}

/** Assets a named person accepted the migration would not carry. Reported, never silent. */
export function excludedAssets(m: AssetManifest): AssetEntry[] {
  return Object.values(m.entries).filter((entry) => !!entry.excluded);
}

/**
 * Marks the entries a scope decision names. The URL must match one the manifest actually recorded:
 * a decision naming nothing is an error, not a no-op, because a typo would otherwise read as an
 * approval that silently protects nothing.
 */
export function applyAssetExclusions(m: AssetManifest, decisions: ReadonlyArray<{ hash?: string; url?: string; reason: string; approvedBy: string; approvedAt?: string }>): void {
  for (const decision of decisions) {
    const named = decision.hash ?? decision.url!;
    // An asset that never downloaded has no content hash — its entry is keyed by URL — and a
    // GitBook file URL carries an access token in its query. Matching a token-free URL against the
    // address without its query identifies the file exactly while keeping the credential out of the
    // plan file. A decision that does state a query must match it in full.
    const withoutQuery = (url: string): string => url.split('?')[0];
    const matches = (entry: AssetEntry): boolean => {
      if (decision.hash) return entry.hash === decision.hash;
      const url = decision.url!;
      if (entry.sourceUrls.includes(url)) return true;
      return !url.includes('?') && entry.sourceUrls.some((candidate) => withoutQuery(candidate) === url);
    };
    const entries = Object.values(m.entries).filter(matches);
    if (!entries.length) throw new Error(`plan/scope-decisions.yaml: assets entry names ${named}, which is not an asset of this migration; use the hash or source URL exactly as plan/assets.json records it`);
    for (const entry of entries) entry.excluded = { reason: decision.reason, approvedBy: decision.approvedBy, ...(decision.approvedAt ? { approvedAt: decision.approvedAt } : {}) };
  }
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

/** An image and every variant it offers, each pointed at wherever the manifest put it. */
function withVariants<T extends { url: string; sources?: string[] }>(node: T, final: (url: string) => string): T {
  const sources = node.sources?.map(final);
  return { ...node, url: final(node.url), ...(sources ? { sources } : {}) };
}

export function rewriteAssetRefs(doc: DocIR, m: AssetManifest): DocIR {
  const ogImage = typeof doc.frontmatter?.ogImage === 'string' && doc.frontmatter.ogImage
    ? finalUrlFor(m, resolveAssetUrl(doc.frontmatter.ogImage, doc.source))
    : undefined;
  // The same resolution the manifest recorded, so a reference finds its entry and an asset that
  // kept its source URL is emitted as that URL rather than as a path into the migrated site.
  const final = (url: string): string => finalUrlFor(m, resolveAssetUrl(url, doc.source));
  return {
    ...doc,
    ...(ogImage ? { frontmatter: { ...doc.frontmatter, ogImage } } : {}),
    children: mapBlocks(doc.children, {
      inline: (n) => n.type === 'image' ? withVariants(n, final)
        : n.type === 'inlineHtml' ? { ...n, value: rewriteHtmlMedia(n.value, final) }
        : n,
      block: (b): Block => {
        switch (b.type) {
          case 'image': return withVariants(b, final);
          case 'figure': return { ...b, image: withVariants(b.image, final) };
          case 'rawHtml': return { ...b, value: rewriteHtmlMedia(b.value, final) };
          case 'dai': case 'component': return { ...b, props: Object.fromEntries(Object.entries(b.props).map(([key, value]) => [key, componentAssetKind(b.name, key) && typeof value === 'string' ? final(value) : value])) };
          default: return b;
        }
      },
    }),
  };
}

/** The manifest entry for a page's reference to an asset a person decided not to carry, if it is one. */
export function excludedAssetEntry(m: AssetManifest, url: string, source?: string): AssetEntry | undefined {
  const resolved = resolveAssetUrl(url, source);
  const key = m.byUrl[resolved] ?? m.byUrl[url];
  const entry = key ? m.entries[key] : Object.values(m.entries).find((e) => e.sourceUrls.includes(resolved) || e.sourceUrls.includes(url));
  return entry?.excluded ? entry : undefined;
}

/**
 * Removes every reference to an excluded asset. Exact output states no media it does not host and
 * points at no source host, so the reference goes rather than degrading into a dead or external
 * URL. A figure loses its image and therefore the figure; a paragraph keeps the words around it.
 */
export function dropExcludedAssets(doc: DocIR, m: AssetManifest, onDrop?: (node: { id: string }, entry: AssetEntry) => void): DocIR {
  const excludedEntry = (url: string): AssetEntry | undefined => excludedAssetEntry(m, url, doc.source);
  const dropped = (node: { id: string }, url: string): boolean => {
    const entry = excludedEntry(url);
    if (entry) onDrop?.(node, entry);
    return !!entry;
  };
  const inlines = (nodes: Inline[]): Inline[] => nodes.flatMap((node): Inline[] => {
    if (node.type === 'image' && dropped(node, node.url)) return [];
    return ['children' in node && Array.isArray((node as { children?: Inline[] }).children)
      ? ({ ...node, children: inlines((node as unknown as { children: Inline[] }).children) } as Inline)
      : node];
  });
  const strip = (blocks: Block[]): Block[] => blocks.flatMap((block): Block[] => {
    switch (block.type) {
      case 'image': return dropped(block, block.url) ? [] : [block];
      case 'figure': return dropped(block, block.image.url) ? [] : [block];
      case 'paragraph': case 'heading': return [{ ...block, children: inlines(block.children) }];
      case 'list': return [{ ...block, children: block.children.map((item) => ({ ...item, children: strip(item.children) })) }];
      case 'blockquote': case 'footnoteDefinition': case 'dai': case 'component':
        return [{ ...block, children: strip(block.children as Block[]) } as Block];
      default: return [block];
    }
  });
  return { ...doc, children: strip(doc.children) };
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
