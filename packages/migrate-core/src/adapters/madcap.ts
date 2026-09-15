/**
 * MadCap Flare, read from the project source a customer keeps in version control.
 *
 * A Flare project states its sidebar in `Project/TOCs/*.fltoc` — plain XML, one `TocEntry` per
 * node, nesting by containment, the label in `@Title` and the destination in `@Link`. That much is
 * deterministic, and unlike the published output (whose navigation is built in the browser) it can
 * be read without running anything.
 *
 * Two things about real Flare projects are not deterministic, and both are refused rather than
 * guessed, because guessing either one silently rewrites the customer's sidebar:
 *
 * 1. **Which TOC is the site.** A project may hold several. The target being built names one in
 *    `@MasterToc`, and the project may name a default. When neither does, Flare falls back to "the
 *    first TOC in the project", which is not an order this tool can know. A project with more than
 *    one candidate and no pointer is reported, not guessed at.
 * 2. **Conditions that both include and exclude.** A target carries
 *    `ConditionTagExpression="include[...] exclude[...]"`, and an entry may be tagged with both an
 *    included and an excluded tag. MadCap does not define which wins. On a real customer project
 *    surveyed for this adapter, 55% of sidebar entries were tagged both ways — so a guess here is
 *    not an edge case, it is most of the tree.
 *
 * Flare writes every file with a UTF-8 byte order mark, which must come off before parsing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseDocument } from 'htmlparser2';
import type { Element } from 'domhandler';
import { pageIdFromPlatform } from '../session/ids.js';
import type { SourceNavigationNode, Tree, TreePage } from '../nav/tree.js';

export interface MadcapRepo {
  root: string;
  tree: Tree;
  /** The TOC read as the site's navigation, when one could be identified. */
  toc?: string;
  /** The target whose settings were applied. */
  target?: string;
  /** Topics a TOC entry names that are not in the project. */
  missing: string[];
  /** Why the navigation could not be read, when it could not. Each one needs a person to answer. */
  refusals: string[];
}

const readXml = (path: string): ReturnType<typeof parseDocument> => parseDocument(readFileSync(path, 'utf8').replace(/^﻿/, ''), { xmlMode: true });

function elements(node: { children?: unknown[] }, name: string): Element[] {
  return ((node.children ?? []) as Element[]).filter((child) => child.type === 'tag' && child.name === name);
}

function firstElement(document: ReturnType<typeof parseDocument>, name: string): Element | undefined {
  const stack = [...(document.children as Element[])];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.type === 'tag' && node.name === name) return node;
    if (node.children) stack.push(...(node.children as Element[]));
  }
  return undefined;
}

function filesUnder(dir: string, match: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(path, match, out);
    else if (match.test(entry.name)) out.push(path);
  }
  return out.sort();
}

/** The project file, which is also how a Flare project is recognised. */
export function flareProjectFile(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.flprj'));
  // Exactly one: a directory holding several is not one project, and `Output/` holds a built copy.
  return projects.length === 1 && existsSync(join(root, 'Content')) && existsSync(join(root, 'Project'))
    ? join(root, projects[0].name)
    : undefined;
}

/** A topic's own title: its `<title>`, then its first heading, then its file name. */
function topicTitle(path: string): string {
  const body = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const declared = /<title>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, '').trim();
  if (declared) return declared;
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, '').trim();
  return heading || basename(path).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ');
}

interface Conditions { include: Set<string>; exclude: Set<string> }

/** `include[Primary.Online] exclude[Primary.Internal]` as the target writes it. */
function conditionsOf(expression: string | undefined): Conditions {
  const list = (kind: string): Set<string> => new Set(
    (new RegExp(`${kind}\\[([^\\]]*)\\]`, 'i').exec(expression ?? '')?.[1] ?? '')
      .split(',').map((tag) => tag.trim()).filter(Boolean),
  );
  return { include: list('include'), exclude: list('exclude') };
}

