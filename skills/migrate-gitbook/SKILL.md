---
name: migrate-gitbook
description: Migrate a GitBook space onto Documentation.AI from its Git Sync repository (SUMMARY.md navigation, .gitbook.yaml root and redirects, Liquid-flavoured Markdown), falling back to scrape-gitbook. The GitBook API client is not implemented yet.
---
# Migrate GitBook

Implemented source preference: **Git Sync repository** → live URL acquisition with the GitBook scrape profile (`.md` suffix first).

## What the adapter does
- Reads `.gitbook.yaml` (`root`, `structure.readme`, `structure.summary`, `redirects`) and `SUMMARY.md`: section headings become top-level groups, nested list items become nested groups, external links are skipped, missing targets and unlisted `.md` files are reported.
- `.gitbook.yaml` redirects become exact rules.
- Content goes through the Markdown adapter with `platform: gitbook`: `{% hint %}`, `{% tabs %}`/`{% tab %}`, `{% embed %}`, `{% content-ref %}`, `{% stepper %}`/`{% step %}`, `{% columns %}`/`{% column %}`, `{% updates %}`/`{% update %}` and `{% code %}` are converted outside code blocks, including inside blockquotes and after list items; mappings in `mappings/gitbook.yaml`.
- Live sites: the published `.md` is unwrapped (the `llms.txt` index line, the H1, the declared description paragraph and the trailing `# Agent Instructions` section are GitBook's, not the page's). Discovery folds each page's `.md` copy and every redirecting URL (group URLs, section `readme`/`welcome` paths) into the page it serves.
- GitBook's HTML encodings are read as what they are: `<table data-view="cards">` becomes cards (target and cover columns give `href` and `image`), `<a class="button">` a link, `<details><summary>` an Expandable title, `{% code title %}` a titled fence, `.md` page links the page path, and `broken://` links their text. Assistant prompts (`<button data-action="ask">`) are platform chrome and dropped by rule. A step's leading heading becomes its Step title (`titleType` h2/h3), which verify counts as that heading.
- API reference: GitBook writes each operation, and each schema on a models page, as a fenced one-operation OpenAPI document. It becomes a static reference in the page: method and path, auth and parameters as `ParamField`, request body fields, and each response's fields as `ResponseField` (`$ref`/`allOf` resolved, nested objects in an Expandable). Any other JSON fence stays code. No group-level `openapi` spec is attached, so the pages keep their approved navigation and no playground is generated.

## Procedure
1. `dai-migrate init ... --repo <git-sync-repo> --platform gitbook`
2. `dai-migrate discover` → **human gate 1/4**: review `plan/tree.yaml` and decide what to do with unlisted files (`inventory/platform-meta.json`).
3. `inventory` → `plan` → **human gate 2/4** → `assets` → `convert` twice → `nav` → local `verify` → **human gate 3/4** → `write --push` (waits for the preview) → `verify --preview` → **human gate 4/4** → `release` (writes the immutable cutover certificate) → `report`.

Not implemented: GitBook API export, variants and sections from `gitbook-docs.yaml` (map manually to versions and tabs in `plan/tree.yaml`), drawings, math, conditional content (T7 candidates).
