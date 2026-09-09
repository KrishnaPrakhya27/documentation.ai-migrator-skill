---
name: migrate-document360
description: Migrate a Document360 workspace onto Documentation.AI from the export ZIP (Articles/, Categories/, <workspace>_category_articles.json, Media/), with per-file format detection, snippet-token resolution and HTML→MDX tree conversion. Falls back to scrape-document360 for pages missing from the export.
---
# Migrate Document360

Implemented source preference: **export ZIP/directory** → live URL acquisition with the Document360 profile → generic profile. A Document360 API client is not implemented in this version.

## Procedure
1. `dai-migrate discover --export <zip|dir>`: reads `<workspace>_category_articles.json` and `Articles/`, writes `plan/tree.yaml` (category path, order, format html|md, workspace, language) and lists `unplaced` entries. ⏸ Confirm scope. If the export mixes workspaces or languages, confirm which ones are in scope.
2. `dai-migrate inventory`: components (infoBox/warningBox/errorBox/successBox, details, editor360-faq, tabs, tables, iframes, custom HTML), assets under `Media/`, links, heading ids, and **snippet tokens** (`{{snippet.X}}`). Snippet bodies are not in the export. ⏸ Add operator-supplied bodies and resolution decisions to `inventory/snippets.json`; unresolved tokens keep affected pages quarantined.
3. `dai-migrate plan`: review `plan/component-plan.yaml` (one row per cluster; mappings from `mappings/document360.yaml`), `plan/urls.yaml` (default `preserve`, `strip_prefix` for `/v1/docs`, `case: preserve`), `plan/assets.yaml` (alt text policy is a decision: Scrut chose no generated alt).
4. `dai-migrate assets` → `convert` → `nav` (categories → groups, order preserved) → local `verify` twice → `write --repo <dir> [--remote <url>] --push` → rendered-preview `verify` → `report`. The branch name is generated as `migration/<session>`.

## Known traps (from the Scrut run)
- Random heading ids (`mkdmggx4-…`) are dropped; text slugs regenerate identically. Anchor shims are only emitted where an inbound link targets a non-slug id.
- `&amp;`-encoded and `%20` media names: unescape before matching `Media/`.
- Markdown-editor articles (`.md`) use the MDX adapter, not the HTML one.
- Confirm the category JSON schema on the first real export and add it as a fixture; the adapter tolerates unknown shapes but logs `unplaced` entries you must review.
