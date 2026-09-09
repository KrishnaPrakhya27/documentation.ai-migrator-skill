---
name: migrate-mintlify
description: Migrate Mintlify Markdown and MDX pages from a source repository or frozen web acquisition, with literal component parsing, declarative component mappings, and executable-expression quarantine.
---
# Migrate Mintlify

Implemented source preference: **source repository Markdown/MDX/HTML files** → live URL acquisition with the Mintlify profile. `docs.json`/`mint.json` navigation, snippet imports, redirects and OpenAPI are not imported automatically in this version.

## Procedure
1. `dai-migrate discover --repo <path>` discovers Markdown, MDX and HTML files and derives provisional groups from directory paths. ⏸ Reconcile `plan/tree.yaml` against `docs.json`/`mint.json` manually, including scope, order, versions, languages and tabs. Add redirects to `plan/urls.yaml`.
2. `dai-migrate inventory`: Mintlify components (Note/Tip/Warning/Info/Check, Accordion*, CardGroup, Frame, Tooltip, Badge, Icon, RequestExample/ResponseExample, Snippet imports, `{expressions}`, `import`/`export`).
3. `dai-migrate plan`: renames from `mappings/mintlify.yaml`; only literal props and the supported `user.*` expression form may pass. Other expressions, ESM, and inline JSX remain blocking review items. Snippet-import conversion and custom-ID syntax import are not yet implemented.
4. `assets` → `convert` → `nav` → local `verify` twice → push the migration branch for preview → rendered-preview `verify` → `report`.
