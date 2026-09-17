/**
 * The assets stage: collect every media reference of the snapshot, ingest through the configured provider and, in exact mode,
 * stop unless every asset has a hosted URL. Exact output never points at a
 * source host and never omits media, so an asset that cannot be hosted ends
 * the stage with the complete list instead of shipping a page without it.
 */
import type { DocIR } from '../ir/types.js';
import type { Fetcher } from '../scrape/fetcher.js';
import { applyAssetExclusions, collectAssets, describeAssetEntry, unhostedAssets, writeManifest, type AssetEntry, type AssetManifest } from './manifest.js';
import { ingestAssets, type AssetProviderOptions } from './providers.js';

export type FidelityMode = 'exact' | 'permissive';

export interface AssetsStageOptions {
  workspace: string;
  docs: DocIR[];
  fidelityMode: FidelityMode;
  provider: AssetProviderOptions;
  fetcher?: Fetcher;
  localResolver?: (url: string) => string | undefined;
  /** A named person decided the pictures stay at their current addresses (`assets --provider none --keep-external --by`). */
  keepExternal?: { by: string; at: string };
  /** Assets a named person accepted the migration would not carry (plan/scope-decisions.yaml `assets`). */
  excluded?: ReadonlyArray<{ hash?: string; url?: string; reason: string; approvedBy: string; approvedAt?: string }>;
}

export interface AssetsStageResult {
  manifest: AssetManifest;
  /** Entries without a hosted URL; empty after an exact-mode run, informational in permissive mode. */
  unhosted: AssetEntry[];
}

const PROVIDER_HINTS: Partial<Record<string, string>> = {
  none: 'provider none leaves every asset on its source host; exact mode needs --provider s3 or dai-api, or a named person\'s decision to leave the pictures where they are served today: assets --provider none --keep-external --by "<who>"',
  local: 'provider local downloads assets but assigns no hosted URL; exact mode needs --provider s3 or dai-api',
};

export class UnhostedAssetsError extends Error {
  constructor(readonly stage: string, readonly entries: AssetEntry[], provider: string) {
    const hint = PROVIDER_HINTS[provider];
    super([
      `${stage} stopped: exact mode requires a hosted URL for every asset and ${entries.length} of them ${entries.length === 1 ? 'has' : 'have'} none`,
      ...entries.map((entry) => `  - ${describeAssetEntry(entry)}`),
      ...(hint ? [hint] : []),
      'an asset the source publishes at no usable address can be accepted as a loss by adding it to the `assets` list in plan/scope-decisions.yaml, with a reason and who approved it',
    ].join('\n'));
  }
}

/** Exact mode ships nothing that points at a source host or at media nobody hosts. */
export function assertAssetsHosted(manifest: AssetManifest, stage: string): void {
  const entries = unhostedAssets(manifest);
  if (entries.length) throw new UnhostedAssetsError(stage, entries, manifest.provider);
}

export async function runAssetsStage(options: AssetsStageOptions): Promise<AssetsStageResult> {
  const collected = await collectAssets(options.docs, options.workspace, { fetcher: options.fetcher, localResolver: options.localResolver, provider: options.provider.provider });
  const manifest = await ingestAssets(collected, options.provider);
  // only with provider none: a provider that hosts and fails has a failure to fix, not a decision to record
  if (options.keepExternal && options.provider.provider === 'none') manifest.keptExternal = options.keepExternal; else delete manifest.keptExternal;
  if (options.keepExternal || collected.keptExternal) writeManifest(options.workspace, manifest);
  // Applied before the gate: an approved exclusion is what lets an unhostable asset through, and
  // applying it after the check would make the approval decorative.
  if (options.excluded?.length) {
    applyAssetExclusions(manifest, options.excluded);
    // Persisted, not only applied: convert drops an excluded asset's references and verify counts it
    // as decided by reading plan/assets.json. Applied in memory alone, the stage passed while the
    // page kept pointing at the source host and the gate still reported the asset as failed.
    writeManifest(options.workspace, manifest);
  }
  if (options.fidelityMode === 'exact') assertAssetsHosted(manifest, 'assets');
  return { manifest, unhosted: unhostedAssets(manifest) };
}
