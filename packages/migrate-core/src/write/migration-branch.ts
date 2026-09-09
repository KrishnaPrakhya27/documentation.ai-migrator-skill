/**
 * Git writer, v1 and only: refs/heads/migration/<session-id>, files at the
 * repository root, one commit, one push after validation. Never force-push,
 * never a protected branch, never a personal remote, never /api/v1/push.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface WriteOptions {
  repoDir: string;
  outputDir: string;
  sessionId: string;
  /** Remote URL; must be under an allowed org. */
  remote?: string;
  allowedRemoteOrgs?: string[];
  baseBranch?: string;
  push?: boolean;
  authorName?: string;
  authorEmail?: string;
  message?: string;
}

const PROTECTED = new Set(['main', 'master', 'production', 'live', 'develop']);

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function remoteOrg(remote: string): { host: string; org: string } | null {
  const scp = remote.match(/^[\w.-]+@([^:/]+):([^/]+)\/.+?(?:\.git)?\/?$/);
  if (scp) return { host: scp[1], org: scp[2] };
  try {
    const u = new URL(remote);
    if (!['http:', 'https:', 'ssh:'].includes(u.protocol)) return null;
    const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    return parts.length >= 2 ? { host: u.hostname, org: parts[0] } : null;
  } catch {
    return null;
  }
}

export function assertRemoteAllowed(remote: string, allowedOrgs: string[]): void {
  const r = remoteOrg(remote);
  if (!r) throw new Error(`cannot parse remote ${remote}`);
  // Allowlist entries are host/org pairs ("github.com/acme-docs"); a bare org implies github.com.
  const allowed = allowedOrgs.map((o) => (o.includes('/') ? o : `github.com/${o}`).toLowerCase());
  if (!allowed.includes(`${r.host}/${r.org}`.toLowerCase())) {
    throw new Error(`remote org "${r.org}" is not in the allowed list [${allowedOrgs.join(', ')}]. Migrations land in the customer's org or the demo org, never a personal account.`);
  }
}

function clearTree(dir: string) {
  for (const f of readdirSync(dir)) { if (f === '.git') continue; rmSync(join(dir, f), { recursive: true, force: true }); }
}

export function writeMigrationBranch(opts: WriteOptions): { branch: string; commit: string; pushed: boolean } {
  if (!/^[A-Za-z0-9._-]+$/.test(opts.sessionId)) throw new Error('session id contains characters unsafe for a git ref');
  const branch = `migration/${opts.sessionId}`;
  if (PROTECTED.has(branch)) throw new Error('refusing protected branch');
  const { repoDir } = opts;
  if (!opts.allowedRemoteOrgs?.length) throw new Error('allowed remote organizations are required; refusing an unscoped write');
  if (!existsSync(opts.outputDir) || !existsSync(join(opts.outputDir, 'documentation.json'))) {
    throw new Error('output is incomplete: output/documentation.json is required before write');
  }
  if (opts.remote) assertRemoteAllowed(opts.remote, opts.allowedRemoteOrgs);
  if (!existsSync(join(repoDir, '.git'))) {
    if (!opts.remote) throw new Error(`${repoDir} is not a git repository and no --remote given`);
    mkdirSync(repoDir, { recursive: true });
    git(repoDir, ['clone', '--quiet', opts.remote, '.']);
  }
  const remote = opts.remote ?? git(repoDir, ['remote', 'get-url', 'origin']);
  assertRemoteAllowed(remote, opts.allowedRemoteOrgs);

  git(repoDir, ['fetch', '--quiet', 'origin']);
  const base = opts.baseBranch ?? git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith('-') || base.includes('..')) throw new Error(`unsafe base branch ${base}`);
  // collision: refuse to reuse an existing migration ref
  const exists = (ref: string) => { try { git(repoDir, ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; } };
  if (exists(`refs/remotes/origin/${branch}`) || exists(`refs/heads/${branch}`)) throw new Error(`branch ${branch} already exists; bump the session id rather than overwriting`);

  // Build in an isolated git worktree. The operator's checkout, current branch,
  // untracked files and in-progress edits remain untouched.
  const tempRoot = mkdtempSync(join(tmpdir(), 'dai-migrate-write-'));
  const worktree = join(tempRoot, 'checkout');
  let added = false;
  try {
    git(repoDir, ['worktree', 'add', '--quiet', '-b', branch, worktree, `origin/${base}`]);
    added = true;
    clearTree(worktree);
    cpSync(opts.outputDir, worktree, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes('.git') });
    git(worktree, ['add', '-A']);
    const env = { GIT_AUTHOR_NAME: opts.authorName ?? 'dai-migrate', GIT_AUTHOR_EMAIL: opts.authorEmail ?? 'migrations@documentation.ai', GIT_COMMITTER_NAME: opts.authorName ?? 'dai-migrate', GIT_COMMITTER_EMAIL: opts.authorEmail ?? 'migrations@documentation.ai' };
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', opts.message ?? `chore(migration): import session ${opts.sessionId}`], { cwd: worktree, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = git(worktree, ['rev-parse', 'HEAD']);
    let pushed = false;
    if (opts.push) { git(worktree, ['push', '--quiet', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]); pushed = true; } // no --force, ever
    return { branch, commit, pushed };
  } finally {
    if (added) {
      try { git(repoDir, ['worktree', 'remove', '--force', worktree]); } catch { /* retain the branch, clean the temporary directory below */ }
    }
    rmSync(tempRoot, { recursive: true, force: true });
    try { git(repoDir, ['worktree', 'prune']); } catch { /* best effort */ }
  }
}

export function outputSize(dir: string): number {
  let n = 0;
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else n += s.size; } };
  walk(dir);
  return n;
}
