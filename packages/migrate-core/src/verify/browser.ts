/**
 * Real rendered-fragment verification. Uses installed Chrome in headless mode
 * so client-rendered pages are tested, not just their server HTML.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isHtmlChromeNode, type GateResult } from './gates.js';
import { assertPublicHost } from '../scrape/fetcher.js';
import { find, findAll, parseHtml, type Dom } from '../ir/from-html.js';
import { inlineText, walkBlocks, type Block, type DocIR, type Inline } from '../ir/types.js';
import { mapConcurrentOrdered } from './concurrency.js';

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

/** The preview URL of a written route; shared with the responsive check so both measure the same page. */
export function routeUrl(base: string, path: string): string {
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
  concurrency = 4,
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

  const checked = await mapConcurrentOrdered([...required], concurrency, async ([path, ids]) => {
    let missing = 0;
    const samples: string[] = [];
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
      return { missing, samples };
    }
    for (const id of ids) {
      if (!hasAnchor(html, id)) {
        missing++;
        if (samples.length < 8) samples.push(`${path}#${id}`);
      }
    }
    return { missing, samples };
  });
  const missing = checked.reduce((total, result) => total + result.missing, 0);
  const samples = checked.flatMap((result) => result.samples).slice(0, 8);
  return {
    id: 'browser-fragments',
    status: missing ? 'fail' : 'pass',
    detail: `${missing} required rendered fragments missing across ${required.size} preview pages`,
    count: missing,
    samples,
  };
}

/** Elements whose boundaries are line breaks for a reader, so text either side must not glue together. */
const BLOCK_ELEMENTS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dd', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const INVISIBLE_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/**
 * The text a reader sees, concatenated exactly as the browser lays it out: no separator
 * between inline nodes, a newline at block boundaries. Joining every child with a space
 * (the previous behaviour) inserted spaces inside words split by inline markup, so a
 * paragraph containing a link before punctuation could never be found in the source.
 */
export function visibleText(node: Dom): string {
  if (node.type === 'text') return node.data;
  if (node.type !== 'tag') return '';
  if (INVISIBLE_ELEMENTS.has(node.name) || node.attribs['aria-hidden'] === 'true' || node.attribs.hidden !== undefined) return '';
  const inner = node.children.map(visibleText).join('');
  return BLOCK_ELEMENTS.has(node.name) ? `\n${inner}\n` : inner;
}

