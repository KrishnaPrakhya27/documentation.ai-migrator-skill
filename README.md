# Documentation.AI migrator

Move a documentation site onto [Documentation.AI](https://documentation.ai) **exactly**: the text, titles, sidebar, order, links, images and code of the migrated site are your source's own, proven against a sealed copy of the source, and you see a preview before anything goes live.

It is a set of agent skills plus a deterministic command line, `dai-migrate`. Your AI assistant (Claude Code, Codex, Claude Desktop, Cursor…) reads the skills and drives the command line; the command line does all of the converting. The assistant never rewrites your content itself.

What you get:

- **Your content, unchanged.** Every page is checked against the source in both directions. When something cannot be carried exactly, the run stops and says what to fix. It never guesses.
- **Your site's look.** Your brand colour, logo, favicon, top-bar links and old-address redirects are carried into the new site's settings, and you pick the template (`classic` or `atlas`). All of it is proposed in one file you can edit.
- **A preview first.** The migration lands on its own branch (or working version). Your live site is untouched until you merge it.
- **Four decisions, made by a person.** Scope, conversion plan, pre-publish review, release. Nothing else asks for your attention.
- **A plain report** of what arrived, what did not, and why, written for someone who was not in the room.

---

## Contents

1. [Choose how to deliver](#choose-how-to-deliver)
2. [What you need](#what-you-need)
3. [Install](#install)
4. [Quick start](#quick-start)
5. [Use it from any assistant](#use-it-from-any-assistant)
6. [The four decisions](#the-four-decisions)
7. [The look of your site](#the-look-of-your-site)
8. [The preview check](#the-preview-check)
9. [Stages](#stages)
10. [Supported sources](#supported-sources)
11. [The workspace and the reports](#the-workspace-and-the-reports)
12. [Environment variables](#environment-variables)
13. [Rules that are never broken](#rules-that-are-never-broken)
14. [Troubleshooting](#troubleshooting)
15. [Developing](#developing)

---

## Choose how to deliver

The migration is the same in every case. What differs is how the result reaches your Documentation.AI project.

| Flow | Choose it when | You need | Delivered by |
| --- | --- | --- | --- |
| **Clone flow** | you have cloned the repository Documentation.AI created for your project | git access to that repository. **No API key.** | `init --clone <folder>` … `write --push` |
| **Git flow** | you have the repository's URL but no clone, or your team migrates for several customers | git access; an API key is optional and finds the preview URL for you | `init --remote <git url>` … `write --push` |
| **MCP flow** | you do not want to touch git at all | your Documentation.AI account. **No API key, no git.** You sign in through the browser | `publish` (sends everything through Documentation.AI's [Authoring MCP server](https://documentation.ai/docs/ai/authoring-mcp-server)) |

In every flow Documentation.AI builds a preview of what was delivered by itself, and the live site changes only when you merge.

---

## What you need

| Need | Why |
| --- | --- |
| Node.js 22 or newer | the command line |
| git, for the clone and git flows | the migration branch is pushed with your own git credentials |
| A Documentation.AI project and an account that can edit it | the target. No API key is needed in any flow; one is optional and only saves you copying the preview address |
| Permission to read the source | **written permission from the site's owner before crawling a live site**, or use an export or the docs repository instead |
| Chrome or Chromium (optional) | measures phone and tablet layout on the preview, and prints the PDF report. Everything else works without it |
| Image hosting (optional) | the Documentation.AI media API or an S3/R2 bucket. Without either, pictures stay at the addresses that serve them today, and the report says so |

---

## Install

```bash
git clone https://github.com/KrishnaPrakhya27/documentation.ai-migrator-skill.git ~/documentation.ai-migration-skills
cd ~/documentation.ai-migration-skills
npm install
```

**Claude Code**, as a plugin:

```
/plugin marketplace add ~/documentation.ai-migration-skills
/plugin install documentation-ai-migration@documentation-ai-migration
```

You can add the marketplace straight from GitHub instead (`/plugin marketplace add KrishnaPrakhya27/documentation.ai-migrator-skill`); then run `npm install` once inside the folder Claude Code cloned it to. Or start Claude Code with the plugin loaded from disk: `claude --plugin-dir ~/documentation.ai-migration-skills`.

**Any other assistant**: see [Use it from any assistant](#use-it-from-any-assistant).

The command line is run from this folder as `npx dai-migrate <command>`. It is not installed globally. `npx dai-migrate --help` lists every command and flag.

---

## Quick start

Tell your assistant: *"Migrate https://docs.acme.com onto Documentation.AI. My project's repository is cloned at ~/acme-docs."* It follows `skills/migrate/SKILL.md` and stops at the four decisions.

By hand, the clone flow is this sequence. The workspace holds everything the run produces and lives **outside** this folder.

```bash
W=~/migrations/acme-docs

npx dai-migrate init      --workspace $W --source https://docs.acme.com --clone ~/acme-docs \
                          --template classic --customer-authorised
npx dai-migrate fingerprint --workspace $W            # which platform is the source?
npx dai-migrate discover  --workspace $W              # → plan/tree.yaml                  [decision 1]
npx dai-migrate approve   --workspace $W --gate 1 --by "Your Name"
npx dai-migrate acquire   --workspace $W              # seal a copy of every page (live sites)
npx dai-migrate inventory --workspace $W
npx dai-migrate plan      --workspace $W              # → plan/*.yaml, plan/site.yaml     [decision 2]
npx dai-migrate approve   --workspace $W --gate 2 --by "Your Name"
npx dai-migrate assets    --workspace $W              # host the pictures
npx dai-migrate convert   --workspace $W
npx dai-migrate convert   --workspace $W              # twice: proves the result is repeatable
npx dai-migrate nav       --workspace $W              # → output/documentation.json
npx dai-migrate verify    --workspace $W              # checks on your machine             [decision 3]
npx dai-migrate approve   --workspace $W --gate 3 --by "Your Name"
npx dai-migrate write     --workspace $W --push       # migration branch → preview build
npx dai-migrate verify    --workspace $W --preview-url https://…   # checks on the preview   [decision 4]
npx dai-migrate approve   --workspace $W --gate 4 --by "Your Name"
npx dai-migrate release   --workspace $W              # → report/release-certificate.json
npx dai-migrate report    --workspace $W              # the report, as HTML, PDF and JSON
```

**Where the preview URL comes from.** With no API key, open your project's dashboard → Deployments → Preview, copy the URL of the migration branch once it is ready, and pass it as `--preview-url`. It is remembered, so later runs only need `verify --preview`. With `DAI_API_KEY` set, `write --push` waits for the preview and records the URL itself.

**The other two flows** change two lines:

```bash
# git flow: name the repository instead of a clone (the migrator clones it into the workspace)
npx dai-migrate init --workspace $W --source https://docs.acme.com --remote git@github.com:acme/docs.git --customer-authorised

# MCP flow: no git and no key. init needs no --clone or --remote, and publish replaces write --push
npx dai-migrate init    --workspace $W --source https://docs.acme.com --customer-authorised
#   … the same stages …
npx dai-migrate publish --workspace $W                 # opens your browser to sign in, then publishes
```

`publish` opens your browser so you can sign in to Documentation.AI, exactly as an assistant does when it connects to the MCP server. The sign-in is held in memory for that run and never written anywhere. If your account can edit several projects, name the one you mean with `--project "<name>"`; it is remembered for this migration. Then it sends every file, then the settings and navigation, and publishes a working version `migration/<id>` once. Documentation.AI builds that version's preview by itself: open the project in the dashboard, switch to the working version, copy the preview address from the Save menu (or from Deployments → Preview), and pass it to `verify --preview-url`.

If `publish` stops half-way, run it again and it continues. Pages your project had before are taken out of the navigation (so they are no longer served) and left in place; `--remove-old-pages` deletes them. Go live by merging the working version in the dashboard. On a machine nobody sits at, set `DAI_API_KEY` to the project's key instead of signing in; with a key the preview address is looked up for you.

**No image hosting?** With no API key and no bucket, run `assets --provider none --keep-external --by "Your Name"`. Pictures stay at the addresses that serve them today and keep working while those stay online. The report reminds you to upload them before the old site is switched off.

---

## Use it from any assistant

The skills are plain Markdown and the engine is a command line, so anything that can read instructions and run a command can drive a migration.

| Assistant | How |
| --- | --- |
| **Claude Code** | install the plugin (above). Ask it to migrate a site |
| **Codex** (ChatGPT's coding agent) | install it as a Codex plugin (below), then type `Use $migrate to migrate https://docs.acme.com onto Documentation.AI` |
| Gemini CLI and other terminal agents | open this folder. They read `AGENTS.md`, which points at `skills/migrate/SKILL.md`. Ask them to migrate a site |
| **Claude Desktop, Cursor, VS Code, Windsurf** and any other MCP host | add the local MCP server below. It gives the host four tools: `migration_guide`, `migration_status`, `migration_run`, `migration_read` |
| **claude.ai, ChatGPT chat** | these run in the cloud and cannot reach your files or your git credentials. Use one of the rows above for the migration; use the chat for reviewing the report |

**Codex.** The repository is a Codex plugin marketplace as well (`.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`):

```bash
codex plugin marketplace add ~/documentation.ai-migration-skills        # or KrishnaPrakhya27/documentation.ai-migrator-skill
codex plugin add documentation-ai-migration@documentation-ai-migration
```

Codex runs commands in a sandbox with the network off and only the current folder writable. A migration fetches the source, pushes or publishes, and writes its workspace elsewhere, so start Codex with both allowed:

```bash
mkdir -p ~/migrations
codex --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir ~/migrations
```

Then type `Use $migrate to migrate https://docs.acme.com onto Documentation.AI` and give `~/migrations/<name>` as the workspace. Inside that sandbox `npx` cannot run, so the skill has Codex call `node packages/migrate-core/bin/dai-migrate.mjs` directly. For the MCP flow, Codex hands you the one `publish` command to run in your own terminal, because the browser sign-in is yours. To pick up a new version later: `codex plugin remove documentation-ai-migration@documentation-ai-migration`, then `codex plugin add` again.

**MCP hosts.** The MCP server is this same command line, served over stdio:

```json
{
  "mcpServers": {
    "dai-migrate": {
      "command": "node",
      "args": ["/absolute/path/to/documentation.ai-migration-skills/packages/migrate-core/bin/dai-migrate.mjs", "mcp"]
    }
  }
}
```

That block goes in `claude_desktop_config.json` for Claude Desktop, `.cursor/mcp.json` for Cursor, or `.vscode/mcp.json` for VS Code (there the top-level key is `servers`). For Codex add to `~/.codex/config.toml`:

```toml
[mcp_servers.dai-migrate]
command = "node"
args = ["/absolute/path/to/documentation.ai-migration-skills/packages/migrate-core/bin/dai-migrate.mjs", "mcp"]
```

No key goes in the server's configuration: `publish` opens your browser to sign in. Whichever assistant drives it, the rules live in the command line: it refuses a workspace inside this folder, refuses to push unapproved scope, and records every approval with a person's name.

---

## The four decisions

| Decision | After | You confirm |
| --- | --- | --- |
| 1 · scope and structure | `discover` | `plan/tree.yaml` is your site: every page, its title, its place in the sidebar. To leave pages out, record them in `plan/scope-decisions.yaml` with a reason and your name |
| 2 · conversion plan | `plan` | the address plan, how each kind of component is converted, the pictures, and `plan/site.yaml` (the look) |
| 3 · pre-publish review | `verify` | the converted site and what the checks found. **A finding never holds back the preview.** It is recorded, shown to you, and must be cleared before release |
| 4 · preview and release | `verify --preview` | the rendered preview. `release` then writes the certificate |

`approve --gate <n> --by "<who>"` records each decision against the exact files you looked at. If they change, the approval lapses and the run says so. An assistant never approves for you.

---

## The look of your site

`plan` writes `plan/site.yaml` from what your source says about itself. Edit it freely: none of it is content.

```yaml
branding:
  carry: true                    # false leaves colours, logo and favicon out (the platform's defaults apply)
  colors: { light: "#166e3f", dark: "#26bd6c" }
  logo:    { light: https://…/logo-light.svg, dark: https://…/logo-dark.svg }
  favicon: { light: https://…/favicon.ico }
navbar:
  primary: { title: Get started, link: https://acme.com/start }
  links:   [{ title: Talk to us, link: https://acme.com/contact }]
template: classic                # or atlas; also settable up front with init --template
stylesheet: true                 # ships styles/migration.css: small finishing rules, all scoped to the migration's own markup
redirects: true                  # old addresses redirect to the pages that replace them
```

`nav` writes these into `documentation.json` under the platform's own settings and checks the result against the platform's published schema. Logos and favicons are hosted with the rest of your pictures. Sidebar icons, API method badges (GET, POST…), "new"/"beta" badges, page layout modes and link-only tabs are carried from the source too. What the platform has no setting for (a footer, custom fonts, a banner) is listed under `notCarried` so you know.

---

## The preview check

`verify --preview` reads every page of the preview over HTTP. A thousand pages take a few minutes, and no browser is needed.

It **fails** a page only for something a reader would miss:

- the page does not load,
- a passage or a heading of the source is nowhere on it,
- a link on it leads nowhere,
- a sidebar entry is missing.

Everything else is **a note, never a failure**: the language label the platform draws on a code block, a "required" pill, a caption, request samples laid out beside the text, a wide table that scrolls sideways on a phone. Your written pages were already proven exact before the push; how the platform draws them is not something a migration can change, so it is listed for you to look at and nothing more.

If a page does fail and you have looked at it and are satisfied, say so:

```bash
npx dai-migrate accept --workspace $W --route docs/keys --reason "the sample moved into the API playground on purpose" --by "Your Name"
npx dai-migrate verify --workspace $W --preview
```

The report keeps the finding with your name beside it. Options: `--renderer chrome` opens every page in a headless browser and also checks the content behind accordions and tabs (slower); `--responsive all|off` measures layout on every page or not at all (the default is a spread of 24 pages).

---

## Stages

| Stage | What it does | Writes |
| --- | --- | --- |
| `init` | creates the workspace, records the build, checks that you can push | `session.json`, `report/preflight.json` |
| `fingerprint` | works out which platform the source is | `plan/fingerprint.json` |
| `discover` | finds every page and the source's own navigation | `plan/tree.yaml`, `source-cache/source-manifest.json` |
| `acquire` | seals a copy of each page; `--openapi <url>` captures an API specification | `source-cache/acquired/` |
| `inventory` | reads every page into a neutral form; records headings, links, components | `snapshot/`, `inventory/` |
| `plan` | proposes addresses, component conversions, pictures and the site's look | `plan/urls.yaml`, `plan/component-plan.yaml`, `plan/assets.yaml`, `plan/site.yaml` |
| `assets` | downloads, de-duplicates and hosts pictures and files | `plan/assets.json` |
| `convert` | converts every page by rule; holds back what it cannot carry exactly | `output/`, `ledger/`, `quarantine/` |
| `nav` | writes `documentation.json`: navigation, settings, redirects | `output/documentation.json`, `output/styles/migration.css` |
| `verify` | runs the checks, on your machine or against the preview | `report/gates.json`, `report/review-queue.md` |
| `write --push` / `publish` | delivers the migration and gets a preview | the migration branch or working version |
| `accept` | records that a named person accepted a preview finding | `plan/preview-acceptances.yaml` |
| `release` | confirms all four decisions against what they approved | `report/release-certificate.json` |
| `report` | the customer report and the team's files | `report/customer-report.{html,pdf,json}` |

A stage that fails stops and names what to fix. Fix the plan (or the migrator) and run the stage again. Never edit `output/` by hand.

**If the migrator itself is fixed mid-run**, do not crawl the site again: `rebase --reason "…"`, then `discover --offline`, then continue from `inventory`. The sealed source is re-read; nothing is fetched.

`init --fidelity exact` is the default and the only mode for a real migration. It stops rather than ship a difference: a page whose published Markdown cannot be acquired, a picture nobody hosts (unless a named person decides otherwise), a title the source never stated, an authored block someone wants to drop (`plan/block-exclusions.yaml` is refused in exact mode). `--fidelity permissive` is for exploring: the exactness checks report `not-run` instead of passing, and the result must not be released.

---

## Supported sources

| Source | How it is read |
| --- | --- |
| **Mintlify** site or repository | `docs.json`/`mint.json` navigation (languages, versions, tabs, menus, groups), icons, badges, page modes, hidden pages, snippets, redirects, OpenAPI; live sites through their published Markdown |
| **GitBook** site or Git Sync repository | `SUMMARY.md`, `.gitbook.yaml`, blocks (`hint`, `tabs`, `stepper`, `embed`, `openapi`…), section switcher, published Markdown |
| **ReadMe** project | sync repository or API v2 (`README_API_KEY`) |
| **Document360** | export ZIP or folder, or the live site |
| **MadCap Flare** published site | pages plus the navigation data files the site publishes; tile grids, tab strips |
| **Fern, Docusaurus, Nextra** repositories | through the adapter registry; a sidebar written in executable JavaScript is reviewed at decision 1 |
| Any Markdown/MDX/HTML folder, any live site | sitemaps, sidebars, same-site links |

API reference pages are bound to their operation in your OpenAPI specification, with the method badge in the sidebar. A help centre can open on a card hub (`nav --help-center "<tab or group>" --by "<who>"`), in every language the site has. `docs/STATUS.md` records what is verified for each platform and where the boundaries are.

---

## The workspace and the reports

```
session.json      the run's identity, stage state, approvals, preview URL
plan/             what a person reviews: tree, addresses, components, pictures, site look, scope decisions
source-cache/     the sealed source; never rewritten
output/           the migrated site: one MDX file per page, documentation.json, api-reference/, styles/
quarantine/       pages held back, each with the reason
report/           everything below
```

| File | For | What |
| --- | --- | --- |
| `report/customer-report.pdf` / `.html` | the site's owner | the verdict, the numbers, the decisions still open as plain sentences, and an appendix with every list |
| `report --summary` | a reader in a hurry | the same first page without the appendix |
| `report/review-queue.md` | whoever runs the migration | every check in the run's own words, with examples and notes |
| `report/gates.json`, `report/preview-routes.json`, `report/responsive.json` | engineering | the facts, machine-readable |

---

## Environment variables

| Variable | Used for |
| --- | --- |
| `MIGRATION_WORKSPACE` | instead of `--workspace` |
| `DAI_API_KEY` | your project's key. Optional everywhere: it finds the preview address for you, checks the project up front, enables the media API, and lets `publish` run without a browser sign-in |
| `DAI_API_BASE` | the platform's API address. Defaults to `https://api.documentation.ai`; set it only for another environment |
| `DAI_MCP_URL` | the Authoring MCP endpoint, default `https://api.documentation.ai/mcp` |
| `MIGRATION_ALLOWED_ORGS` | for teams: the organisations a migration may write to. Without it a migration may write only to the organisation of the repository named at `init` |
| `R2_*` / S3 settings, `MIGRATION_ASSET_PROVIDER` | hosting pictures in your own bucket |
| `FIRECRAWL_API_KEY`, `README_API_KEY` | optional fetchers and the ReadMe API |
| `MIGRATION_RPS`, `MIGRATION_CONCURRENCY` | crawl rate; concurrency of the preview check |
| `CHROME_PATH` | a Chrome or Chromium binary, if it is not found by itself |
| `NODE_OPTIONS=--max-old-space-size=8192` | sites above a thousand pages |

Keep credentials in the environment. No credential is ever written to a file, log or report.

---

## Rules that are never broken

- No crawl without the owner's written permission. Use an export or the repository otherwise.
- Customer content never lives in this folder. Workspaces are always somewhere else.
- A stopped stage is never worked around, a check is never weakened, `output/` is never edited by hand.
- Nothing is substituted silently for something the source states.
- No executable output: no scripts, no event handlers.
- A branch that was pushed is never rewritten (`write --revision "<why>"` makes a new one).
- An assistant never approves a decision. A person does, by name.

---

## Troubleshooting

| The run says | What it means | What to do |
| --- | --- | --- |
| `refused until scope and plan are approved` | decisions 1 and 2 are not recorded, or lapsed because a plan changed | review, then `approve --gate 1` / `--gate 2 --by "…"` |
| `human-gates-approved` fails after a re-run | the tree or a plan changed since the approval | review and approve again |
| `migrator-pinned` fails | this tool changed since `init` | `rebase --reason "…"`, then `discover --offline` and continue |
| `assets stopped: exact mode requires a hosted URL` | no image hosting is configured | set up the media API or a bucket, or `assets --provider none --keep-external --by "…"` |
| `browser-content` fails | a page of the preview is missing something a reader would look for | open `report/review-queue.md`, look at the page, then fix it or `accept` it |
| `publish` stops with `duplicate_path` | the platform refuses a navigation that lists one page twice through the MCP server | deliver with `write --push` instead, or place the page once at decision 1 |
| the "Learn" link in a dropdown opens `/null` | a link-only dropdown or menu item; the platform's renderer needs a fix | the preview check names these; report it to Documentation.AI |
| no preview URL after `write --push` | no API key is configured, so it is not looked up | copy it from the dashboard → Deployments → Preview and pass `--preview-url` |
| no PDF | Chrome is absent | the HTML and JSON are written; install Chrome or use `--no-pdf` |

---

## Developing

```bash
npm run typecheck
npm test                                            # synthetic inputs, no network
DAI_SOURCE_TRUTH_DIR=<dir> npm run test:proof       # exactness proof against a saved real site, kept outside the repo
npm run contract:extract                            # regenerate the content contract from the platform's own schema
```

Before reporting a fix to a check, prove it on a real captured workspace: copy the workspace, `rebase` → `discover --offline` → … → `verify`, and read `report/gates.json`. Conventions: strict TypeScript, no `any`, async/await, names that say what they do, comments that say why. The same input produces byte-identical output. Fail closed.

```
skills/                    the assistant's instructions: migrate (router), migrate-<platform>, scrape-<platform>, verify, report
packages/migrate-core/     the engine: cli, scrape, adapters, ir, components (rules), assets, nav, urls, verify, publish, report
packages/content-contract/ the Documentation.AI content contract: components, navigation grammar, settings schema, icon names
docs/STATUS.md             what is verified, the boundaries, and a dated log of every cause fixed
AGENTS.md                  the working rules for an assistant in this repository
```
