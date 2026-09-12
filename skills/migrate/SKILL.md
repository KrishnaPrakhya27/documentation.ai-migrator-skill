---
name: migrate
description: "Router for Documentation.AI migrations: fingerprints the source (export archive, source repo, or live site), scores the platform, and hands off to the matching platform migration skill or to migrate-generic. Use when asked to migrate, import, or move docs onto Documentation.AI."
---
# Migrate (router)

You are running an internal Documentation.AI migration. Deterministic code does the work; you orchestrate the four standard human gates below and never publish anything the automated checks or a human reviewer rejects.

## Before anything
1. Ask for or confirm: source (URL, export archive, or repo), landing option (`customer-org` or `demo-org`), and an external workspace path. Refuse to run inside this plugin directory.
2. Run `dai-migrate init --workspace <path> --source <src> --target <customer-org|demo-org> --remote <git url of the repo connected to the target Documentation.AI project> --fidelity exact [--platform <name>] [--export <archive>] --allowed-orgs <owner>`. `--fidelity exact` is the default and the only mode for a customer migration: it certifies the output against the raw acquired source and stops the run rather than shipping a difference (missing published Markdown, an unhostable asset, an authored exclusion, a lost navigation placement, a title the source never stated). Use `--fidelity permissive` only for exploration; it reports the exact-fidelity gates as `not-run` and will not let a preview be pushed without an explicit acceptance. It proves push access to the remote with a dry-run that changes nothing (a missing credential is reported with the exact fix, never discovered after conversion). With `DAI_API_BASE` and `DAI_API_KEY` set it also settles every platform question now: the API key, that the remote is the repository connected to the project (branch sets compared), the live deployment branch, whether previews have been produced before, the media API, and the asset provider to use. Any failed check stops here with the fix named; nothing is written. `report/preflight.json` keeps the result. Ask the user for the remote URL if they do not give it: it is the repository the dashboard created or connected for the project.
3. Run `dai-migrate fingerprint`. Read `plan/fingerprint.json`: platform, confidence, signals. If confidence < 0.7 or two platforms score close and the user did not already select a platform, ask which platform it is; never guess on hybrid sites. An explicit user platform selection resolves this exception.

## Hand-off
- `document360` → skill `migrate-document360`
- `readme` → `migrate-readme`
- `mintlify` → `migrate-mintlify`
- `gitbook` → `migrate-gitbook`
- otherwise → `migrate-generic`

Current executable paths are: Document360 export ZIP/directory; any local Markdown/MDX/HTML repository; ReadMe API v2; Mintlify, GitBook and ReadMe sync repositories; and live URL acquisition through the local fetcher or Firecrawl. The platform skills state their remaining boundaries explicitly.

## Four human gates
1. **Scope and structure**, after `discover`: approve pages, exclusions, navigation groups, order, versions and locales.
2. **Conversion plan**, after `inventory` and `plan`: resolve component, URL, redirect, asset, iframe and snippet decisions.
3. **Pre-push validation**, after assets, two identical conversions, `nav` and local `verify`: inspect the generated site and automated results, then approve only the named migration-branch push.
4. **Preview and release**, after preview `verify`: inspect the rendered preview and final report, then explicitly approve cutover/release.

Stop only at these four standard gates. Missing required inputs, ambiguous platform detection and failed automated checks may still require attention, but they are exceptions rather than additional approval gates. Fold platform-specific decisions into gate 1 or 2. Do not ask again for an action already authorized at the relevant gate unless its reviewed artifacts changed.

## Release sequence
Run `assets` before `convert`, and run `convert` twice over identical inputs to prove determinism. Generate navigation, then run local `verify`; gate 3 occurs only when every pre-push automated check passes. `write --push` may then push only the approved migration branch; it clones the remote into the workspace if no `--repo` is given, then waits for the platform to build the preview and records the preview URL in the session (a missing deployment is diagnosed: GitHub App repository access, plan without previews, or wrong remote). Re-run `verify --preview`; the preview URL and the contract version come from the session (the version is read from the platform when exposed, otherwise the pinned version is assumed and the report says so). Gate 4 occurs only when every release check passes.

