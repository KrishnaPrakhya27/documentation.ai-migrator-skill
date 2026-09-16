/**
 * URL plan (plan/urls.yaml): preserve | restructure | hybrid, per page,
 * with reasons. Generates the redirect maps and the anchor map.
 */
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tree, TreePage } from '../nav/tree.js';
import { pathFromTree } from '../nav/tree.js';
import { legalisePath, headingSlug, slugify, slugifySegment } from './slugger.js';
import { classifyRedirect } from '@dai/content-contract';
import GithubSlugger from 'github-slugger';

export interface UrlPlanPage { id: string; old?: string; new: string; reason: string }
export interface UrlPlan {
  /**
   * Pages whose route the platform's slug rules erase: a title or path written in a script that
   * has no ASCII transliteration comes out empty, and numbering those pages would silently destroy
   * every URL the site had. Listed here so the stage can ask for a route instead of inventing one.
   */
  erased?: Array<{ id: string; source?: string; segments: string[] }>;
  mode: 'preserve' | 'restructure' | 'hybrid';
  scope: 'full' | 'partial';
  preserve: { strip_prefix?: string; case: 'preserve' | 'lower' };
  restructure: { strategy: 'from-nav' };
  /**
   * A link to a page this migration does not write (outside its scope, or excluded): `keep` leaves it as authored,
   * and the unmigrated-links gate fails while the output still points at the source site; `source` points links to
   * pages the source is known to publish at the source site, which must then stay up. Convert lists every such link
   * in report/unmigrated-links.json either way.
   */
  unmigratedLinks?: 'keep' | 'source';
  pages: UrlPlanPage[];
}

export function defaultUrlPlan(tree: Tree, opts: { mode?: UrlPlan['mode']; stripPrefix?: string; case?: 'preserve' | 'lower' } = {}): UrlPlan {
  const mode = opts.mode ?? 'preserve';
  const pages: UrlPlanPage[] = [];
  const used = new Set<string>();
  const planned: Array<{ id: string; old?: string; candidate: string; reason: string }> = [];
  /** Pages whose route the slug rules erased rather than transliterated; a route cannot be invented for them. */
  const erased: NonNullable<UrlPlan['erased']> = [];
  for (const p of tree.pages.filter((x) => x.migrate)) {
    let candidate: string; let reason: string;
    const old = p.oldPath;
    if (mode !== 'restructure' && old) {
      let stripped = old;
      if (opts.stripPrefix && stripped.startsWith(opts.stripPrefix)) stripped = stripped.slice(opts.stripPrefix.length);
      // The file extension a static site serves under is not part of the page's identity:
      // /guide.htm is the page "guide". Legalising it in place would route the page at
      // "guide-htm", because the dot is not a legal slug character and becomes a dash. An
      // index file names the directory holding it, the way a web server serves that directory.
      const withoutSuffix = stripped.replace(/\/index\.(?:html?|xhtml|php|aspx?|jsp)$/i, '/').replace(/\.(?:html?|xhtml|php|aspx?|jsp)$/i, '');
      const droppedSuffix = withoutSuffix !== stripped;
      stripped = withoutSuffix;
      const leg = legalisePath(stripped, { case: opts.case ?? 'preserve' });
      candidate = leg.path;
      if (leg.erased?.length) erased.push({ id: p.id, source: p.source, segments: leg.erased });
      const adjustments = [droppedSuffix ? 'dropped the source file extension' : undefined, leg.reason].filter(Boolean).join('; ');
      reason = adjustments ? `preserve (adjusted: ${adjustments})` : 'preserve';
    } else {
      candidate = pathFromTree(p); reason = 'restructure:nav';
      // The same erasure happens when a route is built from a title rather than a path.
      const fromTitle = [...p.group.filter((group) => group && group !== '(uncategorised)'), p.title].filter((part) => slugifySegment(part).erased);
      if (fromTitle.length) erased.push({ id: p.id, source: p.source, segments: fromTitle });
    }
    if (!candidate) {
      candidate = 'index';
      reason += '; root route -> index';
    }
    // versions and locales other than the default live under a prefix (documentation.json dimensions route them)
    const prefix = [p.locale && p.locale !== tree.defaultLocale ? slugify(p.locale) : '', p.version && p.version !== tree.defaultVersion ? slugify(p.version) : ''].filter(Boolean).join('/');
    if (prefix && !candidate.startsWith(prefix + '/')) { candidate = `${prefix}/${candidate}`; reason += `; ${prefix} prefix`; }
    if (!candidate) { candidate = 'index'; reason += '; root page → index'; }
    planned.push({ id: p.id, old, candidate, reason });
  }
  // A page already at a legal path keeps it; a page whose path had to be adjusted gives way on a collision, so its
  // redirect never runs through another page's old path (/a_b → /a-b while /a-b moved on is a chain).
  const finals = new Map<string, { final: string; reason: string }>();
  for (const settled of [true, false]) {
    for (const entry of planned) {
      if ((entry.reason === 'preserve') !== settled) continue;
      let final = entry.candidate; let n = 2;
      while (used.has(final)) final = `${entry.candidate}-${n++}`;
      used.add(final);
      finals.set(entry.id, { final, reason: final !== entry.candidate ? `${entry.reason}; collision → ${final}` : entry.reason });
    }
  }
  for (const entry of planned) pages.push({ id: entry.id, old: entry.old, new: finals.get(entry.id)!.final, reason: finals.get(entry.id)!.reason });
  return { mode, scope: tree.scope, preserve: { strip_prefix: opts.stripPrefix, case: opts.case ?? 'preserve' }, restructure: { strategy: 'from-nav' }, unmigratedLinks: 'keep', pages, ...(erased.length ? { erased } : {}) };
}

