/**
 * Documentation.AI platform client over the API-key surface (`/api/v1`).
 * Everything the tool can learn about the target project without a
 * dashboard session lives here: config, branches (which proves a repo is
 * connected), deployments (which is how a preview URL is discovered after a
 * push), and the media probe. Fetch is injectable so all of it is testable
 * offline.
 *
 * Verified response shapes (backend `contentApi.service.ts`, 2026-09-10):
 *   GET /branches     → { branches: [{ name, ... }], count }
 *   GET /deployments  → { deployments: [{ deploymentId, status, url, branch, isPreview, triggerType, createdAt, updatedAt }], total }
 *   status ∈ pending | building | ready | error | cancelled
 */
export interface DaiDeployment {
  deploymentId: string;
  status: 'pending' | 'building' | 'ready' | 'error' | 'cancelled' | string;
  url?: string | null;
  branch?: string | null;
  isPreview?: boolean;
  triggerType?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DaiClientOptions { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }

export class DaiClient {
  private base: string;
  private fetchImpl: typeof fetch;
  constructor(private opts: DaiClientOptions) {
    if (!opts.baseUrl) throw new Error('DAI_API_BASE is required');
    if (!opts.apiKey) throw new Error('DAI_API_KEY is required');
    this.base = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<{ status: number; body?: T }> {
    const res = await this.fetchImpl(`${this.base}/api/v1${path}`, { headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000) });
    if (!res.ok) return { status: res.status };
    return { status: res.status, body: (await res.json()) as T };
  }

  /** Site config for the deployment branch; also where `contentContractVersion` will appear once the platform exposes it. */
  async config(): Promise<{ status: number; branch?: string; config?: Record<string, unknown>; contentContractVersion?: string }> {
    const r = await this.get<{ branch?: string; config?: Record<string, unknown>; contentContractVersion?: string }>('/config');
    if (!r.body) return { status: r.status };
    const v = r.body.contentContractVersion ?? (r.body.config?.contentContractVersion as string | undefined);
    return { status: r.status, branch: r.body.branch, config: r.body.config, contentContractVersion: v };
  }

  /** Branch names of the repository connected to the key's project. An empty list or a non-200 means no usable connection. */
  async branches(): Promise<{ status: number; names: string[] }> {
    const r = await this.get<{ branches?: Array<{ name?: string; branchName?: string }> }>('/branches');
    return { status: r.status, names: (r.body?.branches ?? []).map((b) => b.name ?? b.branchName ?? '').filter(Boolean) };
  }

  async deployments(limit = 20): Promise<{ status: number; deployments: DaiDeployment[] }> {
    const r = await this.get<{ deployments?: DaiDeployment[] }>(`/deployments?limit=${limit}`);
    return { status: r.status, deployments: r.body?.deployments ?? [] };
  }

  /** Asks the platform to build a preview of one branch (a working version). The build is then found like any other, by `waitForBranchDeployment`. */
  async deployPreview(branch: string): Promise<{ status: number; deploymentId?: string }> {
    const res = await this.fetchImpl(`${this.base}/api/v1/deploy/preview`, { method: 'POST', headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ branch }), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    if (!res.ok) return { status: res.status };
    const body = await res.json().catch(() => ({})) as { deploymentId?: string; deployment?: { deploymentId?: string } };
    return { status: res.status, deploymentId: body.deploymentId ?? body.deployment?.deploymentId };
  }

  /** API-key media surface (platform dependency G7). 200 means `--provider dai-api` can ingest. */
  async mediaAvailable(): Promise<{ status: number; available: boolean }> {
    const r = await this.get<unknown>('/media?limit=1');
    return { status: r.status, available: r.status === 200 };
  }

  /**
   * Wait for the platform to react to a branch push. The GitHub App webhook
   * creates a preview deployment for any non-deployment branch; polling the
   * deployments list is the only API-key way to find its URL.
   */
  async waitForBranchDeployment(branch: string, opts: { timeoutMs?: number; intervalMs?: number; onTick?: (d?: DaiDeployment) => void; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ outcome: 'ready' | 'error' | 'cancelled' | 'timeout'; deployment?: DaiDeployment; firstSeenMs?: number }> {
    const timeout = opts.timeoutMs ?? 15 * 60_000;
    const interval = opts.intervalMs ?? 10_000;
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const start = now();
    let firstSeenMs: number | undefined;
    while (now() - start < timeout) {
      const { deployments } = await this.deployments(20);
      const match = deployments.filter((d) => d.branch === branch).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      opts.onTick?.(match);
      if (match) {
        firstSeenMs ??= now() - start;
        if (match.status === 'ready') return { outcome: 'ready', deployment: match, firstSeenMs };
        if (match.status === 'error') return { outcome: 'error', deployment: match, firstSeenMs };
        if (match.status === 'cancelled') return { outcome: 'cancelled', deployment: match, firstSeenMs };
      }
      await sleep(interval);
    }
    return { outcome: 'timeout', firstSeenMs };
  }
}

/** Why a pushed branch produced no deployment: the causes are outside the tool, so name them precisely. */
export function noDeploymentDiagnosis(branch: string, previewsSeenBefore: boolean): string {
  const causes = [
    'the GitHub App installation does not include the connected repository (GitHub → Settings → Applications → documentation.ai → Repository access)',
    ...(previewsSeenBefore ? [] : ['the project\'s plan does not allow preview deployments (Starter, Standard or Professional required)']),
    'the remote you pushed to is not the repository connected to this Documentation.AI project',
  ];
  return `no deployment appeared for ${branch}. Likely causes, in order: ${causes.map((c, i) => `(${i + 1}) ${c}`).join('; ')}.`;
}
