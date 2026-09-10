/**
 * Offline stand-ins for the network: a fetch implementation that serves the
 * externally stored raw source of the demo site, and one that serves a small
 * in-memory site for unit tests. Both record every requested URL so a test can
 * prove which resources a stage touched. Inject them through
 * `new Fetcher({ fetchImpl })`; the Fetcher's host allowlist, robots policy and
 * redirect handling still run in front of them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Response, type RequestInfo } from 'undici';
import { Fetcher, type FetchImpl, type FetchOptions, type HostLookup } from '../../src/scrape/fetcher.js';
import { assertSourceTruthLayout, resolveSourceTruthDir } from './source-truth.js';

/** Host the demo site is browsed on; truth.json records page URLs here. */
export const FIXTURE_SITE_ORIGIN = 'https://demo-6782454b.mintlify.site';
/** Host that robots.txt, sitemap.xml and llms.txt point at; the same site is served there. */
export const FIXTURE_APP_ORIGIN = 'https://demo-6782454b.mintlify.app';

export interface RecordingFetcher {
  readonly fetch: FetchImpl;
  /** Every requested URL in request order, including those answered 404. */
  readonly requests: string[];
}

export interface ServedResource { body: string | Uint8Array; contentType: string }

export interface SyntheticPage { html?: string; md?: string }

export interface SyntheticSiteSpec {
  host: string;
  /** Further hosts serving the same site, the way a platform pairs `<slug>.mintlify.site` with `<slug>.mintlify.app`. */
  aliasHosts?: string[];
  /** Keyed by page path (`/`, `/guides/setup`); the published Markdown of `/` is served at `/index.md`. */
  pages: Record<string, SyntheticPage>;
  llmsTxt?: string;
  llmsFullTxt?: string;
  robotsTxt?: string;
  sitemapXml?: string;
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  xml: 'application/xml',
} as const;

const ROOT_DOCUMENTS = new Set(['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt']);
const FIXTURE_HOSTS = new Set([FIXTURE_SITE_ORIGIN, FIXTURE_APP_ORIGIN].map((origin) => new URL(origin).hostname));

function requestedUrl(input: RequestInfo): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Resolves every host to one public address so the Fetcher's SSRF check passes without DNS; only meaningful next to an injected fetchImpl. */
export const offlineHostLookup: HostLookup = async () => [{ address: '8.8.8.8', family: 4 }];

/** A Fetcher wired to a recording fetch implementation: no DNS, no network, no rate limiting; the allowlist and robots policy still apply. */
export function offlineFetcher(recording: RecordingFetcher, options: Omit<FetchOptions, 'fetchImpl' | 'lookup'>): Fetcher {
  return new Fetcher({ rps: 1000, ...options, fetchImpl: recording.fetch, lookup: offlineHostLookup });
}

function recordingFetcher(serve: (url: URL) => ServedResource | undefined): RecordingFetcher {
  const requests: string[] = [];
  const fetch: FetchImpl = async (input) => {
    const url = new URL(requestedUrl(input));
    requests.push(url.href);
    const resource = serve(url);
    if (!resource) return new Response('not found', { status: 404, headers: { 'content-type': CONTENT_TYPES.text } });
    return new Response(resource.body, { status: 200, headers: { 'content-type': resource.contentType } });
  };
  return { fetch, requests };
}

/** Decoded path segments, or undefined when a segment could escape the layout directory or names nothing. */
function pathSegments(pathname: string): string[] | undefined {
  const segments: string[] = [];
  for (const raw of pathname.split('/').slice(1)) {
    let segment: string;
    try { segment = decodeURIComponent(raw); } catch { return undefined; }
    if (segment === '' || segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) return undefined;
    segments.push(segment);
  }
  return segments;
}

/** File inside the saved layout that answers a request path: `/` → html/index.html, `/a/b.md` → md/a/b.md, `/a/b` → html/a/b.html. */
function layoutFile(pathname: string): string | undefined {
  if (pathname === '/') return 'html/index.html';
  const segments = pathSegments(pathname);
  if (!segments) return undefined;
  if (segments.length === 1 && ROOT_DOCUMENTS.has(segments[0])) return segments[0];
  const relative = segments.join('/');
  return relative.endsWith('.md') ? `md/${relative}` : `html/${relative}.html`;
}

function contentTypeForFile(relative: string): string {
  if (relative.endsWith('.html')) return CONTENT_TYPES.html;
  if (relative.endsWith('.md')) return CONTENT_TYPES.markdown;
  if (relative.endsWith('.xml')) return CONTENT_TYPES.xml;
  return CONTENT_TYPES.text;
}

/** Serves the saved raw source of the demo site under both of its hosts; everything else is 404. */
export function fixtureFetcher(dir: string = resolveSourceTruthDir()): RecordingFetcher {
  assertSourceTruthLayout(dir);
  return recordingFetcher((url) => {
    if (!FIXTURE_HOSTS.has(url.hostname)) return undefined;
    const relative = layoutFile(url.pathname);
    if (!relative) return undefined;
    const file = join(dir, relative);
    if (!existsSync(file) || !statSync(file).isFile()) return undefined;
    return { body: readFileSync(file), contentType: contentTypeForFile(relative) };
  });
}

function pagePathOfMarkdown(pathname: string): string {
  const withoutExtension = pathname.slice(0, -'.md'.length);
  return withoutExtension === '/index' ? '/' : withoutExtension;
}

function optionalDocument(body: string | undefined, contentType: string): ServedResource | undefined {
  return body === undefined ? undefined : { body, contentType };
}

/** Serves a small in-memory site for unit tests with the same routing and recording as fixtureFetcher. */
export function syntheticSiteFetcher(spec: SyntheticSiteSpec): RecordingFetcher {
  const hosts = new Set([spec.host, ...(spec.aliasHosts ?? [])].map((host) => host.toLowerCase()));
  const rootDocuments = new Map<string, ServedResource | undefined>([
    ['/robots.txt', optionalDocument(spec.robotsTxt, CONTENT_TYPES.text)],
    ['/sitemap.xml', optionalDocument(spec.sitemapXml, CONTENT_TYPES.xml)],
    ['/llms.txt', optionalDocument(spec.llmsTxt, CONTENT_TYPES.text)],
    ['/llms-full.txt', optionalDocument(spec.llmsFullTxt, CONTENT_TYPES.text)],
  ]);
  return recordingFetcher((url) => {
    if (!hosts.has(url.hostname)) return undefined;
    if (rootDocuments.has(url.pathname)) return rootDocuments.get(url.pathname);
    if (url.pathname.endsWith('.md')) return optionalDocument(spec.pages[pagePathOfMarkdown(url.pathname)]?.md, CONTENT_TYPES.markdown);
    return optionalDocument(spec.pages[url.pathname]?.html, CONTENT_TYPES.html);
  });
}
