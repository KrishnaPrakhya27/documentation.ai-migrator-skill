/**
 * Scope decisions: the only way a published source page may leave a migration.
 *
 * `migrate: false` in plan/tree.yaml is an operator edit with no provenance. An
 * exclusion counts only when plan/scope-decisions.yaml names the page, its source
 * identity, the reason and who approved it. Coverage is then accounted against the
 * frozen source manifest, never against the tree, so deleting a page from the tree
 * and the navigation together cannot make it disappear.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { SourceManifest, SourceManifestPage } from './manifest.js';

export interface ScopeExclusion {
  pageId: string;
  /** Must equal the manifest's sourceId for the page, so a decision cannot be moved onto another page by editing an id. */
  sourceId: string;
  reason: string;
  approvedBy: string;
  approvedAt?: string;
}

/**
 * Content the migration writes that the source never stated. A live demo cannot be reproduced
 * statically, so a card naming the tool takes its place - and that card's words are the migrator's,
 * not the author's. Exact fidelity refuses invented content, and rightly: the only thing that makes
 * one acceptable is a named person deciding it, which is what this records. It is deliberately not
 * an equivalence, because the two are not equal and no future reader should be told they were.
 */
export interface ScopeSubstitution {
  /** Source component being replaced, by name, so one decision covers every locale that uses it. */
  component: string;
  reason: string;
  approvedBy: string;
  approvedAt?: string;
  /** Whether the reader loses content rather than convenience; reported to the customer either way. */
  contentLoss?: boolean;
}


/**
 * An asset the migration does not carry. Exact fidelity ships no page missing media and no page
 * pointing at a source host, so an asset that cannot be hosted normally ends the run. This is the
 * one way past that, and it is deliberately narrow: a named person accepts the loss for one exact
 * source URL, the reference is removed from every page that used it rather than left pointing at
 * the old platform, and the customer report names it. It records a loss — it never claims the page
 * is unchanged.
 */
export interface ScopeAssetExclusion {
  /**
   * The asset's content hash from plan/assets.json. Preferred over `url`, and the only usable key
   * for an asset whose address carries an access token: a signed URL is a credential, and a plan
   * file is not where one belongs. Exactly one of `hash` or `url` identifies the asset.
   */
  hash?: string;
  /** The asset's source URL, exactly as the manifest recorded it. Use `hash` when the URL is signed. */
  url?: string;
  /** What the asset is, in words, since a hash says nothing to the next reader. */
  describe?: string;
  reason: string;
  approvedBy: string;
  approvedAt?: string;
}

/**
 * A help system published on the host that this run does not migrate. It is a separate decision
 * type rather than a free-text waiver so it can only ever resolve the issue a second help system
 * raises — never a truncated crawl or an unreadable index, which no approval may wave through.
 */
export interface HelpSystemDecision {
  /** The help system's root, as discovery reported it. */
  root: string;
  /** The frozen manifest issue this decision answers, verbatim. */
  issue: string;
  reason: string;
  approvedBy: string;
  approvedAt?: string;
}

/**
 * A difference between the migrated page and a source witness that a named person accepted, because
 * its cause is outside the migration: a directive the target contract cannot express, or a source
 * that states one thing in its published Markdown and another in its rendered page.
 *
 * Narrow by construction. It names one route and quotes part of the difference the gate itself
 * reported, so it can only ever answer that difference on that page: a second difference appearing
 * later on the same page is still reported. Only the two witness gates may be answered this way -
 * never conversion fidelity, never the content comparison - because those measure what the
 * migration did, not what the source says about itself.
 */
export interface AcceptedDifference { route: string; gate: string; detail: string; reason: string; approvedBy: string; approvedAt?: string }

/** The gates a recorded difference may answer: the two that compare the output with a source witness. */
export const ANSWERABLE_GATES: ReadonlySet<string> = new Set(['source-metadata-exact', 'html-reconciliation']);

export interface ScopeDecisions { excluded: ScopeExclusion[]; substituted: ScopeSubstitution[]; assets: ScopeAssetExclusion[]; helpSystems: HelpSystemDecision[]; differences: AcceptedDifference[] }

export function scopeDecisionsPath(workspace: string): string {
  return join(workspace, 'plan', 'scope-decisions.yaml');
}