## Run sequence
Run every command from the plugin root as `npx dai-migrate <command>`; `dai-migrate` is not installed globally. Every command after `init` takes `--workspace <path>` (or `MIGRATION_WORKSPACE`). Run them in this order; stop at the gate where one is marked.

```
dai-migrate init --workspace <path> --source <src> --target <customer-org|demo-org> --remote <git url> --fidelity exact --allowed-orgs <owner>
dai-migrate fingerprint --workspace <path>
dai-migrate discover   --workspace <path>          # → plan/tree.yaml            [human gate 1]
dai-migrate acquire    --workspace <path>          # live sources only
dai-migrate inventory  --workspace <path>          # → snapshot/, inventory/
dai-migrate plan       --workspace <path>          # → plan/*.yaml               [human gate 2]
dai-migrate assets     --workspace <path> --provider <none|local|s3|dai-api>
dai-migrate convert    --workspace <path>          # run twice, identical inputs
dai-migrate nav        --workspace <path>          # → output/documentation.json
dai-migrate verify     --workspace <path>          # local gates                 [human gate 3]
dai-migrate write      --workspace <path> --push   # migration branch + preview
dai-migrate verify     --workspace <path> --preview                              # [human gate 4]
dai-migrate report     --workspace <path>
```

A stage that fails stops the run and names what to fix. Never skip a stage to get past a failure, and never hand-edit `output/`: change the plan the stage reads and run it again.

## Exploratory test run
Use this only when the user explicitly asks for a test or exploratory migration, or asks to skip asset hosting or push checks. Never for a customer release.

- `init ... --fidelity permissive` instead of `--fidelity exact`.
- `assets --provider none` when asset hosting is not available; permissive mode leaves assets on the source host instead of stopping.
- `write --push --allow-lossy` to push the migration branch and get a preview. It waives only the exactness gates a permissive run leaves unproven; a gate that failed still blocks, and the waiver is recorded in `report/lossy-push.json`.
- Say plainly in your summary that the result is not a certified migration and must not be released to a customer.

If the user asks to skip checks while the session is exact, do not work around the stop: tell them to start a fresh workspace with `--fidelity permissive`.

## Rules you never break
- No `.jsx` snippets or any executable output; T5 is static only.
- Nothing invalid reaches the migration branch; quarantine instead.
- Every source block has a ledger disposition before `verify` can pass.
- Plans are YAML the operator edits; you do not hand-edit output MDX.
- Do not paste secrets, cookies or tokens into any file or log.

### Frozen source and scope review

Discovery now writes a pinned `source-cache/source-manifest.json`. At human gate 1, compare the source identities and any recorded issues with `plan/tree.yaml`. To exclude published pages for a partial migration, record their `pageId`, `sourceId`, reason and actual approver in `plan/scope-decisions.yaml`; deleting a tree entry alone is insufficient. Review these exclusions with the conversion plan at gate 2.

Native inputs are copied into `source-cache/frozen` before adapter processing. Subsequent stages use that copy; changing the original repository does not change this run. Evidence cannot be replaced by repeating discovery: use a new workspace for a new source capture. Credential filenames cause the freeze to stop and request a content-only source directory. Existing workspaces without a source manifest need a new discovery workspace.

Completed live acquisition is separately pinned in `source-cache/acquisition-index.json`. Repeating acquisition checks and reuses that pin; `--refresh` after completion requires a new workspace. Interrupted acquisitions can still resume their successful page records. Firecrawl HTML follows the common acquisition checks, and published Markdown is fetched separately rather than trusting generated Markdown.

Exact discovery stops on a truncated index, missing indexed files or an unsupported independent index reader. The tree and manifest remain available for diagnosis, but acquisition must not proceed past that failed stage. Document360 category enumeration and ReadMe API pagination completeness are currently such blockers.
