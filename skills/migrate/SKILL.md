---
name: migrate
description: "Router for Documentation.AI migrations: fingerprints the source (export archive, source repo, or live site), scores the platform, and hands off to the matching platform migration skill or to migrate-generic. Use when asked to migrate, import, or move docs onto Documentation.AI."
---
# Migrate (router)

You are migrating someone's documentation onto Documentation.AI. Deterministic code does the work; you orchestrate the four human gates below, explain each in plain words to a person who may never have used git, and never publish anything the automated checks or that person rejects. You never approve a gate or accept a finding yourself: those are decisions a named person makes.

## How you ask: choices to click, never sentences to type

The person should be able to run a whole migration by clicking. Wherever your environment has a structured question tool, use it for **every** question and **every** gate: in Claude Code that is `AskUserQuestion`, and it works the same in the terminal, the VS Code extension and the desktop app. One call carries up to four questions, each with two to four options; the person can always choose "Other" to type something else. Put the option you recommend first and end its label with "(Recommended)".

- **Never end a turn by asking the person to type a command-like sentence** such as "tell me to approve gate 1" or "reply with your name". Show the short summary, then call the question tool in that same turn.
- **Keep going.** The moment the person picks the approving option, record it and run the next stages in the same turn. Do not wait for another message, and do not ask "shall I continue?". You stop again only at the next gate, or when a stage stops and names something to fix.
- **The name is asked once**, in the opening questions, and reused for every `--by`. Offer the name from `git config user.name` as the first option. When the person clicks an approving option, that click is their decision and you record it under their name. You still never choose for them: if they pick anything other than the approving option, nothing is approved.
- **Only two things need typing**: a folder path and the preview address. Ask for each in one plain line when you need it.
- **No question tool** (Codex, a plain chat)? Ask the same questions in one short message with numbered choices, so the person can answer "1" or "1, 2, 1".

