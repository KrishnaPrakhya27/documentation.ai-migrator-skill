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
export function readUrlPlan(workspace: string): UrlPlan | undefined {
  const p = join(workspace, 'plan', 'urls.yaml');
  return existsSync(p) ? (parseYaml(readFileSync(p, 'utf8')) as UrlPlan) : undefined;
}

export function applyUrlPlan(tree: Tree, plan: UrlPlan): Tree {
  const byId = new Map(plan.pages.map((p) => [p.id, p]));
  return { ...tree, pages: tree.pages.map((p) => { const u = byId.get(p.id); return u ? { ...p, newPath: u.new, reason: u.reason } : p; }) };
}

export interface RedirectRule { source: string; destination: string; statusCode: number }

/** Exact rules for every page whose old path differs from its new path; wildcard rules for renamed subtrees. */
export function redirectMaps(plan: UrlPlan): { exact: RedirectRule[]; wildcard: RedirectRule[]; issues: string[] } {
  const exact: RedirectRule[] = [];
  const issues: string[] = [];
  const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
  for (const p of plan.pages) {
    if (!p.old) continue;
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
  // subtree candidates: old prefix → new prefix shared by ≥ 3 pages
  const prefixPairs = new Map<string, number>();
  for (const r of exact) {
    const o = r.source.split('/').slice(0, -1).join('/'); const n = r.destination.split('/').slice(0, -1).join('/');
    if (o && n && o !== n) prefixPairs.set(`${o}|${n}`, (prefixPairs.get(`${o}|${n}`) ?? 0) + 1);
  }
  const wildcard: RedirectRule[] = [...prefixPairs.entries()].filter(([, c]) => c >= 3).map(([k]) => { const [o, n] = k.split('|'); return { source: `${o}/*`, destination: `${n}/:splat`, statusCode: 308 }; });
  return { exact, wildcard, issues };
}

export interface AnchorEntry { pageId: string; headingText: string; oldId?: string; newId: string; needsShim: boolean; inboundLinks: number }

/** Compare source heading ids with the renderer's slugs; shim where an inbound link targets a differing id. */
export function anchorMap(pages: Array<{ pageId: string; headings: Array<{ id: string; text: string; sourceId?: string }> }>, inbound: Map<string, number>): { entries: AnchorEntry[]; shims: Map<string, Map<string, string>> } {
  const entries: AnchorEntry[] = [];
  const shims = new Map<string, Map<string, string>>();
  for (const p of pages) {
    const slugger = new GithubSlugger();
    for (const h of p.headings) {
      const newId = headingSlug(h.text, slugger);
      const key = `${p.pageId}#${h.sourceId ?? ''}`;
      const links = h.sourceId ? (inbound.get(key) ?? inbound.get(`#${h.sourceId}`) ?? 0) : 0;
      const needsShim = !!h.sourceId && h.sourceId !== newId && links > 0;
      entries.push({ pageId: p.pageId, headingText: h.text, oldId: h.sourceId, newId, needsShim, inboundLinks: links });
      if (needsShim) { if (!shims.has(p.pageId)) shims.set(p.pageId, new Map()); shims.get(p.pageId)!.set(h.id, h.sourceId!); }
    }
  }
  return { entries, shims };
}
