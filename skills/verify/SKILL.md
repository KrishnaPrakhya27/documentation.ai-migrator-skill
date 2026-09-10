---
name: verify
description: "Test a migration with hard release gates for plans, page and ledger coverage, prose, code and table preservation, contract validity, links, assets, unsafe URLs, redirects, review decisions, determinism, preview contract version, and rendered anchors."
---
# Verify

Run `convert` twice over identical inputs, then run `dai-migrate verify` once locally. When all non-preview checks pass, stop at **human gate 3/4** for output review and permission to push the named migration branch. After `write --push` has recorded the preview, run `verify --preview` (or `verify --preview-url <url>` for a preview found by hand; `--preview-contract-version` overrides the version read from the platform or assumed); when every release check passes, stop at **human gate 4/4** for cutover approval. Read `report/gates.json`: any failed required check blocks the corresponding human gate.

Implemented gates: reviewed plan hashes pinned; 100% pages accounted; 100% block dispositions; exclusions attributed; unsafe source URLs rejected; assets ingested with final URLs; normalized prose present; code blocks exact; complete table cell matrices exact; generated MDX and navigation pass the local content-contract validator; internal links resolve; no snippet, quarantine, expression or inline-component markers remain; redirects are unique, loop-free and chain-free; no unreviewed component decisions; identical canonical hash on rerun; preview contract version matches; all current plus required legacy heading IDs exist in headless Chrome; and the migrator build pinned at init (commit plus uncommitted-diff hash) is the one running verify.

Not yet implemented: component-count/heading-sequence diagnostics, word-count deltas, screenshot comparison, page-weight/load-time scoring, external-link checking, and a post-release search canary.

Previews skip search indexing: search is a post-release canary, not a preview gate.
