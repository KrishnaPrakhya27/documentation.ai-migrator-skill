# Working in this repository

This repository is a migration tool, not a documentation site. It moves a customer's
documentation from another platform onto Documentation.AI. Read this before running
anything.

## The one rule that matters

Migrated content and structure must be **exactly** the source's: text, titles,
descriptions, sidebar labels, groups, order, links, images, code and component
semantics. Visual styling may differ. Content may not. A migration that silently
changed content shipped once; every safeguard here exists because of it.

So: when a stage cannot prove something, it stops and says what to fix. Never work
around a stopped stage. Never hand-edit `output/`. Never weaken or skip a gate to
make a run finish.

When you fix this plugin part-way through a migration, do not start a new workspace and crawl the
source again: run `dai-migrate rebase --reason "<what changed>"` then `dai-migrate discover
--offline`. The frozen bytes are the customer's, not ours, so a fix to our code stales only what we
derived from them. See "After fixing the migrator mid-run" in `skills/migrate/SKILL.md`.

## How to run a migration

Follow `skills/migrate/SKILL.md`. It is the router: it fingerprints the source and
hands off to the platform skill (`skills/migrate-mintlify/`, `migrate-gitbook`,
`migrate-readme`, `migrate-document360`, or `migrate-generic`). Each platform skill
states what its adapter recovers and where it stops.

The skills orchestrate a deterministic CLI; they do not convert anything themselves.
Invoke it from the repository root as `npm run dai-migrate -- <command>` or `npx dai-migrate <command>`;
it is not installed globally. In a sandbox where npm cannot write its own folder (Codex), run the
launcher directly, `node packages/migrate-core/bin/dai-migrate.mjs <command>`, with the network
allowed and the parent of the workspace folder writable
(`codex --sandbox workspace-write -c sandbox_workspace_write.network_access=true --add-dir <folder>`).
The full ordered command sequence is in `skills/migrate/SKILL.md` under "Run sequence".
In short:

```
npm run dai-migrate -- init --workspace <path> --source <url|path> (--clone <folder> | --remote <git url>) --template <classic|atlas>
npm run dai-migrate -- fingerprint --workspace <path>
npm run dai-migrate -- discover    --workspace <path>     # human gate 1
npm run dai-migrate -- acquire     --workspace <path>
npm run dai-migrate -- inventory   --workspace <path>
npm run dai-migrate -- plan        --workspace <path>     # human gate 2 (includes plan/site.yaml, the site's look)
npm run dai-migrate -- assets      --workspace <path> [--provider <none|local|s3|dai-api>]
npm run dai-migrate -- convert     --workspace <path>     # twice
npm run dai-migrate -- nav         --workspace <path>
npm run dai-migrate -- verify      --workspace <path>     # human gate 3
npm run dai-migrate -- write       --workspace <path> --push      # clone or git flow
npm run dai-migrate -- publish     --workspace <path>             # MCP flow instead (browser sign-in; no git, no key)
npm run dai-migrate -- verify      --workspace <path> --preview [--preview-url <url>]   # human gate 4
npm run dai-migrate -- release     --workspace <path>              # immutable four-gate certificate
npm run dai-migrate -- report      --workspace <path>
```

Three ways to deliver, chosen with the person at the start: the **clone flow** (`init --clone
<their clone of the project's repository>`; no API key, the pushed branch gets its preview by
itself, and the preview URL is read from the dashboard), the **git flow** (`init --remote <url>`)
and the **MCP flow** (`publish`, which signs the person in through their browser and sends the
output through Documentation.AI's Authoring MCP server; never send page content through your own
tool calls).

The preview check (`verify --preview`) fails a route only for something a reader would miss: a
page that does not load, a source passage or heading that is nowhere on it, a link into nothing, a
missing sidebar entry. How the platform draws a page is a note, never a failure; do not chase
notes. A person who has looked at a failing route and is satisfied records that with
`accept --route <route> --reason "<why>" --by "<who>"`. You never approve a gate or accept a
finding yourself.

`--fidelity exact` is the default and the only mode for a customer migration.
`--fidelity permissive` is for test runs the user explicitly asks for: it reports the
exact-fidelity gates as `not-run`, lets `assets --provider none` leave media on the source
host, and `write --push --allow-lossy` records the unproven gates as waived. See "Exploratory
test run" in `skills/migrate/SKILL.md`.

A failing gate never withholds the preview, in any mode: once scope and plan are approved,
`write --push` publishes the branch with every finding recorded in
`report/pushed-with-findings.json`; `release` is where a finding blocks.

There are exactly four human approval gates, listed in the router skill. Stop at those, and ask
with choices the person can click (Claude Code's `AskUserQuestion`; numbered choices elsewhere),
never by asking them to type "approve gate 1". Their name is asked once and reused; when they pick
the approving option, record it and continue with the next stages in the same turn.
A failed check or a missing input is an exception to report, not a fifth gate.

## Where run data goes

Never inside this repository. Every command takes `--workspace <path>` (or
`MIGRATION_WORKSPACE`) pointing at a directory outside the plugin; `init` refuses a
workspace inside it. Customer content, credentials and run artefacts live there.

## Developing

```
npm install
npm run typecheck
npm test                                          # unit tier, synthetic inputs only
DAI_SOURCE_TRUTH_DIR=<dir> npm run test:proof     # exactness proof against a saved real site
```

The proof tier reads a saved capture of a real documentation site held **outside** this
repository. No customer or demo-site content may be committed here; a test enforces that.

Code conventions: TypeScript strict, explicit types on exports, no `any`, async/await,
self-explanatory names, comments that say why rather than what. Fail closed: in exact
mode anything unproven stops the stage with a message naming the page, asset or field.
Output must be deterministic — the same input produces byte-identical files.

## Do not

- Commit or push. The repository owner does that.
- Emit executable code into migrated output (no scripts, no event handlers).
- Add a fallback that silently substitutes content for something the source states.
- Put credentials in any file, log or report.
