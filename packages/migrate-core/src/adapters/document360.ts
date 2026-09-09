/**
 * Document360 export adapter. Reads a ZIP or an extracted directory.
 *
 * Verified shape (Scrut export, Aug 2026): `Media/` plus `<workspace>/` holding
 * `Articles/`, `Categories/` and `<workspace>_category_articles.json`. Article
 * files are `.html` (WYSIWYG editor) or `.md` (Markdown editor); each begins
 * with a metadata comment block:
 *   <!-- ## Metadata_Start
 *   key: value
 *   ## Metadata_End -->
 * The category JSON's exact schema is tolerated, not assumed: the adapter walks
 * it recursively and logs any node it cannot place. Confirm on the first real
 * export and add a fixture.
 */
import { open as openZip, type Entry } from 'yauzl-promise';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, relative, basename, extname, resolve, sep, dirname } from 'node:path';
import { htmlToIr, type ComponentRecogniser } from '../ir/from-html.js';
import { markdownToIr } from '../ir/from-markdown.js';
import type { DocIR, Block } from '../ir/types.js';
import { pageIdFromPlatform, shortHash } from '../session/ids.js';

export const D360_RECOGNISERS: ComponentRecogniser[] = [
  { selector: 'blockquote.infoBox', name: 'infoBox' },
  { selector: 'blockquote.warningBox', name: 'warningBox' },
  { selector: 'blockquote.errorBox', name: 'errorBox' },
  { selector: 'blockquote.successBox', name: 'successBox' },
  { selector: 'details', name: 'details', props: { summary: '@text:summary' }, strip: ['summary'] },
  { selector: 'editor360-faq', name: 'faq' },
  { selector: 'div.tabs, ul.nav-tabs', name: 'tabs' },
  { selector: 'div.tab-pane', name: 'tab', props: { title: '@attr:data-title' } },
];

export interface D360Article {
  platformId: string;
  title: string;
  slug: string;
  file: string;
  format: 'html' | 'md';
  categoryPath: string[];
  order: number;
  metadata: Record<string, string>;
  workspace: string;
  language?: string;
}

export interface D360Export {
  root: string;
  workspaces: string[];
  articles: D360Article[];
  mediaDir?: string;
  unplaced: Array<{ reason: string; detail: string }>;
  snippetTokens: Map<string, number>;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

export async function extractIfZip(input: string, extractTo: string): Promise<string> {
  if (statSync(input).isDirectory()) return input;
  if (extname(input).toLowerCase() !== '.zip') throw new Error(`Expected a directory or .zip: ${input}`);
  if (statSync(input).size > 1024 * 1024 * 1024) throw new Error('Refusing ZIP larger than 1 GiB');
  const root = resolve(extractTo);
  let totalSize = 0;
  let entryCount = 0;
  const zip = await openZip(input, { validateEntrySizes: true, validateFilenames: true, strictFilenames: true });
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  const extractRoot = mkdtempSync(join(dirname(root), '.dai-extract-'));
  try {
    for await (const entry of zip) {
      entryCount++;
      if (entryCount > 100_000) throw new Error(`Refusing ZIP with more than 100000 entries`);
      const name = entry.filename;
      const target = resolve(extractRoot, name);
      if (target !== extractRoot && !target.startsWith(extractRoot + sep)) throw new Error(`Refusing zip entry outside target: ${name}`);
      if (entry.uncompressedSize > 200 * 1024 * 1024) throw new Error(`Refusing oversized zip entry: ${name}`);
      totalSize += entry.uncompressedSize;
      if (totalSize > 1024 * 1024 * 1024) throw new Error('Refusing ZIP expanding beyond 1 GiB');
      if (entry.compressedSize === 0 && entry.uncompressedSize > 0) throw new Error(`Refusing suspicious compression ratio: ${name}`);
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 1000) throw new Error(`Refusing suspicious compression ratio: ${name}`);

      const unixMode = entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
      if (unixMode && (unixMode & 0o170000) === 0o120000) throw new Error(`Refusing symbolic link in ZIP: ${name}`);
      if (name.endsWith('/')) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }

      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      let entryBytes = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          entryBytes += chunk.length;
          if (entryBytes > 200 * 1024 * 1024 || totalSize - entry.uncompressedSize + entryBytes > 1024 * 1024 * 1024) callback(new Error(`ZIP extraction limit exceeded by ${name}`));
          else callback(null, chunk);
        },
      });
      await pipeline(await (entry as Entry).openReadStream(), limiter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      if (entryBytes !== entry.uncompressedSize) throw new Error(`ZIP entry size mismatch: ${name}`);
    }
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    renameSync(extractRoot, root);
    return root;
  } catch (error) {
    rmSync(extractRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await zip.close();
  }
}

