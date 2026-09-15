# documentation.ai-migration-skills

Agent skills plus a deterministic TypeScript core for migrating documentation sites onto Documentation.AI. It runs from Claude Code or Codex as a plugin and is designed for reviewable, fail-closed internal migrations.

- API reference pages migrate as the platform renders them — `openapi:` frontmatter over a spec under `api-reference/` assembled from the source's own fragments — and a source's help centre can open on the platform's card hub (`nav --help-center`).
- `report/customer-report.{html,pdf,json}` — the one artefact written for the customer: what was migrated, what did not carry over and why, and what needs their decision. Printed to PDF through the Chrome verification already uses (`packages/migrate-core/src/report/`).
- `skills/` — the operator-facing procedures: `migrate` (router), `migrate-<platform>` and `scrape-<platform>` for ReadMe, Mintlify, GitBook and Document360, `migrate-generic`, `scrape-generic`, `verify`, `report`. Repository sources also cover Fern, Docusaurus, Nextra and MadCap Flare through the adapter registry (`packages/migrate-core/src/adapters/registry.ts`); every adapter passes one shared conformance suite. Published MadCap Flare sites, whose sidebar is built in the browser, have their navigation read from the data files the site publishes (`packages/migrate-core/src/scrape/madcap-toc.ts`).
- `packages/content-contract/` — the authoritative Documentation.AI content contract (components, props, navigation, redirects, anchors) with strict validators. Extracted from the product repos once, then reconciled by decision (`decisions.yaml`).
- `packages/migrate-core/` — the engine: sessions and identity, HTML/MDX → IR, the Component Conversion Engine (tiers T0–T7, declarative mapping tables per platform), block-level ledger, sanitiser, assets, navigation, URL plans and redirects, validation, verification gates, Git writer, reports.

Design rules: AI proposes and reviews; deterministic code executes. HTML is converted tree-to-tree rather than flattened through Markdown. Decisions are made per component cluster and applied per instance. Executable source constructs never run. Unsafe or unresolved content blocks release. Run data lives in an external workspace, never in this repository.

Today the complete path supports Document360 exports, local Markdown/MDX/HTML repositories, and live acquisition through the guarded local fetcher or Firecrawl. See [docs/STATUS.md](docs/STATUS.md) for verified capabilities and explicit boundaries; API-specific imports, OpenAPI migration, hosted asset providers and customer PDF reports remain planned work.

## Develop
```
npm install
npm run contract:extract      # regenerate contract.json from the product repos (paths via --app/--backend/--dashboard)
npm run typecheck
npm test
npm run dai-migrate -- --help
```

## Fidelity modes

`init` takes `--fidelity exact` (the default) or `--fidelity permissive`.

**Exact** is the mode for a customer migration. It certifies that the migrated
content is the source's content, and it fails closed rather than shipping a
difference:

- Titles, descriptions and sidebar labels come only from what the source itself
  states: its `llms.txt` entry, the page's own H1, the platform's page metadata.
  A theme-decorated `<title>` and rendered sidebar anchor text are recorded as
  evidence and never used as metadata.
- A page whose published Markdown cannot be acquired stops the run; the rendered
  HTML never stands in for it.
- `plan/block-exclusions.yaml` is refused: an operator cannot drop authored
  content in exact mode.
- An asset that cannot be hosted stops the run, at `assets` and again at `write`.
- A page the source navigation places but the output does not, or a navigation
  entry that maps to no discovered page, stops the run. A page the source
  publishes without any sidebar placement is migrated as a file and reported in
  `report/unlisted-pages.json`; it is never given an invented group.
- Verification compares the output against the raw acquired source, in both
  directions and in order. Text in the output that the source does not have
  fails as hard as text that is missing, which is what catches platform chrome.

**Permissive** keeps the same pipeline but records what it could not prove: the
exact-family gates report `not-run` rather than `pass`, and pushing a preview
requires `write --push --allow-lossy`. That flag waives only gates a permissive
session left unproven, never a gate that failed, and records the waiver in
`report/lossy-push.json`. The branch it creates is not a certified migration.

## Firecrawl data retention

`acquire --fetcher firecrawl` does not request zero data retention unless
`--zero-data-retention` or `FIRECRAWL_ZERO_DATA_RETENTION=1` is set, because
Firecrawl rejects every job that asks for it on an account without a ZDR
agreement. Without it, Firecrawl may retain the pages it scrapes.

## Verification

Release gates (37) live in `packages/migrate-core/src/verify/gates.ts`. The
family that certifies exactness against the source is
`source-content-exact`, `source-metadata-exact`, `html-reconciliation`,
`chrome-absent`, `navigation-exact`, `source-navigation-proven`,
`conversion-fidelity`, `serialized-output-exact` and `no-authored-exclusions`.
`verify --preview` adds route-by-route comparison of the deployed preview and
writes one row per route to `report/preview-routes.json`. After the fourth human
approval, `release` validates all four immutable approval pins and writes
`report/release-certificate.json`; a passing preview report alone does not
authorise cutover.

The session records which build of this migrator produced the output (commit,
dirty flag, hash of the uncommitted diff). `verify` refuses to certify output
from any other build.

## Testing

Two tiers:

```
npm test                                            # unit tier, synthetic inputs, no network
DAI_SOURCE_TRUTH_DIR=<dir> npm run test:proof       # exactness proof against a saved real site
```

The proof tier reads a saved capture of a real documentation site (raw HTML, raw
published Markdown, `llms.txt`, sitemap, and a `truth.json` describing what the
site actually contains) from the directory named by `DAI_SOURCE_TRUTH_DIR`. That
data lives outside this repository. The proof runs the whole pipeline offline,
asserts the output against the site's own numbers, and then reintroduces each
loss a real migration once shipped to confirm the gates catch it.
