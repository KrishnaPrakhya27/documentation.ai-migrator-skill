import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AssetEntry, AssetManifest } from './manifest.js';
import { writeManifest } from './manifest.js';

/** The one method of the Authoring MCP client the dai-mcp provider needs, so tests can stand in for the server. */
export type McpToolCaller = { call: <T = Record<string, unknown>>(tool: string, args: Record<string, unknown>) => Promise<{ structured: T; text: string }> };

export interface AssetProviderOptions {
  workspace: string;
  provider: 'none' | 'local' | 's3' | 'dai-api' | 'dai-mcp';
  /**
   * The Authoring MCP session the dai-mcp provider imports through, signed in as the person migrating.
   * `project` names the documentation when the session is not a key already bound to one.
   */
  mcp?: { client: McpToolCaller; project?: { organizationId: string; documentationId: string } };
  /** Exact mode refuses a stored copy whose size differs from the captured one; permissive notes it. */
  fidelityMode?: 'exact' | 'permissive';
  sleep?: (ms: number) => Promise<void>;
  /** Documentation.AI media storage on S3-compatible buckets (R2), written in the layout its media library reads. */
  s3?: S3StorageOptions;
  /**
   * Documentation.AI REST media API: `POST <baseUrl>/api/v1/media` takes up to 10 files as multipart form data.
   * The key is bound to one documentation, so no org or documentation id is needed. Used by dai-api for
   * every asset, and by dai-mcp for assets that have no public address to import from.
   */
  dai?: { baseUrl: string; token: string };
  fetchImpl?: typeof fetch;
  s3Client?: Pick<S3Client, 'send'>;
}

/** One bucket and the public base its objects are served from. */
export interface StorageTarget { bucket: string; publicBase: string }

/** Where each media kind is stored, as the platform routes it: images, videos, and every other file in their own bucket. */
export type StorageKind = 'image' | 'video' | 'files';

export interface S3StorageOptions {
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Objects are keyed `org-<organizationId>/doc-<documentationId>/<filename>`, the prefix the media library adopts. */
  organizationId: string;
  documentationId: string;
  buckets: { image: StorageTarget } & Partial<Record<Exclude<StorageKind, 'image'>, StorageTarget>>;
}

/**
 * The image, video and audio types Documentation.AI stores, with their extensions, canonical first
 * (documentation-ai-backend `src/lib/media-types.ts` MEDIA_TYPES and MIME_ALIASES).
 * The extension in a storage path is what the platform routes an object to its bucket by, so it must be one of these.
 */
const PLATFORM_MEDIA_TYPES: Record<string, { kind: 'image' | 'video' | 'audio'; extensions: string[] }> = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/svg+xml': { kind: 'image', extensions: ['svg'] },
  'image/x-icon': { kind: 'image', extensions: ['ico'] },
  'image/heic': { kind: 'image', extensions: ['heic', 'heif'] },
  'image/avif': { kind: 'image', extensions: ['avif'] },
  'image/bmp': { kind: 'image', extensions: ['bmp'] },
  'image/tiff': { kind: 'image', extensions: ['tif', 'tiff'] },
  'video/mp4': { kind: 'video', extensions: ['mp4', 'm4v'] },
  'video/webm': { kind: 'video', extensions: ['webm'] },
  'video/quicktime': { kind: 'video', extensions: ['mov'] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'] },
  'audio/wav': { kind: 'audio', extensions: ['wav'] },
  'audio/ogg': { kind: 'audio', extensions: ['ogg', 'oga'] },
  'audio/mp4': { kind: 'audio', extensions: ['m4a'] },
  'audio/aac': { kind: 'audio', extensions: ['aac'] },
};
const PLATFORM_MEDIA_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg', 'image/vnd.microsoft.icon': 'image/x-icon', 'image/ico': 'image/x-icon', 'image/x-ms-bmp': 'image/bmp', 'image/heif': 'image/heic',
  'video/x-m4v': 'video/mp4', 'video/mov': 'video/quicktime',
  'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/aacp': 'audio/aac',
};

