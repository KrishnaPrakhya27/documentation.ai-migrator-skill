# documentation.ai-migration-skills

Agent skills plus a deterministic TypeScript core (`dai-migrate`) for moving a documentation site onto Documentation.AI **exactly**: the migrated content and structure are the source's own, proven against a sealed copy of the source, with a customer-facing report of what arrived, what did not, and why.

It runs as a Claude Code (or Codex) plugin: the skills in `skills/` tell the agent what to do, and the agent drives the CLI. The CLI does all conversion; the agent never converts anything itself.

- **One rule:** migrated text, titles, descriptions, sidebar labels, groups, order, links, images, code and component semantics must be the source's. Styling may differ. Content may not. When a stage cannot prove something it stops and names what to fix.
- **Four human gates** and nothing else: scope and structure, conversion plan, pre-push review, preview and release.
- **A failing check is a finding, never a lock on the preview.** Once scope and plan are approved, the migration branch is pushed with every finding recorded; findings block `release`, not the preview.
- **Run data never lives in this repository.** Every command takes `--workspace <dir>` outside the plugin.

---

## Contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [How a migration runs](#how-a-migration-runs)
5. [Supported sources](#supported-sources)
6. [The workspace](#the-workspace)
7. [Reports](#reports)
8. [Fixing the migrator mid-run](#fixing-the-migrator-mid-run)
9. [Several migrations at once](#several-migrations-at-once)
10. [Environment variables](#environment-variables)
11. [Rules you never break](#rules-you-never-break)
12. [Developing](#developing)
13. [Troubleshooting](#troubleshooting)
14. [Repository map](#repository-map)

---

## Requirements

| Need | Why |
| --- | --- |
| Node.js 22 or newer, npm | the CLI and its tests |
| git, and push access to the customer's docs repository | `write --push` publishes a migration branch |
| `gh auth login` (or SSH keys) | the private plugin repository and GitHub remotes |
| Google Chrome or Chromium (optional) | `verify --preview` renders the deployed preview; `report` prints the PDF. Without it the HTML and JSON are still written |
| Documentation.AI API key and base URL (optional) | `init` settles the platform questions up front: the connected repository, previews, the media API, the asset provider |

---

## Install

The plugin is hosted in a private GitHub repository: `KrishnaPrakhya27/documentation.ai-migrator-skill`. You need read access to it on GitHub and git credentials on your machine (`gh auth login` is enough).

### As a Claude Code plugin

Inside Claude Code:

```
/plugin marketplace add KrishnaPrakhya27/documentation.ai-migrator-skill
/plugin install documentation-ai-migration@documentation-ai-migration
```

The marketplace and the plugin are both named `documentation-ai-migration` (see `.claude-plugin/marketplace.json`); `/plugin` lists the exact names if they ever change. The same commands exist on the command line as `claude plugin marketplace add …` and `claude plugin install …`. To pick up a new version later:

```
/plugin marketplace update documentation-ai-migration
```

The CLI needs its dependencies installed once inside the plugin's checkout. Find where Claude Code cloned the marketplace (`/plugin` shows it; by default under `~/.claude/plugins/`) and run `npm install` there. If that is awkward, use a local clone instead (next section), which is what every migration so far has done.

### From a local clone

```bash
git clone https://github.com/KrishnaPrakhya27/documentation.ai-migrator-skill.git ~/documentation.ai-migration-skills
cd ~/documentation.ai-migration-skills
npm install
npm run typecheck && npm test        # 80 files, ~790 tests, no network
```

Then either register the clone as a marketplace (`/plugin marketplace add ~/documentation.ai-migration-skills` followed by the same `/plugin install`), or start Claude Code with the plugin loaded from disk:

```bash
claude --plugin-dir ~/documentation.ai-migration-skills
```

The skills reference the CLI as `npx dai-migrate <command>` (or `npm run dai-migrate -- <command>`), run from the plugin root. It is not installed globally.

### Team settings (optional)

To have the marketplace and plugin enabled for everyone opening a given project, add to that project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "documentation-ai-migration": {
      "source": { "source": "github", "repo": "KrishnaPrakhya27/documentation.ai-migrator-skill" }
    }
  },
  "enabledPlugins": { "documentation-ai-migration@documentation-ai-migration": true }
}
```

---

## Quick start

Ask the agent to migrate a site and it follows `skills/migrate/SKILL.md`. Run by hand, a migration is this sequence, from the plugin root, with a workspace **outside** the plugin:

```bash
W=~/migrations/acme-docs          # never inside this repository

npx dai-migrate init      --workspace $W --source https://docs.acme.com --target customer-org \
                          --remote git@github.com:acme/docs.git --fidelity exact --allowed-orgs acme \
                          --customer-authorised
npx dai-migrate fingerprint --workspace $W            # which platform is this?
npx dai-migrate discover  --workspace $W              # → plan/tree.yaml           [human gate 1]
npx dai-migrate approve   --workspace $W --gate 1 --by "Your Name <you@company>"
npx dai-migrate acquire   --workspace $W              # freeze every page (live sources only)
npx dai-migrate inventory --workspace $W
npx dai-migrate plan      --workspace $W              # → plan/*.yaml              [human gate 2]
npx dai-migrate approve   --workspace $W --gate 2 --by "Your Name <you@company>"
npx dai-migrate assets    --workspace $W --provider dai-api
npx dai-migrate convert   --workspace $W
npx dai-migrate convert   --workspace $W              # twice: proves determinism
npx dai-migrate nav       --workspace $W
npx dai-migrate verify    --workspace $W              # local gates                [human gate 3]
npx dai-migrate write     --workspace $W --push       # migration branch + preview URL
npx dai-migrate verify    --workspace $W --preview    # gates on the deployed preview [human gate 4]
npx dai-migrate approve   --workspace $W --gate 3 --by "…"   # and --gate 4 after the preview review
npx dai-migrate release   --workspace $W              # → report/release-certificate.json
npx dai-migrate report    --workspace $W              # team files + customer report (HTML, PDF, JSON)
```

`npx dai-migrate --help` prints every command and flag.

Two things to have before you start:

- **Written permission from the customer to crawl their site** (`--customer-authorised` records it), or a native export or repository instead of a crawl. Never crawl without it.
- **The git remote of the repository connected to the target Documentation.AI project.** `init` proves push access with a dry run that changes nothing, and refuses to reuse a remote from some other migration.

---

## How a migration runs

### Stages

| Stage | What it does | Writes |
| --- | --- | --- |
| `init` | creates the workspace, pins the migrator build, proves the remote and (with an API key) the platform | `session.json`, `report/preflight.json` |
| `fingerprint` | scores which platform the source is | `plan/fingerprint.json` |
| `discover` | finds every page and the source's own navigation; freezes the source universe | `plan/tree.yaml`, `source-cache/discovery-result.json`, `source-cache/source-manifest.json` |
| `acquire` | freezes each page: its rendered HTML, its published Markdown where the platform serves one, its `llms.txt` entry; `--openapi <url>` captures a spec the source shows | `source-cache/acquired/` |
| `inventory` | reads every page into the intermediate representation; records headings, links, components, fidelity records | `snapshot/`, `inventory/` |
| `plan` | proposes the URL plan, the component plan, the asset plan | `plan/urls.yaml`, `plan/component-plan.yaml`, `plan/assets.yaml` |
| `assets` | downloads, de-duplicates and hosts media | `plan/assets.json`, `assets-original/`, `assets-ready/` |
| `convert` | converts every page to Documentation.AI MDX by rule; quarantines what it cannot carry exactly | `output/`, `ledger/`, `quarantine/` |
| `nav` | writes `documentation.json`: navigation, redirects, anchor shims | `output/documentation.json`, `report/redirects.*.json`, `report/anchors.json` |
| `verify` | runs the 37 release gates locally, or against the deployed preview with `--preview` | `report/gates.json`, `report/review-queue.md` |
| `write --push` | writes the migration branch `migration/<session>` and pushes it; waits for the preview | `repo/`, preview URL in `session.json` |
| `release` | validates the four approvals against their pinned evidence | `report/release-certificate.json` |
| `report` | team reports and the customer report | `report/summary.md`, `report/customer-report.{html,pdf,json}` |

A stage that fails stops and names what to fix. Fix the plan or the migrator, then run the stage again. Never hand-edit `output/`.

### The four human gates

| Gate | After | The person confirms |
| --- | --- | --- |
| 1 · scope and structure | `discover` | `plan/tree.yaml` is the site: every page, its title, its place in the navigation. Pages to leave out go in `plan/scope-decisions.yaml` with a reason and an approver, never by deleting tree entries |
| 2 · conversion plan | `plan` | the URL plan, the component decisions (per component cluster, applied per instance), the asset plan |
| 3 · pre-push review | `verify` | the output and the findings. **A failing gate is a finding for this review, not a reason to withhold the preview** |
| 4 · preview and release | `verify --preview` | the deployed preview, route by route. `release` then writes the certificate; nothing is cut over without it |

`approve --gate <n> --by "<who>"` records each one against the exact state approved; if that state changes, the approval lapses and `human-gates-approved` says so.

### Exact and permissive

`init --fidelity exact` is the default and the only mode for a customer migration. It certifies the output against the raw acquired source, in both directions and in order: text the output has that the source does not fails as hard as text that is missing (that is what catches platform chrome). Titles and descriptions come only from what the source states. An asset that cannot be hosted, a page whose published Markdown cannot be acquired, an authored block someone wants to drop (`plan/block-exclusions.yaml` is refused in exact mode): each stops the run.

`--fidelity permissive` is for exploration. The same pipeline runs, but the exact-family gates report `not-run` instead of `pass`, assets may stay on the source host (`assets --provider none`), and `write --push --allow-lossy` records the unproven gates as waived in `report/lossy-push.json`. The branch is not a certified migration and must never be released to a customer.

### What a failing gate means

`verify` writes `report/gates.json` and a readable `report/review-queue.md`. Each gate is a fact about the output, in the run's own words, with samples. The exact family (`source-content-exact`, `source-metadata-exact`, `html-reconciliation`, `chrome-absent`, `navigation-exact`, `conversion-fidelity`, `serialized-output-exact`, `no-authored-exclusions`, `source-universe-accounted`) compares against the sealed source.

Two gates fail on every re-run and are not defects: `human-gates-approved` (the tree or plan changed since the approval, so approve again) and `migrator-pinned` when the build changed (run `rebase`, below).

`write --push` never refuses over a failing gate or a missing gate-3 sign-off, in any mode. It requires gates 1 and 2, records every open finding in `report/pushed-with-findings.json`, prints them, and pushes. `release` is where a finding blocks.

---

## Supported sources

The router (`skills/migrate/SKILL.md`) fingerprints the source and hands off to a platform skill. Every adapter passes one shared conformance suite, so a guarantee that holds for one holds for all.

| Source | How it is read | Skill |
| --- | --- | --- |
| Mintlify site or repository | `docs.json`/`mint.json` navigation (versions, languages, tabs, anchors, dropdowns, groups), snippets, redirects, group-level OpenAPI, custom heading ids; live sites through the sidebar and the published Markdown | `migrate-mintlify`, `scrape-mintlify` |
| GitBook site or Git Sync repository | `SUMMARY.md`, `.gitbook.yaml`, Liquid blocks (`hint`, `tabs`, `stepper`, `embed`, `openapi`…), section switcher and section groups, published Markdown and `llms.txt`; a supplied OpenAPI spec (`acquire --openapi <url>`) | `migrate-gitbook`, `scrape-gitbook` |
| ReadMe project | sync repository or API v2 (`README_API_KEY`), categories, guides, reference pages | `migrate-readme`, `scrape-readme` |
| Document360 | export ZIP or directory (articles, categories, media, snippet tokens), or the live site | `migrate-document360`, `scrape-document360` |
| MadCap Flare (published site) | pages plus the navigation data files the site publishes (`Data/HelpSystem.xml`, table-of-contents chunks); tile grids, tab strips and linked tables of contents | `migrate-generic` (`madcap` profile) |
| Fern, Docusaurus, Nextra repositories | through the adapter registry; a sidebar written in executable JavaScript is reported as unread and reviewed at gate 1 | `migrate-generic` |
| Any local Markdown/MDX/HTML repository, any live site | sitemaps, sidebars, same-origin links; optional Firecrawl | `migrate-generic`, `scrape-generic` |

API reference pages migrate the way the platform renders them: `openapi:` on the page's navigation entry over a spec under `api-reference/`. Group-level (auto) references attach to the group; custom-mode pages are never emitted. A source help centre can open on the platform's card hub (`nav --help-center`).

`docs/STATUS.md` records what is verified and the explicit boundaries per platform.

---

## The workspace

Everything a migration produces lives in the workspace, mode `0700`:

```
session.json                 identity, stage state, pins (migrator build, plans, output hash), approvals, preview URL
plan/                        what a person reviews: tree.yaml, urls.yaml, component-plan.yaml, assets.yaml, scope-decisions.yaml
source-cache/                the sealed source: discovery-result.json, source-manifest.json, acquired/<pageId>.json
snapshot/  inventory/        the intermediate representation and per-page records (fidelity, anchors, links, page-openapi)
assets-original/ assets-ready/
output/                      the migrated site: MDX per page, documentation.json, api-reference/
ledger/                      one disposition per source block: identical, transformed, excluded, quarantined
quarantine/                  pages held back, each with the reason and both snapshots
repo/                        clone of the customer's repository, where the migration branch is written
report/                      everything below
```

Plans are YAML that a person edits; the stages read them. The sealed source is never rewritten: a migrator fix re-derives from it (see below).

---

## Reports

Written by `report` after `verify`:

| File | For whom | What |
| --- | --- | --- |
| `report/customer-report.pdf` / `.html` | the customer | the verdict, four numbers, the decisions they must make as plain sentences with example page names, what is good to know, the checks at a glance, and an appendix with the complete lists for whoever acts on them |
| `report/customer-report.json` | the customer's team | the same data, every item |
| `report --summary` | a reader | the same page without the appendix, addresses or build detail |
| `report/summary.md`, `report/review-queue.md` | the migration team | build provenance, every gate with samples, in the run's own words |
| `report/gates.json`, `report/redirects.*.json`, `report/anchors.json`, `report/unlisted-pages.json`, `report/unmigrated-links.json`, `report/platform-gaps.json` | engineering | the machine-readable facts |

Gate ids never appear in the customer report; each is said in the customer's terms (`report/gate-language.ts`). Reasons a page was left out are said in plain words (`SKIP_REASON_LANGUAGE` in `report/customer-data.ts`). Nothing is dropped silently: the appendix and the JSON are complete.

The PDF is printed by the same headless Chrome `verify --preview` uses. `--no-pdf` writes the HTML only.

---

## Fixing the migrator mid-run

A fix to this plugin changes what the migrator derives, never what the source served. Do **not** start a new workspace and crawl the site again:

```bash
npx dai-migrate rebase   --workspace $W --reason "what the fix changed"
npx dai-migrate discover --workspace $W --offline      # rebuilds plan/tree.yaml from the sealed source, fetching nothing
npx dai-migrate inventory --workspace $W               # then continue the sequence
```

`rebase` re-pins the build, records the reason in `session.json` (the report lists every build that touched the migration) and marks derived stages stale. `discover --offline` keeps the scope decisions reviewed at gate 1. Re-confirm gate 1 afterwards; the structure may have changed, which is why the fix was made. Start a new workspace only if the re-derivation says the source universe itself would change.

---

## Several migrations at once

Each migration is one workspace and, while the migrator is being fixed for it, one git branch and one worktree of this repository:

```bash
cd ~/documentation.ai-migration-skills
git worktree add ~/dai-migrator-acme -b migrate/acme main
cd ~/dai-migrator-acme && npm install
```

Run that migration's commands from that worktree, and its workspace elsewhere (`~/migrations/acme`). When the fixes are done, merge the branch into `main`, run `npm run typecheck && npm test`, and remove the worktree (`git worktree remove ~/dai-migrator-acme`). A run that needs no code changes can use the `main` checkout directly.

The repository owner commits and pushes; agents leave changes in the working tree with a proposed commit message.

---

## Environment variables

| Variable | Used by |
| --- | --- |
| `MIGRATION_WORKSPACE` | every command, instead of `--workspace` |
| `DAI_API_BASE`, `DAI_API_KEY` | `init` platform checks, `assets --provider dai-api`, preview lookup |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_ZERO_DATA_RETENTION` | `acquire --fetcher firecrawl`; Firecrawl may retain scraped pages unless zero data retention is set and agreed |
| `README_API_KEY`, `README_BRANCH` | ReadMe API v2 discovery |
| `MIGRATION_ALLOWED_ORGS` | the organisations `write` may push to |
| `MIGRATION_RPS`, `MIGRATION_CONCURRENCY`, `MIGRATION_DISCOVERY_LIMIT` | crawl rate and size |
| `MIGRATION_HEADERS_FILE`, `MIGRATION_COOKIES_FILE`, `MIGRATION_AUTH_ORIGINS`, `HTTPS_PROXY` | authenticated or proxied sources |
| `MIGRATION_ASSET_PROVIDER`, `MIGRATION_PREVIEW_TIMEOUT_MIN`, `MIGRATION_TARGET_PUBLIC_BASE`, `MIGRATION_SEARCH_URL_TEMPLATE` | defaults for `assets`, `write`, the cutover notes |
| `NODE_OPTIONS=--max-old-space-size=8192` | sites above a thousand pages; verification streams pages, the rewriting stages hold the corpus |

Credentials go in the environment or in files outside the workspace. Nothing here reads a `.env` for secrets, and no credential is ever written to a file, log or report.

---

## Rules you never break

- No customer or demo content in this repository: no captures, no workspaces, no outputs. A test enforces it.
- No crawl without the customer's written authorisation, or a native export or repository instead.
- Never work around a stopped stage, never weaken or skip a gate, never hand-edit `output/`.
- No fallback that silently substitutes content for something the source states.
- No executable output: no scripts, no event handlers, no `.jsx` snippets. Unsafe or unresolved content blocks release.
- Never reuse another migration's remote. Never rewrite a branch that was already pushed (`write --revision` supersedes it).
- Never paste secrets, cookies or tokens into any file or log.

---

## Developing

```bash
npm install
npm run typecheck
npm test                                            # unit tier: synthetic inputs, no network
DAI_SOURCE_TRUTH_DIR=<dir> npm run test:proof       # exactness proof against a saved real site (held outside the repo)
npm run test:scale                                  # generated corpora; DAI_SCALE_PAGES sets the size
npm run contract:extract                            # regenerate the content contract from the product repos
```

Before reporting a gate fix, prove it on a real captured workspace: copy the workspace, `rebase` → `discover --offline` → `inventory` → … → `verify`, and read `report/gates.json`. Unit tests passing while a gate still fails on the real site has cost a day more than once.

Conventions: TypeScript strict, explicit types on exports, no `any`, async/await, names that say what they do, comments that say why. Deterministic output: the same input produces byte-identical files. Fail closed.

---

## Troubleshooting

| The run says | What it means | What to do |
| --- | --- | --- |
| `--push refused until scope and plan are approved` | gates 1 and 2 are not recorded, or lapsed because the plan changed | review, then `approve --gate 1` / `--gate 2 --by "…"` |
| `human-gates-approved` fails after a re-run | the tree or plan changed since the approval | review and approve again |
| `migrator-pinned` fails | the build changed since `init` | `rebase --reason "…"` then `discover --offline` and continue |
| `discover` refuses: source manifest would change | a fix would change which pages exist, not only how they are read | that is a new capture: start a new workspace |
| `openapi-preserved`: navigation entry does not bind … | an endpoint page is hidden or unlisted, so no entry can carry its operation | place the page in the navigation, or accept that it renders as prose |
| pages quarantined for `exact-fidelity` | conversion could not carry the page without changing it; `quarantine/<page>.json` holds both snapshots | fix the cause in the migrator, `rebase`, re-derive; never exclude the content |
| `linked table of contents … was not captured with the site` | an older capture predates the feature that freezes Flare data files | `discover` and `acquire` again on this build |
| `unmigrated-links` fails | links point at source pages not in scope | migrate those pages, fix the links, or record `unmigratedLinks: source` in `plan/urls.yaml` if the old site stays up |
| no PDF | Chrome is absent | the HTML and JSON are written; install Chrome or use `--no-pdf` |

---

## Repository map

```
skills/                    operator skills: migrate (router), migrate-<platform>, scrape-<platform>, migrate-generic, verify, report
packages/migrate-core/     the engine: cli.ts and cli/, scrape/, adapters/, ir/ (HTML/MDX → IR → MDX), components/ (rules engine),
                           assets/, nav/, urls/, verify/ (gates, fidelity, source truth), report/, evidence/, session/
packages/content-contract/ the Documentation.AI content contract (components, props, navigation, redirects) with strict validators
docs/STATUS.md             what is verified, the boundaries, and a dated log of every cause fixed
docs/platform/             notes on the platform surfaces the migrator relies on
AGENTS.md                  the working rules for an agent in this repository
.claude-plugin/            plugin and marketplace manifests
```
