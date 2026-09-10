/**
 * Preflight at `init`: the tool refuses to start a migration that cannot
 * land safely, and it settles every connection question up front so the
 * later stages never discover them. Checks that need the platform API are
 * skipped with an explicit `not-checked` when no API key is configured, and
 * the session records that.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadContract } from '@dai/content-contract';
import type { SessionTarget } from './workspace.js';
import { remoteOrg, assertRemoteAllowed } from '../write/migration-branch.js';
import { DaiClient } from './platform.js';

const execFileAsync = promisify(execFile);

export interface PreflightCheck { id: string; status: 'ok' | 'fail' | 'not-checked'; detail: string }

export interface PreflightOptions {
  target: SessionTarget;
  allowedRemoteOrgs: string[];
  daiApiBase?: string;
  daiApiKey?: string;
  /** S3/R2 provider configured through env; used to recommend an asset provider. */
  s3Configured?: boolean;
  fetchImpl?: typeof fetch;
  /** Injectable for tests: branch names and default branch of a git remote. */
  listRemote?: (remote: string) => Promise<{ defaultBranch?: string; branches: string[] }>;
  /** Injectable for tests: whether this machine can push to the remote. */
  probePush?: (remote: string) => Promise<PushProbe>;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** What the session should remember so later stages do not re-ask. */
  target: Partial<SessionTarget>;
}

