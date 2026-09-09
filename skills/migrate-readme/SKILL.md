---
name: migrate-readme
description: Migrate a ReadMe project onto Documentation.AI from the bi-directional sync repository (docs/<category>/*.md with ReadMe frontmatter) or the API v2 (guides, reference, categories), then scrape-readme. Emoji callouts, Accordion, Cards, Columns, Image props and embeds map by rule.
---
# Migrate ReadMe

Implemented source preference: **sync repository** (`docs/<category>/*.md`, frontmatter `title`, `slug`, `excerpt`, `hidden`, `order`) → **API v2** (`README_API_KEY`; `/branches/{branch}/guides|reference|categories`, bodies from `content.body`) → live URL acquisition with the ReadMe scrape profile (`.md` suffix first, then `.rm-Markdown.markdown-body`).

## What the adapters do
- Sync repo: category folders become groups, `hidden: true` pages are skipped and listed, `order` is respected, `parentDocSlug` nests.
- API v2: paginated lists, per-page bodies, hidden pages excluded, tree grouped by section (Guides, Reference) and category.
- Markdown adapter with `platform: readme`: `> 📘 / 👍 / 🚧 / ❗` blockquotes become `Callout` kinds; `mappings/readme.yaml` covers Accordion → Expandable, Cards → Columns + Card, Columns, Image prop drops, Tabs, embeds, Recipes (when the body is present).

## Procedure
1. `dai-migrate init ... --repo <sync-repo> --platform readme` (or `--source https://<subdomain>.readme.io` for API or scrape).
2. `dai-migrate discover` ⏸ review `plan/tree.yaml`; hidden pages are in `inventory/platform-meta.json`.
3. `inventory` → `plan` ⏸ (variables, glossary terms, Recipes without bodies and marketplace components need a decision) → `assets` (rehost off `files.readme.io`) → `convert` → `convert` → `nav` ⏸ → `verify` → `write` → preview `verify` → `report`.

Not implemented: API reference generation from ReadMe's OpenAPI uploads (export the spec and use the Mintlify-style group-level `openapi` in `documentation.json` manually), variables and glossary substitution, Changelog → Update conversion.
