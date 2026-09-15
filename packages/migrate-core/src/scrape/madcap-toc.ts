/**
 * The navigation a published MadCap Flare site builds in the browser, read without a browser.
 *
 * Flare's HTML5 output ships the sidebar as an empty skeleton and fills it at runtime, so crawling
 * the pages yields no navigation at all: the 448-page capture this was written against produced
 * none, and the migration fell back to inferring groups from URL paths — exactly what exact mode
 * refuses. The data those scripts read is static, and fetching it directly gives the real tree.
 *
 * Four hops, each one confirmed against three independent live builds:
 *
 *   1. any topic page → `data-mc-path-to-help-system` on `<html>`, resolved against that page's own
 *      directory. It is per page, not per host: one host can serve several help systems.
 *   2. `<root>Data/HelpSystem.xml` → `@Toc`. The filename is chosen per project, so it is read here
 *      and never assumed; the three sites surveyed used three different names.
 *   3. that file → `define({numchunks, prefix, tree})`, where the tree carries structure only:
 *      `{i: nodeIndex, c: chunkNumber, n: [children]}`.
 *   4. `<tocDir>/<prefix><N>.js` for every chunk → `{'<link>': {i: [...], t: [...], b: [...]}}`,
 *      three positionally parallel arrays holding the titles and links.
 *
 * These files are data, so they are parsed as data. Nothing here evaluates JavaScript.
 *
 * Fetching and tree-building are separate on purpose. The files are frozen with the capture, and
 * verification re-derives the sidebar from those frozen bytes with no network — so the assembly is
 * a pure function over the data, and the fetch is only the walk that collects it.
 */
import type { DiscoveredNavigationNode } from './discovery.js';

export interface FlareFetch {
  (url: string): Promise<{ status: number; body: string }>;
}

export interface FlareNavigation {
  nodes: DiscoveredNavigationNode[];
  /** The table of contents actually read, for the report. */
  toc: string;
  /** Entries whose node index no chunk supplied; a hole here would silently shorten the sidebar. */
  unresolved: number;
}

/** A page's help-system root: the attribute resolved against the page's own directory. */
export function helpSystemRoot(html: string, pageUrl: string): string | undefined {
  const declared = /<html[^>]*\sdata-mc-path-to-help-system=["']([^"']*)["']/i.exec(html)?.[1];
  if (declared === undefined) return undefined;
  try { return new URL(declared || './', pageUrl).toString(); } catch { return undefined; }
}

/** The table of contents this help system declares. The name is per project and never assumed. */
export function tocPathFromHelpSystem(xml: string): string | undefined {
  return /<WebHelpSystem[^>]*\sToc=["']([^"']+)["']/i.exec(xml)?.[1];
}

/** The page a help system opens on, which is where it states its own name. */
export function defaultUrlFromHelpSystem(xml: string, helpSystemRootUrl: string): string | undefined {
  const declared = /<WebHelpSystem[^>]*\sDefaultUrl=["']([^"']+)["']/i.exec(xml)?.[1];
  if (!declared) return undefined;
  try { return new URL(declared, helpSystemRootUrl).toString(); } catch { return undefined; }
}

/**
 * A `define({...})` data file as a value.
 *
 * These are object literals with bare keys and single-quoted strings — JSON in all but spelling.
 * The rewrite below is a scan, not an evaluation: a file that does not parse is reported rather
 * than run.
 */
export function parseDefine(source: string): unknown {
  const open = source.indexOf('(');
  const close = source.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error('not a define() data file');
  const body = source.slice(open + 1, close).trim();
  let json = '';
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === '"' || character === "'") {
      const literal = jsStringToJson(body, index);
      json += literal.json;
      index = literal.end - 1;
      continue;
    }
    // A bare key: quote it.
    if (/[A-Za-z_$]/.test(character)) {
      let word = '';
      while (index < body.length && /[\w$]/.test(body[index])) { word += body[index]; index++; }
      const rest = body.slice(index).match(/^\s*:/);
      json += rest ? JSON.stringify(word) : word === 'true' || word === 'false' || word === 'null' ? word : JSON.stringify(word);
      index--;
      continue;
    }
    json += character;
  }
  return JSON.parse(json) as unknown;
}

