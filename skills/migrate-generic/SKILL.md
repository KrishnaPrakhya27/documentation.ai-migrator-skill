---
name: migrate-generic
description: "Migrate a documentation site onto Documentation.AI from a local Markdown, MDX, or HTML repository, or from a frozen live-URL list discovered through sitemaps, seed-page links, and optional Firecrawl mapping."
---
# Migrate generic (HTML crawl path)

For sites with no export, API or source repo, or for platforms without a dedicated skill.

## Procedure
1. `dai-migrate discover --url <site>`: sitemap URLs ∪ links on the seed page ∪ Firecrawl `/map` when selected. The union records why each page was found. This version does not recursively crawl the link graph or reconstruct the sidebar; review `plan/tree.yaml`, correct groups/order, and mark exclusions with `migrate: false`.
2. `dai-migrate acquire --profile generic`: batch scrape of the confirmed list through Firecrawl (explicit settings) or the local fetcher; content-addressed cache; robots honoured unless `--customer-authorised`.
3. `dai-migrate inventory`: everything with a class or a non-standard tag is a component candidate; `details`, `iframe`, `video`, tables, code, images.
4. `dai-migrate plan`: `mappings/generic.yaml`; unknown clusters need review and become a sanitised T7 fragment only when explicitly approved, otherwise they are quarantined. Automatic T6 rule proposal is not implemented.
5. `assets` → `convert` → `nav` → local `verify` twice → push the migration branch for preview → rendered-preview `verify` → `report`.
