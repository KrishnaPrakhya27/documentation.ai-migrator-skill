---
name: verify
description: "Test a migration with hard release gates for plans, page and ledger coverage, prose, code and table preservation, contract validity, links, assets, unsafe URLs, redirects, review decisions, determinism, preview contract version, and rendered anchors."
---
# Verify

Run `dai-migrate verify` twice after local conversion; the first records the canonical hash and the second proves determinism. After pushing the migration branch and obtaining its preview, run `verify --preview-url <url> --preview-contract-version <version>`. Read `report/gates.json`: any failed or not-run gate blocks release.

Implemented gates: reviewed plan hashes pinned; 100% pages accounted; 100% block dispositions; exclusions attributed; unsafe source URLs rejected; assets ingested with final URLs; normalized prose present; code blocks exact; complete table cell matrices exact; generated MDX and navigation pass the local content-contract validator; internal links resolve; no snippet, quarantine, expression or inline-component markers remain; redirects are unique, loop-free and chain-free; no unreviewed component decisions; identical canonical hash on rerun; preview contract version matches; and all current plus required legacy heading IDs exist in headless Chrome.

Not yet implemented: component-count/heading-sequence diagnostics, word-count deltas, screenshot comparison, page-weight/load-time scoring, external-link checking, and a post-release search canary.

Previews skip search indexing: search is a post-release canary, not a preview gate.
