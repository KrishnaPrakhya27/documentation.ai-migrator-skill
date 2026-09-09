---
name: migrate
description: "Router for Documentation.AI migrations: fingerprints the source (export archive, source repo, or live site), scores the platform, and hands off to the matching platform migration skill or to migrate-generic. Use when asked to migrate, import, or move docs onto Documentation.AI."
---
# Migrate (router)

You are running an internal Documentation.AI migration. Deterministic code does the work; you orchestrate, stop at gates, and never publish anything the gates reject.

## Before anything
1. Ask for or confirm: source (URL, export archive, or repo), landing option (`customer-org` or `demo-org`), and an external workspace path. Refuse to run inside this plugin directory.
2. Run `dai-migrate init --workspace <path> --source <src> --target <customer-org|demo-org> [--platform <name>] [--export <archive>]`. It validates the landing choice, records the remote allowlist, and—when `DAI_API_BASE` and `DAI_API_KEY` are set—checks `/api/v1/config`. Preview availability, quota and role are reported as platform checks that still require dashboard confirmation.
3. Run `dai-migrate fingerprint`. Read `plan/fingerprint.json`: platform, confidence, signals. If confidence < 0.7 or two platforms score close, stop and ask which platform it is; never guess on hybrid sites.

## Hand-off
- `document360` → skill `migrate-document360`
- `readme` → `migrate-readme`
- `mintlify` → `migrate-mintlify`
- `gitbook` → `migrate-gitbook`
- otherwise → `migrate-generic`

Current executable paths are: Document360 export ZIP/directory; any local Markdown/MDX/HTML repository; and live URL acquisition through the local fetcher or Firecrawl. ReadMe and GitBook API clients, OpenAPI migration, provider-backed asset ingestion, and source-specific navigation config import are not implemented; the platform skills state these boundaries explicitly.

## Release sequence
Run `assets` before `convert`. Run `verify` twice without a preview so the second run proves determinism. `write --push` may then push only the migration branch, with every non-preview gate passing, so Documentation.AI can create the preview. Re-run `verify --preview-url <url> --preview-contract-version <version>`; release is allowed only when every gate passes.

## Rules you never break
- No `.jsx` snippets or any executable output; T5 is static only.
- Nothing invalid reaches the migration branch; quarantine instead.
- Every source block has a ledger disposition before `verify` can pass.
- Plans are YAML the operator edits; you do not hand-edit output MDX.
- Do not paste secrets, cookies or tokens into any file or log.
