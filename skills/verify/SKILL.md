---
name: verify
description: "Test a migration with hard release gates for plans, page and ledger coverage, prose, code and table preservation, contract validity, links, assets, unsafe URLs, redirects, review decisions, determinism, preview contract version, and rendered anchors."
---
# Verify

Run `convert` twice over identical inputs, then run `dai-migrate verify` once locally. When all non-preview checks pass, stop at **human gate 3/4** for output review and permission to push the named migration branch. After `write --push` has recorded the preview, run `verify --preview` (or `verify --preview-url <url>` for a preview found by hand; `--preview-contract-version` overrides the version read from the platform or assumed); when every release check passes, stop at **human gate 4/4** for cutover approval. Read `report/gates.json`: any failed required check blocks the corresponding human gate.

The 30 required release gates, by id (this list is generated from `REQUIRED_RELEASE_GATE_IDS` in `packages/migrate-core/src/verify/gates.ts` and a test fails when the two drift):

- `plans-pinned`
- `pages-accounted`
- `block-dispositions`
- `exclusions-attributed`
- `no-authored-exclusions`
- `conversion-fidelity`
- `serialized-output-exact`
- `no-unsafe-urls`
- `assets-ready`
- `prose-match`
- `code-blocks-exact`
- `tables-exact`
- `source-content-exact`
- `source-metadata-exact`
- `html-reconciliation`
- `chrome-absent`
- `contract-valid`
- `navigation-valid`
- `navigation-exact`
- `source-navigation-proven`
- `internal-links`
- `no-unresolved-blocks`
- `headings-sequence`
- `redirects-clean`
- `no-unreviewed-decisions`
- `deterministic-rerun`
- `preview-contract-version`
- `browser-fragments`
- `browser-content`
- `migrator-pinned`

The exact-fidelity family — `no-authored-exclusions`, `conversion-fidelity`, `serialized-output-exact`, `navigation-exact`, `source-navigation-proven`, `source-content-exact`, `source-metadata-exact`, `html-reconciliation`, `chrome-absent` — certifies the output against the raw acquired source. In a permissive session each reports `not-run`; it is never reported as passing.

`source-content-exact`, `source-metadata-exact`, `html-reconciliation` and `chrome-absent` re-read what `acquire` froze (published Markdown, rendered HTML, the `llms.txt` entry) and compare it with the written output in both directions and in order, so rendered text the source does not have fails as loudly as text that went missing. `navigation-exact` compares `documentation.json` against a navigation freshly extracted from the frozen source, not only against the tree this run built.

`verify --preview` writes one row per route to `report/preview-routes.json`, each recording the residual rendered text, link, image, heading-outline and sidebar problems for that route.

Not yet implemented: component-count/heading-sequence diagnostics, word-count deltas, screenshot comparison, page-weight/load-time scoring, external-link checking, and a post-release search canary.

Previews skip search indexing: search is a post-release canary, not a preview gate.