export function parseMetadata(content: string): { metadata: Record<string, string>; body: string } {
  const m = content.match(/<!--\s*## Metadata_Start\s*([\s\S]*?)## Metadata_End\s*-->/);
  if (!m) return { metadata: {}, body: content };
  const metadata: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*([A-Za-z0-9_ -]+?)\s*:\s*(.*?)\s*$/);
    if (mm) metadata[mm[1].toLowerCase().replace(/\s+/g, '_')] = mm[2];
  }
  return { metadata, body: content.slice(m.index! + m[0].length) };
}

/** Walk any JSON shape and collect (categoryPath, article-like objects). */
function collectFromJson(node: any, path: string[], out: Array<{ categoryPath: string[]; article: any; order: number }>, unplaced: D360Export['unplaced'], order = { n: 0 }): void {
  if (Array.isArray(node)) { node.forEach((n) => collectFromJson(n, path, out, unplaced, order)); return; }
  if (!node || typeof node !== 'object') return;
  const name = node.category_name ?? node.categoryName ?? node.name ?? node.title;
  const isCategory = ('articles' in node) || ('child_categories' in node) || ('children' in node) || ('categories' in node) || ('sub_categories' in node);
  const isArticle = ('slug' in node || 'article_slug' in node || 'url' in node) && !isCategory;
  if (isArticle) { out.push({ categoryPath: path, article: node, order: order.n++ }); return; }
  if (isCategory) {
    const p = name ? [...path, String(name)] : path;
    for (const k of ['articles', 'child_categories', 'children', 'categories', 'sub_categories']) if (k in node) collectFromJson(node[k], p, out, unplaced, order);
    return;
  }
  // unknown object: descend but record it
  const keys = Object.keys(node);
  if (keys.length) unplaced.push({ reason: 'unknown json node shape', detail: keys.slice(0, 8).join(',') });
  for (const v of Object.values(node)) collectFromJson(v, path, out, unplaced, order);
}

