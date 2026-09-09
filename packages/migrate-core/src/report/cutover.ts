import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { Tree } from '../nav/tree.js';
import type { RedirectRule, UrlPlan } from '../urls/plan.js';
import type { Fetcher } from '../scrape/fetcher.js';

export interface SeoPlan {
  sourceBase?: string;
  targetBase?: string;
  redirectRetentionDays: number;
  preserveHreflang: boolean;
  searchCanaryTemplate?: string;
}

export function readSeoPlan(workspace: string): SeoPlan | undefined {
  const path = join(workspace, 'plan', 'seo.yaml');
  return existsSync(path) ? parseYaml(readFileSync(path, 'utf8')) as SeoPlan : undefined;
}

export function writeDefaultSeoPlan(workspace: string, source: string): SeoPlan {
  const path = join(workspace, 'plan', 'seo.yaml');
  if (existsSync(path)) return readSeoPlan(workspace)!;
  const plan: SeoPlan = {
    sourceBase: /^https?:\/\//.test(source) ? new URL(source).origin : undefined,
    targetBase: process.env.MIGRATION_TARGET_PUBLIC_BASE,
    redirectRetentionDays: 365,
    preserveHreflang: true,
    searchCanaryTemplate: process.env.MIGRATION_SEARCH_URL_TEMPLATE,
  };
  writeFileSync(path, toYaml(plan), { mode: 0o600 });
  return plan;
}

export function canonicalUrl(base: string | undefined, newPath: string): string | undefined {
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${newPath.replace(/^\//, '')}`;
  url.search = ''; url.hash = '';
  return url.toString();
}

export function writeCutoverArtifacts(workspace: string, input: { tree: Tree; urlPlan: UrlPlan; exact: RedirectRule[]; wildcard: RedirectRule[]; seo: SeoPlan }): void {
  const publicPages = input.tree.pages.filter((page) => page.migrate && page.newPath);
  writeFileSync(join(workspace, 'report', 'sitemap.urls.txt'), publicPages.map((page) => canonicalUrl(input.seo.targetBase, page.newPath!) ?? `/${page.newPath}`).join('\n') + '\n', { mode: 0o600 });
  const md = `# Cutover and SEO runbook

## Planned routing

- Source: ${input.seo.sourceBase ?? 'set in plan/seo.yaml'}
- Target: ${input.seo.targetBase ?? 'set in plan/seo.yaml'}
- Exact redirects: ${input.exact.length}
- Wildcard candidates requiring platform support: ${input.wildcard.length}
- Minimum redirect retention: ${input.seo.redirectRetentionDays} days
- Hreflang preservation: ${input.seo.preserveHreflang ? 'required' : 'not configured'}

## Before cutover

- Confirm every release gate passes against the rendered preview.
- Approve redirects.exact.json and every wildcard candidate.
- Configure target canonical host, robots policy and sitemap using sitemap.urls.txt.
- Keep the source site available read-only until redirects and rollback are proven.
- Lower DNS TTL only if DNS changes are part of this migration.

## Cutover

- Deploy the approved migration commit.
- Apply redirects before changing the public entry point.
- Test a representative old URL, old deep link and legacy heading anchor.
- Confirm canonical tags point at the target host and the target is indexable.
- Submit or refresh the sitemap in the relevant search consoles.

## After cutover

- Run dai-migrate canary and retain report/search-canary.json.
- Monitor 404s, redirect loops, crawl errors and search traffic daily during the coexistence period.
- Roll back routing if critical pages, authentication, assets or search are unavailable.
- Keep redirects for at least ${input.seo.redirectRetentionDays} days; permanent retention is preferable.
`;
  writeFileSync(join(workspace, 'report', 'cutover.md'), md, { mode: 0o600 });
}

export async function runSearchCanary(input: { workspace: string; tree: Tree; template: string; fetcher: Fetcher; sampleSize?: number }): Promise<{ pass: boolean; checked: number; failures: Array<{ query: string; expected: string; reason: string }> }> {
  if (!input.template.includes('{query}')) throw new Error('search canary template must contain {query}');
  const candidates = input.tree.pages.filter((page) => page.migrate && page.newPath).slice(0, input.sampleSize ?? 5);
  const failures: Array<{ query: string; expected: string; reason: string }> = [];
  for (const page of candidates) {
    const query = page.title.trim();
    const url = input.template.replace('{query}', encodeURIComponent(query));
    try {
      const response = await input.fetcher.get(url, { useCache: false });
      if (response.status < 200 || response.status >= 300) failures.push({ query, expected: page.newPath!, reason: `HTTP ${response.status}` });
      else if (!response.body.toLowerCase().includes(page.newPath!.toLowerCase()) && !response.body.toLowerCase().includes(query.toLowerCase())) failures.push({ query, expected: page.newPath!, reason: 'expected title or route absent from response' });
    } catch (error) {
      failures.push({ query, expected: page.newPath!, reason: (error as Error).message });
    }
  }
  const report = { at: new Date().toISOString(), pass: failures.length === 0 && candidates.length > 0, checked: candidates.length, failures };
  writeFileSync(join(input.workspace, 'report', 'search-canary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}
