---
name: migrate-gitbook
description: "Migrate GitBook Markdown from a Git Sync repository or hosted Markdown-suffix pages, translating supported Liquid blocks through the deterministic IR and component rules engine."
---
# Migrate GitBook

Implemented source preference: **Git Sync repository files** → hosted `.md` suffix → HTML acquisition. The GitBook API, `SUMMARY.md`/`.gitbook.yaml` navigation import, sections and variants are not implemented automatically.

## Procedure
1. `dai-migrate discover --repo <path>` discovers content files and derives provisional groups from paths. ⏸ Reconcile `plan/tree.yaml` against `SUMMARY.md`, `.gitbook.yaml`, sections and variants manually.
2. `dai-migrate inventory` recognises supported block Liquid syntax (`hint`, `tabs`, `tab`, `embed`, `content-ref`, `stepper`, `step`) plus ordinary Markdown/HTML. Other Liquid, drawings, math-specific transforms, buttons and conditional content remain review/quarantine cases.
3. `dai-migrate plan`: apply `mappings/gitbook.yaml` and explicitly review every unknown or expression-bearing cluster.
4. `assets` → `convert` → `nav` → local `verify` twice → push the migration branch for preview → rendered-preview `verify` → `report`.
