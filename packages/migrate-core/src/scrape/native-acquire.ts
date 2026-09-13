/**
 * The frozen repository or export, recorded as an acquisition.
 *
 * A live site is frozen page by page into `source-cache/acquired`, and every exactness gate reads
 * the migration back against those bytes. A repository or export source froze its files instead,
 * and nothing ever wrote acquisition records for them, so `loadRawSourcePages` found nothing and
 * verification had no source to compare against: the exact-fidelity family could not certify a
 * Mintlify, GitBook, ReadMe or Document360 repository at all — the sources a customer migration is
 * most likely to use.
 *
 * Writing the frozen file bytes as acquisition records puts every source kind on one verification
 * path. The bytes are the ones `freezeDirectory` already pinned, so this copies evidence rather
 * than gathering it: nothing is fetched, and a page whose file cannot be read is reported rather
 * than recorded as empty.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { writeAcquired, type AcquiredPage } from './acquire.js';
import { sha256 } from '../session/ids.js';
import { splitFrontmatter } from '../ir/from-markdown.js';

/** What the file at a source path holds: authored Markdown, rendered HTML, or neither. */
function bodyKind(path: string): 'markdown' | 'html' | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === '.md' || extension === '.mdx' || extension === '.markdown') return 'markdown';
  if (extension === '.html' || extension === '.htm' || extension === '.xhtml') return 'html';
  return undefined;
}

/**
 * The title and description the file itself states in its frontmatter.
 *
 * The same safe YAML parser used by inventory reads the frozen file. Folded and multiline values
 * are source declarations too; reducing frontmatter to one-line regexes made the proof compare a
 * fallback title against itself instead of the value the customer wrote.
 */
function statedMetadata(body: string): { title?: string; description?: string } {
  const data = splitFrontmatter(body, 'frozen native source').data;
  const scalar = (field: string): string | undefined => typeof data[field] === 'string' && data[field].trim() ? data[field].trim() : undefined;
  return { title: scalar('title'), description: scalar('description') };
}

export interface NativeAcquisition {
  /** Pages whose frozen bytes are now recorded. */
  recorded: number;
  /** Pages whose file could not be read, with the reason; exact mode refuses to certify these. */
  unreadable: Array<{ pageId: string; source: string; reason: string }>;
}

/**
 * Records the frozen bytes of every in-scope page. A record that already exists and matches is
 * left alone, so re-running acquire is free and cannot rewrite pinned evidence.
 */
export function acquireNativePages(
  workspace: string,
  root: string,
  pages: ReadonlyArray<{ id: string; source: string; title?: string; description?: string; migrate: boolean }>,
): NativeAcquisition {
  const result: NativeAcquisition = { recorded: 0, unreadable: [] };
  mkdirSync(join(workspace, 'source-cache', 'acquired'), { recursive: true, mode: 0o700 });
  for (const page of pages) {
    if (!page.migrate) continue;
    const kind = bodyKind(page.source);
    if (!kind) { result.unreadable.push({ pageId: page.id, source: page.source, reason: `no Markdown or HTML body: ${extname(page.source) || 'no extension'}` }); continue; }
    // Page sources are recorded relative to the frozen root; a path leaving it is refused rather
    // than read, the same containment the inventory stage applies.
    const file = resolve(root, page.source);
    if (file !== root && !file.startsWith(resolve(root) + '/')) { result.unreadable.push({ pageId: page.id, source: page.source, reason: 'path escapes the frozen source root' }); continue; }
    if (!existsSync(file)) { result.unreadable.push({ pageId: page.id, source: page.source, reason: 'file is not in the frozen source' }); continue; }
    let body: string;
    try { body = readFileSync(file, 'utf8'); }
    catch (error) { result.unreadable.push({ pageId: page.id, source: page.source, reason: (error as Error).message }); continue; }
    // What the source states about itself is in the file, not in the plan: the tree's title may be
    // a placeholder an operator edited, and using that would certify the output against the plan.
    const stated = statedMetadata(body);
    const title = stated.title ?? page.title;
    const description = stated.description ?? page.description;
    const record: AcquiredPage = {
      url: page.source,
      ...(kind === 'markdown' ? { markdown: body, markdownSha256: sha256(body) } : { html: body, htmlSha256: sha256(body), contentType: 'text/html' }),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
    writeAcquired(workspace, page.id, record);
    result.recorded++;
  }
  return result;
}