## Before anything
1. Ask, in **one** question call, only what the request does not already say ("migrate https://docs.acme.com using the MCP flow" states the source and the delivery):
   - **Permission** (live sites only): "Do you have the owner's permission to crawl <host>?" Options: "Yes, it is my site or I have written permission" (records `--customer-authorised`), "No, I will give an export or the repository instead". Never crawl without the first answer.
   - **How to deliver**, if not stated. Options, each with what it needs: "Clone flow" (they cloned the repository Documentation.AI created for their project; no API key), "Git flow" (they give the repository's git URL; an API key is optional and finds the preview address), "MCP flow" (no git and no API key; `publish` opens their browser to sign in).
   - **Template**: "classic (Recommended)" (sidebar layout), "atlas" (denser navigation, content on a card).
   - **Name for the approvals**: the `git config user.name` value first, then "Other".
   Do not ask for the workspace: use `~/migrations/<site-name>` (never inside this plugin directory), say so in one line, and use another folder only if the person says so. For the clone flow, ask for the clone's folder in one plain line afterwards.
2. Run `dai-migrate init --workspace <path> --source <src> (--clone <folder> | --remote <git url> | neither, for the MCP flow) --template <classic|atlas> [--platform <name>] [--export <archive>]`. `--fidelity exact` is the default and the only mode for a real migration: it certifies the output against the raw acquired source and stops the run rather than shipping a difference. `--target` defaults to `customer-org`; only Documentation.AI's own team passes `demo-org`. A team that migrates for several customers lists the organisations it may write to (`--allowed-orgs`, `MIGRATION_ALLOWED_ORGS`); without a list, a migration may write only to the organisation of the repository named here. `init` proves push access with a dry run that changes nothing. With `DAI_API_KEY` set (the API address defaults to the public platform; `DAI_API_BASE` overrides it) it also checks the project connection, previews and the media API up front; without them those checks are skipped and said so, which is normal for the clone flow. Any failed check stops here with the fix named.
   **MCP flow only: run `dai-migrate project` straight after `init`.** It opens the person's browser to sign in (tell them to look for it) and records which Documentation.AI project the migration goes into. If it stops and lists several projects, ask which one, with the projects as the options, and run it again with `--project "<name>"`. Doing this first means the person learns now, not after an hour's work, whether their account can edit the project, and it is what files hosted pictures under the right project: storage is filed per project, and `assets --provider s3` refuses to run in the MCP flow until the project is chosen. `publish` later signs in again (the sign-in is never stored) and goes to the same project.
3. Run `dai-migrate fingerprint`. Read `plan/fingerprint.json`: platform, confidence, signals. If confidence < 0.7 or two platforms score close and the user did not already select a platform, ask which platform it is; never guess on hybrid sites. An explicit user platform selection resolves this exception.

## Hand-off
- `document360` → skill `migrate-document360`
- `readme` → `migrate-readme`
- `mintlify` → `migrate-mintlify`
- `gitbook` → `migrate-gitbook`
- otherwise → `migrate-generic`

Current executable paths are: Document360 export ZIP/directory; any local Markdown/MDX/HTML repository; ReadMe API v2; Mintlify, GitBook, ReadMe sync, Fern, Docusaurus, Nextra and MadCap Flare repositories; and live URL acquisition through the local fetcher or Firecrawl, including published MadCap Flare sites. The platform skills state their remaining boundaries explicitly.

Repository sources are read through one adapter registry (`packages/migrate-core/src/adapters/registry.ts`), which decides what a repository is, reads it, and re-reads its declared navigation at verification. Every adapter passes the same conformance suite, so a guarantee that holds for one platform holds for all of them.

Three platforms need saying at gate 1, because each states its navigation somewhere a crawl does not reach:

- **Docusaurus** with a `sidebars.js`/`.ts` file, and **Nextra** (whose `_meta.json` support was removed in Nextra 3, leaving only `_meta.{js,ts}` modules), declare their sidebar in JavaScript that may scan directories, import generated files or compute entries. This tool does not execute a customer's build code, and will not parse it as if it were data. Pages migrate normally; the sidebar is reported as unread, `source-navigation-proven` refuses to certify it in exact mode, and the operator reviews `plan/tree.yaml` and records that review as the navigation.
- **Docusaurus without a sidebars file** uses its autogenerated sidebar, which is the docs tree plus `_category_.*` plus `sidebar_position`. A single-version/default-locale tree is read and certified. Versioned or translated repositories still depend on executable config for aliases, labels and defaults: every page receives a unique reviewable version/locale route, but exact mode requires gate 1 to record the reviewed tree as `navigationSource: manual` before it can be certified.
- **MadCap Flare** is read two ways, and both are exact.
  - A **published Flare site** serves its sidebar container empty and fills it in the browser, so crawling the HTML recovers no navigation at all. The tree is read instead from the data files the site publishes: the page's own `data-mc-path-to-help-system` names its help system, `Data/HelpSystem.xml` names the table of contents (the filename is chosen per project and is never assumed), and that file names the chunks holding the links and labels. Every chunk is required; a missing one fails rather than yielding a shortened sidebar. The files are frozen with the capture, so verification re-derives the same tree with no network.
  - A **Flare project source** states its sidebar in `Project/TOCs/*.fltoc`, which is XML and is read directly. Two things in a real project are not deterministic and are refused rather than guessed: which table of contents the site builds when several exist and no target names one, and an entry that a target's conditions both include and exclude (MadCap does not define which wins; on a real customer project 55% of entries were tagged both ways). Either refusal is reported for a person to answer.
  - One host may publish several independent help systems (a surveyed site serves 438 pages under one and 13 under another). The seed's help system is the site's navigation; a second is reported, never merged, because concatenating two sidebars would state a structure the source does not have. Exact discovery stops on the second system, because which one the run migrates is the operator's decision: answer it with `discover --exclude-help-system <root> --by "<who>"` (repeatable), which excludes every page under that root with attribution in `plan/scope-decisions.yaml` and records the manifest issue the decision answers. The seed's own help system can never be excluded, and a root matching no discovered system is refused rather than ignored. Migrate a second help system as its own run against its own root.

## What the navigation carries

- **A container's own page.** A GitBook parent page, a Flare topic with subtopics, or a rendered sidebar entry whose subpages follow it opens as that page. It is written as the container's `path`, which is how Documentation.AI reads it — never as a duplicate first entry beneath the container.
- **Hidden containers.** A Mintlify tab, group or page marked `hidden` is published but not shown. Its pages migrate and are reported as unlisted; nothing places them in a sidebar the source never showed.
- **Menus.** A Mintlify `menu` of `item`s is what the platform calls dropdowns, and is written as `dropdowns`; an item that is only a link stays a link.
- **URL case.** The default URL plan preserves a path as the site served it, letter case included: `/Procedures/Composer` stays `Procedures/Composer`. Pass `plan --case lower` to lowercase deliberately.
- **A failing gate never withholds the preview.** `write --push` publishes the migration branch with every finding recorded (`report/pushed-with-findings.json`) once scope and plan are approved; gate 3 is reviewed on the preview, and `release` is where a finding blocks. This holds in exact and permissive mode alike.
- **A group's landing page.** A container's first page is written as the container's own `path` (Documentation.AI's group page) rather than as a child of the same name when the source makes it the landing page: it carries the container's name, or its route is the container's own (`assistant` under "Assistant", or the `index`/`readme` of the directory its siblings sit in), and something else stays beneath the container. This holds for every source. A source that gives the container a page outright (a GitBook parent page, a Flare topic with subtopics) is written the same way.
- **MadCap tile grids.** A Flare landing page's tile grid (`div.procedure-tiles` of `a.procedure-button` links on the surveyed site) is written as a four-column `Columns` of `Card`s, each card titled with the tile's label and linked to its target. Another skin's class names go in the `madcap` profile's recognisers the same way.
- **MadCap tile menus.** A Flare landing page draws tile menus from tables of contents it names with `data-mc-linked-toc`. `discover` captures those TOCs with the site and `convert` writes each menu as the list of links it draws (one level per `data-mc-max-depth`). A capture that predates this holds no such data and the page is held with that reason; re-run `discover`.
- **Pages beside the docs on the same host.** Discovery refuses same-origin URLs outside the site's base path as another site (`/pricing` beside `/docs`), and the frozen source manifest leaves them out too, so exact mode never asks for a decision on them. A workspace captured before this change corrects itself with `rebase --reason "…" && discover --offline`: the only change an offline re-derivation may make to the frozen universe is dropping pages discovery refused.
- **Pages added after planning.** `plan` keeps an existing `plan/urls.yaml` as the operator wrote it and adds the default entry for every migrating page the tree gained since (a scope exclusion lifted, a page a rerun discovered). A new page whose default route the plan already gives another page is refused with the route named, not renumbered.
- **A help centre.** `nav --help-center "<container>" --by "<who>"` opens that container on a hub page the platform renders with `<CollectionList>`: its categories as cards, drawn from its own navigation. The page carries no words of the migration's; it is still a page the source never had, so it is recorded on the tree with its approver, applied identically at verification, and named in the customer report. `--hub-path <route>` places it somewhere other than `<container>/index`.