/** How the platform stores one asset: its media type, the bucket kind, and the extension its path carries. */
export function platformMedia(entry: Pick<AssetEntry, 'contentType' | 'localPath'>): { mimeType: string; storage: StorageKind; extension: string } | undefined {
  const declared = (entry.contentType ?? '').split(';')[0].trim().toLowerCase();
  const byType = PLATFORM_MEDIA_ALIASES[declared] ?? declared;
  const ext = extname(entry.localPath ?? '').slice(1).toLowerCase();
  const mimeType = PLATFORM_MEDIA_TYPES[byType] ? byType : Object.keys(PLATFORM_MEDIA_TYPES).find((type) => ext && PLATFORM_MEDIA_TYPES[type].extensions.includes(ext));
  if (!mimeType) return undefined;
  const spec = PLATFORM_MEDIA_TYPES[mimeType];
  return { mimeType, storage: spec.kind === 'image' ? 'image' : spec.kind === 'video' ? 'video' : 'files', extension: spec.extensions[0] };
}

/**
 * `<hash>-<source name>.<ext>`: the platform's `<timestamp>-<random>-<name>.<ext>` shape, with the content hash in place of
 * the time and random parts so the same bytes always land on the same object and a re-run uploads nothing new.
 */
export function storageFilename(entry: Pick<AssetEntry, 'hash' | 'sourceUrls'>, extension: string): string {
  const source = entry.sourceUrls[0] ?? '';
  let name = source.split(/[?#]/)[0].split('/').pop() ?? '';
  try { name = decodeURIComponent(name); } catch { /* keep the raw segment */ }
  const stem = name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 80) || 'asset';
  return `${entry.hash.slice(0, 16)}-${stem}.${extension}`;
}

/** `org-<org>/doc-<doc>/<filename>` (documentation-ai-backend `generateStoragePath`). */
export function storagePath(organizationId: string, documentationId: string, filename: string): string {
  return `org-${organizationId}/doc-${documentationId}/${filename}`;
}

/**
 * The URL the platform's media library gives an object (documentation-ai-backend `getDefaultOptimizedUrl`): images through the
 * image CDN with automatic format and compression, SVG through it untransformed, videos and files from their own hosts.
 */
export function platformPublicUrl(publicBase: string, path: string, storage: StorageKind): string {
  const url = `${publicBase.replace(/\/+$/, '')}/${path}`;
  if (storage !== 'image') return url;
  return path.toLowerCase().endsWith('.svg') ? `${url}?rasterize-bypass=true` : `${url}?fm=auto&auto=compress%2Cformat`;
}

/** Images carry no Cache-Control; other kinds get the platform's short one, so a library replacement is seen within minutes. */
function cacheControlFor(storage: StorageKind): string | undefined {
  return storage === 'image' ? undefined : 'public, max-age=300';
}

/** The bucket-name variable of each kind, named as the backend names it. */
const STORAGE_ENV: Record<StorageKind, string> = { image: 'R2_IMAGES_BUCKET_NAME', video: 'R2_VIDEOS_BUCKET_NAME', files: 'R2_FILES_BUCKET_NAME' };
/** The CDN base each kind is served from, named as the backend names it (imgix for images, a direct host for the others). */
const DELIVERY_ENV: Record<StorageKind, string> = { image: 'MEDIA_IMAGE_CDN_BASE', video: 'MEDIA_VIDEO_CDN_BASE', files: 'MEDIA_FILES_CDN_BASE' };

/**
 * Documentation.AI R2 media storage from the backend's own variables: CLOUDFLARE_ENDPOINT (or CLOUDFLARE_ACCOUNT_ID),
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_{IMAGES,VIDEOS,FILES}_BUCKET_NAME with MEDIA_{IMAGE,VIDEO,FILES}_CDN_BASE,
 * keyed by the organization and documentation.
 */
export function s3StorageFromEnv(vars: Record<string, string | undefined>, target?: { organizationId?: string; documentationId?: string }): S3StorageOptions {
  const value = (name: string) => vars[name] || undefined;
  const accountId = value('CLOUDFLARE_ACCOUNT_ID');
  const bucket = (kind: StorageKind): StorageTarget => ({ bucket: value(STORAGE_ENV[kind]) ?? '', publicBase: value(DELIVERY_ENV[kind]) ?? '' });
  return {
    region: 'auto',
    endpoint: value('CLOUDFLARE_ENDPOINT') ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined),
    accessKeyId: value('R2_ACCESS_KEY_ID'),
    secretAccessKey: value('R2_SECRET_ACCESS_KEY'),
    organizationId: target?.organizationId ?? value('DAI_ORGANIZATION_ID') ?? '',
    documentationId: target?.documentationId ?? value('DAI_DOCUMENTATION_ID') ?? '',
    buckets: { image: bucket('image'), video: bucket('video'), files: bucket('files') },
  };
}