export function readMadcapRepo(rootIn: string, options: { target?: string } = {}): MadcapRepo {
  const root = resolve(rootIn);
  const projectFile = flareProjectFile(root);
  if (!projectFile) throw new Error(`no MadCap Flare project (.flprj beside Content/ and Project/) under ${root}`);

  const refusals: string[] = [];
  const missing: string[] = [];
  const project = firstElement(readXml(projectFile), 'CatapultProject');

  // Which target is the site: the one asked for, or the only one there is.
  const targetFiles = filesUnder(join(root, 'Project', 'Targets'), /\.fltar$/i);
  const chosenTarget = options.target
    ? targetFiles.find((file) => basename(file).replace(/\.fltar$/i, '') === options.target)
    : targetFiles.length === 1 ? targetFiles[0] : undefined;
  if (!chosenTarget && targetFiles.length > 1) {
    refusals.push(`${targetFiles.length} build targets (${targetFiles.map((file) => basename(file)).join(', ')}); name the one that builds the site, because each can select a different TOC and a different set of conditions`);
  }
  const target = chosenTarget ? firstElement(readXml(chosenTarget), 'CatapultTarget') : undefined;

  // Which TOC is the site's navigation: the target's, then the project's. Flare's own fallback is
  // "the first TOC in the project", which is not an order this tool can know.
  const tocFiles = filesUnder(join(root, 'Project', 'TOCs'), /\.fltoc$/i);
  const declaredToc = target?.attribs.MasterToc ?? project?.attribs.MasterToc;
  const tocPath = declaredToc
    ? resolve(root, declaredToc.replace(/^\/+/, ''))
    : tocFiles.length === 1 ? tocFiles[0] : undefined;
  if (!declaredToc && tocFiles.length > 1) {
    refusals.push(`${tocFiles.length} tables of contents and no MasterToc on the target or the project; Flare would use "the first one", which is not a stated order`);
  }
  if (tocPath && !existsSync(tocPath)) { refusals.push(`the declared table of contents ${declaredToc} is not in the project`); }

  const conditions = conditionsOf(target?.attribs.ConditionTagExpression);
  const pages: TreePage[] = [];
  const seen = new Set<string>();
  let order = 0;

  /** A node the target's conditions neither clearly keep nor clearly drop is refused, not guessed. */
  const conditionProblem = (tags: string | undefined): 'excluded' | 'ambiguous' | undefined => {
    const set = (tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
    if (!set.length) return undefined;
    const included = set.some((tag) => conditions.include.has(tag));
    const excluded = set.some((tag) => conditions.exclude.has(tag));
    if (included && excluded) return 'ambiguous';
    return excluded ? 'excluded' : undefined;
  };

  const addPage = (link: string, title: string | undefined, group: string[]): SourceNavigationNode | undefined => {
    const file = resolve(root, link.replace(/^\/+/, '').split('#')[0]);
    if (!file.startsWith(root + '/') || !existsSync(file)) { missing.push(link); return undefined; }
    const source = relative(root, file);
    if (seen.has(source)) return { type: 'page', pageId: pageIdFromPlatform('madcap', source), title: title ?? topicTitle(file) };
    seen.add(source);
    const stated = title && title !== '[%=System.LinkedTitle%]' ? title : topicTitle(file);
    const id = pageIdFromPlatform('madcap', source);
    pages.push({ id, title: stated, source, group: [...group], order: order++, oldPath: `/${source.replace(/\.html?$/i, '')}`, migrate: true, reason: 'fltoc' });
    return { type: 'page', pageId: id, title: stated };
  };

  const walkToc = (node: { children?: unknown[] }, group: string[], tocDir: string, visited: Set<string>): SourceNavigationNode[] => {
    const out: SourceNavigationNode[] = [];
    for (const entry of elements(node, 'TocEntry')) {
      const problem = conditionProblem(entry.attribs.conditions);
      if (problem === 'excluded') continue;
      if (problem === 'ambiguous') {
        refusals.push(`"${entry.attribs.Title ?? entry.attribs.Link ?? 'an entry'}" is tagged both included and excluded by this target (${entry.attribs.conditions}); MadCap does not define which wins`);
        continue;
      }
      const link = entry.attribs.Link;
      // A TOC entry may point at another TOC, which Flare merges in place.
      if (link && /\.fltoc$/i.test(link)) {
        const merged = resolve(root, link.replace(/^\/+/, ''));
        if (!existsSync(merged) || visited.has(merged)) { missing.push(link); continue; }
        out.push(...walkToc(firstElement(readXml(merged), 'CatapultToc') ?? { children: [] }, group, dirname(merged), new Set([...visited, merged])));
        continue;
      }
      const children = elements(entry, 'TocEntry');
      const title = entry.attribs.Title;
      if (!link) {
        // No destination: a heading that names the group beneath it.
        const label = title && title !== '[%=System.LinkedTitle%]' ? title : 'Untitled';
        const nested = walkToc(entry, [...group, label], tocDir, visited);
        if (nested.length) out.push({ type: 'group', label, children: nested });
        continue;
      }
      const page = addPage(link, title, group);
      if (!children.length) { if (page) out.push(page); continue; }
      // A topic with children is the group its own title names, and opens as that topic.
      const label = page?.type === 'page' ? (page.title ?? 'Untitled') : (title ?? 'Untitled');
      const nested = walkToc(entry, [...group, label], tocDir, visited);
      out.push({ type: 'group', label, ...(page?.type === 'page' ? { pageId: page.pageId } : {}), children: nested });
    }
    return out;
  };

  const navigation = tocPath && existsSync(tocPath) && !refusals.length
    ? walkToc(firstElement(readXml(tocPath), 'CatapultToc') ?? { children: [] }, [], dirname(tocPath), new Set([tocPath]))
    : [];

  // Topics the project holds but the sidebar never places: Flare publishes them only if linked.
  for (const file of filesUnder(join(root, 'Content'), /\.html?$/i)) {
    const source = relative(root, file);
    if (seen.has(source)) continue;
    pages.push({ id: pageIdFromPlatform('madcap', source), title: topicTitle(file), source, group: [], order: order++, oldPath: `/${source.replace(/\.html?$/i, '')}`, migrate: false, reason: 'not placed by the table of contents' });
  }

  return {
    root,
    tree: {
      scope: 'full',
      platform: 'madcap',
      pages,
      ...(navigation.length ? { navigation, navigationSource: 'source-config' as const } : {}),
    },
    ...(tocPath ? { toc: relative(root, tocPath) } : {}),
    ...(chosenTarget ? { target: basename(chosenTarget).replace(/\.fltar$/i, '') } : {}),
    missing,
    refusals,
  };
}
