/**
 * The assets stage: collect every media reference of the snapshot, ingest through the configured provider and, in exact mode,
 * stop unless every asset has a hosted URL. Exact output never points at a
 * source host and never omits media, so an asset that cannot be hosted ends
 * the stage with the complete list instead of shipping a page without it.
 */
import type { DocIR } from '../ir/types.js';
import type { Fetcher } from '../scrape/fetcher.js';
import { collectAssets, describeAssetEntry, unhostedAssets, type AssetEntry, type AssetManifest } from './manifest.js';
import { ingestAssets, type AssetProviderOptions } from './providers.js';

export type FidelityMode = 'exact' | 'permissive';

export interface AssetsStageOptions {
  workspace: string;
  docs: DocIR[];
  fidelityMode: FidelityMode;
  provider: AssetProviderOptions;
  fetcher?: Fetcher;
  localResolver?: (url: string) => string | undefined;
}

export interface AssetsStageResult {
  manifest: AssetManifest;
  /** Entries without a hosted URL; empty after an exact-mode run, informational in permissive mode. */
  unhosted: AssetEntry[];
}

const PROVIDER_HINTS: Partial<Record<string, string>> = {
  none: 'provider none leaves every asset on its source host; exact mode needs --provider s3 or dai-api',
  local: 'provider local downloads assets but assigns no hosted URL; exact mode needs --provider s3 or dai-api',
};

export class UnhostedAssetsError extends Error {
  constructor(readonly stage: string, readonly entries: AssetEntry[], provider: string) {
    const hint = PROVIDER_HINTS[provider];
    super([
      `${stage} stopped: exact mode requires a hosted URL for every asset and ${entries.length} of them ${entries.length === 1 ? 'has' : 'have'} none`,
      ...entries.map((entry) => `  - ${describeAssetEntry(entry)}`),
      ...(hint ? [hint] : []),
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
  if (options.fidelityMode === 'exact') assertAssetsHosted(manifest, 'assets');
  return { manifest, unhosted: unhostedAssets(manifest) };
}