/** What stops the s3 provider from writing platform storage. Videos and files buckets are optional; without one, those assets fail. */
export function s3StorageProblems(storage: S3StorageOptions): string[] {
  const problems: string[] = [];
  if (!storage.organizationId || !storage.documentationId) problems.push('DAI_ORGANIZATION_ID and DAI_DOCUMENTATION_ID are required: storage paths are org-<id>/doc-<id>/…');
  else if (![storage.organizationId, storage.documentationId].every((id) => /^[A-Za-z0-9-]+$/.test(id))) problems.push('DAI_ORGANIZATION_ID and DAI_DOCUMENTATION_ID must be plain ids (letters, digits, hyphens)');
  if (!storage.endpoint) problems.push('CLOUDFLARE_ENDPOINT or CLOUDFLARE_ACCOUNT_ID is required');
  if (!storage.accessKeyId || !storage.secretAccessKey) problems.push('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  if (!storage.buckets.image.bucket || !storage.buckets.image.publicBase) problems.push(`${STORAGE_ENV.image} and ${DELIVERY_ENV.image} are required`);
  for (const kind of ['video', 'files'] as const) {
    const target = storage.buckets[kind];
    if (target && !!target.bucket !== !!target.publicBase) problems.push(`${STORAGE_ENV[kind]} and ${DELIVERY_ENV[kind]} must be set together`);
  }
  return problems;
}

/** How many files the platform takes per upload or import request. */
export const PLATFORM_BATCH_SIZE = 10;
/** Files stored per organisation per minute through the API or MCP (backend `rateLimitPolicies.mediaWrites`). */
const PLATFORM_FILES_PER_MINUTE = 120;

/** The name a file is shown under in the library: the source's own file name, with the extension its type implies. */
export function libraryName(entry: Pick<AssetEntry, 'sourceUrls'>, extension: string): string {
  let name = (entry.sourceUrls[0] ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
  try { name = decodeURIComponent(name); } catch { /* keep the raw segment */ }
  const stem = name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9 _-]/g, '-').trim().slice(0, 80) || 'asset';
  return `${stem}.${extension}`;
}

/** `org-<org>/doc-<doc>/<file>` read back from a hosted URL, so a later project change can be detected as with s3. */
export function storagePathFromUrl(url: string): string | undefined {
  try {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    return /^org-[^/]+\/doc-[^/]+\/./.test(path) ? path : undefined;
  } catch { return undefined; }
}

/** The public address the platform can fetch this asset from itself, or undefined when only the captured bytes will do. */
export function importableUrl(entry: Pick<AssetEntry, 'sourceUrls' | 'sanitized'>): string | undefined {
  // A cleaned SVG is not what the source serves: importing it would carry the unsafe original.
  if (entry.sanitized) return undefined;
  return entry.sourceUrls.find((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
}

/** Seconds a per-file rate-limit refusal asks to wait, or undefined when the refusal is anything else. */
function retryAfterSeconds(error: string, statusCode?: number): number | undefined {
  const stated = /Retry in (\d+) seconds?/i.exec(error);
  if (stated) return Number(stated[1]);
  return statusCode === 429 ? 30 : undefined;
}

/** Spaces batches so files stay under the platform's per-organisation rate. */
function pacer(sleep: (ms: number) => Promise<void>) {
  let nextAt = 0;
  return async (files: number) => {
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextAt = Math.max(Date.now(), nextAt) + Math.ceil((files * 60_000) / PLATFORM_FILES_PER_MINUTE);
  };
}

type FileOutcome = { ok: true; url: string; sizeBytes?: number } | { ok: false; error: string; retryAfter?: number };

/**
 * Sends batches through `send`, retrying files the platform refused for rate alone after the wait it asks
 * for, and records each outcome on its entry. `checkpoint` runs after every batch so an interrupted run
 * resumes where it stopped.
 */
async function inBatches(
  entries: AssetEntry[],
  send: (batch: AssetEntry[]) => Promise<FileOutcome[]>,
  record: (entry: AssetEntry, outcome: FileOutcome) => void,
  options: { sleep: (ms: number) => Promise<void>; checkpoint: () => void },
): Promise<void> {
  const pace = pacer(options.sleep);
  let queue = entries;
  for (let round = 0; queue.length && round < 6; round++) {
    const retry: AssetEntry[] = [];
    let longestWait = 0;
    for (let start = 0; start < queue.length; start += PLATFORM_BATCH_SIZE) {
      const batch = queue.slice(start, start + PLATFORM_BATCH_SIZE);
      await pace(batch.length);
      let outcomes: FileOutcome[];
      try { outcomes = await send(batch); }
      catch (error) { outcomes = batch.map(() => ({ ok: false as const, error: (error as Error).message })); }
      batch.forEach((entry, index) => {
        const outcome = outcomes[index] ?? { ok: false as const, error: 'the platform returned no result for this file' };
        if (!outcome.ok && outcome.retryAfter !== undefined && round < 5) {
          retry.push(entry);
          longestWait = Math.max(longestWait, outcome.retryAfter);
          return;
        }
        record(entry, outcome);
      });
      options.checkpoint();
    }
    if (retry.length) await options.sleep(longestWait * 1000);
    queue = retry;
  }
}

async function responseJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${context} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export function mediaApi(baseUrl: string): string { return `${baseUrl.replace(/\/$/, '')}/api/v1/media`; }

export class MediaApiUnavailable extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(status === 401 || status === 403
      ? `the Documentation.AI media API rejected the API key (${status}) at ${url}: check that DAI_API_KEY is this project's key, has not been revoked, and has the editor or admin role`
      : status === 404
        ? `the Documentation.AI media API is not available at ${url} (404): this platform does not offer API media upload yet. Use --provider dai-mcp to host pictures through a sign-in instead`
        : `the Documentation.AI media API answered ${status} at ${url}`);
  }
}