## The look of the site (`plan/site.yaml`)

`plan` reads what the source says about itself (a Mintlify site's embedded `docs.json`, a GitBook page's header and head) and proposes `plan/site.yaml`: brand colour per colour scheme, logo and favicon, the top bar's button and links, site-level SEO statements, the template chosen at `init`, the migration's finishing stylesheet, and whether old addresses redirect. It is presentation, not content, so the person may change anything in it; review it with the other plans at gate 2. `nav` writes it into `documentation.json` under the platform's own keys (`colors.{light,dark}.brand`, `logo-light`, `logo-dark`, `favicon`, `navbar.actions`, `seo`, `template`, `customCss`, `redirects`) and validates the whole file against the platform's published schema (`packages/content-contract/documentation.schema.json`): an unknown key is an error here, because the platform would silently ignore it. Logos and favicons are hosted by `assets` like any picture; one that cannot be hosted is left out and said so. For a demo of someone else's documentation, set `branding.carry: false`.

`icons` decides the sidebar's icons and defaults to `suggested`. The platform draws one beside every row that carries one, and documentation written on the platform does carry them; but a GitBook, Docusaurus or ReadMe sidebar states a link and its text and nothing else, so a source that had nowhere to say it migrates into a sidebar that reads plainer than the same pages written in the editor, for a reason no reader can see. `suggested` proposes one from each entry's own title — "Getting Started" gets `rocket`, "Billing" gets `credit-card`, "Migrate from GitBook" gets `book-marked`, a changelog's year groups get `calendar` — wherever the source leaves an entry bare. An icon the source does state is kept exactly as stated; every proposal is checked against the renderer's own icon list, so nothing is written that draws nothing; and within one container the pages either all carry an icon or none do, so no row sits with its title shifted against its neighbours'. Set `icons: source` to carry only what the source states, or `icons: none` for plain text. `nav` reports how many it proposed, and any of them can be changed in `output/documentation.json` afterwards.

