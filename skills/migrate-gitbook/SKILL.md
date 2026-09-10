---
name: migrate-gitbook
description: Migrate a GitBook space onto Documentation.AI from its Git Sync repository (SUMMARY.md navigation, .gitbook.yaml root and redirects, Liquid-flavoured Markdown), falling back to scrape-gitbook. The GitBook API client is not implemented yet.
---
# Migrate GitBook

Implemented source preference: **Git Sync repository** → live URL acquisition with the GitBook scrape profile (`.md` suffix first).

## What the adapter does
- Reads `.gitbook.yaml` (`root`, `structure.readme`, `structure.summary`, `redirects`) and `SUMMARY.md`: section headings become top-level groups, nested list items become nested groups, external links are skipped, missing targets and unlisted `.md` files are reported.
- `.gitbook.yaml` redirects become exact rules.
- Content goes through the Markdown adapter with `platform: gitbook`: `{% hint %}`, `{% tabs %}`/`{% tab %}`, `{% embed %}`, `{% content-ref %}`, `{% stepper %}` are converted outside code blocks; mappings in `mappings/gitbook.yaml`.

## Procedure
1. `dai-migrate init ... --repo <git-sync-repo> --platform gitbook`
2. `dai-migrate discover` → **human gate 1/4**: review `plan/tree.yaml` and decide what to do with unlisted files (`inventory/platform-meta.json`).
3. `inventory` → `plan` → **human gate 2/4** → `assets` → `convert` twice → `nav` → local `verify` → **human gate 3/4** → `write --push` (waits for the preview) → `verify --preview` → **human gate 4/4** → `report`.

Not implemented: GitBook API export, variants and sections from `gitbook-docs.yaml` (map manually to versions and tabs in `plan/tree.yaml`), drawings, math, conditional content (T7 candidates).
