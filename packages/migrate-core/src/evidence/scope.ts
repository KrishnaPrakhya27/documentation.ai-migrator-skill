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
import { parse as parseYaml } from 'yaml';
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

export interface ScopeDecisions { excluded: ScopeExclusion[]; substituted: ScopeSubstitution[] }

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
excluded: []
#
# substituted: content the migration writes in place of something it cannot carry.
# Its words are the migrator's, not the source's, so each one is owned by a person.
#   - component: <source component name>
#     reason: <why nothing static can reproduce it>
#     approvedBy: <who approved it>
#     contentLoss: true|false
substituted: []
`;

/** Writes the commented template when the file does not exist; an existing file is never touched. */
export function ensureScopeDecisionsFile(workspace: string): void {
  const path = scopeDecisionsPath(workspace);
  if (!existsSync(path)) writeFileSync(path, TEMPLATE, { mode: 0o600 });
}

/** A missing file means no exclusions. A malformed entry is refused with its position and the field at fault. */
export function readScopeDecisions(workspace: string): ScopeDecisions {
  const path = scopeDecisionsPath(workspace);
  if (!existsSync(path)) return { excluded: [], substituted: [] };
  const parsed = parseYaml(readFileSync(path, 'utf8')) as { excluded?: unknown; substituted?: unknown } | null;
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
  return { excluded, substituted };
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
