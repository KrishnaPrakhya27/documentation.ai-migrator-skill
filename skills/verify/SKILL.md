---
name: verify
description: "Test a migration with hard release gates for plans, page and ledger coverage, prose, code and table preservation, contract validity, links, assets, unsafe URLs, redirects, review decisions, determinism, preview contract version, and rendered anchors."
---
# Verify

Run `convert` twice over identical inputs, then run `dai-migrate verify` once locally. Stop at **human gate 3/4** for output review; a check that failed is a finding for that review and is recorded with the push, never a reason to withhold the preview (release is where it blocks). After `write --push` or `publish` has recorded the preview, run `verify --preview` (or `verify --preview-url <url>` for a preview URL read from the dashboard, which is the normal case when no API key is configured; it is remembered; `--preview-contract-version` overrides the version read from the platform or assumed); when every release check passes, stop at **human gate 4/4** for cutover approval. After approval run `dai-migrate release`; only its immutable `report/release-certificate.json` authorises cutover. Read `report/gates.json`: any failed required check blocks the corresponding human gate.

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

## The rendered preview (`verify --preview`, human gate 4)

The written pages are proven exact before the push. The preview check answers a different question: did the platform serve them, whole? It reads every route over HTTP (the platform renders pages on the server, so the response holds the article, headings, links and sidebar); a thousand pages take a few minutes and need no browser.

**A route fails only for something a reader would miss:** the page does not load; a source passage or heading is nowhere on the rendered page; a link the page itself states leads to no migrated page (a redirected address lands, so it passes); a link with no destination (`/null`); a sidebar placement the rendered sidebars never show.

**Everything else is a note (`advisories`), never a failure**, because no change to the migration can make it pass and a gate nobody can clear stops being read: the language label the platform draws on a code block (`jsonjson`), a "required" pill, an alt text drawn as a caption, passages laid out in a different place, an external link the theme adds, a passage present with different punctuation or escaping (the platform's MDX preprocessor shows `{x}` inside inline code as `&#123;x}`), a code sample the platform rewrote in places (it strips the options from a fence shown inside an example, and turns a literal `\n` into a line break), a link the platform draws from an API description, a link that was already broken on the source site, a page written as a file that no navigation entry names (decided and reported at `nav`), a deep-link target the platform did not render, a page that scrolls sideways on a phone. Notes are listed per gate in `report/review-queue.md` and per route in `report/preview-routes.json`. Do not try to fix a note in the migration; tell the person what it is.

`browser-fragments` accepts either the id this migration predicted for a heading or the id the source itself published (the platform slugs a heading from everything it draws in it, badges included, which is usually how the source slugged it). `responsive-layout` measures a spread of 24 routes (`--responsive all` for every route, `off` for none) at 390, 768 and 1440px; it fails a page that renders no text at some width, and notes sideways scroll with the element that widened it. With no Chrome on the machine it reports `inapplicable` and the content check still runs. `--renderer chrome` reads pages in a headless browser instead, opening accordions and tabs first, so the content behind them is verified too (several times slower).

A finding a person has looked at on the preview and is satisfied with is recorded, by name, with `dai-migrate accept --route <route> --reason "<why>" --by "<who>"` (`plan/preview-acceptances.yaml`); the next `verify --preview` reports the route as accepted, keeps the finding in the report, and stops failing it. `accept` with no route lists what has been accepted. Never accept on your own judgement.

Not yet implemented: component-count/heading-sequence diagnostics, word-count deltas, screenshot comparison, page-weight/load-time scoring, external-link checking, and a post-release search canary.

Previews skip search indexing: search is a post-release canary, not a preview gate.

`fragments-resolve` reads the written files and checks that every deep link lands: a link carrying `#some-heading` must name an anchor the target page actually has, whether from a heading, from a Step title the platform renders as a heading, from a footnote, from a parameter of an endpoint page, or from the shim the anchor plan wrote for a renamed one. Heading ids change between platforms (GitBook and Mintlify each slug differently from the target renderer, so `inventory` records each source's own id and the shim is written where a link uses it), and a fragment that no longer matches loads the page at the top and reports nothing, so this is checked before the push rather than only against a preview. A link whose anchor the source page never had either was broken before the migration: it is the customer's to fix, does not block, and is listed in `report/inherited-broken-links.json`; `internal-links` lists a link to a route the source never had the same way in `report/inherited-broken-page-links.json`.

`unmigrated-links` counts links that point at a page of the source site rather than at the migrated one. A link to the source host outside the docs' own base (`/pricing` beside `/docs`) is to the site beside the docs, and a link to a file the source serves (`sitemap.xml`, `llms.txt`, a page's `.md` export, a PDF) is to that file: both stay as authored and are reported in the gate's detail without failing it, as is a page's link to its own source address, which is where a rule sends the reader for a live tool the migration cannot carry.

`responsive-layout` reports its widths in `report/responsive.json`; it measures layout rather than comparing screenshots, which differ between font sets and browser versions.

A local verify that finds failing gates still offers gate 3 and does not block `write --push`: the findings travel with the push and must pass before `release`.

`human-gates-approved` reports approvals as records rather than prose: `dai-migrate approve --gate <n> --by "<who>"` pins the files that gate covers (gate 1 the tree and scope decisions, gate 2 the plans, gate 3 the immutable pre-push report, and gate 4 the immutable preview report, route comparison and responsive readings). A local verify asks for gates 1 and 2, `verify --preview` also for gate 3, `write --push` and `publish` refuse without gates 1 and 2 (a missing gate-3 sign-off is recorded, not refused), and `release` refuses unless all four still match.

Source coverage uses the discovery-pinned `source-cache/source-manifest.json`, independently of the editable tree. Frozen native files are checked for additions, deletions, modifications and symbolic links. A missing source page, a changed source identity, duplicate output ownership, an extra output page or an unresolved quarantine blocks exact certification. Partial-scope exclusions require matching identities, a reason and an approver in `plan/scope-decisions.yaml`; conversion pins this file. These two gates remain `not-run` in permissive mode.

Every source kind retains at least one independent content witness. Native repository/export/API sources use their frozen authored files, so rendered-HTML and theme-chrome proofs are explicitly inapplicable; a live HTML-only source must pass rendered reconciliation. Document360 category enumeration and ReadMe API pagination completeness remain explicit blockers.

The source manifest check also validates the session-pinned acquisition index for live/API sources. Altering an acquired page and its own checksum still fails against the independent record hash. Required in-scope pages must be present in that acquisition index.