/** One authenticated call before any asset is touched: proves the key can drive the media surface at all. */
export async function probeDaiMediaApi(opts: NonNullable<AssetProviderOptions['dai']>, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${mediaApi(opts.baseUrl)}?limit=1`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new MediaApiUnavailable(res.status, url);
}

interface MediaApiResult { status: 'added' | 'reused' | 'failed'; media?: { url: string; sizeBytes?: number }; error?: string; statusCode?: number }

/** Uploads one batch of captured bytes. The API answers one result per file, in the order sent. */
async function uploadBatch(batch: AssetEntry[], opts: NonNullable<AssetProviderOptions['dai']>, fetchImpl: typeof fetch): Promise<FileOutcome[]> {
  const form = new FormData();
  const refused = new Map<number, string>();
  batch.forEach((entry, index) => {
    const media = platformMedia(entry);
    if (!media || !entry.localPath) { refused.set(index, `Documentation.AI does not accept ${entry.contentType || 'this type'}`); return; }
    form.append('files', new Blob([readFileSync(entry.localPath)], { type: media.mimeType }), libraryName(entry, media.extension));
  });
  const sent = batch.map((_, index) => index).filter((index) => !refused.has(index));
  const results: MediaApiResult[] = [];
  if (sent.length) {
    const url = mediaApi(opts.baseUrl);
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${opts.token}` }, body: form, signal: AbortSignal.timeout(300_000) });
    if ([401, 403, 404].includes(res.status)) throw new MediaApiUnavailable(res.status, url);
    const body = await res.json().catch(() => undefined) as { results?: MediaApiResult[] } | undefined;
    if (!body?.results) throw new Error(`the media API answered ${res.status} without per-file results`);
    results.push(...body.results);
  }
  return batch.map((_, index) => {
    if (refused.has(index)) return { ok: false, error: refused.get(index)! };
    const result = results[sent.indexOf(index)];
    if (result?.media?.url && result.status !== 'failed') return { ok: true, url: result.media.url, sizeBytes: result.media.sizeBytes };
    const error = result?.error ?? 'the platform returned no result for this file';
    return { ok: false, error, retryAfter: retryAfterSeconds(error, result?.statusCode) };
  });
}

interface ImportMediaResult {
  imported?: Array<{ source: string; url: string; sizeBytes: number }>;
  failed?: Array<{ source: string; error: string }>;
}

