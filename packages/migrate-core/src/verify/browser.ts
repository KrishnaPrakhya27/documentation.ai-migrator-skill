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
import { find, parseHtml, type Dom } from '../ir/from-html.js';
import { inlineText, walkBlocks, type DocIR } from '../ir/types.js';

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

/**
 * Chrome host-resolver rules that pin the preview host to a validated address and make every
 * other hostname unresolvable. Chrome applies the first matching rule, so the pin must come
 * before the wildcard; wildcard-first sends the preview host itself to NOTFOUND.
 */
export function pinnedResolverRules(hostname: string, address: string): string {
  return `MAP ${hostname} ${address}, MAP * ~NOTFOUND`;
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
    : pinnedResolverRules(parsed.hostname, await assertPublicHost(parsed));
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
      // Chrome's own error document is still HTML; scanning it would report every anchor as missing
      if (/<body[^>]*\bclass=["'][^"']*\bneterror\b/i.test(html) || /\bid=["']main-frame-error["']/i.test(html)) {
        throw new Error('Chrome showed its network error page instead of the preview; check host resolution and connectivity');
      }
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

function visibleText(node: Dom): string {
  if (node.type === 'text') return node.data;
  if (['script', 'style', 'noscript', 'nav', 'aside', 'footer', 'button'].includes(node.name) || node.attribs['aria-hidden'] === 'true') return '';
  return node.children.map(visibleText).join(' ');
}

function normaliseVisible(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Every authored text segment must appear in the rendered preview, in source order. */
export async function runBrowserContentGate(
  previewUrl: string,
  pages: Array<BrowserPage & { doc?: DocIR }>,
  render: PageRenderer = chromeDump,
): Promise<GateResult> {
  let failures = 0; const samples: string[] = []; let checked = 0;
  for (const page of pages.filter((entry) => entry.migrate && entry.newPath && entry.doc)) {
    checked++;
    let html: string;
    try {
      html = await render(routeUrl(previewUrl, page.newPath!));
      if (!/<html\b/i.test(html) || /<body[^>]*\bclass=["'][^"']*\bneterror\b/i.test(html) || /\bid=["']main-frame-error["']/i.test(html)) throw new Error('preview did not render a valid page');
    }
    catch (error) { failures++; if (samples.length < 8) samples.push(`${page.newPath}: browser load failed: ${(error as Error).message}`); continue; }
    const root = parseHtml(html);
    const scope = find(root, 'article') ?? find(root, 'main') ?? find(root, '[role=main]') ?? find(root, 'body') ?? root;
    const rendered = normaliseVisible(visibleText(scope));
    const segments: string[] = [];
    for (const value of [page.doc!.frontmatter.title, page.doc!.frontmatter.description]) if (typeof value === 'string' && normaliseVisible(value)) segments.push(normaliseVisible(value));
    walkBlocks(page.doc!.children, (block) => {
      if (block.type === 'paragraph' || block.type === 'heading') { const value = normaliseVisible(inlineText(block.children)); if (value) segments.push(value); }
      else if (block.type === 'code') { const value = normaliseVisible(block.value); if (value) segments.push(value); }
      else if (block.type === 'table') for (const row of block.children) for (const cell of row.children) { const value = normaliseVisible(inlineText(cell.children)); if (value) segments.push(value); }
      else if (block.type === 'component' || block.type === 'dai') for (const key of ['title', 'summary', 'description', 'label']) { const value = block.props[key]; if (typeof value === 'string' && normaliseVisible(value)) segments.push(normaliseVisible(value)); }
      else if (block.type === 'image' && block.alt) segments.push(normaliseVisible(block.alt));
      else if (block.type === 'figure' && block.image.alt) segments.push(normaliseVisible(block.image.alt));
    });
    let cursor = 0;
    for (const segment of segments) {
      const index = rendered.indexOf(segment, cursor);
      if (index < 0) { failures++; if (samples.length < 8) samples.push(`${page.newPath}: missing/out-of-order “${segment.slice(0, 80)}”`); }
      else cursor = index + segment.length;
    }
  }
  return { id: 'browser-content', status: failures ? 'fail' : 'pass', detail: `${failures} authored text segments missing or out of order across ${checked} rendered preview pages`, count: failures, samples };
}
