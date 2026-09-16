/**
 * The command line: what each command is called, what it takes, and what the help says.
 *
 * Kept apart from the stages so the surface an operator sees is one readable file, and so a stage
 * cannot grow a flag without it appearing here.
 */
import { parseArgs } from 'node:util';

export const HELP = `dai-migrate <command> [options]

Commands (run in order; the workflow has exactly four standard human gates):
  init         --workspace <dir> --source <url|path> --target customer-org|demo-org --remote <git url> [--platform p] [--export <zip|dir>] [--fidelity exact|permissive] [--allowed-orgs a,b] [--customer-authorised]
               verifies the remote, the API key, the connected repository, previews and the media API up front; records the asset provider
  fingerprint  [--url <u>] [--export <zip|dir>] [--repo <dir>]     → plan/fingerprint.json
  discover     [--export <zip|dir>] [--url <u>] [--discovery-limit n] [--offline] [--exclude-help-system <root> --by "<who>"] → plan/tree.yaml [gate 1: scope]
               --offline rebuilds the tree and navigation from the frozen source already in the workspace; it fetches nothing
               --exclude-help-system (repeatable) records that a second help system published on the host is out of
               scope, with --by naming who decided; its pages are excluded with attribution instead of being placed by
               a sidebar that does not name them. The seed's own help system can never be excluded.
  approve      --gate <1-4> --by "<who>" [--note "<why>"]           records a human gate against the state it approves
  rebase       --reason "<why>"                                     re-pins the migrator build after a fix, keeps the frozen source
               and its acquisition pin, and stales every derivation; follow it with "discover --offline"
  acquire      [--fetcher local|firecrawl] [--zero-data-retention] [--profile p] [--urls file] [--proxy url] [--headers-file json] [--cookies-file file] → source-cache/acquired/
  inventory                                                         → snapshot/, inventory/*.json
  plan         [--mode preserve|restructure|hybrid] [--strip-prefix p] [--case preserve|lower] → plan/*.yaml [gate 2: conversion plan]
  assets       [--provider none|local|s3|dai-api]                   → plan/assets.json, assets-original/
  convert                                                           → output/, ledger/, quarantine/
  nav          [--place-unlisted --by "<who>"]                      → output/documentation.json, report/redirects.*.json, report/anchors.json
               [--help-center "<container>" [--hub-path <route>] --by "<who>"]
               opens that container on a help-centre hub: a page of category cards drawn from its own navigation
               --place-unlisted puts pages the source's own sidebar never named under the folders the source
               publishes them in, because the renderer serves only routes the navigation names. It states a
               structure the source's sidebar does not, so it records who decided and marks the navigation
               operator-reviewed; gate 1 must then be approved again for the tree it produced.
  write        [--repo <dir>] [--remote <url>] [--push] [--allow-lossy] [--no-wait] [--preview-timeout min] [--revision "<why>"] → refs/heads/migration/<session>; with --push waits for the preview deployment and records its URL
               --revision takes a new migration id for a build that supersedes the last push, recording why;
               a branch already pushed is evidence and is never rewritten
               --allow-lossy (permissive sessions only) pushes an exploratory branch with unproven exactness gates waived; failed gates still block
  verify       [--preview] [--preview-url <u>] [--preview-contract-version v] → local [gate 3: pre-push] or preview [gate 4: release]; --preview uses the URL recorded by write
  release                                                            validates all four approvals and writes an immutable release certificate
  report       [--no-pdf] [--summary]                               → report/summary.md, report/platform-gaps.json,
               and the customer-facing report/customer-report.{html,pdf,json}: what was migrated,
               what did not carry over and why, and what still needs a customer decision.
               --no-pdf writes the HTML only (no browser needed)
               --summary writes the reader's version: verdict, numbers, decisions and checks, without the appendix, addresses or technical detail

Every command except init takes --workspace <dir> (or MIGRATION_WORKSPACE).`;

/** The parsed command line. The return type is inferred so each flag keeps the type its definition gives it. */
export function parseCommandLine() {
  return parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', default: process.env.MIGRATION_WORKSPACE },
    source: { type: 'string' }, target: { type: 'string' }, platform: { type: 'string' }, export: { type: 'string' }, url: { type: 'string' }, repo: { type: 'string' },
    'allowed-orgs': { type: 'string', default: process.env.MIGRATION_ALLOWED_ORGS ?? '' },
    'customer-authorised': { type: 'boolean', default: false },
    fidelity: { type: 'string', default: 'exact' },
    mode: { type: 'string' }, 'strip-prefix': { type: 'string' }, case: { type: 'string' },
    provider: { type: 'string', default: process.env.MIGRATION_ASSET_PROVIDER }, fetcher: { type: 'string', default: 'local' }, profile: { type: 'string' }, urls: { type: 'string' },
    'discovery-limit': { type: 'string', default: process.env.MIGRATION_DISCOVERY_LIMIT ?? '5000' },
    'firecrawl-proxy': { type: 'string', default: process.env.FIRECRAWL_PROXY_MODE ?? 'auto' },
    'max-concurrency': { type: 'string', default: process.env.FIRECRAWL_MAX_CONCURRENCY },
    'firecrawl-timeout-min': { type: 'string', default: process.env.FIRECRAWL_TIMEOUT_MIN ?? '360' },
    openapi: { type: 'string', multiple: true },
    'exclude-help-system': { type: 'string', multiple: true },
    'place-unlisted': { type: 'boolean', default: false }, 'help-center': { type: 'string' }, 'hub-path': { type: 'string' },
    revision: { type: 'string' },
    concurrency: { type: 'string', default: process.env.MIGRATION_CONCURRENCY ?? '4' },
    rps: { type: 'string', default: process.env.MIGRATION_RPS ?? '2' },
    refresh: { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false }, reason: { type: 'string' },
    gate: { type: 'string' }, by: { type: 'string' }, note: { type: 'string' },
    'zero-data-retention': { type: 'boolean', default: process.env.FIRECRAWL_ZERO_DATA_RETENTION === '1' },
    proxy: { type: 'string', default: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY },
    'headers-file': { type: 'string', default: process.env.MIGRATION_HEADERS_FILE }, 'cookies-file': { type: 'string', default: process.env.MIGRATION_COOKIES_FILE }, 'auth-origin': { type: 'string', default: process.env.MIGRATION_AUTH_ORIGINS },
    remote: { type: 'string' }, push: { type: 'boolean', default: false }, 'allow-lossy': { type: 'boolean', default: false },
    'no-wait': { type: 'boolean', default: false }, 'no-pdf': { type: 'boolean', default: false }, summary: { type: 'boolean', default: false }, 'preview-timeout': { type: 'string', default: process.env.MIGRATION_PREVIEW_TIMEOUT_MIN ?? '15' },
    preview: { type: 'boolean', default: false }, 'preview-url': { type: 'string' }, 'preview-contract-version': { type: 'string' },
    'log-originals': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
}
