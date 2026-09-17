/**
 * Findings on the rendered preview that a named person looked at and accepted.
 *
 * The preview check fails a route only for something a reader would miss: a page that does not
 * load, a source passage or heading that is nowhere on it, a link into nothing. Even so, the check
 * reads a page the platform rendered, and a person looking at that page can see what a comparison
 * cannot: that the passage is there, drawn in a way the check does not read, or that the customer
 * has decided to live with it. `accept` records that decision against the route with who made it
 * and why; the next `verify --preview` reports the route as accepted rather than failing, and the
 * report names the person. Nothing is accepted silently, and nothing is accepted by a rule.
 *
 * The file lives beside the plans and is not pinned by convert: accepting a rendered page changes
 * no output, so it must not invalidate the conversion it was rendered from.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';

export interface PreviewAcceptance { route: string; reason: string; by: string; at: string }

export const PREVIEW_ACCEPTANCES_FILE = 'preview-acceptances.yaml';

const HEADER = `# Findings on the rendered preview that a named person reviewed and accepted.
# Written by: dai-migrate accept --route <route> --reason "<why>" --by "<who>"
# Remove an entry to have verify --preview report that route again.
`;

export function previewAcceptancesPath(workspace: string): string {
  return join(workspace, 'plan', PREVIEW_ACCEPTANCES_FILE);
}

export function readPreviewAcceptances(workspace: string): PreviewAcceptance[] {
  const path = previewAcceptancesPath(workspace);
  if (!existsSync(path)) return [];
  const parsed = parseYaml(readFileSync(path, 'utf8')) as { accepted?: unknown } | null;
  const entries = Array.isArray(parsed?.accepted) ? parsed!.accepted : [];
  return entries.flatMap((entry): PreviewAcceptance[] => {
    const { route, reason, by, at } = (entry ?? {}) as Record<string, unknown>;
    // an entry without a person or a reason is not a decision anyone made
    if (typeof route !== 'string' || typeof reason !== 'string' || typeof by !== 'string' || !route.trim() || !reason.trim() || !by.trim()) return [];
    return [{ route: route.replace(/^\/+|\/+$/g, ''), reason: reason.trim(), by: by.trim(), at: typeof at === 'string' ? at : '' }];
  });
}

/** Records the acceptance of each route, replacing an earlier acceptance of the same route. */
export function acceptPreviewRoutes(workspace: string, routes: readonly string[], reason: string, by: string, at = new Date().toISOString()): PreviewAcceptance[] {
  const wanted = routes.map((route) => route.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const kept = readPreviewAcceptances(workspace).filter((entry) => !wanted.includes(entry.route));
  const all = [...kept, ...wanted.map((route) => ({ route, reason: reason.trim(), by: by.trim(), at }))].sort((a, b) => a.route.localeCompare(b.route));
  writeFileSync(previewAcceptancesPath(workspace), `${HEADER}${toYaml({ accepted: all })}`, { mode: 0o600 });
  return all;
}
