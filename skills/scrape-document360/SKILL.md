---
name: scrape-document360
description: Acquire live Document360 pages when an export is unavailable, using sitemap and seed-link discovery plus the Document360 article selectors and component recognisers.
---
# Scrape Document360

Use only for pages the export or API could not provide. Native sources win.

- Fingerprint: `#serverApp`, `#articleContent`, `.editor360-published-content`, assets on `cdn.document360.io`, `/llms.txt` present.
- Discovery: sitemap ∪ seed-page links ∪ optional Firecrawl map. `/llms.txt` and sidebar-tree discovery are not implemented; add any missing URLs to `plan/tree.yaml` before acquisition.
- Article container: `#articleContent, .editor360-published-content`. Chrome removed: `nav`, `header`, `footer`, `.breadcrumb`, `.article-feedback`, `.related-articles`.
- Fetch through `dai-migrate acquire --profile document360 [--urls <json>]` using Firecrawl's explicit safe settings or the local fetcher, which honours robots unless `--customer-authorised`.
- Output feeds the same Document360 recognisers and mapping table as the export path.