Know what the platform has and has not: there is **no** footer, banner, font or search setting, so a source's footer links and fonts are listed under `notCarried`, never invented. Navigation entries carry `icon` (Lucide names only; a Font Awesome name is translated, an untranslatable one is left out with a note), `method` (draws the GET/POST badge; written for every page bound to an OpenAPI operation), `badge`, and the layout switches a Mintlify page `mode` implies. Labels are the source's own, letter for letter; a label the source never states (a group derived from a URL) is written in sentence case. Custom CSS loads through `customCss` and may use the platform's stable `dai-*` classes and `--brand`-family variables; the shipped `styles/migration.css` touches only `dai-mig-*` hooks the migration itself wrote.

## API reference pages

An endpoint page is rendered from a specification, and Documentation.AI renders it from `openapi: api-reference/<spec> METHOD /path` in the page's frontmatter with the spec under `api-reference/`. A Mintlify site's published Markdown restates that as a trailing "OpenAPI" section holding the spec cut to the one operation; the section is read back into the frontmatter, and the spec file is assembled from every page's fragment at `convert`. GitBook's block-form `{% openapi src="<url>" %}` is read the same way, but its spec is a URL: `acquire --openapi <url>` captures it, and `report/openapi-declared.json` lists any the output still lacks. A source's link to a parameter (`#param-<name>`) follows the parameter to the anchor the platform renders (`query-<name>`, `body-<name>`), and the fragment gate counts those anchors.

## Four human gates
At each gate: a summary of a few lines in plain words (what was found, what deserves a look, where the full file is), then the question, in the same turn. The first option approves and continues; the others let the person look closer or change something, after which you ask again.

