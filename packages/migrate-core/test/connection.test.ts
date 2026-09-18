import { describe, it, expect } from 'vitest';
import { preflight, pushFix } from '../src/session/preflight.js';
import { DaiClient, noDeploymentDiagnosis } from '../src/session/platform.js';
import { loadContract } from '@dai/content-contract';

type Route = (url: string) => Response | undefined;
const api = (routes: Record<string, unknown | ((u: URL) => unknown)>, status = 200): typeof fetch =>
  (async (input: any) => {
    const url = new URL(String(input));
    const key = url.pathname.replace('/api/v1', '') + (url.search && !routes[url.pathname.replace('/api/v1', '')] ? url.search : '');
    const hit = routes[key] ?? routes[url.pathname.replace('/api/v1', '')];
    if (hit === undefined) return new Response('nope', { status: 404 });
    if (hit === 401) return new Response('Authentication required', { status: 401 });
    return new Response(JSON.stringify(typeof hit === 'function' ? (hit as (u: URL) => unknown)(url) : hit), { status });
  }) as unknown as typeof fetch;

const remote = (branches: string[], defaultBranch = 'main') => async () => ({ defaultBranch, branches });
const pushOk = async () => ({ ok: true, transport: 'https' as const, detail: 'push credentials accepted (dry run, nothing changed)' });
const base = { target: { landing: 'demo-org' as const, repoRemote: 'https://github.com/acme-docs/site.git' }, allowedRemoteOrgs: ['acme-docs'], daiApiBase: 'https://api.example', daiApiKey: 'k', probePush: pushOk };

describe('preflight: connection is settled at init', () => {
  it('passes when the remote is the connected repo, records the deployment branch, provider and contract assumption', async () => {
    const fetchImpl = api({ '/config': { branch: 'main', config: { name: 'Acme' } }, '/branches': { branches: [{ name: 'main' }, { name: 'feature' }] }, '/deployments': { deployments: [{ deploymentId: 'd1', status: 'ready', isPreview: false, branch: 'main' }] } });
    const r = await preflight({ ...base, fetchImpl, listRemote: remote(['main', 'feature']) });
    const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(byId['remote-policy'].status).toBe('ok');
    expect(byId['remote-reachable'].status).toBe('ok');
    expect(byId['dai-api'].status).toBe('ok');
    expect(byId['connected-repo'].status).toBe('ok');
    expect(byId['contract-version'].status).toBe('ok');
    expect(byId['media-api'].status).toBe('not-checked'); // /media is 404 on this environment
    expect(r.target).toMatchObject({ repoRemote: base.target.repoRemote, deploymentBranch: 'main', connectedRepoVerified: true, contractVersionAssumed: true, assetProvider: 'dai-mcp', previewsSeen: false, mediaApiAvailable: false });
    expect(r.checks.some((c) => c.status === 'fail')).toBe(false);
  });
  it('fails when the remote is a different repository than the one connected to the project', async () => {
    const fetchImpl = api({ '/config': { branch: 'main' }, '/branches': { branches: [{ name: 'main' }, { name: 'docs-v2' }] }, '/deployments': { deployments: [] } });
    const r = await preflight({ ...base, fetchImpl, listRemote: remote(['master', 'wip'], 'master') });
    const c = r.checks.find((x) => x.id === 'connected-repo')!;
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/pushing there would deploy nothing/);
  });
  it('fails when the project has no repository connected, and when the key is rejected', async () => {
    const none = await preflight({ ...base, fetchImpl: api({ '/config': { branch: 'main' }, '/branches': { branches: [] }, '/deployments': { deployments: [] } }), listRemote: remote(['main']) });
    expect(none.checks.find((x) => x.id === 'connected-repo')!.detail).toMatch(/no repository is connected/);
    const bad = await preflight({ ...base, fetchImpl: api({ '/config': 401 }), listRemote: remote(['main']) });
    expect(bad.checks.find((x) => x.id === 'dai-api')!.detail).toMatch(/invalid, revoked/);
  });
  it('picks dai-api when the media API answers, s3 when configured, else dai-mcp; uses the exposed contract version when present', async () => {
    const withMedia = api({ '/config': { branch: 'main', contentContractVersion: loadContract().contractVersion }, '/branches': { branches: [{ name: 'main' }] }, '/deployments': { deployments: [{ deploymentId: 'p', status: 'ready', isPreview: true, branch: 'migration/x' }] }, '/media': { images: [] } });
    const r = await preflight({ ...base, fetchImpl: withMedia, listRemote: remote(['main']) });
    expect(r.target.assetProvider).toBe('dai-api');
    expect(r.target.contractVersionAssumed).toBe(false);
    expect(r.target.previewsSeen).toBe(true);
    const s3 = await preflight({ ...base, s3Configured: true, fetchImpl: api({ '/config': { branch: 'main' }, '/branches': { branches: [{ name: 'main' }] }, '/deployments': { deployments: [] } }), listRemote: remote(['main']) });
    expect(s3.target.assetProvider).toBe('s3');
    const mismatch = await preflight({ ...base, fetchImpl: api({ '/config': { branch: 'main', contentContractVersion: '9.9.9' }, '/branches': { branches: [{ name: 'main' }] }, '/deployments': { deployments: [] } }), listRemote: remote(['main']) });
    expect(mismatch.checks.find((x) => x.id === 'contract-version')!.status).toBe('fail');
  });
  it('fails at init when the remote is readable but not pushable, and names the fix', async () => {
    const fetchImpl = api({ '/config': { branch: 'main' }, '/branches': { branches: [{ name: 'main' }] }, '/deployments': { deployments: [] } });
    const noCreds = async () => ({ ok: false, transport: 'https' as const, detail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled", fix: pushFix('https', 'could not read Username') });
    const r = await preflight({ ...base, fetchImpl, listRemote: remote(['main']), probePush: noCreds });
    const c = r.checks.find((x) => x.id === 'push-access')!;
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/gh auth login/);
    expect(r.target.pushAccessVerified).toBe(false);
    expect(pushFix('ssh', 'Permission denied (publickey)')).toMatch(/SSH key is not registered/);
  });
  it('refuses a remote outside the allowlist before touching the network', async () => {
    let called = false;
    const r = await preflight({ ...base, target: { landing: 'demo-org', repoRemote: 'https://github.com/someone/personal.git' }, fetchImpl: api({}), listRemote: async () => { called = true; return { branches: [] }; } });
    expect(r.checks.find((x) => x.id === 'remote-policy')!.status).toBe('fail');
    expect(called).toBe(false);
  });
});

