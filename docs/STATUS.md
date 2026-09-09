# Implementation status

Last updated 9 September 2026 after the architecture hardening pass.

## Implemented and verified

- Portable Codex/Claude plugin manifests and 13 operator skills, validated by the Codex plugin validator.
- External `0700` migration workspaces, resumable stage state, stable page/node identities, redacted decision logs, editable plans pinned by hash, and deterministic output hashing.
- Content-contract extraction and reconciliation data for Documentation.AI components, props, navigation and source-syntax restrictions.
- Source support for Document360 export ZIPs/directories (HTML and Markdown articles), generic local Markdown/MDX/HTML repositories, and frozen live sites acquired by the local fetcher or Firecrawl.
- Markdown/MDX parsing with GFM, literal-only MDX props, supported GitBook Liquid preprocessing, ReadMe emoji callouts, and no JavaScript evaluation.
- HTML-to-IR and IR-to-MDX conversion, component clustering, declarative T0–T7 rules, per-block dispositions, quarantine, snippet blocking, safe raw-HTML handling and deterministic navigation/redirect/anchor planning.
- Asset byte preservation and hash deduplication. Releases are blocked while an asset failed, remains external, or lacks its final ingested URL.
- Security controls: DNS/redirect SSRF checks, host allowlists, origin-bound credentials, robots handling, request throttling/retry/size caps, ZIP path/size/count/ratio/symlink controls, unsafe URL stripping plus a blocking gate, safe YAML/frontmatter and MDX code-fence serialization, remote-organization allowlists, and isolated Git worktrees that preserve the operator checkout.
- Release gates for plan integrity, page/ledger coverage, attributed exclusions, unsafe URLs, asset readiness, prose, code and table parity, contract/navigation validity, internal links, unresolved blocks, redirects, review completion, deterministic reruns, preview contract version and rendered heading/legacy anchors in headless Chrome.
- Safe preview workflow: two local verification runs must pass every non-preview gate before the migration branch can be pushed; final release still requires all rendered-preview gates.
- Reports: `gates.json`, `review-queue.md`, `summary.md`, redirects, anchors and aggregated platform gaps.
- Automated verification: TypeScript typecheck, 38 unit/integration tests, real local Git writer integration, crafted ZIP and binary-asset tests, and a two-page CLI/browser smoke migration.

## Important current boundaries

- ReadMe and GitBook API clients are not implemented.
- `docs.json`, `mint.json`, `SUMMARY.md`, `.gitbook.yaml`, ReadMe categories/versions and similar source navigation configs are not parsed; repository discovery derives a provisional tree from file paths that must be reviewed.
- OpenAPI/reference migration, recipe/variable/glossary import, snippet-import resolution and custom component definition loading are not implemented.
- Live discovery unions sitemaps, links on the seed page and optional Firecrawl mapping. Recursive local link-graph crawling, sidebar reconstruction and `/llms.txt` discovery are not implemented.
- `dai-api` and S3 asset providers are not implemented. The core downloads originals but intentionally blocks release until final hosted URLs exist.
- Preview deployment is created by the product's branch workflow; this plugin does not call a preview-deployment API. The preview contract version is supplied to verification because the product does not expose it through a public migration endpoint yet.
- Customer HTML/PDF reports, CSV annexes, screenshots, performance scoring, external-link checks and post-release search canaries remain future work.
- T6 AI rule proposal/promotion remains future work; operators can add and approve declarative rules manually.

## Verified command sequence

```bash
npm install
npm run typecheck
npm test

npm run dai-migrate -- init --workspace /tmp/dai-run --source /path/to/source --target demo-org --platform mintlify --allowed-orgs your-github-org
npm run dai-migrate -- fingerprint --workspace /tmp/dai-run
npm run dai-migrate -- discover --workspace /tmp/dai-run
npm run dai-migrate -- acquire --workspace /tmp/dai-run        # URL sources only
npm run dai-migrate -- inventory --workspace /tmp/dai-run
npm run dai-migrate -- plan --workspace /tmp/dai-run
# Review plan/tree.yaml, component-plan.yaml, urls.yaml, assets.yaml and snippets.json.
npm run dai-migrate -- assets --workspace /tmp/dai-run
npm run dai-migrate -- convert --workspace /tmp/dai-run
npm run dai-migrate -- nav --workspace /tmp/dai-run
npm run dai-migrate -- verify --workspace /tmp/dai-run         # records canonical hash
npm run dai-migrate -- verify --workspace /tmp/dai-run         # proves deterministic rerun
npm run dai-migrate -- write --workspace /tmp/dai-run --repo /path/to/target-repo --remote https://github.com/your-github-org/docs.git --push
npm run dai-migrate -- verify --workspace /tmp/dai-run --preview-url https://preview.example --preview-contract-version 0.1.0
npm run dai-migrate -- report --workspace /tmp/dai-run
```

Headless verification rejects private preview hosts and uses an isolated temporary Chrome profile. For an intentional local test server only, set `DAI_ALLOW_LOCAL_PREVIEW=1`.
