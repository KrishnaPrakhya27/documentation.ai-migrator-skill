# documentation.ai-migration-skills

Agent skills plus a deterministic TypeScript core for migrating documentation sites onto Documentation.AI. It runs from Claude Code or Codex as a plugin and is designed for reviewable, fail-closed internal migrations.

- `skills/` — the operator-facing procedures: `migrate` (router), `migrate-<platform>` and `scrape-<platform>` for ReadMe, Mintlify, GitBook and Document360, `migrate-generic`, `scrape-generic`, `verify`, `report`.
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
