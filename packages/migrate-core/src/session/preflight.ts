/**
 * Preflight at `init`: the tool refuses to start a migration that cannot
 * land safely. Checks that need the platform API are skipped with an
 * explicit `not-checked` when no API key is configured, and the session
 * records that.
 */
import { loadContract } from '@dai/content-contract';
import type { SessionTarget } from './workspace.js';
import { remoteOrg } from '../write/migration-branch.js';

export interface PreflightCheck { id: string; status: 'ok' | 'fail' | 'not-checked'; detail: string }

export interface PreflightOptions {
  target: SessionTarget;
  allowedRemoteOrgs: string[];
  daiApiBase?: string;
  daiApiKey?: string;
}

export async function preflight(opts: PreflightOptions): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const contract = loadContract();

  // landing option recorded
  checks.push({ id: 'landing-option', status: opts.target.landing ? 'ok' : 'fail', detail: opts.target.landing ? `landing: ${opts.target.landing}` : 'landing option (customer-org | demo-org) is required' });

  // remote policy
  if (opts.target.repoRemote) {
    const r = remoteOrg(opts.target.repoRemote);
    const ok = !!r && opts.allowedRemoteOrgs.map((o) => o.toLowerCase()).includes(r.org.toLowerCase());
    checks.push({ id: 'remote-policy', status: ok ? 'ok' : 'fail', detail: ok ? `remote org ${r!.org} allowed` : `remote ${opts.target.repoRemote} is not under an allowed org [${opts.allowedRemoteOrgs.join(', ')}]` });
  } else checks.push({ id: 'remote-policy', status: 'not-checked', detail: 'no remote set yet; will be enforced at write' });

  // platform checks via API key (plan limits, preview availability, quota, contract version)
  if (opts.daiApiKey && opts.daiApiBase) {
    try {
      const res = await fetch(`${opts.daiApiBase.replace(/\/$/, '')}/api/v1/config`, { headers: { authorization: `Bearer ${opts.daiApiKey}` }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) checks.push({ id: 'dai-api', status: 'fail', detail: `GET /api/v1/config → ${res.status}` });
      else {
        const cfg = (await res.json()) as Record<string, unknown>;
        const v = (cfg.contentContractVersion as string | undefined) ?? undefined;
        checks.push({ id: 'contract-version', status: v === undefined ? 'not-checked' : v === contract.contractVersion ? 'ok' : 'fail', detail: v === undefined ? 'environment does not expose contentContractVersion yet (platform dependency); gating against a preview will be refused until it does' : `environment ${v} vs pinned ${contract.contractVersion}` });
        checks.push({ id: 'preview-available', status: 'not-checked', detail: 'plan preview availability is not exposed by /api/v1/config; verify in the dashboard (Starter/Standard/Professional plans allow previews)' });
        checks.push({ id: 'quota-headroom', status: 'not-checked', detail: 'storage quota is exposed under /organizations/:org/storage (dashboard auth); check in the dashboard before assets ingestion' });
      }
    } catch (e) {
      checks.push({ id: 'dai-api', status: 'fail', detail: `cannot reach DAI API: ${(e as Error).message}` });
    }
  } else {
    checks.push({ id: 'dai-api', status: 'not-checked', detail: 'DAI_API_KEY not configured; platform checks skipped (repo-branch writer only)' });
  }
  return checks;
}
