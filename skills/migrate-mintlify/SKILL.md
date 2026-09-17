---
name: migrate-mintlify
description: "Migrate a Mintlify site from its source repository onto Documentation.AI: docs.json or mint.json navigation (versions, languages, tabs, anchors, dropdowns, groups), snippet imports, redirects, group-level OpenAPI, custom heading ids, and a component rename layer. Falls back to scrape-mintlify."
---
# Migrate Mintlify

Implemented source preference: **source repository** (`docs.json` or `mint.json`) → live URL acquisition with the Mintlify scrape profile.

## Migrating a live Mintlify site
A hosted Mintlify site states its own content, and exact mode uses only those statements:

- `/llms.txt` is the page index: one entry per page with the exact title, the exact description and the URL of the published Markdown. `discover` fetches it first and every page it lists enters scope.
- Each page serves its authored Markdown at `<path>.md`. Acquisition **requires** it: in exact mode a page whose `.md` is missing, is not Markdown, or answers with HTML stops the run. The rendered HTML is frozen beside it for reconciliation, never as a replacement.
- `.mintlify.site` and `.mintlify.app` are the same site. The paired host is treated as the seed origin, so the sitemap Mintlify publishes on the other host is used rather than discarded.
- The page's navigation, sidebar label, group and description come from the `scopedNav` object in the rendered Flight payload, which is what the sidebar renders. The rendered sidebar DOM is extracted too, as an independent witness the gates cross-check.
- The title is the `llms.txt` title, then the published `.md` H1, then the platform's page metadata. The `<title>` element is theme-decorated (`Page - Site`) and is never a title. A page the site lists but does not place in the sidebar is migrated and reported in `report/unlisted-pages.json`, never given an invented group.
- Fence info strings carry Mintlify's own theming (```bash theme={null}). The directive is dropped because the target contract rejects the expression; the language and code text are byte-exact, and the original info string is kept on the node.

## What the adapter does
- Walks the recursive navigation object (`versions`, `languages`, `tabs`, `anchors`, `dropdowns`, `products`, `groups`, `pages`) into `plan/tree.yaml` with group path, version and locale per page; lists pages that are in navigation but missing on disk.
- Translates `redirects`: exact rules now; trailing `:slug*` or `*` become `:splat` candidates in `report/redirects.wildcard.json` (platform dependency); mid-path wildcards are reported and skipped.
- Records group-level `openapi` references; `nav` copies the spec into the output and sets `openapi` on the matching group.
- Resolves `import X from "/snippets/x.mdx"` and inlines `<X />` (no props) from the repo's `snippets/`; `.jsx` snippets and snippets used with props stay as source components for review.
- Lifts `## Title {#custom-id}` into the anchor map; shims are emitted where inbound links need them. Mintlify's own heading ids (dots and spaces to hyphens, badge text included, `( ) , * :` dropped, repeats numbered `-2`, `-3`) are recorded as each heading's source id, so a link written against the Mintlify id lands after the target renderer slugs the heading its own way. An empty `<div id="…"></div>` is the anchor an older link still uses and is written as one.
- Copies `name` into `documentation.json`. The source's `logo`, `favicon`, `colors` and `theme` are recorded in `inventory/platform-meta.json` but never carried: the migrated site shows Documentation.AI's own branding.
- Scans `snippets/`, `components/`, `src/components/` and `custom-blocks/` for component definitions and attaches their hashes to signatures, so custom components cluster per definition.

## Procedure
At every gate, ask the way the router skill (`skills/migrate/SKILL.md`, "How you ask" and "Four human gates") says: a short summary, then choices the person can click, first option approves; on approval record it under the name they gave at the start and carry on with the next stages in the same turn. Never ask them to type "approve gate N".
1. `dai-migrate init --workspace <dir> --source <repo> --repo <repo> --platform mintlify (--clone <their clone of the Documentation.AI repository> | --remote <git url>) --template <classic|atlas>` (the delivery flow and the template are agreed with the person first; see the router skill)
2. `dai-migrate discover` → **human gate 1/4**: review `plan/tree.yaml` (scope, version and locale mapping) and `inventory/platform-meta.json` (missing pages, skipped redirects).
3. `dai-migrate inventory` → `plan` → **human gate 2/4**: review clusters; custom components and non-literal expressions need a decision.
4. `assets` → `convert` twice (determinism) → `nav` → local `verify` → **human gate 3/4** → `write --push` (or `publish` in the MCP flow) → `verify --preview` (with `--preview-url <url>` read from the dashboard when no API key is configured) → **human gate 4/4** → `release` (writes the immutable cutover certificate) → `report`.

Not implemented: SDK reference generation, `Snippet` components with props, `Icon`/`Tiles`/`Tree`/`Panel` (T7 candidates).
