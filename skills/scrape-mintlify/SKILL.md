---
name: scrape-mintlify
description: Acquire hosted Mintlify pages when the source repository is unavailable, using sitemap and seed-link discovery plus Mintlify article selectors and rendered-component recognisers.
---
# Scrape Mintlify

- Fingerprint: `<meta name="generator" content="Mintlify">`, `application-name=Mintlify`, `#content-container`, `#content-area`, `#sidebar-content`, `mintcdn.com`.
- Discovery: sitemap ∪ seed-page links ∪ optional Firecrawl map. The profile records navigation selectors, but sidebar reconstruction and recursive link-graph discovery are not wired into the current CLI.
- Article: `#content-area` (`.prose`). Remove `#table-of-contents-content`, `#page-title` duplicates, feedback widgets.
- Rendered components lose their MDX names; the profile maps rendered DOM back to source names where the markup is stable (callout variants by class, accordion groups, card grids, tabs). Everything else is a T7 candidate and appears in the component plan.
- Prefer asking the customer for the source repo; scraping a Mintlify site is strictly the fallback.
