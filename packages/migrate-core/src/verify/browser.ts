/**
 * Real rendered-fragment verification. Uses installed Chrome in headless mode
 * so client-rendered pages are tested, not just their server HTML.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GateResult } from './gates.js';
import { assertPublicHost } from '../scrape/fetcher.js';

const execFileAsync = promisify(execFile);

export interface BrowserAnchor {
  pageId: string;
  newId: string;
  oldId?: string;
  needsShim: boolean;
}

export interface BrowserPage {
  id: string;
  newPath?: string;
  migrate: boolean;
}

export type PageRenderer = (url: string) => Promise<string>;

export function findChrome(): string | undefined {
  const configured = process.env.CHROME_PATH;
  const candidates = [configured, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((x): x is string => !!x);
  return candidates.find(existsSync);
}

export async function chromeDump(url: string): Promise<string> {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found; set CHROME_PATH to a Chrome or Chromium binary');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('preview URL must use HTTP or HTTPS');
  const localPreview = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  // Pin the preview host to the address we validated and make every other hostname unresolvable,
  // so a redirect to another host (including link-local metadata endpoints) fails closed in Chrome.
  const resolverRules = localPreview && process.env.DAI_ALLOW_LOCAL_PREVIEW === '1'
    ? undefined
    : `MAP * ~NOTFOUND, MAP ${parsed.hostname} ${await assertPublicHost(parsed)}`;
  const profile = mkdtempSync(join(tmpdir(), 'dai-chrome-profile-'));
  try {
    const { stdout } = await execFileAsync(chrome, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
      '--disable-sync', '--no-first-run', '--incognito', `--user-data-dir=${profile}`,
      ...(resolverRules ? [`--host-resolver-rules=${resolverRules}`] : []),
      '--dump-dom', parsed.toString(),
    ], { timeout: 45_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

function routeUrl(base: string, path: string): string {
  const u = new URL(base);
  u.hash = '';
  u.search = '';
  u.pathname = `${u.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  return u.toString();
}

function hasAnchor(html: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"'])(?:id|name)=["']${escaped}["']`).test(html);
}

export async function runBrowserFragmentGate(
  previewUrl: string,
  pages: BrowserPage[],
  anchors: BrowserAnchor[],
  render: PageRenderer = chromeDump,
): Promise<GateResult> {
  const byId = new Map(pages.filter((p) => p.migrate && p.newPath).map((p) => [p.id, p.newPath!]));
  const required = new Map<string, Set<string>>();
  for (const anchor of anchors) {
    const path = byId.get(anchor.pageId);
    if (!path) continue;
    if (!required.has(path)) required.set(path, new Set());
    if (anchor.newId) required.get(path)!.add(anchor.newId);
    if (anchor.needsShim && anchor.oldId) required.get(path)!.add(anchor.oldId);
  }
  if (!required.size) {
    const first = pages.find((p) => p.migrate && p.newPath)?.newPath ?? '';
    required.set(first, new Set());
  }

  let missing = 0;
  const samples: string[] = [];
  for (const [path, ids] of required) {
    const url = routeUrl(previewUrl, path);
    let html: string;
    try {
      html = await render(url);
      if (!/<html\b/i.test(html)) throw new Error('rendered output is not an HTML document');
    } catch (error) {
      missing += Math.max(1, ids.size);
      if (samples.length < 8) samples.push(`${path || '/'}: browser load failed: ${(error as Error).message}`);
      continue;
    }
    for (const id of ids) {
      if (!hasAnchor(html, id)) {
        missing++;
        if (samples.length < 8) samples.push(`${path}#${id}`);
      }
    }
  }
  return {
    id: 'browser-fragments',
    status: missing ? 'fail' : 'pass',
    detail: `${missing} required rendered fragments missing across ${required.size} preview pages`,
    count: missing,
    samples,
  };
}