/**
 * A JavaScript string literal, starting on its opening quote, as the JSON string literal that
 * names the same characters — and the index just past its closing quote.
 *
 * JavaScript and JSON share some escapes (`\uXXXX`, `\n`), and differ on others: `\'` and `\xHH`
 * exist only in JavaScript, a bare `"` inside single quotes needs escaping in JSON. Flare writes
 * an ampersand in a title as `\u0026`; carrying that backslash through as text once put the six
 * characters `\u0026` into a sidebar label where the reader expected `&`.
 */
function jsStringToJson(body: string, start: number): { json: string; end: number } {
  const quote = body[start];
  let out = '';
  let i = start + 1;
  for (; i < body.length && body[i] !== quote; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch === '"' ? '\\"' : ch; continue; }
    const next = body[++i];
    if (next === undefined) break;
    const hex4 = body.slice(i + 1, i + 5);
    const hex2 = body.slice(i + 1, i + 3);
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(hex4)) { out += `\\u${hex4}`; i += 4; }
    else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex2)) { out += `\\u00${hex2}`; i += 2; }
    else if ('nrtbf'.includes(next)) out += `\\${next}`;
    else if (next === '\\' || next === '"') out += `\\${next}`;
    else if (next === '0') out += '\\u0000';
    else if (next === '\n') { /* a line continuation names no character */ }
    else out += next; // `\'`, `\/` and any other escaped character: the character itself
  }
  // JSON refuses a raw control character inside a string; JavaScript does not.
  out = out.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return { json: `"${out}"`, end: i + 1 };
}

interface TocNode { i?: number; c?: number; n?: TocNode[] }
interface ChunkEntry { i?: number[]; t?: string[]; b?: string[] }

/** A link Flare writes for a node that is a heading rather than a page. */
const HEADING_SENTINEL = '___';

/** The data files a published help system serves, by URL: what gets frozen with the capture. */
export type FlareData = ReadonlyMap<string, string>;

/** The table of contents a help system declares, as an absolute URL. */
function tocUrlFor(root: string, read: (url: string) => string | undefined): string | undefined {
  const helpSystem = read(new URL('Data/HelpSystem.xml', root).toString());
  if (helpSystem === undefined) return undefined;
  const tocPath = tocPathFromHelpSystem(helpSystem);
  return tocPath ? new URL(tocPath, root).toString() : undefined;
}

/** A table of contents as Flare writes it: the chunk naming, and the structure-only tree. */
function tocShape(tocUrl: string, source: string): { chunks: string[]; tree: TocNode } {
  const parsed = parseDefine(source) as { numchunks?: number; prefix?: string; tree?: TocNode };
  const count = Number(parsed.numchunks ?? 0);
  const prefix = String(parsed.prefix ?? '');
  if (!parsed.tree || !prefix || !Number.isInteger(count) || count < 1) throw new Error(`${tocUrl}: table of contents has no tree or chunk prefix`);
  // Every chunk, not only the first: a tree routinely references the last one.
  return { chunks: Array.from({ length: count }, (_, index) => new URL(`${prefix}${index}.js`, tocUrl).toString()), tree: parsed.tree };
}

/**
 * The published sidebar, built from data already in hand.
 *
 * Pure, so the tree verification re-derives from the frozen files is the same tree discovery read
 * from the live site, and a difference between them is a difference in the bytes.
 */
