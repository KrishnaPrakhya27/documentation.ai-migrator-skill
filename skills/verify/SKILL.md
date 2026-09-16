---
name: verify
description: "Test a migration with hard release gates for plans, page and ledger coverage, prose, code and table preservation, contract validity, links, assets, unsafe URLs, redirects, review decisions, determinism, preview contract version, and rendered anchors."
---
# Verify

Run `convert` twice over identical inputs, then run `dai-migrate verify` once locally. When all non-preview checks pass, stop at **human gate 3/4** for output review and permission to push the named migration branch. After `write --push` has recorded the preview, run `verify --preview` (or `verify --preview-url <url>` for a preview found by hand; `--preview-contract-version` overrides the version read from the platform or assumed); when every release check passes, stop at **human gate 4/4** for cutover approval. After approval run `dai-migrate release`; only its immutable `report/release-certificate.json` authorises cutover. Read `report/gates.json`: any failed required check blocks the corresponding human gate.

The 37 required release gates, by id (this list is generated from `REQUIRED_RELEASE_GATE_IDS` in `packages/migrate-core/src/verify/gates.ts` and a test fails when the two drift):

- `openapi-preserved`
- `source-manifest-pinned`
- `source-universe-accounted`
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
- `unmigrated-links`
- `no-unresolved-blocks`
- `headings-sequence`
- `fragments-resolve`
- `redirects-clean`
- `no-unreviewed-decisions`
- `deterministic-rerun`
- `preview-contract-version`
- `browser-fragments`
- `browser-content`
- `responsive-layout`
- `migrator-pinned`
- `human-gates-approved`

The exact-fidelity family — `no-authored-exclusions`, `conversion-fidelity`, `serialized-output-exact`, `navigation-exact`, `source-navigation-proven`, `source-content-exact`, `source-metadata-exact`, `html-reconciliation`, `chrome-absent` — certifies the output against the raw acquired source. In a permissive session each reports `not-run`; it is never reported as passing. A proof the source kind cannot supply reports `inapplicable`, which is a completed justified result distinct from a proof that should have run but did not.

`source-content-exact`, `source-metadata-exact`, `html-reconciliation` and `chrome-absent` re-read what `acquire` froze (published Markdown, rendered HTML, the `llms.txt` entry) and compare it with the written output in both directions and in order, so rendered text the source does not have fails as loudly as text that went missing. `navigation-exact` compares `documentation.json` against a navigation freshly extracted from the frozen source, not only against the tree this run built.

`verify --preview` writes one row per route to `report/preview-routes.json`, each recording the residual rendered text, link, image, heading-outline and sidebar problems for that route.

Not yet implemented: component-count/heading-sequence diagnostics, word-count deltas, screenshot comparison, page-weight/load-time scoring, external-link checking, and a post-release search canary.

Previews skip search indexing: search is a post-release canary, not a preview gate.

`fragments-resolve` reads the written files and checks that every deep link lands: a link carrying `#some-heading` must name an anchor the target page actually has, whether from a heading, from a Step title the platform renders as a heading, from a footnote, from a parameter of an endpoint page, or from the shim the anchor plan wrote for a renamed one. Heading ids change between platforms (GitBook and Mintlify each slug differently from the target renderer, so `inventory` records each source's own id and the shim is written where a link uses it), and a fragment that no longer matches loads the page at the top and reports nothing, so this is checked before the push rather than only against a preview. A link whose anchor the source page never had either was broken before the migration: it is the customer's to fix, does not block, and is listed in `report/inherited-broken-links.json`; `internal-links` lists a link to a route the source never had the same way in `report/inherited-broken-page-links.json`.

`unmigrated-links` counts links that point at a page of the source site rather than at the migrated one. A link to the source host outside the docs' own base (`/pricing` beside `/docs`) is to the site beside the docs, and a link to a file the source serves (`sitemap.xml`, `llms.txt`, a page's `.md` export, a PDF) is to that file: both stay as authored and are reported in the gate's detail without failing it, as is a page's link to its own source address, which is where a rule sends the reader for a live tool the migration cannot carry.

`responsive-layout` measures every written route on a phone (390px), a tablet (768px) and a desktop (1440px) through the same browser session, and fails a page that scrolls sideways or renders no text. It reports the widths in `report/responsive.json`, and it measures layout rather than comparing screenshots, which differ between font sets and browser versions.

A local verify that finds failing gates still offers gate 3 and does not block `write --push`: the findings travel with the push and must pass before `release`.

`human-gates-approved` reports approvals as records rather than prose: `dai-migrate approve --gate <n> --by "<who>"` pins the files that gate covers (gate 1 the tree and scope decisions, gate 2 the plans, gate 3 the immutable pre-push report, and gate 4 the immutable preview report, route comparison and responsive readings). A local verify asks for gates 1 and 2, `verify --preview` also for gate 3, `write --push` refuses without gates 1–3, and `release` refuses unless all four still match.

Source coverage uses the discovery-pinned `source-cache/source-manifest.json`, independently of the editable tree. Frozen native files are checked for additions, deletions, modifications and symbolic links. A missing source page, a changed source identity, duplicate output ownership, an extra output page or an unresolved quarantine blocks exact certification. Partial-scope exclusions require matching identities, a reason and an approver in `plan/scope-decisions.yaml`; conversion pins this file. These two gates remain `not-run` in permissive mode.

Every source kind retains at least one independent content witness. Native repository/export/API sources use their frozen authored files, so rendered-HTML and theme-chrome proofs are explicitly inapplicable; a live HTML-only source must pass rendered reconciliation. Document360 category enumeration and ReadMe API pagination completeness remain explicit blockers.

The source manifest check also validates the session-pinned acquisition index for live/API sources. Altering an acquired page and its own checksum still fails against the independent record hash. Required in-scope pages must be present in that acquisition index.