/** `git ls-remote --symref` without credentials in the URL; the operator's git auth applies. */
export async function listRemote(remote: string): Promise<{ defaultBranch?: string; branches: string[] }> {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', remote, 'HEAD', 'refs/heads/*'], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const branches: string[] = []; let defaultBranch: string | undefined;
  for (const line of stdout.split('\n')) {
    const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) { defaultBranch = sym[1]; continue; }
    const m = line.match(/^[0-9a-f]{40}\s+refs\/heads\/(.+)$/);
    if (m) branches.push(m[1]);
  }
  return { defaultBranch, branches };
}

export interface PushProbe { ok: boolean; transport: 'https' | 'ssh' | 'other'; detail: string; fix?: string }

/** Guidance the operator can act on, by transport and by what git reported. */
export function pushFix(transport: PushProbe['transport'], stderr: string): string {
  if (transport === 'ssh') return 'this machine\'s SSH key is not registered with the git host, or none exists: add it under GitHub → Settings → SSH and GPG keys (or switch --remote to the HTTPS URL and use gh auth login && gh auth setup-git)';
  if (/could not read Username|terminal prompts disabled|Authentication failed|403|Permission to .* denied/i.test(stderr)) return 'no git credentials for this host: run `gh auth login` (GitHub.com → HTTPS → browser) then `gh auth setup-git`, or configure a credential helper with a token that has repo write access';
  return 'check that the account git uses on this machine has write access to the repository';
}

/**
 * Prove write access without changing anything: a dry-run push that deletes a
 * ref which does not exist. Authentication happens before the server can
 * answer, so "remote ref does not exist" means the credentials work, while
 * an auth failure names exactly what is missing. Reads alone do not prove
 * this: public repositories read fine with no credentials at all.
 */
export async function probePushAccess(remote: string): Promise<PushProbe> {
  const transport: PushProbe['transport'] = /^https?:\/\//.test(remote) ? 'https' : /^(?:ssh:\/\/|[\w.-]+@[^:]+:)/.test(remote) ? 'ssh' : 'other';
  const dir = mkdtempSync(join(tmpdir(), 'dai-push-probe-'));
  const probeRef = `refs/heads/dai-migrate-preflight-probe-${randomBytes(6).toString('hex')}`;
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir });
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };
    let stderr = '';
    try {
      const r = await execFileAsync('git', ['push', '--dry-run', remote, `:${probeRef}`], { cwd: dir, env, timeout: 60_000 });
      stderr = r.stderr ?? '';
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    }
    if (/remote ref does not exist|up to date|Everything up-to-date|\[deleted\]/i.test(stderr)) return { ok: true, transport, detail: 'push credentials accepted (dry run, nothing changed)' };
    return { ok: false, transport, detail: stderr.trim().split('\n')[0] || 'push probe failed', fix: pushFix(transport, stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function preflight(opts: PreflightOptions): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const target: Partial<SessionTarget> = {};
  const contract = loadContract();

  checks.push({ id: 'landing-option', status: opts.target.landing ? 'ok' : 'fail', detail: opts.target.landing ? `landing: ${opts.target.landing}` : 'landing option (customer-org | demo-org) is required' });

  // 1. remote: policy, reachability, default branch
  let remoteBranches: string[] | undefined;
  if (opts.target.repoRemote) {
    const r = remoteOrg(opts.target.repoRemote);
    let policyOk = false;
    try { assertRemoteAllowed(opts.target.repoRemote, opts.allowedRemoteOrgs); policyOk = true; } catch { policyOk = false; }
    checks.push({ id: 'remote-policy', status: policyOk ? 'ok' : 'fail', detail: policyOk ? `remote ${r!.host}/${r!.org} is allowed` : `remote ${opts.target.repoRemote} is not under an allowed org [${opts.allowedRemoteOrgs.join(', ')}]` });
    if (policyOk) {
      try {
        const info = await (opts.listRemote ?? listRemote)(opts.target.repoRemote);
        remoteBranches = info.branches;
        target.repoRemote = opts.target.repoRemote;
        target.deploymentBranch = info.defaultBranch;
        checks.push({ id: 'remote-reachable', status: 'ok', detail: `${info.branches.length} branch(es); default ${info.defaultBranch ?? 'unknown'} (the live deployment branch; migrations land on migration/<session>)` });
        // reads do not prove writes: probe push access now, so a missing credential surfaces here and not after conversion
        const push = await (opts.probePush ?? probePushAccess)(opts.target.repoRemote);
        target.pushAccessVerified = push.ok;
        checks.push({ id: 'push-access', status: push.ok ? 'ok' : 'fail', detail: push.ok ? push.detail : `${push.detail}. Fix: ${push.fix}` });
      } catch (e) {
        checks.push({ id: 'remote-reachable', status: 'fail', detail: `cannot read ${opts.target.repoRemote}: ${(e as Error).message.split('\n')[0]}. Check git credentials and that the repository exists.` });
      }
    }
  } else checks.push({ id: 'remote-policy', status: 'not-checked', detail: 'no --remote given; pass it at init so the connection is verified now rather than at write' });

  // 2. platform, via the API key
  if (!opts.daiApiKey || !opts.daiApiBase) {
    checks.push({ id: 'dai-api', status: 'not-checked', detail: 'DAI_API_KEY not configured; platform checks skipped (repo-branch writer only, no preview discovery)' });
    target.assetProvider = opts.s3Configured ? 's3' : 'none';
    checks.push({ id: 'asset-provider', status: 'ok', detail: `assets will use --provider ${target.assetProvider}${target.assetProvider === 'none' ? ' (images keep source URLs; release stays blocked until an ingestion provider exists)' : ''}` });
    return { checks, target };
  }

  const api = new DaiClient({ baseUrl: opts.daiApiBase, apiKey: opts.daiApiKey, fetchImpl: opts.fetchImpl });
  target.apiBase = opts.daiApiBase.replace(/\/$/, '');
  try {
    const cfg = await api.config();
    if (cfg.status !== 200) {
      checks.push({ id: 'dai-api', status: 'fail', detail: cfg.status === 401 || cfg.status === 403 ? `GET /api/v1/config → ${cfg.status}: the API key is invalid, revoked, or belongs to a plan without API access` : `GET /api/v1/config → ${cfg.status}` });
      return { checks, target };
    }
    checks.push({ id: 'dai-api', status: 'ok', detail: `API key accepted; project config read from branch ${cfg.branch ?? 'unknown'}` });
    if (cfg.branch) target.deploymentBranch ??= cfg.branch;

    // contract version: exposed → must match; absent → assumed at verify, recorded as such
    if (cfg.contentContractVersion === undefined) {
      target.contractVersionAssumed = true;
      checks.push({ id: 'contract-version', status: 'ok', detail: `environment does not expose contentContractVersion yet; the pinned ${contract.contractVersion} will be assumed at preview verification and recorded in the report` });
    } else {
      target.contentContractVersion = cfg.contentContractVersion;
      target.contractVersionAssumed = false;
      const match = cfg.contentContractVersion === contract.contractVersion;
      checks.push({ id: 'contract-version', status: match ? 'ok' : 'fail', detail: `environment ${cfg.contentContractVersion} vs pinned ${contract.contractVersion}` });
    }

    // connected repository: the project must have one, and it must be the remote we will push to
    const br = await api.branches();
    if (br.status !== 200 || !br.names.length) {
      target.connectedRepoVerified = false;
      checks.push({ id: 'connected-repo', status: 'fail', detail: br.status === 200 ? 'the project reports no branches: no repository is connected to it yet (dashboard → project → Git settings)' : `GET /api/v1/branches → ${br.status}: the project has no usable repository connection` });
    } else if (remoteBranches) {
      const overlap = remoteBranches.filter((b) => br.names.includes(b));
      const same = overlap.length > 0 && (target.deploymentBranch ? br.names.includes(target.deploymentBranch) : true);
      target.connectedRepoVerified = same;
      checks.push({ id: 'connected-repo', status: same ? 'ok' : 'fail', detail: same ? `remote matches the project's connected repository (${overlap.length} shared branch(es))` : `the project's connected repository has branches [${br.names.slice(0, 5).join(', ')}] but the remote has [${remoteBranches.slice(0, 5).join(', ')}]; pushing there would deploy nothing` });
    } else {
      target.connectedRepoVerified = undefined;
      checks.push({ id: 'connected-repo', status: 'ok', detail: `project has a connected repository with ${br.names.length} branch(es); pass --remote to verify it is the one you will push to` });
    }

    // deployments: proves the webhook path works and whether previews have ever been produced
    const dep = await api.deployments(50);
    if (dep.status === 200) {
      const previews = dep.deployments.filter((d) => d.isPreview);
      const live = dep.deployments.filter((d) => !d.isPreview && d.status === 'ready');
      target.previewsSeen = previews.length > 0;
      checks.push({ id: 'deployments', status: 'ok', detail: `${dep.deployments.length} deployment(s) on record: ${live.length} live ready, ${previews.length} preview${previews.length ? '' : ' (none yet: preview availability is confirmed on the first migration push; it needs a Starter/Standard/Professional plan and GitHub App access to the repository)'}` });
    } else checks.push({ id: 'deployments', status: 'not-checked', detail: `GET /api/v1/deployments → ${dep.status}` });

    // media: decides the asset provider
    const media = await api.mediaAvailable();
    target.mediaApiAvailable = media.available;
    target.assetProvider = media.available ? 'dai-api' : opts.s3Configured ? 's3' : 'none';
    checks.push({ id: 'media-api', status: media.available ? 'ok' : 'not-checked', detail: media.available ? 'API-key media upload available' : `GET /api/v1/media → ${media.status}; API-key media upload is not available on this environment (platform dependency G7)` });
    checks.push({ id: 'asset-provider', status: 'ok', detail: `assets will use --provider ${target.assetProvider}${target.assetProvider === 'none' ? ' (images keep source URLs; configure MIGRATION_S3_* or wait for the media API to release)' : ''}` });
  } catch (e) {
    checks.push({ id: 'dai-api', status: 'fail', detail: `cannot reach DAI API: ${(e as Error).message}` });
  }
  return { checks, target };
}
