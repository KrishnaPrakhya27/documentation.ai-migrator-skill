/**
 * Migrator provenance: which build of this tool produced a session's output.
 * `init` pins the commit and the exact uncommitted state of the migrator
 * checkout; `verify` refuses to certify output from any other build, because
 * the gates only prove exactness for the code that actually ran.
 */
import { execFileSync } from 'node:child_process';
import { sha256 } from './ids.js';

export interface MigratorProvenance {
  /** Commit the migrator ran from (`git rev-parse HEAD`). */
  gitSha: string;
  /** The checkout differs from the commit: tracked changes or untracked files. */
  dirty: boolean;
  /** sha256 over the tracked diff against HEAD plus the untracked file list and blob ids; null when clean. */
  dirtyHash: string | null;
  packageVersion: string;
}

/** Exactly what `dirtyHash` is taken over, printed wherever the hash is so no report claims the hash covers more than it does. */
export const DIRTY_HASH_COVERAGE = 'tracked diff against HEAD plus untracked file list and blob ids';

/** Runs one read-only git command in the migrator checkout and returns its stdout. Injectable so tests can describe a fake tree. */
export type GitRunner = (args: string[]) => string;

export interface ProvenanceInput {
  repoRoot: string;
  packageVersion: string;
  git?: GitRunner;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const DIFF_HASH = /^[0-9a-f]{64}$/;

/**
 * Every field of a session's recorded provenance, or the name of the first one that is
 * wrong. A half-written record pins nothing, so verify must not accept one.
 */
export function migratorProvenanceProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return 'migrator';
  const migrator = value as Partial<MigratorProvenance>;
  if (typeof migrator.gitSha !== 'string' || !COMMIT_SHA.test(migrator.gitSha)) return 'migrator.gitSha';
  if (typeof migrator.dirty !== 'boolean') return 'migrator.dirty';
  if (migrator.dirtyHash !== null && (typeof migrator.dirtyHash !== 'string' || !DIFF_HASH.test(migrator.dirtyHash))) return 'migrator.dirtyHash';
  if (migrator.dirty && migrator.dirtyHash === null) return 'migrator.dirtyHash';
  if (typeof migrator.packageVersion !== 'string' || !migrator.packageVersion) return 'migrator.packageVersion';
  return undefined;
}

export function gitRunnerFor(repoRoot: string): GitRunner {
  // GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the index, so provenance capture never writes to the checkout
  return (args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
}

export function captureMigratorProvenance(input: ProvenanceInput): MigratorProvenance {
  const git = input.git ?? gitRunnerFor(input.repoRoot);
  let gitSha: string;
  try {
    gitSha = git(['rev-parse', 'HEAD']).trim();
  } catch (error) {
    throw new Error(`migrator provenance: ${input.repoRoot} is not a git checkout with a commit (git rev-parse HEAD: ${firstLine(error)}); the migrator must run from a git checkout so the session can pin its commit`);
  }
  if (!COMMIT_SHA.test(gitSha)) throw new Error(`migrator provenance: unexpected "git rev-parse HEAD" output "${gitSha}" in ${input.repoRoot}`);
  const status = workingTreeStatus(git);
  const dirty = status.length > 0;
  return { gitSha, dirty, dirtyHash: dirty ? sha256(uncommittedState(git, status)) : null, packageVersion: input.packageVersion };
}

/** Differences between the pinned and the current migrator, one line each; empty when they are the same build. */
export function migratorDrift(pinned: MigratorProvenance, current: MigratorProvenance): string[] {
  const drift: string[] = [];
  if (pinned.gitSha !== current.gitSha) drift.push(`commit ${pinned.gitSha} → ${current.gitSha}`);
  if (pinned.dirtyHash !== current.dirtyHash) drift.push(`uncommitted changes ${describeDirtyState(pinned)} → ${describeDirtyState(current)}`);
  if (pinned.packageVersion !== current.packageVersion) drift.push(`package version ${pinned.packageVersion} → ${current.packageVersion}`);
  return drift;
}

export function describeMigrator(migrator: MigratorProvenance): string {
  return `${migrator.gitSha} (${describeDirtyState(migrator)}) v${migrator.packageVersion}`;
}

function describeDirtyState(migrator: MigratorProvenance): string {
  return migrator.dirty ? `dirty, diff sha256 ${migrator.dirtyHash}` : 'clean';
}

interface StatusEntry { code: string; path: string }

/** `git status --porcelain -z`: `XY path`, NUL-terminated and unquoted; renames and copies carry the original path as a second field. */
function workingTreeStatus(git: GitRunner): StatusEntry[] {
  const fields = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i].slice(0, 2);
    entries.push({ code, path: fields[i].slice(3) });
    if (/[RC]/.test(code)) i++;
  }
  return entries;
}

/** `git diff` cannot see untracked files, so their blob ids are hashed alongside the tracked diff. */
function uncommittedState(git: GitRunner, status: StatusEntry[]): string {
  const trackedDiff = git(['diff', '--no-ext-diff', '--no-color', 'HEAD', '--']);
  const untrackedBlobs = status.filter((entry) => entry.code === '??').map((entry) => `?? ${entry.path}\0${git(['hash-object', '--', entry.path]).trim()}`);
  return [trackedDiff, ...untrackedBlobs].join('\n');
}

function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr;
  const text = stderr ? String(stderr).trim() : (error as Error).message;
  return text.split('\n')[0];
}
