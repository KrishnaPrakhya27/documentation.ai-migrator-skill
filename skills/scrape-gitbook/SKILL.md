---
name: scrape-gitbook
description: "Scrape a hosted GitBook site using its generator metadata, page-document container, main content region, and Markdown-suffix endpoint when Git Sync and API are unavailable."
---
# Scrape GitBook

- Fingerprint: `<meta name="generator" content="GitBook (…)">`, `fonts.gitbook.com`, `static-2v.gitbook.com`, `main.page-has-toc`, `.page-document-item`.
- The acquire command tries a `.md` suffix and falls back to HTML when it fails; confirm coverage because availability varies by site.
- Discovery: recursive sitemap indexes ∪ ordered GitBook sidebar links ∪ recursive same-origin links ∪ optional Firecrawl map. Sitemap order and locale/version hints are retained as fallbacks; variants still require review when the live site does not expose them distinctly.
- Article: `main .page-document-item` container; remove ToC, footer, "last updated", rating widgets.