export function writeUrlPlan(workspace: string, plan: UrlPlan): void { writeFileSync(join(workspace, 'plan', 'urls.yaml'), toYaml(plan), { mode: 0o600 }); }
/**
 * An existing plan, plus the default entry for every migrating page it does not name. The
 * operator's entries are never changed; a new page whose default route collides with one of
 * theirs is refused rather than renumbered, because a route is an address the site publishes.
 */
export function extendUrlPlan(existing: UrlPlan, tree: Tree, opts: { mode?: UrlPlan['mode']; stripPrefix?: string; case?: 'preserve' | 'lower' } = {}): UrlPlan {
  const known = new Set(existing.pages.map((page) => page.id));
  const missing = tree.pages.filter((page) => page.migrate && !known.has(page.id));
  if (!missing.length) return existing;
  const defaults = defaultUrlPlan(tree, { ...opts, mode: existing.mode ?? opts.mode });
  const taken = new Map(existing.pages.map((page) => [page.new, page.id]));
  const added: UrlPlanPage[] = [];
  for (const page of defaults.pages) {
    if (known.has(page.id)) continue;
    const holder = taken.get(page.new);
    if (holder !== undefined && holder !== page.id) throw new Error(`page ${page.id} (${page.old ?? 'no source path'}) would take route ${page.new}, which plan/urls.yaml already gives page ${holder}; set its "new" path in plan/urls.yaml and run plan again`);
    added.push(page);
  }
  const erased = [...(existing.erased ?? []), ...(defaults.erased ?? []).filter((page) => !known.has(page.id))];
  return { ...existing, pages: [...existing.pages, ...added], ...(erased.length ? { erased } : {}) };
}

export function readUrlPlan(workspace: string): UrlPlan | undefined {
  const p = join(workspace, 'plan', 'urls.yaml');
  return existsSync(p) ? (parseYaml(readFileSync(p, 'utf8')) as UrlPlan) : undefined;
}

export function applyUrlPlan(tree: Tree, plan: UrlPlan): Tree {
  const byId = new Map(plan.pages.map((p) => [p.id, p]));
  return { ...tree, pages: tree.pages.map((p) => { const u = byId.get(p.id); return u ? { ...p, newPath: u.new, reason: p.migrate ? u.reason : p.reason } : p; }) };
}

export interface RedirectRule { source: string; destination: string; statusCode: number }

/**
 * Exact rules for every page whose old path differs from its new path; wildcard rules for renamed
 * subtrees.
 *
 * `writes` names the pages this migration actually writes. A page that left the scope keeps its
 * entry in the plan — plans are the operator's file and a stage never edits one — but it has no
 * destination to send a reader to, so it gets no rule. Without this a page excluded after planning
 * left a redirect pointing at a route nobody wrote.
 */
