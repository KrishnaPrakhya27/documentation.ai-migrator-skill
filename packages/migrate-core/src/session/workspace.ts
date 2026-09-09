/**
 * External secure workspace. Run data never lives inside the plugin directory.
 *
 * Layout: <workspace>/
 *   session.json          pins: snapshot hash, plan hashes, versions, target
 *   identity-map.json     source location → page entity id (for platforms without ids)
 *   source-cache/         content-addressed acquisition cache
 *   snapshot/             frozen input (pages as DocIR JSON, assets manifest)
 *   inventory/            components.json, assets.json, links.json, anchors.json, snippets.json
 *   plan/                 tree.yaml, component-plan.yaml, urls.yaml, assets.yaml
 *   output/               DAI repo tree
 *   ledger/               dispositions.jsonl
 *   quarantine/           blocks that could not be represented
 *   logging/              decisions.jsonl, run log
 *   report/               gates.json, verification.json, review-queue.md, customer report
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { sha256 } from './ids.js';

export const WORKSPACE_DIRS = ['source-cache', 'snapshot', 'inventory', 'plan', 'output', 'ledger', 'quarantine', 'logging', 'report', 'assets-original', 'assets-ready'] as const;

export interface SessionTarget {
  /** 'customer-org' (option A) or 'demo-org' (option B) */
  landing: 'customer-org' | 'demo-org';
  organizationId?: string;
  documentationId?: string;
  repoRemote?: string;
  subdomain?: string;
  deploymentBranch?: string;
  contentContractVersion?: string;
}

export interface Session {
  migrationId: string;
  createdAt: string;
  /** Source description (URL, export path, repo). */
  source: { kind: 'url' | 'export' | 'repo' | 'api'; location: string; platform?: string; platformConfidence?: number };
  target: SessionTarget;
  scope: 'full' | 'partial';
  customerAuthorisedCrawl: boolean;
  versions: {
    core: string;
    contentContract: string;
    parsers: Record<string, string>;
    model?: string;
    prompt?: string;
  };
  hashes: {
    snapshot?: string;
    componentPlan?: string;
    urlPlan?: string;
    assetPlan?: string;
    canonicalOutput?: string;
    /** Inputs (snapshot + plans + asset manifest) of the last convert, and its output hash; a repeat over identical inputs proves determinism. */
    convertInputs?: string;
    convertOutput?: string;
    previousConvertOutput?: string;
  };
  stages: Record<string, { status: 'pending' | 'done' | 'failed'; at?: string; note?: string }>;
}

export function defaultWorkspaceRoot(): string {
  const env = process.env.MIGRATION_WORKSPACE_ROOT;
  if (env) return env;
  const home = homedir();
  if (osPlatform() === 'darwin') return join(home, 'Library', 'Application Support', 'dai-migrate');
  if (osPlatform() === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'dai-migrate');
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'dai-migrate');
}

/** Refuse a workspace that sits inside the plugin repository. */
export function assertOutsidePlugin(workspace: string, pluginRoot: string): void {
  const w = resolve(workspace);
  const p = resolve(pluginRoot);
  if (w === p || w.startsWith(p + '/')) {
    throw new Error(`Workspace ${w} is inside the plugin directory ${p}. Run data must live outside the plugin (use --workspace).`);
  }
}

export function ensureWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  try { chmodSync(workspace, 0o700); } catch { /* best effort on non-POSIX */ }
  for (const d of WORKSPACE_DIRS) mkdirSync(join(workspace, d), { recursive: true, mode: 0o700 });
  const st = statSync(workspace);
  if (osPlatform() !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new Error(`Workspace ${workspace} is readable by other users; expected mode 0700.`);
  }
}

export function sessionPath(workspace: string): string {
  return join(workspace, 'session.json');
}

export function readSession(workspace: string): Session {
  const p = sessionPath(workspace);
  if (!existsSync(p)) throw new Error(`No session at ${p}. Run "dai-migrate init" first.`);
  return JSON.parse(readFileSync(p, 'utf8')) as Session;
}

export function writeSession(workspace: string, session: Session): void {
  writeFileSync(sessionPath(workspace), JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
}

export function markStage(workspace: string, stage: string, status: 'pending' | 'done' | 'failed', note?: string): Session {
  const s = readSession(workspace);
  s.stages[stage] = { status, at: new Date().toISOString(), note };
  writeSession(workspace, s);
  return s;
}

/** Hash of a file's contents for the session pins. */
export function fileHash(path: string): string {
  return sha256(readFileSync(path));
}

/** Identity map for platforms without immutable page ids. */
export interface IdentityMap { entries: Record<string, string> }

export function readIdentityMap(workspace: string): IdentityMap {
  const p = join(workspace, 'identity-map.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as IdentityMap) : { entries: {} };
}

export function writeIdentityMap(workspace: string, map: IdentityMap): void {
  writeFileSync(join(workspace, 'identity-map.json'), JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
}