const TEMPLATE = `# Scope decisions: the only way a published source page leaves this migration.
# A page set to migrate: false in plan/tree.yaml without an entry here fails verification.
#
# excluded:
#   - pageId: <page id from plan/tree.yaml>
#     sourceId: <sourceId from source-cache/source-manifest.json>
#     reason: <why this page is not migrated>
#     approvedBy: <who approved it>
#     approvedAt: <ISO date>
#
# helpSystems records a whole help system published on the host that this run does not migrate.
# Written by "discover --exclude-help-system <root> --by <who>"; each entry quotes the frozen
# manifest issue it answers, and every page under that root needs an excluded entry above.
excluded: []
#
# substituted: content the migration writes in place of something it cannot carry.
# Its words are the migrator's, not the source's, so each one is owned by a person.
#   - component: <source component name>
#     reason: <why nothing static can reproduce it>
#     approvedBy: <who approved it>
#     contentLoss: true|false
substituted: []
#
# assets: media the migration does not carry, by exact source URL. The reference is removed from
# every page that used it; exact mode never leaves it pointing at the source host.
#   - hash: <content hash from plan/assets.json>   # or url: <source URL, when it carries no token>
#     describe: <what the asset is, since a hash says nothing>
#     reason: <why it cannot be hosted>
#     approvedBy: <who approved it>
#     approvedAt: <ISO date>
assets: []
# differences: a difference from a source witness that a person accepted, because its cause is
# outside the migration: a directive the target cannot express, or a source whose published Markdown
# and rendered page disagree. It quotes part of the difference the gate reported, so it answers that
# difference on that page and nothing else.
#   - route: <output route>
#     gate: source-metadata-exact | html-reconciliation
#     detail: <words from the reported difference>
#     reason: <why it is accepted>
#     approvedBy: <who approved it>
differences: []
helpSystems: []
`;

/** Writes the commented template when the file does not exist; an existing file is never touched. */
export function ensureScopeDecisionsFile(workspace: string): void {
  const path = scopeDecisionsPath(workspace);
  if (!existsSync(path)) writeFileSync(path, TEMPLATE, { mode: 0o600 });
}