/** Imports one batch by URL through the Authoring MCP server, which fetches each file itself. */
async function importBatch(batch: AssetEntry[], mcp: NonNullable<AssetProviderOptions['mcp']>): Promise<FileOutcome[]> {
  const files = batch.map((entry) => {
    const media = platformMedia(entry);
    return { url: importableUrl(entry)!, ...(media ? { name: libraryName(entry, media.extension) } : {}) };
  });
  const { structured } = await mcp.client.call<ImportMediaResult>('import_media', { files, ...(mcp.project ?? {}) });
  const imported = new Map((structured.imported ?? []).map((item) => [item.source, item]));
  const failed = new Map((structured.failed ?? []).map((item) => [item.source, item.error]));
  return files.map(({ url }) => {
    const stored = imported.get(url);
    if (stored) return { ok: true, url: stored.url, sizeBytes: stored.sizeBytes };
    const error = failed.get(url) ?? 'the platform returned no result for this file';
    return { ok: false, error, retryAfter: retryAfterSeconds(error) };
  });
}

export function s3Client(opts: S3StorageOptions): S3Client {
  const config: S3ClientConfig = { region: opts.region, endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint };
  if (opts.accessKeyId && opts.secretAccessKey) config.credentials = { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey };
  return new S3Client(config);
}

/** Store one asset where and how the platform's media library would have: its bucket, its path, its headers, its URL. */
async function ingestS3(entry: AssetEntry, opts: S3StorageOptions, s3: Pick<S3Client, 'send'>): Promise<{ url: string; storagePath: string }> {
  if (!entry.localPath) throw new Error('downloaded asset has no local path');
  const media = platformMedia(entry);
  if (!media) throw new Error(`Documentation.AI media storage does not accept ${entry.contentType || 'this type'} (${extname(entry.localPath) || 'no extension'})`);
  const target = opts.buckets[media.storage];
  if (!target?.bucket || !target.publicBase) throw new Error(`no ${media.storage} bucket is configured for ${media.mimeType}: set ${STORAGE_ENV[media.storage]} and ${DELIVERY_ENV[media.storage]}`);
  const path = storagePath(opts.organizationId, opts.documentationId, storageFilename(entry, media.extension));
  await s3.send(new PutObjectCommand({ Bucket: target.bucket, Key: path, Body: readFileSync(entry.localPath), ContentType: media.mimeType, CacheControl: cacheControlFor(media.storage), Metadata: { sha256: entry.hash } }));
  return { url: platformPublicUrl(target.publicBase, path, media.storage), storagePath: path };
}

/** The project folders (`org-<id>/doc-<id>`) this migration's hosted assets are filed under, other than the given project's. Empty when everything is where it belongs. */
export function assetFoldersElsewhere(manifest: AssetManifest, organizationId: string, documentationId: string): string[] {
  const folder = storagePath(organizationId, documentationId, '');
  return [...new Set(Object.values(manifest.entries).filter((entry) => entry.status === 'ingested' && !!entry.storagePath && !entry.storagePath.startsWith(folder)).map((entry) => entry.storagePath!.split('/').slice(0, 2).join('/')))].sort();
}

/** Ingest downloaded assets idempotently and checkpoint after every object or batch. */
export async function ingestAssets(manifest: AssetManifest, options: AssetProviderOptions): Promise<AssetManifest> {
  manifest.provider = options.provider;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (options.provider === 'dai-api') {
    if (!options.dai) throw new Error('DAI API provider configuration is missing');
    await probeDaiMediaApi(options.dai, fetchImpl); // fail fast with the real reason, not one 401 per asset
  }
  if (options.provider === 'dai-mcp' && !options.mcp) throw new Error('dai-mcp provider needs a signed-in Authoring MCP session');
  if (options.provider === 's3' && !options.s3) throw new Error('S3 provider configuration is missing');
  let s3: Pick<S3Client, 'send'> | undefined = options.s3Client;
  // Platform storage is filed per project (`org-<id>/doc-<id>/…`): the media library lists a
  // project's folder, and deleting a project deletes it. An asset stored while this migration
  // pointed at another project is therefore stored again under the one it goes into now.
  const project = options.provider === 's3' ? options.s3 : options.provider === 'dai-mcp' ? options.mcp?.project : undefined;
  const folder = project ? storagePath(project.organizationId, project.documentationId, '') : undefined;
  const toPlatform: AssetEntry[] = [];
  for (const entry of Object.values(manifest.entries)) {
    const filedElsewhere = !!folder && entry.status === 'ingested' && !!entry.storagePath && !entry.storagePath.startsWith(folder);
    if (filedElsewhere && !entry.localPath) { entry.status = 'failed'; entry.error = `stored under another project (${entry.storagePath!.split('/').slice(0, 2).join('/')}) and the downloaded original is gone, so it cannot be stored again; run assets with --refresh`; continue; }
    if (entry.status === 'ingested' && !filedElsewhere) continue;
    if (entry.status === 'failed' && !entry.localPath) continue; // nothing to retry without bytes
    if (options.provider === 'none') { entry.status = 'kept-external'; continue; }
    if (options.provider === 'local') { if (entry.localPath) entry.status = 'downloaded'; continue; }
    if (!entry.localPath) continue;
    if (options.provider !== 's3') { toPlatform.push(entry); continue; }
    try {
      s3 ??= s3Client(options.s3!);
      const stored = await ingestS3(entry, options.s3!, s3);
      entry.finalUrl = stored.url;
      entry.storagePath = stored.storagePath;
      entry.status = 'ingested';
      entry.error = undefined;
    } catch (error) {
      entry.status = 'failed';
      entry.error = (error as Error).message;
    }
    writeManifest(options.workspace, manifest);
  }
  if (toPlatform.length) await ingestToPlatform(toPlatform, options, { fetchImpl, sleep, checkpoint: () => writeManifest(options.workspace, manifest) });
  writeManifest(options.workspace, manifest);
  return manifest;
}