function normaliseVisible(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\u200b/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** One rendered route, judged against the source it was migrated from. */
export interface PreviewRouteResult {
  route: string;
  status: 'pass' | 'fail';
  problems: string[];
  /** Rendered article text that no source segment accounts for, after the platform's own chrome is allowed. */
  residual?: string;
}

/** Ordered sidebar the preview must render: group labels outermost first, then the page labels under each. */
export interface ExpectedNavigationEntry { groupPath: string[]; label: string }

export interface BrowserContentOptions {
  render?: PageRenderer;
  /** Strings the target platform renders inside the article itself (copy buttons and the like). Anything else left over fails. */
  previewChrome?: string[];
  /** Routes the migration wrote, so an internal link that resolves to nothing fails. */
  routes?: ReadonlySet<string>;
  /** Final hosted URL per original asset URL; an image still pointing at the source host fails. */
  assetUrls?: ReadonlyMap<string, string>;
  /** The sidebar the source states, in order, including a page placed in more than one group. */
  navigation?: ExpectedNavigationEntry[];
  /** Selector for the rendered navigation; the check is skipped, and reported, when the target platform declares none. */
  navSelector?: string;
  siteName?: string;
  /** Selectors of the rendered page's own content (title, description, body), in page order; the platform chrome around them is not read. Default: the whole article. */
  contentSelectors?: string[];
  /** The renderer opened every accordion, expandable and tab before reading the DOM, so their content is verified rather than excused. */
  interactive?: boolean;
  /** Number of routes inspected concurrently; output ordering remains source ordering. */
  concurrency?: number;
}

const DEFAULT_PREVIEW_CHROME = ['copy', 'copied', 'copy to clipboard', 'ask ai', 'on this page', 'edit this page', 'was this page helpful?', 'yes', 'no', 'previous', 'next'];
/** What remains between matched segments that carries no information: punctuation, list markers, digits from generated numbering. */
const INSIGNIFICANT_RESIDUAL = /^[\s\p{P}\p{S}\d]*$/u;

/** Components whose content mounts only when a reader opens them, so a static render does not contain it. */
const COLLAPSED_BY_DEFAULT = new Set(['details', 'expandable', 'accordion']);

/** Blocks a static render cannot show: the content of a collapsed block, and platform chrome the migration dropped (a GitBook assistant prompt). */
function unrenderedBlockIds(doc: DocIR, interactive = false): Set<string> {
  // A run that opens what a reader can open has no excuse to offer: the content of a collapsed
  // block is on the page, so it is compared like everything else.
  if (interactive) return new Set<string>();
  const ids = new Set<string>();
  walkBlocks(doc.children, (block) => {
    if (block.type !== 'component' && block.type !== 'dai') return;
    if (isHtmlChromeNode(block)) { ids.add(block.id); walkBlocks(block.children, (inner) => { ids.add(inner.id); }); }
    else if (COLLAPSED_BY_DEFAULT.has(block.name.toLowerCase()) && block.props.defaultOpen !== true) walkBlocks(block.children, (inner) => { ids.add(inner.id); });
  });
  return ids;
}

/**
 * Where an image the page authored now lives.
 *
 * A page writes its images the way its author did — `../../Resources/Images/x.png` — while the
 * asset manifest keys them by the address they were fetched from. Looking the raw reference up in
 * that manifest finds nothing, and the check then compares the rendered image against a relative
 * path it can never equal, which failed 323 of 428 routes whose images were hosted correctly.
 * Resolving the reference against the page it appears on asks the manifest the question it answers.
 */
export function hostedAssetUrl(ref: string, pageSource: string | undefined, assetUrls: ReadonlyMap<string, string>): string | undefined {
  const direct = assetUrls.get(ref);
  if (direct) return direct;
  if (!pageSource) return undefined;
  for (const candidate of resolvedSpellings(ref, pageSource)) {
    const hosted = assetUrls.get(candidate);
    if (hosted) return hosted;
  }
  return undefined;
}

/** The spellings one reference can have once resolved: as written, and with its escapes read. */
function resolvedSpellings(ref: string, pageSource: string): string[] {
  const out: string[] = [];
  const add = (value: string | undefined): void => { if (value && !out.includes(value)) out.push(value); };
  try { add(new URL(ref, pageSource).toString()); } catch { /* not resolvable against this page */ }
  try { add(new URL(decodeURI(ref), pageSource).toString()); } catch { /* the reference is not valid escaped text */ }
  try { add(decodeURI(new URL(ref, pageSource).toString())); } catch { /* nothing more to try */ }
  return out;
}

interface DocumentSegment { text: string; optional: boolean }

/**
 * The authored segments of a document, in reading order: what the preview must show and nothing more.
 * Text inside a collapsed block may be absent from a static render, so it is optional; a tab set renders
 * every tab label before its panels, so its titles come first; dropped platform chrome is not content.
 */
/**
 * Inline text as the reader sees it. `inlineText` drops an inline HTML element, which is right for
 * a title but not for comparing against a rendered page: the source writes
 * `stores <u>prior to ingest</u>, auto-mapping`, the reader sees those words, and expecting the
 * text either side of them to be adjacent reported a page that was perfectly correct.
 */
function renderedInlineText(nodes: Inline[] | undefined): string {
  if (!nodes) return '';
  return nodes.map((node) => {
    switch (node.type) {
      case 'text': case 'inlineCode': return node.value;
      case 'inlineHtml': return node.value.replace(/<[^>]*>/g, '');
      case 'break': return '\n';
      case 'image': return node.alt;
      case 'footnoteReference': return '';
      default: return renderedInlineText((node as { children?: Inline[] }).children);
    }
  }).join('');
}

function documentSegments(doc: DocIR, interactive = false): DocumentSegment[] {
  const segments: DocumentSegment[] = [];
  const unrendered = unrenderedBlockIds(doc, interactive);
  const push = (value: string | undefined, optional: boolean) => { const text = normaliseVisible(value ?? ''); if (text) segments.push({ text, optional }); };
  const visit = (blocks: Block[]): void => {
    for (const block of blocks) {
      if (isHtmlChromeNode(block)) continue;
      const optional = unrendered.has(block.id);
      switch (block.type) {
        case 'paragraph': case 'heading': push(renderedInlineText(block.children), optional); break;
        // a mermaid fence renders as a diagram, not as its source text
        case 'code': push(block.value, optional || block.lang === 'mermaid'); break;
        case 'table': for (const row of block.children) for (const cell of row.children) push(renderedInlineText(cell.children), optional); break;
        // Image alt text is not rendered text; it is compared attribute to attribute below.
        case 'figure': if (block.caption) push(inlineText(block.caption), optional); break;
        case 'blockquote': visit(block.children); break;
        case 'list': for (const item of block.children) visit(item.children); break;
        case 'snippetRef': visit(block.body ?? []); break;
        case 'component': case 'dai': {
          for (const key of ['title', 'summary', 'description', 'label', 'cta']) { const value = block.props[key]; if (typeof value === 'string') push(value, optional); }
          // an API field renders its location badge, name and type above its description, and its allowed values below it
          const apiField = /^(?:paramfield|responsefield|api-param|api-field)$/.test(block.name.toLowerCase());
          if (apiField) {
            for (const key of ['path', 'query', 'header', 'body', 'name', 'param-type', 'field-type']) {
              const value = block.props[key];
              if (typeof value !== 'string') continue;
              if (key !== 'name' && !key.endsWith('-type')) push(key, true);
              push(value, true);
            }
          }
          // an embed the target cannot frame shows its URL as link text; one it frames shows none
          if (block.name.toLowerCase() === 'embed') for (const key of ['src', 'url']) { const value = block.props[key]; if (typeof value === 'string') push(value, true); }
          if (block.name.toLowerCase() !== 'tabs') {
            visit(block.children);
            if (apiField && typeof block.props.enum === 'string') { push('allowed values:', true); for (const value of block.props.enum.split(',')) push(value, true); }
            break;
          }
          for (const tab of block.children) if ((tab.type === 'component' || tab.type === 'dai') && typeof tab.props.title === 'string') push(tab.props.title, optional);
          for (const tab of block.children) visit(tab.type === 'component' || tab.type === 'dai' ? tab.children : [tab]);
          break;
        }
      }
    }
  };
  push(doc.frontmatter.title, false);
  push(doc.frontmatter.description, false);
  visit(doc.children);
  return segments;
}

/** Heading outline of a document, ignoring the H1 the target renders from the title. A step's leading heading renders as its Step title, at h2 or h3. */
function sourceOutline(doc: DocIR, interactive = false): string[] {
  const out: string[] = [];
  const unrendered = unrenderedBlockIds(doc, interactive);
  const stepTitles = new Set<string>();
  walkBlocks(doc.children, (block) => {
    if (block.type === 'component' && block.name.toLowerCase() === 'step' && !block.props.title && block.children[0]?.type === 'heading') stepTitles.add(block.children[0].id);
  });
  walkBlocks(doc.children, (block) => {
    if (block.type !== 'heading' || block.depth <= 1 || unrendered.has(block.id)) return;
    const depth = stepTitles.has(block.id) ? Math.min(Math.max(block.depth, 2), 3) : block.depth;
    out.push(`${depth}:${normaliseVisible(inlineText(block.children))}`);
  });
  return out;
}

/**
 * Every inline node in a tree, including the ones nested inside a link, emphasis or other wrapper.
 * Reading only the direct children missed an image inside a link and a link inside emphasis, and
 * reported both as content the source never stated.
 */
function inlineNodes(nodes: readonly Inline[]): Inline[] {
  return nodes.flatMap((node) => {
    const children = (node as { children?: Inline[] }).children;
    return Array.isArray(children) ? [node, ...inlineNodes(children)] : [node];
  });
}

function sourceLinkTargets(doc: DocIR): Set<string> {
  const urls = new Set<string>();
  // A link the source writes relative to the page it sits on is the same link however it is
  // written: `../../../../Admin_Shadow/x.htm` on /Procedures/Admin/Manage/archive/y.htm and
  // https://host/Admin_Shadow/x.htm name one target. The migration writes the absolute form
  // wherever the operator declared the source site stays up, so both forms are the source's.
  const add = (url: string): void => {
    urls.add(url);
    if (url.startsWith('#')) return;
    // A URL is compared as a URL, not as text. A space in a source path is %20 once a browser has
    // read the link, and a link written relative to the page it sits on names the same target as
    // its absolute form: both are the source's own statement of where it points.
    try { urls.add(new URL(url, doc.source).toString()); } catch { /* not a URL this page can resolve */ }
  };
  walkBlocks(doc.children, (block) => {
    if (block.type === 'paragraph' || block.type === 'heading') { for (const inline of inlineNodes(block.children)) if (inline.type === 'link') add(inline.url); }
    else if (block.type === 'table') { for (const row of block.children) for (const cell of row.children) for (const inline of inlineNodes(cell.children)) if (inline.type === 'link') add(inline.url); }
    // a component links through href, and an embed the target cannot frame renders its src as a link
    else if (block.type === 'component' || block.type === 'dai') for (const key of ['href', 'src', 'url']) { const value = block.props[key]; if (typeof value === 'string') add(value); }
  });
  return urls;
}

function sourceImages(doc: DocIR, interactive = false): Array<{ src: string; alt?: string }> {
  const images: Array<{ src: string; alt?: string }> = [];
  const unrendered = unrenderedBlockIds(doc, interactive);
  walkBlocks(doc.children, (block) => {
    if (unrendered.has(block.id)) return;
    if (block.type === 'image') images.push({ src: block.url, alt: block.alt });
    else if (block.type === 'figure') images.push({ src: block.image.url, alt: block.image.alt });
    else if (block.type === 'paragraph' || block.type === 'heading') { for (const inline of inlineNodes(block.children)) if (inline.type === 'image') images.push({ src: inline.url, alt: inline.alt }); }
    else if (block.type === 'table') { for (const row of block.children) for (const cell of row.children) for (const inline of inlineNodes(cell.children)) if (inline.type === 'image') images.push({ src: inline.url, alt: inline.alt }); }
    // a card's cover image renders with the card title as its alt text
    else if ((block.type === 'component' || block.type === 'dai') && typeof block.props.image === 'string') images.push({ src: block.props.image, alt: typeof block.props.title === 'string' ? block.props.title : '' });
  });
  return images;
}

/**
 * Every authored segment must appear in the rendered preview in order, and the
 * rendered article must contain nothing else: text with no source is how platform
 * chrome reached the last migration unnoticed. Links, images, the heading outline
 * and the sidebar are checked on the same pass, one report row per route.
 */
export async function runBrowserContentGate(
  previewUrl: string,
  pages: Array<BrowserPage & { doc?: DocIR }>,
  options: BrowserContentOptions | PageRenderer = {},
): Promise<{ gate: GateResult; routes: PreviewRouteResult[] }> {
  const opts: BrowserContentOptions = typeof options === 'function' ? { render: options } : options;
  const render = opts.render ?? chromeDump;
  const allowed = (opts.previewChrome ?? DEFAULT_PREVIEW_CHROME).map(normaliseVisible).filter(Boolean);
  const routes: PreviewRouteResult[] = [];

  const inspected = await mapConcurrentOrdered(pages.filter((entry) => entry.migrate), opts.concurrency ?? 4, async (page): Promise<PreviewRouteResult> => {
    const route = page.newPath ?? page.id;
    const problems: string[] = [];
    // A page with no source document cannot be judged, so it is a failure rather than a silent skip.
    if (!page.newPath) return { route, status: 'fail', problems: ['migrated page has no output route'] };
    // Read once: a page's document may be built on demand, and it is released when this page is done.
    const doc = page.doc;
    if (!doc) return { route, status: 'fail', problems: ['no source document to compare the rendered page against'] };

    let html: string;
    try {
      html = await render(routeUrl(previewUrl, page.newPath));
      if (!/<html\b/i.test(html) || /<body[^>]*\bclass=["'][^"']*\bneterror\b/i.test(html) || /\bid=["']main-frame-error["']/i.test(html)) throw new Error('preview did not render a valid page');
    } catch (error) {
      return { route, status: 'fail', problems: [`browser load failed: ${(error as Error).message}`] };
    }

    const root = parseHtml(html);
    const article = find(root, 'article') ?? find(root, 'main') ?? find(root, '[role=main]') ?? find(root, 'body') ?? root;
    // With content selectors only the page itself is read, not the platform chrome around it (breadcrumbs, feedback, prev/next, footer).
    // A match that contains another match is a wrapper (the theme nests its body container inside an outer one around the whole page), so only the innermost are read.
    const matches = (opts.contentSelectors ?? []).flatMap((selector) => findAll(root, selector));
    const contains = (outer: Dom, inner: Dom): boolean => { for (let node = inner.parent; node; node = node.parent) if (node === outer) return true; return false; };
    const selected = matches.filter((candidate) => !matches.some((other) => other !== candidate && contains(candidate, other)));
    const content = selected.length ? selected : [article];
    const rendered = normaliseVisible(content.map(visibleText).join('\n'));

    // Segments in order; the text between consecutive matches is residual and must be insignificant.
    // Optional text (inside a collapsed block) counts only where it sits before the next required segment.
    const segments = documentSegments(doc, opts.interactive);
    let cursor = 0;
    const residual: string[] = [];
    segments.forEach((segment, position) => {
      const index = rendered.indexOf(segment.text, cursor);
      if (index >= 0 && segment.optional) {
        const next = segments.slice(position + 1).find((later) => !later.optional);
        const nextIndex = next ? rendered.indexOf(next.text, cursor) : -1;
        if (nextIndex >= 0 && index + segment.text.length > nextIndex) return;
      }
      if (index < 0) { if (!segment.optional) problems.push(`missing or out of order: “${segment.text.slice(0, 80)}”`); return; }
      residual.push(rendered.slice(cursor, index));
      cursor = index + segment.text.length;
    });
    residual.push(rendered.slice(cursor));
    const unexplained = residual
      .map((piece) => allowed.reduce((text, chrome) => text.split(chrome).join(' '), piece))
      .map((piece) => piece.trim())
      .filter((piece) => piece && !INSIGNIFICANT_RESIDUAL.test(piece));
    if (unexplained.length) problems.push(`rendered text with no source: ${unexplained.slice(0, 3).map((piece) => `“${piece.slice(0, 60)}”`).join(', ')}`);

    // The outline the reader navigates by.
    const renderedOutline = content.flatMap((node) => findAll(node, 'h2, h3, h4, h5, h6')).map((heading) => `${Number(heading.name.slice(1))}:${normaliseVisible(visibleText(heading))}`);
    const expectedOutline = sourceOutline(doc, opts.interactive);
    if (renderedOutline.join('|') !== expectedOutline.join('|')) problems.push(`heading outline differs: rendered ${JSON.stringify(renderedOutline)}, source ${JSON.stringify(expectedOutline)}`);

    // Links: internal ones must land on a migrated route, external ones must be the source's own.
    const sourceTargets = sourceLinkTargets(doc);
    for (const anchor of content.flatMap((node) => findAll(node, 'a[href]'))) {
      const href = anchor.attribs.href;
      if (!href || href.startsWith('#')) continue;
      if (href.startsWith('/')) {
        const target = href.split(/[?#]/)[0].replace(/^\/+|\/$/g, '') || 'index';
        if (opts.routes && !opts.routes.has(target)) problems.push(`internal link ${href} resolves to no migrated page`);
      } else if (/^https?:/i.test(href) && sourceTargets.size && !sourceTargets.has(href)) {
        problems.push(`external link ${href} is not one the source states`);
      }
    }

    // Images: rehosted, and still carrying the alt text the source wrote.
    const expectedImages = sourceImages(doc, opts.interactive);
    const renderedImages = content.flatMap((node) => findAll(node, 'img'));
    if (renderedImages.length !== expectedImages.length) problems.push(`image count differs: rendered ${renderedImages.length}, source ${expectedImages.length}`);
    renderedImages.forEach((image, index) => {
      const expected = expectedImages[index];
      if (!expected) return;
      const alt = image.attribs.alt ?? '';
      if (normaliseVisible(alt) !== normaliseVisible(expected.alt ?? '')) problems.push(`image ${index + 1} alt is ${JSON.stringify(alt)}, source states ${JSON.stringify(expected.alt ?? '')}`);
      const src = image.attribs.src ?? '';
      if (opts.assetUrls?.size) {
        const hosted = hostedAssetUrl(expected.src, doc.source, opts.assetUrls) ?? expected.src;
        if (src && hosted && !src.startsWith(hosted) && src !== hosted) problems.push(`image ${index + 1} renders ${src}, expected the hosted ${hosted}`);
      }
    });

    return { route, status: problems.length ? 'fail' : 'pass', problems, ...(unexplained.length ? { residual: unexplained.join(' | ').slice(0, 500) } : {}) };
  });
  routes.push(...inspected);

  // The sidebar and the site name are properties of the whole preview, checked once on the first route.
  const first = pages.find((entry) => entry.migrate && entry.newPath);
  if (first && (opts.navigation?.length || opts.siteName)) {
    const problems: string[] = [];
    try {
      const html = await render(routeUrl(previewUrl, first.newPath!));
      const root = parseHtml(html);
      if (opts.siteName) {
        const title = find(root, 'title');
        const text = title ? normaliseVisible(visibleText(title)) : '';
        if (!text.includes(normaliseVisible(opts.siteName))) problems.push(`page title ${JSON.stringify(text)} does not carry the site name ${JSON.stringify(opts.siteName)}`);
      }
      if (opts.navigation?.length) {
        if (!opts.navSelector) problems.push('the target platform declares no navigation selector, so the rendered sidebar cannot be checked');
        else if (!find(root, opts.navSelector)) problems.push(`no rendered navigation matched ${opts.navSelector}`);
        else {
          // A tabbed site shows one tab's pages at a time, so no single route's sidebar lists the
          // whole navigation: the demo-64 root page sits in a tab of its own and rendered ["home"]
          // against all 41 source labels. Each distinct rendered sidebar is one such surface, so
          // they are read across the routes this gate already rendered (renders are cached, so
          // reading them again costs nothing), deduplicated, and counted together.
          //
          // Counted, not merely present: a page the navigation places twice has to appear twice, or
          // one of its placements was lost. Summing over distinct sidebars keeps that, and keeps a
          // label a source states under several tabs - "Getting started" sits under three here -
          // from having to appear three times in any one of them.
          const surfaces = new Map<string, string[]>();
          for (const entry of pages) {
            if (!entry.migrate || !entry.newPath) continue;
            try {
              const container = find(parseHtml(await render(routeUrl(previewUrl, entry.newPath))), opts.navSelector);
              if (!container) continue;
              const labels = findAll(container, 'a[href]').map((anchor) => normaliseVisible(visibleText(anchor))).filter(Boolean);
              if (labels.length) surfaces.set(labels.join('|'), labels);
            } catch { /* a route that will not load is already reported as that route's own failure */ }
          }
          const shown = new Map<string, number>();
          for (const labels of surfaces.values()) for (const label of labels) shown.set(label, (shown.get(label) ?? 0) + 1);
          const wanted = new Map<string, number>();
          for (const entry of opts.navigation) { const label = normaliseVisible(entry.label); if (label) wanted.set(label, (wanted.get(label) ?? 0) + 1); }
          const missing = [...wanted.entries()].filter(([label, count]) => (shown.get(label) ?? 0) < count)
            .map(([label, count]) => `${JSON.stringify(label)} placed ${count}\u00d7, shown ${shown.get(label) ?? 0}\u00d7`);
          if (missing.length) problems.push(`sidebar labels differ: navigation placements the rendered sidebars never show: ${missing.slice(0, 12).join('; ')}`);
        }
      }
    } catch (error) {
      problems.push(`browser load failed: ${(error as Error).message}`);
    }
    routes.push({ route: '(site)', status: problems.length ? 'fail' : 'pass', problems });
  }

  const failed = routes.filter((entry) => entry.status === 'fail');
  return {
    gate: {
      id: 'browser-content',
      status: failed.length ? 'fail' : 'pass',
      detail: `${failed.length} of ${routes.length} preview routes differ from the source they were migrated from`,
      count: failed.length,
      samples: failed.slice(0, 8).map((entry) => `${entry.route}: ${entry.problems[0]}`),
    },
    routes,
  };
}
