/**
 * What the source platform said about the site, recorded at discovery and read by later stages.
 *
 * `inventory/platform-meta.json` is where an adapter puts the facts that belong to the site rather
 * than to a page: its name, the connections it declares, the repository its specs are relative to.
 * Stages read it rather than re-reading the source, so discovery stays the one place the source is
 * interpreted.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './io.js';
import { acquiredPath, type AcquiredPage } from '../scrape/acquire.js';
import type { GroupOpenapiRef } from '../nav/tree.js';
import type { RedirectRule } from '../urls/plan.js';

export interface PlatformMeta {
  name?: string;
  theme?: string;
  colors?: Record<string, string>;
  logo?: unknown;
  favicon?: string;
  redirects?: { exact: RedirectRule[]; wildcard: RedirectRule[] };
  openapi?: GroupOpenapiRef[];
  /** Source repository root the openapi specs are relative to. */
  root?: string;
  openapiCaptured?: boolean;
}

export function readPlatformMeta(workspace: string): PlatformMeta {
  const path = join(workspace, 'inventory', 'platform-meta.json');
  return existsSync(path) ? readJson<PlatformMeta>(path) : {};
}

/** The HTML `acquire` froze for a page, if it has one. */
export function acquiredHtml(workspace: string, pageId: string): string | undefined {
  const file = acquiredPath(workspace, pageId);
  return existsSync(file) ? readJson<AcquiredPage>(file).html : undefined;
}
