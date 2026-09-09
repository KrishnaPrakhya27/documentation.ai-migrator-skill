---
name: scrape-gitbook
description: "Scrape a hosted GitBook site using its generator metadata, page-document container, main content region, and Markdown-suffix endpoint when Git Sync and API are unavailable."
---
# Scrape GitBook

- Fingerprint: `<meta name="generator" content="GitBook (…)">`, `fonts.gitbook.com`, `static-2v.gitbook.com`, `main.page-has-toc`, `.page-document-item`.
- The acquire command tries a `.md` suffix and falls back to HTML when it fails; confirm coverage because availability varies by site.
- Discovery: sitemap ∪ seed-page links ∪ optional Firecrawl map. Sidebar and variant reconstruction are not wired into the current CLI.
- Article: `main .page-document-item` container; remove ToC, footer, "last updated", rating widgets.
