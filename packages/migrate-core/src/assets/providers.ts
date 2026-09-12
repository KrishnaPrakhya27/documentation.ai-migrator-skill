import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AssetEntry, AssetManifest } from './manifest.js';
import { writeManifest } from './manifest.js';

export interface AssetProviderOptions {
  workspace: string;
  provider: 'none' | 'local' | 's3' | 'dai-api';
  /** Documentation.AI media storage on S3-compatible buckets (R2), written in the layout its media library reads. */
  s3?: S3StorageOptions;
  /**
   * Documentation.AI API-key media surface: `<baseUrl>/api/v1/media/{upload-url,confirm}` plus `GET /api/v1/media?search=`.
   * The key is bound to one documentation, so no org or documentation id is needed. The dashboard's
   * `/organizations/:org/documentation/:doc/images` routes accept sessions only and are never used here.
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

function filename(entry: AssetEntry): string {
  const ext = entry.localPath ? extname(entry.localPath) : '';
  return `${entry.hash}${ext || '.bin'}`;
}

async function responseJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${context} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function existingDaiAsset(api: string, headers: Record<string, string>, entry: AssetEntry, fetchImpl: typeof fetch): Promise<string | undefined> {
  const res = await fetchImpl(`${api}?search=${encodeURIComponent(filename(entry))}&limit=100`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return undefined;
  const body = await res.json() as { images?: Array<{ fileHash?: string; publicUrl?: string }> };
  return body.images?.find((image) => image.fileHash === entry.hash)?.publicUrl;
}

export function mediaApi(baseUrl: string): string { return `${baseUrl.replace(/\/$/, '')}/api/v1/media`; }

export class MediaApiUnavailable extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(status === 401 || status === 403
      ? `the Documentation.AI media API rejected the API key (${status}) at ${url}. The platform's media routes currently accept dashboard sessions only; API-key media upload is a platform dependency (G7). Use --provider s3 or --provider none until it ships.`
      : status === 404
        ? `the Documentation.AI media API is not available at ${url} (404). API-key media upload is a platform dependency (G7); use --provider s3 or --provider none until it ships.`
        : `the Documentation.AI media API answered ${status} at ${url}`);
  }
}

/** One authenticated call before any asset is touched: proves the key can drive the media surface at all. */
export async function probeDaiMediaApi(opts: NonNullable<AssetProviderOptions['dai']>, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${mediaApi(opts.baseUrl)}?limit=1`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new MediaApiUnavailable(res.status, url);
}

async function ingestDai(entry: AssetEntry, opts: NonNullable<AssetProviderOptions['dai']>, fetchImpl: typeof fetch): Promise<string> {
  if (!entry.localPath) throw new Error('downloaded asset has no local path');
  const api = mediaApi(opts.baseUrl);
  const auth = { authorization: `Bearer ${opts.token}` };
  const jsonHeaders = { ...auth, 'content-type': 'application/json' };
  const bytes = readFileSync(entry.localPath);
  const name = filename(entry);
  const mimeType = (entry.contentType || 'application/octet-stream').split(';')[0];
  const presignRes = await fetchImpl(`${api}/upload-url`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ filename: name, mimeType, fileSize: bytes.length }), signal: AbortSignal.timeout(30_000) });
  if (presignRes.status === 409) {
    const found = await existingDaiAsset(api, auth, entry, fetchImpl);
    if (found) return found;
  }
  const presign = await responseJson<{ uploadUrl: string; storagePath: string; cacheControl?: string }>(presignRes, 'DAI upload-url');
  const put = await fetchImpl(presign.uploadUrl, { method: 'PUT', headers: { 'content-type': mimeType, ...(presign.cacheControl ? { 'cache-control': presign.cacheControl } : {}) }, body: bytes, signal: AbortSignal.timeout(120_000) });
  if (!put.ok) throw new Error(`DAI signed upload returned HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`);
  const confirm = await responseJson<{ image: { publicUrl: string } }>(await fetchImpl(`${api}/confirm`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ storagePath: presign.storagePath, originalName: name, metadata: { fileSize: bytes.length } }), signal: AbortSignal.timeout(60_000) }), 'DAI confirm');
  if (!confirm.image?.publicUrl) throw new Error('DAI confirm response has no publicUrl');
  return confirm.image.publicUrl;
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

/** Ingest downloaded assets idempotently and checkpoint after every object. */
export async function ingestAssets(manifest: AssetManifest, options: AssetProviderOptions): Promise<AssetManifest> {
  manifest.provider = options.provider;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.provider === 'dai-api') {
    if (!options.dai) throw new Error('DAI API provider configuration is missing');
    await probeDaiMediaApi(options.dai, fetchImpl); // fail fast with the real reason, not one 401 per asset
  }
  if (options.provider === 's3' && !options.s3) throw new Error('S3 provider configuration is missing');
  let s3: Pick<S3Client, 'send'> | undefined = options.s3Client;
  for (const entry of Object.values(manifest.entries)) {
    if (entry.status === 'ingested') continue;
    if (entry.status === 'failed' && !entry.localPath) continue; // nothing to retry without bytes
    if (options.provider === 'none') { entry.status = 'kept-external'; continue; }
    if (options.provider === 'local') { if (entry.localPath) entry.status = 'downloaded'; continue; }
    if (!entry.localPath) continue;
    try {
      if (options.provider === 's3') {
        s3 ??= s3Client(options.s3!);
        const stored = await ingestS3(entry, options.s3!, s3);
        entry.finalUrl = stored.url;
        entry.storagePath = stored.storagePath;
      } else {
        entry.finalUrl = await ingestDai(entry, options.dai ?? (() => { throw new Error('DAI API provider configuration is missing'); })(), fetchImpl);
      }
      entry.status = 'ingested';
      entry.error = undefined;
    } catch (error) {
      entry.status = 'failed';
      entry.error = (error as Error).message;
    }
    writeManifest(options.workspace, manifest);
  }
  writeManifest(options.workspace, manifest);
  return manifest;
}
