# Implementation status

Last updated 10 September 2026 after the exact-fidelity work. Verified by `npm run typecheck`, the unit tier (`npm test`), the exactness proof tier (`npm run test:proof` against a saved real Mintlify site) and end-to-end CLI runs over the synthetic Document360 export, Mintlify fixture repository, and generic smoke repository.

## Measured performance

Run with `npm run test:scale` (`DAI_SCALE_PAGES` sets the corpus size). Generated generic-repository
corpora, one machine, exact mode:

| Corpus | discover → nav | verify | heap needed |
| --- | --- | --- | --- |
| 500 pages | 8s | 5s | under 512 MB |
| 5,000 pages | 18s | 48s | 384 MB; fails at 256 MB |

Peak RSS on the 5,000-page run is about 1 GB unconstrained, which measures what the machine had
free rather than what the run needed: with the heap capped at 384 MB the same run completes, and at
256 MB it exhausts the heap while parsing a page. Verification streams the snapshot a page at a
time for this reason; the stages that rewrite every page still hold the corpus.

## Implemented and verified

- Portable Codex/Claude plugin manifests and 13 operator skills whose text matches the code.
- External `0700` workspaces, resumable stage state, stable page and node identities, redacted decision logs, plans pinned by hash, convert-level determinism (two converts over identical inputs must hash identically).
- Content contract extracted from the product repos and reconciled by decision (`packages/content-contract`), with a strict validator (editor-only nodes, unknown components, invalid enum props, expressions, ESM, residual source syntax, multi-line evasion folded).
- **Sources**
  - Document360 export ZIP or directory (HTML and Markdown articles, hardened extraction, snippet tokens with `blocked` mode).
  - **Mintlify repository**: `docs.json`/`mint.json` recursive navigation (versions, languages, tabs, anchors, dropdowns, products, groups, pages), redirects (exact now, trailing wildcards as `:splat` candidates), group-level `openapi` copied and attached, `snippets/*.mdx` imports inlined, `{#custom-id}` headings, site name (the source's logo, favicon, colours and theme are recorded but not carried).
  - **GitBook Git Sync repository**: `.gitbook.yaml` root, structure and redirects; `SUMMARY.md` sections and nesting; missing and unlisted files reported; Liquid `hint`, `tabs`, `embed`, `content-ref`, `stepper` outside code.
  - **ReadMe**: sync repository (`docs/<category>/*.md`, frontmatter `title`, `slug`, `excerpt`, `hidden`, `order`, `parentDocSlug`) and API v2 client (paginated categories, guides and reference with bodies; wired into `discover` when `README_API_KEY` is set).
  - Generic local Markdown/MDX/HTML repositories, and live sites via discovery (robots-declared/conventional recursive sitemap indexes and gzip URL sets ∪ ordered sidebar links ∪ recursive same-origin links ∪ optional Firecrawl map) with the SSRF-guarded fetcher or Firecrawl batch scrape. Fetch order: native sources first, then the built-in fetcher (the default: robots, SSRF checks, DNS pinning, 2 rps per host, content-addressed cache), then Firecrawl batch scrape only when `--fetcher firecrawl` is passed with `FIRECRAWL_API_KEY` set, for large, rate-limited or client-rendered sites. Sitemap provenance, order, SEO fields, hreflang, and conservative section/locale/version hints are retained in `inventory/sitemaps.json` and `plan/tree.yaml`; sidebar/path evidence takes precedence.
- Component definitions scanned from `snippets/`, `components/`, `src/components/`, `custom-blocks/` and attached to signatures, so custom components cluster per definition.
- Markdown/MDX parsing with GFM, literal-only props, no JavaScript evaluation; single-line JSX elements promoted to block components; inline runs under flow elements kept as paragraphs.
- Component Conversion Engine: declarative mappings per platform, T0–T4 deterministic, T5 static only, T7 sanitised fragment or quarantine, `drop` rules with subtree ledger marks, per-cluster plan decisions honoured (approve, exclude, quarantine).
- Assets: download, hash dedupe, SVG sanitisation, `s3` provider (tested with an injected client), `dai-api` provider (wired to the presign/confirm endpoints; blocked until the platform accepts API-key credentials there), failed entries retried.
- Verification: 37 release gates including verification against the raw acquired source (`source-content-exact`, `source-metadata-exact`, `html-reconciliation`, `chrome-absent`), navigation compared against a fresh extraction from the frozen source, route-by-route preview comparison, migrator provenance pinning, and block-level ledger coverage, prose and code/table parity, contract validation, navigation, links, redirects, plan pinning, gates bound to the output hash, convert-level determinism, preview contract version, rendered anchors in headless Chrome with resolver pinning.
- Git writer: `refs/heads/migration/<session>`, isolated worktree, host-bound org allowlist (GitHub and GitLab, subgroups), no force-push, protected-branch refusal.
- Reports: gates, review queue, summary, redirects, anchors, platform gaps, cutover runbook, sitemap list, search canary.
- Human review is consolidated into exactly four standard gates: scope/structure, conversion plan, pre-push validation, and preview/release. Ambiguity and failed automated checks are exception states, not additional approvals.

- Connection is settled at `init`: remote policy, reachability (`git ls-remote`) and **push access** (a dry-run push that deletes a ref which does not exist, so credentials are proven without changing the remote; a failure names the fix: `gh auth login && gh auth setup-git`, or registering the SSH key), API key, the project's connected repository compared with the remote by branch set, live deployment branch, prior previews, media API, and the asset provider to use; results in `report/preflight.json` and the session. `write --push` clones the remote when no `--repo` is given, then polls `/api/v1/deployments` until the migration branch's preview is ready and records its URL (with a diagnosis when none appears). `verify --preview` uses the recorded URL; the contract version is read from the platform when exposed and otherwise assumed from the pinned version, marked as such in `report/connection.md`.

## Boundaries

- GitBook API export (`format=markdown`) and variants/sections from `gitbook-docs.yaml` are not implemented; map them in `plan/tree.yaml`.
- ReadMe: OpenAPI uploads, variables/glossary substitution and Changelog → Update are not implemented; Recipes convert only when the body is present.
- Mintlify: `.jsx` snippets and snippets used with props remain source components for review; SDK reference generation is not implemented.
- `dai-api` asset ingestion targets the API-key media surface `/api/v1/media/*`, implemented in the backend working tree on 10 September 2026 (pending review and deploy); until deployed the provider probes once and fails fast with the reason, and `assets-ready` keeps release blocked. See `docs/platform/media-api.md`. The same backend change exposes `contentContractVersion` on `/api/v1/config`.
- Preview deployments are created by the product's branch workflow; the preview contract version must be supplied until the product exposes it.
- Customer PDF renderer and annexes, screenshots and performance scoring, external-link checks, and T6 AI rule proposals remain future work.

## Verified command sequence

```bash
npm install && npm run typecheck && npm test

# repository sources (Mintlify, GitBook, ReadMe sync repo, Fern, Docusaurus, Nextra, MadCap Flare, generic)
npx tsx packages/migrate-core/src/cli.ts init --workspace /secure/ws --source /path/repo --repo /path/repo --target demo-org --platform mintlify --allowed-orgs your-github-org
# ReadMe API: --source https://<subdomain>.readme.io --platform readme with README_API_KEY set
npx tsx packages/migrate-core/src/cli.ts discover  --workspace /secure/ws   # human gate 1/4: scope and structure
npx tsx packages/migrate-core/src/cli.ts inventory --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts plan      --workspace /secure/ws   # human gate 2/4: conversion plan
npx tsx packages/migrate-core/src/cli.ts assets    --workspace /secure/ws --provider s3|none
npx tsx packages/migrate-core/src/cli.ts convert   --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts convert   --workspace /secure/ws   # determinism
npx tsx packages/migrate-core/src/cli.ts nav       --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts verify    --workspace /secure/ws   # human gate 3/4: pre-push validation
npx tsx packages/migrate-core/src/cli.ts write     --workspace /secure/ws --repo /path/target --remote https://github.com/your-org/docs.git --push
npx tsx packages/migrate-core/src/cli.ts verify    --workspace /secure/ws --preview-url https://preview... --preview-contract-version 0.1.0 # human gate 4/4: preview and release
npx tsx packages/migrate-core/src/cli.ts release   --workspace /secure/ws # immutable certificate after gate 4 approval
npx tsx packages/migrate-core/src/cli.ts report    --workspace /secure/ws
```

## Testing

Two tiers. `npm test` runs the unit tier (`packages/*/test/**/*.test.ts`): self-contained tests over small synthetic inputs with neutral content that reproduce each structural trap (duplicate sidebar placement, `sidebarTitle` ≠ title, description blockquote next to an authored blockquote, `⌘I` chrome, fenced code with meta, cross-host sitemaps, llms.txt double listing). `npm run test:proof` runs the proof tier (`packages/*/test/proof/**/*.proof.test.ts` through `vitest.proof.config.ts`, excluded from `npm test`): the exactness proof against the saved raw source of a real site, reached only through `DAI_SOURCE_TRUTH_DIR`, a directory holding `truth.json`, `llms.txt`, `robots.txt`, `sitemap.xml`, `html/` and `md/`. That source lives outside this repository, so no customer or demo content is vendored here; the proof run fails immediately, naming the variable and the missing file, when the directory is unset or incomplete. `packages/migrate-core/test/helpers/source-truth.ts` loads and types `truth.json` (`loadTruth`, `pageByPath`, `chromeStrings`); `test/helpers/fixture-fetcher.ts` serves the saved site to the `Fetcher` (`fixtureFetcher`, both site hosts) and a synthetic in-memory site for the unit tier (`syntheticSiteFetcher`), each recording every requested URL. Every proof assertion has a synthetic counterpart in the unit tier so `npm test` proves the mechanism without the external source.

## Exact fidelity

`init --fidelity exact` (the default) is the mode for a customer migration. What it
guarantees, and where each guarantee is enforced:

| Guarantee | Enforced at |
|---|---|
| Title, description and sidebar label come from the source's own statements, never a URL or a theme-decorated `<title>` | `discover`, `inventory`, gate `source-metadata-exact` |
| Every page the source publishes is migrated; none is invented | `discover`, gates `pages-accounted`, `source-content-exact` |
| Body blocks match the published source in count and order | gate `source-content-exact` |
| The rendered page and the published Markdown agree on images, links, code languages and the heading outline | gate `html-reconciliation` |
| No platform chrome reaches the output | gate `chrome-absent`, profile `chromeStrings` |
| Group labels, order, nesting and repeated placements match the source, cross-checked against a fresh extraction | gate `navigation-exact` |
| Missing published Markdown, an unhostable asset, an authored exclusion or a lost placement stops the run | `acquire`, `assets`, `convert`, `nav` |
| The deployed preview renders the source's content and nothing else | gate `browser-content`, `report/preview-routes.json` |
| The output was produced by the migrator build the session pinned | gate `migrator-pinned` |
| A second convert over the same inputs is byte-identical | gate `deterministic-rerun` |

Permissive mode runs the same pipeline and reports the exact family as `not-run`.

## Testing

- `npm test` — unit tier. Synthetic inputs only; no network and no customer content in the repository.
- `DAI_SOURCE_TRUTH_DIR=<dir> npm run test:proof` — exactness proof against a saved capture of a real
  documentation site held outside this repository. It runs the pipeline offline, asserts the output
  against the site's own `truth.json`, and reintroduces each loss a real migration once shipped to
  confirm the gates fail. The command fails, rather than skipping, when the variable is unset.

## Source evidence hardening

Discovery now pins a separate source manifest. Native repositories/exports are frozen before conversion reads them. Mintlify config entries, GitBook SUMMARY links, ReadMe files and the live sitemap/llms/sidebar union supply page identities independently of the editable migration tree. Missing pages, substituted identities, duplicate output ownership, extra output files and unresolved quarantine block source-universe certification. Scope exclusions are attributed and pinned at conversion. Completed live/API acquisitions have a separate session-bound record-hash index; Firecrawl HTML uses the common acquisition checks and generated Markdown is not treated as published source.

Limitations: this is page-universe and byte-integrity evidence, not an independent semantic AST/DOM witness. Raw live index HTTP bytes are not yet separately pinned (the parsed discovery result is pinned). Document360 category enumeration and ReadMe API pagination completeness remain blocking implementation gaps. Native-source navigation/content proof gaps are not exempted. No customer migration or preview is certified by synthetic tests.

## 2026-09-15 — three parallel migration branches integrated

Merged `fix/gitbook-link-graph-scope`, `migrate/mintlify-docs` and `migrate/sessionm-helpsystems` (the latter two carrying the shared `fix/hosted-asset-fidelity` work). The auto-merge duplicated two things both branches had invented independently — `withinSiteBase` and the site-base confinement in `discoverLiveSite` — reconciled to one rule: everything outside the site's base is refused except what a sitemap the site itself serves declares. `mergeNavigation` (Mintlify scoped sidebars) and `mergeNavigationTrees` (GitBook per-section sidebars) still coexist; unifying them is a follow-up.

Fixed on top: a container's own page is its `path` (not a duplicate child); Mintlify `hidden` containers and `menu` items; `\u0026` in Flare TOC titles; URL case preserved; the Flare copyright line no longer reaches the topic; Mintlify and GitBook endpoint pages carry `openapi:` frontmatter over assembled or captured specs under `api-reference/`; `#param-` links follow parameters to the platform's anchors; GitBook `<picture>` unwrapped; GitBook `prompt`, `file`, `br`, `esm` mapped; `nav --help-center`; the strict validator reads multi-backtick code spans.

## 2026-09-16 — gates re-run against the real captured workspaces

The three 2026-09-15 migrations were re-derived offline from their frozen captures (copies of the GitBook and Mintlify workspaces, on the integrated build) and every remaining gate failure was traced to its cause in the source bytes rather than waived. What changed:

- **Verify read the two sides differently.** The output normaliser padded a code span with spaces and the source side did not, so `(oneOf / anyOf)` and `( oneof / anyof )` were "different prose"; a `<kbd>` was padded the same way; a code fence nested more than eight spaces deep (Steps › Expandable › CodeGroup) was invisible to the code-block gate; a heading's badge text (`### \`navigation\` <Badge>required</Badge>`) was in the output outline and not the source's; a Card's title, a PreviewButton's label become, was not read as prose; `~~strikethrough~~` markers were compared as text. The source side now renders inline content exactly as the serializer writes it and the output side reads titles and key caps as the reader sees them. Mintlify prose misses went 2427 → 0-order and tables 100 → 0; GitBook prose 823 → single digits.
- **Anchors.** The platform gives a Step title rendered as a heading its own id (Steps.tsx); verify now counts it, which closed every GitBook stepper deep link. Mintlify's heading ids (dots and spaces to hyphens, badge text included, `( ) , * :` dropped, repeats `-2`, `-3`; derived from 9,773 rendered headings) are recorded as the source id so a link written against them gets its shim. An empty `<div id>` is an anchor and is written as one instead of quarantined. Source HTML no longer has slugged anchors invented for headings that publish their own id, so a link the source itself had broken is reported as inherited, not charged to the migration.
- **GitBook pages an operator had excluded "for the preview run".** Thirty-one pages could not be read into MDX: a brace in prose or a table cell, a `{% openapi %}` quoted in escaped backticks, a paragraph opening with `import`, `{% file %}` never closed, footnotes, and an embed URL whose tail the export left outside the autolink brackets. Each is now read as the author's text (braces escaped outside code and tags, `import` written with its first letter as a character reference on both sides, footnotes carried as GFM footnotes with their anchors, `file` self-closing, the URL re-joined). All thirty-one convert.
- **`unmigrated-links`** counts only links to pages under the docs' own base (derived from the tree's pages, not the sitemap, which lists the marketing site too) and lists links to served files (`llms.txt`, sitemaps, `.md` exports) without failing.
- `internal-links` with no tree context no longer classifies every broken link as inherited.
- `plan` extends an existing URL plan with the default entry for every page the tree gained since it was written (a lifted scope exclusion, a page a rerun discovered); before, such pages had no route and convert skipped them silently. A rule that writes a link by the operator's decision (a live-demo card) records it in the ledger, and `unmigrated-links` counts it apart. GitBook's inline search and assistant buttons are chrome, inline and as blocks.
- A link nested inside a link (Mintlify's export writes `<a href="mailto:x">[x](mailto:x)</a>`) is written once, as a browser shows it; a link fragment is matched to its heading after percent-decoding (`#…-%24ref` is `$ref`); a prompt copies its whole text, numbered lists included, and the prose gate looks for a prompt's sentences in the code block the ledger says they became; `inventory` names the page a parse failure happened on.

Gate counts on the re-derived copies, before this batch → after (permissive sessions; `assets --provider none`):

| Gate | Mintlify (1050 pages) | GitBook (1224 → 1255 pages) | MadCap (427 pages) |
| --- | --- | --- | --- |
| prose-match | 827 → 0 | 505 → 0 | 0 |
| fragments-resolve | 1029 → 0 (1009 inherited, listed) | 758 → 0 (775 inherited, listed) | 0 |
| no-unresolved-blocks | 384 → 0 | 6 → 0 | 0 |
| headings-sequence | 8 → 0 | 5 → 0 | 0 |
| tables-exact | 11 → 0 | 12 → 0 | 0 |
| code-blocks-exact | 12 → 0 | 0 | 0 |
| internal-links | 9 → 0 (9 inherited, listed) | 77 → 0 (9 inherited, listed) | 0 |
| unmigrated-links | 43 → 0 (23 beside the docs, 20 declared by rule) | 20 → 0 (7 beside, 17 files) | 0 |

The only failures left on a rerun are `human-gates-approved` (the tree changed since the approval, by design), `migrator-pinned` (an uncommitted build) and, on GitBook, `assets-ready` under `--provider none`. The thirty-one GitBook pages excluded on 2026-09-15 are in the 1255.