const capturedSize = (entry: AssetEntry): number | undefined =>
  entry.bytes ?? (entry.localPath ? (() => { try { return statSync(entry.localPath!).size; } catch { return undefined; } })() : undefined);

/**
 * dai-api uploads the captured bytes. dai-mcp has the platform fetch each file from its public
 * address, and sends the bytes instead when there is none, the SVG was cleaned, or (exact mode) the
 * address now serves a different file; bytes need an API key, since a tool call cannot carry them.
 */
async function ingestToPlatform(
  entries: AssetEntry[],
  options: AssetProviderOptions,
  io: { fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>; checkpoint: () => void },
): Promise<void> {
  const exact = (options.fidelityMode ?? 'exact') === 'exact';
  const succeed = (entry: AssetEntry, url: string, note?: string) => {
    entry.finalUrl = url;
    entry.storagePath = storagePathFromUrl(url);
    entry.status = 'ingested';
    entry.error = undefined;
    entry.note = note;
  };
  const fail = (entry: AssetEntry, error: string) => { entry.status = 'failed'; entry.error = error; };
  const needBytes: Array<{ entry: AssetEntry; why: string }> = [];

  if (options.provider === 'dai-mcp') {
    const byUrl = entries.filter((entry) => importableUrl(entry));
    for (const entry of entries) if (!importableUrl(entry)) {
      needBytes.push({ entry, why: entry.sanitized ? 'the SVG was cleaned of unsafe content, so the copy the source serves is not the one to host' : 'it has no public https address the platform can fetch' });
    }
    await inBatches(byUrl, (batch) => importBatch(batch, options.mcp!), (entry, outcome) => {
      // the captured copy is still here, so a file the platform could not fetch can go as bytes
      if (!outcome.ok) { needBytes.push({ entry, why: `the platform could not fetch it: ${outcome.error}` }); return; }
      const expected = capturedSize(entry);
      if (expected === undefined || outcome.sizeBytes === undefined || expected === outcome.sizeBytes) { succeed(entry, outcome.url); return; }
      const difference = `the source now serves ${outcome.sizeBytes} bytes where ${expected} were captured`;
      if (exact) needBytes.push({ entry, why: `${difference}, so the imported copy is not the captured one (it stays in the library, unused)` });
      else succeed(entry, outcome.url, `${difference}; the source's current copy is hosted`);
    }, io);
  } else {
    needBytes.push(...entries.map((entry) => ({ entry, why: '' })));
  }

  if (!needBytes.length) return;
  if (!options.dai) {
    for (const { entry, why } of needBytes) fail(entry, `cannot host through a sign-in: ${why}. Uploading the captured file needs a project API key (DAI_API_KEY and DAI_API_BASE), or record that it stays where it is served today`);
    return;
  }
  await inBatches(needBytes.map(({ entry }) => entry), (batch) => uploadBatch(batch, options.dai!, io.fetchImpl), (entry, outcome) => {
    if (outcome.ok) succeed(entry, outcome.url); else fail(entry, outcome.error);
  }, io);
}