export function flareNavigationFromData(pageUrl: string, html: string, data: FlareData): FlareNavigation | undefined {
  const read = (url: string): string | undefined => data.get(url);
  const root = helpSystemRoot(html, pageUrl);
  if (!root) return undefined;
  const tocUrl = tocUrlFor(root, read);
  const toc = tocUrl === undefined ? undefined : read(tocUrl);
  if (tocUrl === undefined || toc === undefined) return undefined;
  const { chunks, tree } = tocShape(tocUrl, toc);

  const byIndex = new Map<number, { link: string; title: string; bookmark: string }>();
  chunks.forEach((chunkUrl, chunk) => {
    const source = read(chunkUrl);
    // A missing chunk drops whole branches, and a shortened sidebar looks complete.
    if (source === undefined) throw new Error(`${chunkUrl}: chunk ${chunk} of ${chunks.length} is missing, so the sidebar cannot be read in full`);
    for (const [link, entry] of Object.entries(parseDefine(source) as Record<string, ChunkEntry>)) {
      // `i`, `t` and `b` are positionally parallel: the entry for node index i[k] is t[k]/b[k].
      (entry.i ?? []).forEach((nodeIndex, position) => {
        byIndex.set(nodeIndex, { link, title: entry.t?.[position] ?? '', bookmark: entry.b?.[position] ?? '' });
      });
    }
  });

  let unresolved = 0;
  const walk = (nodes: readonly TocNode[]): DiscoveredNavigationNode[] => {
    const out: DiscoveredNavigationNode[] = [];
    for (const node of nodes) {
      const entry = node.i === undefined ? undefined : byIndex.get(node.i);
      if (!entry) { unresolved++; continue; }
      const children = node.n?.length ? walk(node.n) : [];
      const isHeading = !entry.link || entry.link === HEADING_SENTINEL;
      // The bookmark is the anchor within the topic that this entry points at. Dropping it would
      // send an entry that names a section to the top of the page instead.
      const target = `${entry.link.replace(/^\/+/, '')}${entry.bookmark && !entry.link.includes('#') ? `#${entry.bookmark.replace(/^#/, '')}` : ''}`;
      const page: DiscoveredNavigationNode | undefined = isHeading
        ? undefined
        : { type: 'page', url: new URL(target, root).toString(), ...(entry.title ? { title: entry.title } : {}) };
      if (!children.length) { if (page) out.push(page); continue; }
      // A topic with children is the group its own title names, and opens as that topic: the page is
      // the container's own, not a duplicate first entry beneath it.
      out.push({ type: 'group', label: entry.title || 'Untitled', ...(page ? { pageUrl: page.url } : {}), children });
    }
    return out;
  };

  return { nodes: walk(tree.n ?? []), toc: tocUrl, unresolved };
}

/**
 * Walks the chain over the network and returns the files read, for freezing with the capture.
 *
 * Nothing is returned for a page that is not Flare output or whose help system publishes no data;
 * a chain that starts and then breaks raises, because a half-read sidebar is worse than none.
 */
export async function fetchFlareData(pageUrl: string, html: string, fetch: FlareFetch): Promise<Map<string, string> | undefined> {
  const data = new Map<string, string>();
  const load = async (url: string): Promise<string | undefined> => {
    const response = await fetch(url);
    if (response.status !== 200) return undefined;
    data.set(url, response.body);
    return response.body;
  };

  const root = helpSystemRoot(html, pageUrl);
  if (!root) return undefined;
  const helpSystem = await load(new URL('Data/HelpSystem.xml', root).toString());
  if (helpSystem === undefined) return undefined;
  const tocPath = tocPathFromHelpSystem(helpSystem);
  if (!tocPath) return undefined;
  const tocUrl = new URL(tocPath, root).toString();
  const toc = await load(tocUrl);
  if (toc === undefined) return undefined;
  const { chunks } = tocShape(tocUrl, toc);
  for (const [chunk, chunkUrl] of chunks.entries()) {
    if (await load(chunkUrl) === undefined) throw new Error(`${chunkUrl}: chunk ${chunk} of ${chunks.length} is missing, so the sidebar cannot be read in full`);
  }
  return data;
}

