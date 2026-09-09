# Implementation status

Last updated 9 September 2026 after the platform-adapter pass. Verified by `npm run typecheck`, 61 tests, and end-to-end CLI runs over the synthetic Document360 export and the Mintlify fixture repository.

## Implemented and verified

- Portable Codex/Claude plugin manifests and 13 operator skills whose text matches the code.
- External `0700` workspaces, resumable stage state, stable page and node identities, redacted decision logs, plans pinned by hash, convert-level determinism (two converts over identical inputs must hash identically).
- Content contract extracted from the product repos and reconciled by decision (`packages/content-contract`), with a strict validator (editor-only nodes, unknown components, invalid enum props, expressions, ESM, residual source syntax, multi-line evasion folded).
- **Sources**
  - Document360 export ZIP or directory (HTML and Markdown articles, hardened extraction, snippet tokens with `blocked` mode).
  - **Mintlify repository**: `docs.json`/`mint.json` recursive navigation (versions, languages, tabs, anchors, dropdowns, products, groups, pages), redirects (exact now, trailing wildcards as `:splat` candidates), group-level `openapi` copied and attached, `snippets/*.mdx` imports inlined, `{#custom-id}` headings, site name/colors/favicon.
  - **GitBook Git Sync repository**: `.gitbook.yaml` root, structure and redirects; `SUMMARY.md` sections and nesting; missing and unlisted files reported; Liquid `hint`, `tabs`, `embed`, `content-ref`, `stepper` outside code.
  - **ReadMe**: sync repository (`docs/<category>/*.md`, frontmatter `title`, `slug`, `excerpt`, `hidden`, `order`, `parentDocSlug`) and API v2 client (paginated categories, guides and reference with bodies; wired into `discover` when `README_API_KEY` is set).
  - Generic local Markdown/MDX/HTML repositories, and live sites via discovery (sitemap ∪ sidebar ∪ recursive same-origin links ∪ optional Firecrawl map) with the SSRF-guarded fetcher or Firecrawl batch scrape.
- Component definitions scanned from `snippets/`, `components/`, `src/components/`, `custom-blocks/` and attached to signatures, so custom components cluster per definition.
- Markdown/MDX parsing with GFM, literal-only props, no JavaScript evaluation; single-line JSX elements promoted to block components; inline runs under flow elements kept as paragraphs.
- Component Conversion Engine: declarative mappings per platform, T0–T4 deterministic, T5 static only, T7 sanitised fragment or quarantine, `drop` rules with subtree ledger marks, per-cluster plan decisions honoured (approve, exclude, quarantine).
- Assets: download, hash dedupe, SVG sanitisation, `s3` provider (tested with an injected client), `dai-api` provider (wired to the presign/confirm endpoints; blocked until the platform accepts API-key credentials there), failed entries retried.
- Verification: 18 release gates including block-level ledger coverage, prose and code/table parity, contract validation, navigation, links, redirects, plan pinning, gates bound to the output hash, convert-level determinism, preview contract version, rendered anchors in headless Chrome with resolver pinning.
- Git writer: `refs/heads/migration/<session>`, isolated worktree, host-bound org allowlist (GitHub and GitLab, subgroups), no force-push, protected-branch refusal.
- Reports: gates, review queue, summary, redirects, anchors, platform gaps, cutover runbook, sitemap list, search canary.

## Boundaries

- GitBook API export (`format=markdown`) and variants/sections from `gitbook-docs.yaml` are not implemented; map them in `plan/tree.yaml`.
- ReadMe: OpenAPI uploads, variables/glossary substitution and Changelog → Update are not implemented; Recipes convert only when the body is present.
- Mintlify: `.jsx` snippets and snippets used with props remain source components for review; SDK reference generation is not implemented.
- `dai-api` asset ingestion targets session-authenticated endpoints and fails cleanly until the platform ships a migration credential path; `assets-ready` keeps release blocked.
- Preview deployments are created by the product's branch workflow; the preview contract version must be supplied until the product exposes it.
- Customer PDF renderer and annexes, screenshots and performance scoring, external-link checks, and T6 AI rule proposals remain future work.

## Verified command sequence

```bash
npm install && npm run typecheck && npm test

# repository sources (Mintlify, GitBook, ReadMe sync repo, generic)
npx tsx packages/migrate-core/src/cli.ts init --workspace /secure/ws --source /path/repo --repo /path/repo --target demo-org --platform mintlify --allowed-orgs your-github-org
# ReadMe API: --source https://<subdomain>.readme.io --platform readme with README_API_KEY set
npx tsx packages/migrate-core/src/cli.ts discover  --workspace /secure/ws   # ⏸ plan/tree.yaml, inventory/platform-meta.json
npx tsx packages/migrate-core/src/cli.ts inventory --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts plan      --workspace /secure/ws   # ⏸ plan/*.yaml, inventory/snippets.json
npx tsx packages/migrate-core/src/cli.ts assets    --workspace /secure/ws --provider s3|none
npx tsx packages/migrate-core/src/cli.ts convert   --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts convert   --workspace /secure/ws   # determinism
npx tsx packages/migrate-core/src/cli.ts nav       --workspace /secure/ws   # ⏸ documentation.json, redirects
npx tsx packages/migrate-core/src/cli.ts verify    --workspace /secure/ws
npx tsx packages/migrate-core/src/cli.ts write     --workspace /secure/ws --repo /path/target --remote https://github.com/your-org/docs.git --push
npx tsx packages/migrate-core/src/cli.ts verify    --workspace /secure/ws --preview-url https://preview... --preview-contract-version 0.1.0
npx tsx packages/migrate-core/src/cli.ts report    --workspace /secure/ws
```