describe('preview discovery after push', () => {
  it('polls deployments until the migration branch is ready and returns its URL', async () => {
    let tick = 0;
    const fetchImpl = api({ '/deployments': () => { tick++; return { deployments: tick < 3 ? [{ deploymentId: 'd', status: 'building', branch: 'migration/mig-1', isPreview: true, createdAt: '2026-09-10T00:00:00Z' }] : [{ deploymentId: 'd', status: 'ready', url: 'migration-mig-1--acme.documentationai.com', branch: 'migration/mig-1', isPreview: true, createdAt: '2026-09-10T00:00:00Z' }] }; } });
    const client = new DaiClient({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl });
    let t = 0;
    const seen: string[] = [];
    const r = await client.waitForBranchDeployment('migration/mig-1', { timeoutMs: 60_000, intervalMs: 1000, now: () => t, sleep: async () => { t += 1000; }, onTick: (d) => seen.push(d?.status ?? 'none') });
    expect(r.outcome).toBe('ready');
    expect(r.deployment?.url).toBe('migration-mig-1--acme.documentationai.com');
    expect(seen).toEqual(['building', 'building', 'ready']);
  });
  it('times out with a diagnosis when nothing appears, and reports error states', async () => {
    const silent = new DaiClient({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl: api({ '/deployments': { deployments: [{ deploymentId: 'x', status: 'ready', branch: 'main', isPreview: false }] } }) });
    let t = 0;
    const r = await silent.waitForBranchDeployment('migration/mig-2', { timeoutMs: 5000, intervalMs: 1000, now: () => t, sleep: async () => { t += 1000; } });
    expect(r.outcome).toBe('timeout');
    expect(r.firstSeenMs).toBeUndefined();
    expect(noDeploymentDiagnosis('migration/mig-2', false)).toMatch(/GitHub App installation.*plan does not allow preview.*not the repository connected/s);
    expect(noDeploymentDiagnosis('migration/mig-2', true)).not.toMatch(/plan does not allow/);
    const failed = new DaiClient({ baseUrl: 'https://api.example', apiKey: 'k', fetchImpl: api({ '/deployments': { deployments: [{ deploymentId: 'e', status: 'error', branch: 'migration/mig-3', isPreview: true }] } }) });
    expect((await failed.waitForBranchDeployment('migration/mig-3', { timeoutMs: 5000, intervalMs: 1000, now: () => 0, sleep: async () => {} })).outcome).toBe('error');
  });
});