1. **Scope and structure**, after `discover`. Summarise the tabs or sections with their page counts, anything left out, and anything odd (repeated titles, pages outside the sidebar, a second help system). Ask "Is this the site to migrate?" with: "Approve and continue (Recommended)", "Show me the full page list", "Leave some pages out" (record them in `plan/scope-decisions.yaml` with the reason and their name, then summarise again), "Something is wrong". On approval run `approve --gate 1 --by "<name>"`, then `acquire`, `inventory` and `plan` without pausing.
2. **Conversion plan**, after `plan`. Summarise whether addresses are kept, how many component kinds convert automatically and which need a decision, where the pictures will be hosted, and the look from `plan/site.yaml` (colours, logo, top-bar links, template). A component that needs a decision, and pictures with no hosting (leave them where they are served today under the person's name, or set hosting up first), are each their own question with the choices spelled out. Then ask "Approve this plan?" with: "Approve and continue (Recommended)", "Change the look" (template, carry the brand or not, top-bar links), "Review the component decisions", "Something is wrong". On approval run `approve --gate 2 --by "<name>"`, then `assets`, `convert` twice, `nav` and `verify` without pausing.
3. **Pre-publish review**, after the local `verify`. Summarise the checks in plain words: how many passed, and each failing one as what it means for a reader, not as a gate id. Ask "Publish the preview?" with: "Approve and publish the preview (Recommended)", "Show me the findings", "Show me a converted page", "Stop here". On approval run `approve --gate 3 --by "<name>"` and deliver by the chosen flow. If `publish` lists several projects, ask which one with the projects as the options.
4. **Preview and release**, after `verify --preview`. Summarise what failed (only what a reader would miss) and how many notes there are. Ask "Release this migration?" with: "Approve and release (Recommended)", "Go through the pages with findings" (for each: fix it, or record their acceptance with `accept --route … --reason … --by "<name>"`, then verify again), "Not yet". On approval run `approve --gate 4 --by "<name>"`, `release` and `report`, and end with where the report is and how to go live.

Stop only at these four standard gates. Missing required inputs, ambiguous platform detection and failed automated checks may still require attention, but they are exceptions rather than additional approval gates, and they are asked the same way, with choices. Fold platform-specific decisions into gate 1 or 2; the platform skills say what to review at each gate, and this section says how to ask. Do not ask again for an action already authorized at the relevant gate unless its reviewed artifacts changed.

## Release sequence
Run `assets` before `convert`, and run `convert` twice over identical inputs to prove determinism. Generate navigation, then run local `verify` and stop at gate 3 for the person's review of the output; a failing check is a finding for that review, not a reason to withhold the preview.

Deliver by the flow chosen at the start:
- **clone or git flow**: `write --push` pushes the migration branch once scope and plan (gates 1 and 2) are approved, recording every open finding in `report/pushed-with-findings.json`. With an API key it waits for the preview and records its URL. Without one it prints where to read it: ask the person to open the dashboard → Deployments → Preview, copy the URL of the migration branch once ready, and give it to you; pass it as `verify --preview-url <url>` (it is remembered).
- **MCP flow**: `publish` opens the person's browser to sign in to Documentation.AI (tell them to look for it; the sign-in is held in memory for that run only, and `DAI_API_KEY` is used instead when it is set). If their account can edit several projects it stops and lists them: ask which one and pass `--project "<name>"`. It then sends the output through the Authoring MCP server onto a working version `migration/<id>`: every file first, then settings and navigation (in steps the platform's drift guard accepts), and one publication. The platform builds that version's preview by itself; without a key its address is read from the dashboard (the working version's Save menu, or Deployments → Preview) and passed to `verify --preview-url`. It needs the same approvals as a push. A run that stops continues when run again. It never touches the live version; going live is the person merging the working version. Do not send page content through your own MCP tool calls: `publish` does it byte for byte, which is what makes the result certifiable.

Then `verify --preview`. **What it fails and what it only notes matters**: it fails a route only for something a reader would miss (the page does not load, a source passage or heading is nowhere on it, a link on it leads nowhere, a sidebar entry is missing). How the platform draws a page (a language label on a code block, a "required" pill, a caption, reordered request samples, sideways scroll on a phone) is a note in `report/review-queue.md`, never a failure; do not try to "fix" notes. If a route fails, open it on the preview with the person. Either fix the cause and re-run, or, when they have looked and are satisfied, record their decision: `accept --route <route> --reason "<why>" --by "<their name>"`, then `verify --preview` again. Never accept on your own judgement.

Gate 4 pins `report/preview-gates.json`, `preview-routes.json` and `responsive.json`. After approval, run `release`: it verifies all four approvals against their immutable evidence and writes `report/release-certificate.json`. No cutover is authorised without that certificate.

**No image hosting** (no API key, no bucket) is normal in the clone flow. `assets` then stops in exact mode. Explain the choice to the person: host the pictures (media API or an S3/R2 bucket), or leave them at the addresses that serve them today, which works while the old site stays online. If they choose the latter, run `assets --provider none --keep-external --by "<their name>"`; the report states it.

## Run sequence
Run every command from the plugin root as `npx dai-migrate <command>`; `dai-migrate` is not installed globally. The plugin root is the folder that holds `skills/` and `packages/`, two levels above this file; it is not the folder the person has open. If it has no `node_modules`, run `npm install` in it once before the first command.

**In a sandboxed agent (Codex and similar)** `npx` cannot write npm's own folder and fails with a read-only file system error. Run the launcher directly instead, from the plugin root: `node packages/migrate-core/bin/dai-migrate.mjs <command> …`. It is the same program. The sandbox must also allow the network (the source is fetched, the branch is pushed, the MCP server is called) and must let the run write the **parent** of the workspace folder (the run keeps a lock file beside the workspace) and, in the clone flow, the person's clone. In Codex that is `codex --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir <parent of the workspace>`; if a stage stops with `EROFS` or cannot reach a host, say so and ask the person to restart with those options or to approve the command outside the sandbox. Never work around it by moving the workspace inside the plugin.

