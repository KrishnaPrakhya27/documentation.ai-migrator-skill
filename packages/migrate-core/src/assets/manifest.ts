/**
 * Assets: download originals, hash-dedupe, ingest through a provider,
 * rewrite references from a manifest keyed by content hash.
 * Providers: none (keep source URL, flagged), local (copy into the workspace
 * for later ingestion), dai-api (platform dependency G7), s3 (BYO).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { DocIR, Block, Inline } from '../ir/types.js';
import { walkBlocks } from '../ir/types.js';
import { sha256 } from '../session/ids.js';
import type { Fetcher } from '../scrape/fetcher.js';

export interface AssetEntry {
  hash: string;
  sourceUrls: string[];
  localPath?: string;
  bytes?: number;
  contentType?: string;
  /** Absolute URL to use in output; set by the provider. */
  finalUrl?: string;
  status: 'pending' | 'downloaded' | 'ingested' | 'kept-external' | 'failed';
  error?: string;
  altMissing: number;
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

/** Download every referenced asset (from the export's Media dir or the web), hash, dedupe. */
export async function collectAssets(docs: DocIR[], workspace: string, opts: { fetcher?: Fetcher; localResolver?: (url: string) => string | undefined; provider?: string }): Promise<AssetManifest> {
  const m = readManifest(workspace);
  m.provider = opts.provider ?? m.provider;
  const dir = join(workspace, 'assets-original');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      const hash = sha256(buf);
      const candidateExt = extname(url.split('?')[0]);
      const ext = /^\.[A-Za-z0-9]{1,10}$/.test(candidateExt) ? candidateExt.toLowerCase() : '.bin';
      const localPath = join(dir, `${hash}${ext}`);
      if (!existsSync(localPath)) writeFileSync(localPath, buf, { mode: 0o600 });
      const e = m.entries[hash] ?? { hash, sourceUrls: [], localPath, bytes: buf.length, contentType, status: 'downloaded' as const, altMissing: 0 };
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