export function readD360Export(inputRoot: string): D360Export {
  const files = walkFiles(inputRoot);
  const mediaDir = files.some((f) => /\/Media\//.test(f)) ? join(inputRoot, 'Media') : undefined;
  const catJson = files.filter((f) => /_category_articles\.json$/i.test(f));
  const articleFiles = files.filter((f) => /\/Articles\/.*\.(html?|md)$/i.test(f));
  const unplaced: D360Export['unplaced'] = [];
  const articles: D360Article[] = [];
  const snippetTokens = new Map<string, number>();

  const byBase = new Map<string, string>();
  for (const f of articleFiles) byBase.set(basename(f).replace(/\.(html?|md)$/i, '').toLowerCase(), f);

  const workspaces = [...new Set(catJson.map((f) => basename(f).replace(/_category_articles\.json$/i, '')))];

  const placed = new Set<string>();
  for (const cj of catJson) {
    const ws = basename(cj).replace(/_category_articles\.json$/i, '');
    let json: any;
    try { json = JSON.parse(readFileSync(cj, 'utf8')); } catch (e) { unplaced.push({ reason: 'category json unparsable', detail: relative(inputRoot, cj) }); continue; }
    const items: Array<{ categoryPath: string[]; article: any; order: number }> = [];
    collectFromJson(json, [], items, unplaced);
    for (const it of items) {
      const a = it.article;
      const slug = String(a.slug ?? a.article_slug ?? (a.url ? String(a.url).split('/').pop() : '') ?? '');
      const title = String(a.title ?? a.article_title ?? a.name ?? slug);
      const file = byBase.get(slug.toLowerCase()) ?? byBase.get(title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      if (!file) { unplaced.push({ reason: 'article in json without file', detail: slug || title }); continue; }
      placed.add(file);
      articles.push(makeArticle(file, inputRoot, ws, it.categoryPath, it.order, a.id ?? a.article_id ?? slug, snippetTokens));
    }
  }
  // files not referenced by any category json still count as pages (uncategorised)
  for (const f of articleFiles) if (!placed.has(f)) {
    const ws = relative(inputRoot, f).split('/')[0];
    articles.push(makeArticle(f, inputRoot, ws, ['(uncategorised)'], 1e6, basename(f), snippetTokens));
    unplaced.push({ reason: 'article file not in category json', detail: relative(inputRoot, f) });
  }
  return { root: inputRoot, workspaces: workspaces.length ? workspaces : [...new Set(articles.map((a) => a.workspace))], articles, mediaDir, unplaced, snippetTokens };
}

function makeArticle(file: string, root: string, ws: string, categoryPath: string[], order: number, platformId: string, tokens: Map<string, number>): D360Article {
  const raw = readFileSync(file, 'utf8');
  const { metadata } = parseMetadata(raw);
  for (const m of raw.matchAll(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g)) tokens.set(m[1], (tokens.get(m[1]) ?? 0) + 1);
  const slug = metadata.slug ?? basename(file).replace(/\.(html?|md)$/i, '');
  return {
    platformId: String(metadata.id ?? metadata.article_id ?? platformId),
    title: metadata.title ?? slug,
    slug,
    file,
    format: /\.md$/i.test(file) ? 'md' : 'html',
    categoryPath,
    order,
    metadata,
    workspace: ws,
    language: metadata.language ?? metadata.lang,
  };
}

/** Convert one HTML article to DocIR; snippet tokens become snippetRef nodes. */
export function d360ArticleToIr(article: D360Article, root: string): DocIR {
  const raw = readFileSync(article.file, 'utf8');
  const { metadata, body } = parseMetadata(raw);
  const pageId = pageIdFromPlatform('document360', article.platformId);
  const file = relative(root, article.file);
  if (article.format === 'md') {
    return markdownToIr(body, {
      platform: 'document360', file, pageId, title: article.title,
      frontmatter: { title: article.title, description: metadata.description ?? metadata.meta_description, metaTitle: metadata.meta_title, ...(metadata.tags ? { tags: metadata.tags } : {}) },
    });
  }
  const withTokens = body.replace(/\{\{\s*snippet\.([^}]+?)\s*\}\}/g, (_, t) => `<dai-snippet-ref data-token="${t.trim()}"></dai-snippet-ref>`);
  const res = htmlToIr(withTokens, {
    platform: 'document360',
    file,
    recognisers: [...D360_RECOGNISERS, { selector: 'dai-snippet-ref', name: 'snippetRef', props: { token: '@attr:data-token' } }],
    removeSelectors: ['nav', 'header', 'footer', '.breadcrumb', '.article-feedback'],
  });
  const children: Block[] = res.children.map((b) => (b.type === 'component' && b.name === 'snippetRef' ? { id: b.id, type: 'snippetRef', token: String(b.props.token), platform: 'document360' } : b));
  return {
    pageId,
    platform: 'document360',
    source: file,
    frontmatter: { title: article.title, description: metadata.description ?? metadata.meta_description, metaTitle: metadata.meta_title, ...(metadata.tags ? { tags: metadata.tags } : {}) },
    children,
  };
}

export function d360ContentHash(article: D360Article): string {
  return shortHash(readFileSync(article.file));
}