**Commands that outlast one tool call.** `acquire`, `assets`, `publish` and `verify --preview` can run for many minutes on a large site. Run them in the background where your environment allows it and read their output as it arrives. `publish` also needs the person: it opens their browser for the sign-in and prints the sign-in address first. Tell them before you start it. If no browser can open from where you run (a sandbox, a remote machine), give the person the exact `publish` command to run in their own terminal, wait until they say it finished, then read `report/mcp-publish-result.json` and continue. Either way you never see or handle their sign-in. Every command after `init` takes `--workspace <path>` (or `MIGRATION_WORKSPACE`). Run them in this order; stop at the gate where one is marked.

```
dai-migrate init --workspace <path> --source <src> (--clone <folder> | --remote <git url>) --template <classic|atlas>
dai-migrate project    --workspace <path>          # MCP flow only: sign in, choose the project
dai-migrate fingerprint --workspace <path>
dai-migrate discover   --workspace <path>          # → plan/tree.yaml            [human gate 1]
dai-migrate acquire    --workspace <path>          # live sources only
dai-migrate inventory  --workspace <path>          # → snapshot/, inventory/
dai-migrate plan       --workspace <path>          # → plan/*.yaml, plan/site.yaml [human gate 2]
dai-migrate assets     --workspace <path> [--provider <none|local|s3|dai-api>]
dai-migrate convert    --workspace <path>          # run twice, identical inputs
dai-migrate nav        --workspace <path>          # → output/documentation.json, output/styles/migration.css
dai-migrate verify     --workspace <path>          # local gates                 [human gate 3]
dai-migrate write      --workspace <path> --push   # clone/git flow: migration branch + preview
dai-migrate publish    --workspace <path>          # MCP flow instead: working version + preview
dai-migrate verify     --workspace <path> --preview [--preview-url <url>]        # [human gate 4]
dai-migrate accept     --workspace <path> --route <route> --reason "<why>" --by "<who>"   # only a person's decision
dai-migrate release    --workspace <path>          # → report/release-certificate.json
dai-migrate report     --workspace <path>
```

A stage that fails stops the run and names what to fix. Never skip a stage to get past a failure, and never hand-edit `output/`: change the plan the stage reads and run it again.

## After fixing the migrator mid-run
A fix to this plugin invalidates what the migrator derived, never what the source served: the
frozen bytes came from the customer's site. Do **not** start a new workspace and crawl the site
again — on a 428-page site that costs about eight minutes of requests per attempt, every time.

```
dai-migrate rebase   --workspace <path> --reason "<what the fix changed>"
dai-migrate discover --workspace <path> --offline   # rebuilds plan/tree.yaml from the frozen bytes
dai-migrate inventory --workspace <path>            # then continue the sequence as normal
```

`rebase` re-pins the migrator build, records the change in `session.json` so the report shows every
build that touched the migration, and marks every derived stage stale. It keeps the frozen source,
its acquisition pin and any captured OpenAPI graph, and refuses if those bytes have drifted.
`discover --offline` then rebuilds the tree and navigation from the acquired pages, fetching
nothing, and carries the scope decisions already reviewed at gate 1 onto the rebuilt tree.

Re-confirm gate 1 after an offline rebuild: the structure may have changed, which is why the fix
was made. Start a new workspace only when the re-derivation reports that the source universe itself
would change (different pages), because that is a new capture rather than a new reading of one.

## Exploratory test run
Use this only when the user explicitly asks for a test or exploratory migration, or asks to skip asset hosting or push checks. Never for a customer release.

- `init ... --fidelity permissive` instead of `--fidelity exact`.
- `assets --provider none` when asset hosting is not available; permissive mode leaves assets on the source host instead of stopping.
- `write --push --allow-lossy` to push the migration branch and get a preview. It records the exactness gates a permissive run leaves unproven as waived in `report/lossy-push.json`; a gate that failed is recorded in `report/pushed-with-findings.json`, as in every mode, and blocks release rather than the push.
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