/** A missing file means no exclusions. A malformed entry is refused with its position and the field at fault. */
export function readScopeDecisions(workspace: string): ScopeDecisions {
  const path = scopeDecisionsPath(workspace);
  if (!existsSync(path)) return { excluded: [], substituted: [], assets: [], helpSystems: [], differences: [] };
  const parsed = parseYaml(readFileSync(path, 'utf8')) as { excluded?: unknown; substituted?: unknown; helpSystems?: unknown } | null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.excluded)) throw new Error(`${path}: expected an object with an excluded list`);
  const entries = parsed.excluded;
  if (!Array.isArray(entries)) throw new Error(`${path}: excluded must be a list`);
  const seen = new Set<string>();
  const excluded = entries.map((entry, index): ScopeExclusion => {
    const where = `${path}: excluded[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const record = entry as Record<string, unknown>;
    for (const field of ['pageId', 'sourceId', 'reason', 'approvedBy'] as const) {
      if (typeof record[field] !== 'string' || !(record[field] as string).trim()) throw new Error(`${where} needs a non-empty ${field}`);
    }
    if (record.approvedAt !== undefined && typeof record.approvedAt !== 'string') throw new Error(`${where}.approvedAt must be a string`);
    const pageId = record.pageId as string;
    if (seen.has(pageId)) throw new Error(`${where} repeats pageId ${pageId}`);
    seen.add(pageId);
    return { pageId, sourceId: record.sourceId as string, reason: record.reason as string, approvedBy: record.approvedBy as string, ...(record.approvedAt ? { approvedAt: record.approvedAt as string } : {}) };
  });
  const rawSubstituted = parsed.substituted;
  if (rawSubstituted !== undefined && rawSubstituted !== null && !Array.isArray(rawSubstituted)) throw new Error(`${path}: substituted must be a list`);
  const byComponent = new Set<string>();
  const substituted = ((rawSubstituted ?? []) as unknown[]).map((entry, index): ScopeSubstitution => {
    const where = `${path}: substituted[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const record = entry as Record<string, unknown>;
    for (const field of ['component', 'reason', 'approvedBy'] as const) {
      if (typeof record[field] !== 'string' || !(record[field] as string).trim()) throw new Error(`${where}.${field} is required`);
    }
    if (record.approvedAt !== undefined && typeof record.approvedAt !== 'string') throw new Error(`${where}.approvedAt must be a string`);
    if (record.contentLoss !== undefined && typeof record.contentLoss !== 'boolean') throw new Error(`${where}.contentLoss must be true or false`);
    const component = (record.component as string).trim();
    // One decision per component, applied wherever it appears, so locales cannot diverge.
    if (byComponent.has(component)) throw new Error(`${where} repeats component ${component}`);
    byComponent.add(component);
    return {
      component, reason: record.reason as string, approvedBy: record.approvedBy as string,
      ...(record.approvedAt ? { approvedAt: record.approvedAt as string } : {}),
      ...(record.contentLoss !== undefined ? { contentLoss: record.contentLoss as boolean } : {}),
    };
  });
  const rawAssets = (parsed as { assets?: unknown }).assets;
  if (rawAssets !== undefined && rawAssets !== null && !Array.isArray(rawAssets)) throw new Error(`${path}: assets must be a list`);
  const byUrl = new Set<string>();
  const assets = ((rawAssets ?? []) as unknown[]).map((entry, index): ScopeAssetExclusion => {
    const where = `${path}: assets[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const record = entry as Record<string, unknown>;
    for (const field of ['reason', 'approvedBy'] as const) {
      if (typeof record[field] !== 'string' || !(record[field] as string).trim()) throw new Error(`${where}.${field} is required`);
    }
    for (const field of ['hash', 'url', 'describe'] as const) {
      if (record[field] !== undefined && (typeof record[field] !== 'string' || !(record[field] as string).trim())) throw new Error(`${where}.${field} must be a non-empty string`);
    }
    if (record.approvedAt !== undefined && typeof record.approvedAt !== 'string') throw new Error(`${where}.approvedAt must be a string`);
    const hash = record.hash ? (record.hash as string).trim() : undefined;
    const url = record.url ? (record.url as string).trim() : undefined;
    if (!hash && !url) throw new Error(`${where} needs a hash or a url to identify the asset`);
    const key = hash ?? url!;
    if (byUrl.has(key)) throw new Error(`${where} repeats ${hash ? 'hash' : 'url'} ${key}`);
    byUrl.add(key);
    return {
      ...(hash ? { hash } : {}), ...(url ? { url } : {}),
      ...(record.describe ? { describe: (record.describe as string).trim() } : {}),
      reason: record.reason as string, approvedBy: record.approvedBy as string,
      ...(record.approvedAt ? { approvedAt: record.approvedAt as string } : {}),
    };
  });
  const declared = (parsed as { helpSystems?: unknown }).helpSystems;
  if (declared !== undefined && !Array.isArray(declared)) throw new Error(`${path}: helpSystems must be a list`);
  const helpSystems = (declared ?? []).map((entry, index): HelpSystemDecision => {
    const where = `${path}: helpSystems[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const record = entry as Record<string, unknown>;
    for (const field of ['root', 'issue', 'reason', 'approvedBy'] as const) {
      if (typeof record[field] !== 'string' || !(record[field] as string).trim()) throw new Error(`${where} needs a non-empty ${field}`);
    }
    return { root: record.root as string, issue: record.issue as string, reason: record.reason as string, approvedBy: record.approvedBy as string, ...(record.approvedAt ? { approvedAt: record.approvedAt as string } : {}) };
  });
  const stated = (parsed as { differences?: unknown }).differences;
  if (stated !== undefined && stated !== null && !Array.isArray(stated)) throw new Error(`${path}: differences must be a list`);
  const differences = ((stated ?? []) as unknown[]).map((entry, index): AcceptedDifference => {
    const where = `${path}: differences[${index}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const record = entry as Record<string, unknown>;
    for (const field of ['route', 'gate', 'detail', 'reason', 'approvedBy'] as const) {
      if (typeof record[field] !== 'string' || !(record[field] as string).trim()) throw new Error(`${where} needs a non-empty ${field}`);
    }
    const gate = (record.gate as string).trim();
    if (!ANSWERABLE_GATES.has(gate)) throw new Error(`${where}.gate must be one of ${[...ANSWERABLE_GATES].join(', ')}: only a witness disagreeing with the source can be accepted, never what the conversion did`);
    if (record.approvedAt !== undefined && typeof record.approvedAt !== 'string') throw new Error(`${where}.approvedAt must be a string`);
    return { route: (record.route as string).trim(), gate, detail: (record.detail as string).trim(), reason: record.reason as string, approvedBy: record.approvedBy as string, ...(record.approvedAt ? { approvedAt: record.approvedAt as string } : {}) };
  });
  return { excluded, substituted, assets, helpSystems, differences };
}

/**
 * A help system discovery found, reduced to what a scope decision needs. Kept structural rather
 * than imported so scope accounting stays independent of the crawler.
 */
export interface DiscoveredHelpSystem { root: string; seed: boolean; issue?: string }

export interface HelpSystemScopeResult {
  exclusions: ScopeExclusion[];
  /** The decisions to record, one per help system left out. */
  decisions: HelpSystemDecision[];
  /** Manifest issues these decisions answer. Any issue not listed here still stops an exact run. */
  answeredIssues: string[];
  /** Why a named root was not accepted. A refusal is fatal: a mistyped root must never pass silently. */
  refusals: string[];
}

/**
 * The manifest issues the decisions already recorded in this workspace answer.
 *
 * An approval is given once. A later re-derivation of the same capture — an offline rebuild after
 * a migrator fix — must honour it without the operator re-typing it on the command line, which
 * would otherwise risk recording a different approver for a decision already made.
 */
export function answeredHelpSystemIssues(decisions: ScopeDecisions, issues: readonly string[]): string[] {
  return decisions.helpSystems.map((entry) => entry.issue).filter((issue) => issues.includes(issue));
}

/** A help-system root names a directory, so it compares with a trailing slash however it was typed. */
function normaliseRoot(root: string): string | undefined {
  let url: URL;
  try { url = new URL(root); } catch { return undefined; }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.hash = ''; url.search = '';
  return url.toString();
}

/**
 * The exclusions that answer "which help system does this run migrate?".
 *
 * A host may publish several independent help systems. Discovery reports every one it finds and
 * refuses to merge their sidebars; this turns the operator's answer into the same attributed
 * exclusions any other out-of-scope page needs, so the source universe still reconciles page for
 * page against the frozen manifest. The seed's own help system can never be excluded, and a root
 * that matches nothing discovered is refused rather than ignored: both would otherwise drop pages
 * on a typo.
 */
export function excludeHelpSystems(input: {
  roots: readonly string[];
  helpSystems: readonly DiscoveredHelpSystem[];
  manifestPages: readonly SourceManifestPage[];
  approvedBy: string;
  approvedAt: string;
}): HelpSystemScopeResult {
  const result: HelpSystemScopeResult = { exclusions: [], decisions: [], answeredIssues: [], refusals: [] };
  const found = new Map<string, DiscoveredHelpSystem>();
  for (const system of input.helpSystems) {
    const key = normaliseRoot(system.root);
    if (key) found.set(key, system);
  }
  const known = [...found.keys()].sort();
  const claimed = new Set<string>();
  for (const root of input.roots) {
    const key = normaliseRoot(root);
    if (!key) { result.refusals.push(`${root}: not a URL`); continue; }
    const system = found.get(key);
    if (!system) { result.refusals.push(`${root}: names no help system found on this host; discovery found ${known.length ? known.join(', ') : 'none'}`); continue; }
    if (system.seed) { result.refusals.push(`${root}: this is the help system the seed belongs to, whose navigation the run states; it cannot be excluded from its own migration`); continue; }
    if (claimed.has(key)) continue;
    claimed.add(key);
    if (system.issue) result.answeredIssues.push(system.issue);
    const reason = `published under the separate MadCap help system at ${key}, which states its own navigation; this run migrates the help system at the seed URL`;
    if (system.issue) result.decisions.push({ root: key, issue: system.issue, reason, approvedBy: input.approvedBy, approvedAt: input.approvedAt });
    for (const page of input.manifestPages) {
      if (!page.published) continue;
      const location = page.location;
      if (location !== key && location !== key.replace(/\/$/, '') && !location.startsWith(key)) continue;
      result.exclusions.push({ pageId: page.pageId, sourceId: page.sourceId, reason, approvedBy: input.approvedBy, approvedAt: input.approvedAt });
    }
  }
  return result;
}

/**
 * Adds exclusions and help-system decisions to plan/scope-decisions.yaml, keeping every decision
 * already recorded there. A page already excluded keeps its original entry: a re-run never
 * rewrites an approval, so who approved what stays true.
 */
export function recordScopeExclusions(workspace: string, entries: readonly ScopeExclusion[], decisions: readonly HelpSystemDecision[] = []): number {
  ensureScopeDecisionsFile(workspace);
  const existing = readScopeDecisions(workspace);
  const have = new Set(existing.excluded.map((entry) => entry.pageId));
  const added = entries.filter((entry) => !have.has(entry.pageId));
  const known = new Set(existing.helpSystems.map((entry) => entry.root));
  const newDecisions = decisions.filter((entry) => !known.has(entry.root));
  if (!added.length && !newDecisions.length) return 0;
  const record = { excluded: [...existing.excluded, ...added], substituted: existing.substituted, helpSystems: [...existing.helpSystems, ...newDecisions], differences: existing.differences };
  writeFileSync(scopeDecisionsPath(workspace), `${TEMPLATE.slice(0, TEMPLATE.indexOf('excluded: []'))}${toYaml(record)}`, { mode: 0o600 });
  return added.length;
}

export interface UniversePage { id: string; source?: string; migrate: boolean; newPath?: string }

export interface UniverseAccount {
  published: number;
  migrated: number;
  quarantined: number;
  excluded: number;
  /** Source files the platform does not publish; reported, never required. */
  unpublished: number;
  /** Published pages with no outcome: not migrated and no approved exclusion. */
  undecided: SourceManifestPage[];
  /** Pages in scope that were neither written nor quarantined. */
  unwritten: SourceManifestPage[];
  /** Tree pages set to migrate that the frozen source never listed. */
  notInSource: UniversePage[];
  /** Exclusions naming a page the manifest does not list, or a page that is also being migrated. */
  staleExclusions: ScopeExclusion[];
  /** Exclusions whose sourceId disagrees with the manifest entry for that page. */
  mismatchedExclusions: ScopeExclusion[];
  integrityProblems: string[];
}

/**
 * Every page the source published, and every page the migration claims, reconciled in
 * both directions. `written` holds the new paths of files convert wrote.
 */
export function accountSourceUniverse(input: {
  manifest: SourceManifest;
  treePages: readonly UniversePage[];
  written: ReadonlySet<string>;
  quarantined: ReadonlySet<string>;
  decisions: ScopeDecisions;
}): UniverseAccount {
  const tree = new Map(input.treePages.map((page) => [page.id, page]));
  const exclusions = new Map(input.decisions.excluded.map((entry) => [entry.pageId, entry]));
  const account: UniverseAccount = { published: 0, migrated: 0, quarantined: 0, excluded: 0, unpublished: 0, undecided: [], unwritten: [], notInSource: [], staleExclusions: [], mismatchedExclusions: [], integrityProblems: [] };
  const ids = new Set<string>(); const paths = new Set<string>();
  for (const page of input.treePages) {
    if (ids.has(page.id)) account.integrityProblems.push(`${page.id}: duplicate tree identity`);
    ids.add(page.id);
    if (page.migrate && page.newPath) {
      if (paths.has(page.newPath)) account.integrityProblems.push(`${page.newPath}: output claimed by multiple pages`);
      paths.add(page.newPath);
    }
  }
  for (const path of input.written) if (!paths.has(path)) account.integrityProblems.push(`${path}: output has no in-scope source page`);
  const listed = new Set<string>();

  for (const page of input.manifest.pages) {
    listed.add(page.pageId);
    if (page.published) account.published++;
    const treePage = tree.get(page.pageId);
    const exclusion = exclusions.get(page.pageId);
    if (treePage && treePage.source !== page.location) account.integrityProblems.push(`${page.sourceId}: tree source changed from ${page.location} to ${treePage.source ?? 'missing'}`);
    if (treePage?.migrate) {
      if (exclusion) account.staleExclusions.push(exclusion);
      if (treePage.newPath && input.written.has(treePage.newPath)) account.migrated++;
      else if (input.quarantined.has(page.pageId)) account.quarantined++;
      else account.unwritten.push(page);
      continue;
    }
    if (exclusion) {
      if (exclusion.sourceId !== page.sourceId) account.mismatchedExclusions.push(exclusion);
      else account.excluded++;
      continue;
    }
    if (page.published) account.undecided.push(page);
    else account.unpublished++;
  }

  for (const page of input.treePages) if (page.migrate && !listed.has(page.id)) account.notInSource.push(page);
  for (const exclusion of input.decisions.excluded) if (!listed.has(exclusion.pageId)) account.staleExclusions.push(exclusion);
  return account;
}

/** The problems that stop certification, in the order an operator should fix them. */
export function universeProblems(account: UniverseAccount): string[] {
  return [
    ...account.integrityProblems,
    ...account.undecided.map((page) => `${page.sourceId}: published in the source but neither migrated nor excluded in plan/scope-decisions.yaml`),
    ...account.unwritten.map((page) => `${page.sourceId}: in scope but no output was written and it was not quarantined`),
    ...account.notInSource.map((page) => `${page.source}: set to migrate but not in the frozen source manifest`),
    ...account.mismatchedExclusions.map((entry) => `${entry.pageId}: excluded under sourceId ${entry.sourceId}, which is not this page's source identity`),
    ...account.staleExclusions.map((entry) => `${entry.pageId}: exclusion names a page that is migrated or not in the source`),
  ];
}
