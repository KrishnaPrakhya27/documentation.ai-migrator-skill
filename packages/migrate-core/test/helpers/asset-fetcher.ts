/**
 * Offline stand-in for asset CDNs: answers every host with synthetic media
 * bytes chosen by the URL's extension, an allow-all robots policy, and
 * configurable failures, so asset collection can be proven without the
 * network. Inject through `new Fetcher({ fetchImpl, lookup })`; the Fetcher's
 * SSRF guard, robots policy and redirect handling still run in front of it.
 */
import { Response, type RequestInfo } from 'undici';
import type { FetchImpl, HostLookup } from '../../src/scrape/fetcher.js';

export interface ServedMedia { body: Uint8Array; contentType: string }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MP4_FTYP_BOX = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
const SVG_DOCUMENT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" /></svg>\n', 'utf8');

/** Bytes served per extension; every URL of one extension yields the same bytes, which is what hash dedupe must cope with. */
export const SYNTHETIC_MEDIA: Record<string, ServedMedia> = {
  '.png': { body: PNG_SIGNATURE, contentType: 'image/png' },
  '.mp4': { body: MP4_FTYP_BOX, contentType: 'video/mp4' },
  '.svg': { body: SVG_DOCUMENT, contentType: 'image/svg+xml' },
};

export interface AssetServerSpec {
  /** URLs answered with this HTTP status instead of media. */
  failing?: Record<string, number>;
  /** URLs answered 200 with an HTML body, the way a CDN error page or a login wall does. */
  htmlAt?: string[];
  /** Distinct bytes per URL when hash dedupe must not merge two files; defaults to the per-extension bytes. */
  distinctBytes?: boolean;
}

export interface AssetServer {
  readonly fetch: FetchImpl;
  /** Every requested URL in request order. */
  readonly requests: string[];
}

function requestedUrl(input: RequestInfo): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function extensionOf(url: URL): string {
  const match = url.pathname.match(/\.[A-Za-z0-9]+$/);
  return match ? match[0].toLowerCase() : '';
}

export function syntheticAssetFetcher(spec: AssetServerSpec = {}): AssetServer {
  const requests: string[] = [];
  const fetch: FetchImpl = async (input) => {
    const url = new URL(requestedUrl(input));
    requests.push(url.href);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
    const failure = spec.failing?.[url.href];
    if (failure) return new Response('failed', { status: failure, headers: { 'content-type': 'text/plain' } });
    if (spec.htmlAt?.includes(url.href)) return new Response('<!DOCTYPE html><html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const media = SYNTHETIC_MEDIA[extensionOf(url)];
    if (!media) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = spec.distinctBytes ? Buffer.concat([Buffer.from(media.body), Buffer.from(url.href, 'utf8')]) : media.body;
    return new Response(body, { status: 200, headers: { 'content-type': media.contentType } });
  };
  return { fetch, requests };
}

/** Resolves every host to a public address so the Fetcher's SSRF guard passes without DNS. */
export const offlineHostLookup: HostLookup = async () => [{ address: '8.8.8.8', family: 4 }];
