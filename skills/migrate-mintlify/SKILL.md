---
name: migrate-mintlify
description: "Migrate a Mintlify site from its source repository onto Documentation.AI: docs.json or mint.json navigation (versions, languages, tabs, anchors, dropdowns, groups), snippet imports, redirects, group-level OpenAPI, custom heading ids, and a component rename layer. Falls back to scrape-mintlify."
---
# Migrate Mintlify

Implemented source preference: **source repository** (`docs.json` or `mint.json`) → live URL acquisition with the Mintlify scrape profile.

## What the adapter does
- Walks the recursive navigation object (`versions`, `languages`, `tabs`, `anchors`, `dropdowns`, `products`, `groups`, `pages`) into `plan/tree.yaml` with group path, version and locale per page; lists pages that are in navigation but missing on disk.
- Translates `redirects`: exact rules now; trailing `:slug*` or `*` become `:splat` candidates in `report/redirects.wildcard.json` (platform dependency); mid-path wildcards are reported and skipped.
- Records group-level `openapi` references; `nav` copies the spec into the output and sets `openapi` on the matching group.
- Resolves `import X from "/snippets/x.mdx"` and inlines `<X />` (no props) from the repo's `snippets/`; `.jsx` snippets and snippets used with props stay as source components for review.
- Lifts `## Title {#custom-id}` into the anchor map; shims are emitted where inbound links need them.
- Copies `name`, `colors` and `favicon` into `documentation.json`.
- Scans `snippets/`, `components/`, `src/components/` and `custom-blocks/` for component definitions and attaches their hashes to signatures, so custom components cluster per definition.

## Procedure
1. `dai-migrate init --workspace <dir> --source <repo> --repo <repo> --target customer-org|demo-org --platform mintlify --remote <connected repo url> --allowed-orgs <owner>`
2. `dai-migrate discover` → **human gate 1/4**: review `plan/tree.yaml` (scope, version and locale mapping) and `inventory/platform-meta.json` (missing pages, skipped redirects).
3. `dai-migrate inventory` → `plan` → **human gate 2/4**: review clusters; custom components and non-literal expressions need a decision.
4. `assets` → `convert` twice (determinism) → `nav` → local `verify` → **human gate 3/4** → `write --push` (waits for the preview) → `verify --preview` → **human gate 4/4** → `report`.

Not implemented: SDK reference generation, `Snippet` components with props, `Icon`/`Tiles`/`Tree`/`Panel` (T7 candidates).
