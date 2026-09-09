---
name: migrate-readme
description: "Migrate ReadMe Markdown from a sync repository or hosted Markdown-suffix pages, including emoji callouts and declarative ReadMe-to-Documentation.AI component mappings."
---
# Migrate ReadMe

Implemented source preference: **sync repository Markdown/MDX/HTML files** → hosted `.md` suffix → HTML acquisition. ReadMe API v2, OpenAPI/reference generation, recipes, variables/glossary and custom-component definition loading are not implemented automatically.

## Procedure
1. `dai-migrate discover --repo <path>` discovers content files and derives provisional groups from paths. For hosted docs use `discover --url`, then `acquire --profile readme`. ⏸ Reconcile categories, order and versions manually in `plan/tree.yaml`.
2. `dai-migrate inventory`: Accordion, Callout (component and emoji-blockquote forms), Cards/Card, Columns/Column, Image, Tabs/Tab, embeds, Recipes, variables/glossary, custom `custom-blocks/` components (definition hash recorded), marketplace components.
3. `dai-migrate plan`: apply `mappings/readme.yaml`; unknown recipes, variables and custom components remain blocking review/quarantine items. Executable output is never available.
4. Migrate OpenAPI files separately and validate endpoint/field parity outside this core until the OpenAPI command exists.
5. `assets` → `convert` → `nav` → local `verify` twice → push the migration branch for preview → rendered-preview `verify` → `report`.

Mapping table: `mappings/readme.yaml`. Automatic Font Awesome-to-Lucide conversion is not implemented.