export function redirectMaps(plan: UrlPlan, writes?: (pageId: string) => boolean): { exact: RedirectRule[]; wildcard: RedirectRule[]; issues: string[] } {
  const exact: RedirectRule[] = [];
  const issues: string[] = [];
  const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
  for (const p of plan.pages) {
    if (!p.old) continue;
    if (writes && !writes(p.id)) continue;
    const from = norm(p.old); const to = norm(p.new);
    if (from === to) continue;
    exact.push({ source: from, destination: to, statusCode: 308 });
  }
  // uniqueness, loops, chains
  const bySource = new Map<string, RedirectRule>();
  for (const r of exact) {
    if (bySource.has(r.source)) issues.push(`duplicate source ${r.source}`);
    bySource.set(r.source, r);
  }
  for (const r of exact) {
    if (bySource.has(r.destination)) issues.push(`chain: ${r.source} → ${r.destination} → ${bySource.get(r.destination)!.destination}`);
    if (r.destination === r.source) issues.push(`loop: ${r.source}`);
  }
  for (const r of exact) if (classifyRedirect(r.source) === 'needs-wildcard') issues.push(`unsupported pattern in ${r.source}`);
  // Subtree candidates: an old prefix → new prefix shared by ≥ 3 pages, offered so an operator can
  // collapse many exact rules into one. A wildcard copies the splat verbatim, so it only says the
  // same thing as the rules it covers where the part after the prefix survives unchanged. Where the
  // filenames change too — preserve mode slugifies them, so `p_a_Step1.htm` becomes `p-a-step1` —
  // no single wildcard expresses the move, and proposing one would send every path it covers to a
  // page nobody wrote. Those subtrees keep their exact rules and get no candidate.
  const prefixPairs = new Map<string, { covered: number; splatSurvives: boolean }>();
  for (const r of exact) {
    const o = r.source.split('/').slice(0, -1).join('/'); const n = r.destination.split('/').slice(0, -1).join('/');
    if (!o || !n || o === n) continue;
    const key = `${o}|${n}`;
    const entry = prefixPairs.get(key) ?? { covered: 0, splatSurvives: true };
    entry.covered++;
    if (r.source.slice(o.length + 1) !== r.destination.slice(n.length + 1)) entry.splatSurvives = false;
    prefixPairs.set(key, entry);
  }
  // …and only where every exact rule anywhere beneath the old prefix agrees: `/docs/*` →
  // `/en/docs/:splat` is wrong for `/docs/documentation/fr/…`, which moves to `/fr/docs/…`, and a
  // candidate that covers those would send them to a page nobody wrote.
  const agreesBeneath = (o: string, n: string): boolean => exact.every((r) => !r.source.startsWith(`${o}/`) || r.destination === `${n}${r.source.slice(o.length)}`);
  const wildcard: RedirectRule[] = [...prefixPairs.entries()]
    .filter(([k, entry]) => { const [o, n] = k.split('|'); return entry.covered >= 3 && entry.splatSurvives && agreesBeneath(o, n); })
    .map(([k]) => { const [o, n] = k.split('|'); return { source: `${o}/*`, destination: `${n}/:splat`, statusCode: 308 }; });
  return { exact, wildcard, issues };
}

export interface AnchorEntry { pageId: string; headingText: string; oldId?: string; newId: string; needsShim: boolean; inboundLinks: number }

/** Compare source heading ids with the renderer's slugs; shim where an inbound link targets a differing id. */
export function anchorMap(pages: Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string; aliases?: string[]; component?: boolean }>; titleAnchor?: string }>, inbound: Map<string, number>): { entries: AnchorEntry[]; shims: Map<string, Map<string, string[]>>; leading: Map<string, string> } {
  const entries: AnchorEntry[] = [];
  const shims = new Map<string, Map<string, string[]>>();
  /** pageId → the anchor its title heading published, for pages something still links to by it. */
  const leading = new Map<string, string>();
  for (const p of pages) {
    // The title heading became the frontmatter title, so its anchor has no heading left to sit
    // before. It is written at the head of the body instead, and only where a link still uses it.
    if (p.titleAnchor && (inbound.get(`${p.pageId}#${p.titleAnchor}`) ?? inbound.get(`#${p.titleAnchor}`) ?? 0) > 0) leading.set(p.pageId, p.titleAnchor);
    const slugger = new GithubSlugger();
    for (const h of p.headings) {
      // A component's anchor is not a heading: the renderer gives it no id of its own to compare with.
      const newId = h.component ? '' : headingSlug(h.text, slugger);
      // The source may have published one heading under more than one address - a translated page
      // carries the original's anchor beside its own - and a link may use any of them. Every
      // spelling something points at is kept, not just the first: keeping only one left the pages
      // that link by the other spelling landing nowhere.
      const candidates = [h.sourceId, ...(h.aliases ?? [])].filter((id): id is string => !!id);
      const linksTo = (id: string): number => inbound.get(`${p.pageId}#${id}`) ?? inbound.get(`#${id}`) ?? 0;
      const linked = candidates.filter((id) => linksTo(id) > 0);
      const shimmed = [...new Set(linked.filter((id) => id !== newId))];
      const links = linked.reduce((total, id) => total + linksTo(id), 0);
      entries.push({ pageId: p.pageId, headingText: h.text, oldId: linked[0] ?? h.sourceId, newId, needsShim: shimmed.length > 0, inboundLinks: links });
      if (shimmed.length) { if (!shims.has(p.pageId)) shims.set(p.pageId, new Map()); shims.get(p.pageId)!.set(h.id, shimmed); }
    }
  }
  return { entries, shims, leading };
}
