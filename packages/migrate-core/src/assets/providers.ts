import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { AssetEntry, AssetManifest } from './manifest.js';
import { writeManifest } from './manifest.js';

export interface AssetProviderOptions {
  workspace: string;
  provider: 'none' | 'local' | 's3' | 'dai-api';
  s3?: { bucket: string; region: string; prefix?: string; publicBase: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string };
  /**
   * Documentation.AI API-key media surface: `<baseUrl>/api/v1/media/{upload-url,confirm}` plus `GET /api/v1/media?search=`.
   * The key is bound to one documentation, so no org or documentation id is needed. The dashboard's
   * `/organizations/:org/documentation/:doc/images` routes accept sessions only and are never used here.
   */
  dai?: { baseUrl: string; token: string };
  fetchImpl?: typeof fetch;
  s3Client?: Pick<S3Client, 'send'>;
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

async function ingestS3(entry: AssetEntry, opts: NonNullable<AssetProviderOptions['s3']>, client?: Pick<S3Client, 'send'>): Promise<string> {
  if (!entry.localPath) throw new Error('downloaded asset has no local path');
  const config: S3ClientConfig = { region: opts.region, endpoint: opts.endpoint, forcePathStyle: !!opts.endpoint };
  if (opts.accessKeyId && opts.secretAccessKey) config.credentials = { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey };
  const s3 = client ?? new S3Client(config);
  const key = [opts.prefix?.replace(/^\/+|\/+$/g, ''), filename(entry)].filter(Boolean).join('/');
  await s3.send(new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: readFileSync(entry.localPath), ContentType: entry.contentType, CacheControl: 'public,max-age=31536000,immutable', Metadata: { sha256: entry.hash } }));
  return `${opts.publicBase.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Ingest downloaded assets idempotently and checkpoint after every object. */
export async function ingestAssets(manifest: AssetManifest, options: AssetProviderOptions): Promise<AssetManifest> {
  manifest.provider = options.provider;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.provider === 'dai-api') {
    if (!options.dai) throw new Error('DAI API provider configuration is missing');
    await probeDaiMediaApi(options.dai, fetchImpl); // fail fast with the real reason, not one 401 per asset
  }
  for (const entry of Object.values(manifest.entries)) {
    if (entry.status === 'ingested') continue;
    if (entry.status === 'failed' && !entry.localPath) continue; // nothing to retry without bytes
    if (options.provider === 'none') { entry.status = 'kept-external'; continue; }
    if (options.provider === 'local') { if (entry.localPath) entry.status = 'downloaded'; continue; }
    if (!entry.localPath) continue;
    try {
      entry.finalUrl = options.provider === 's3'
        ? await ingestS3(entry, options.s3 ?? (() => { throw new Error('S3 provider configuration is missing'); })(), options.s3Client)
        : await ingestDai(entry, options.dai ?? (() => { throw new Error('DAI API provider configuration is missing'); })(), fetchImpl);
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
