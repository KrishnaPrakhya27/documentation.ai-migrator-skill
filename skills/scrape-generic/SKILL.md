---
name: scrape-generic
description: "Acquire a frozen documentation URL list with Firecrawl batch scrape or a rate-limited local fetcher with robots, retry, cache, response-size, redirect, DNS and SSRF protections."
---
# Scrape generic

- Firecrawl: `POST /v2/batch/scrape` over the frozen URL list with `maxConcurrency` from the session, `ignoreInvalidURLs:false`, `skipTlsVerification:false`, `storeInCache:false`, `formats:[html,markdown,links]`, `onlyMainContent:true`, `proxy:auto`. Persist results before the job's `expiresAt`; consume every `next` page; fail if `completed !== expected`.
- Discovery: recursively reads robots-declared and conventional sitemap indexes/URL sets (including gzip), preserving order, index provenance, `lastmod`, `changefreq`, `priority`, hreflang alternates, and conservative section/locale/version hints. It unions those pages with ordered sidebar links, recursive same-origin links, and optional Firecrawl mapping.
- Local fetcher: origin-bound in-memory headers, cookie jar, token-bucket rate limiting, backoff with jitter on 429/5xx, robots.txt unless `--customer-authorised`, proxy support, DNS pinning with non-public-address rejection, host allowlisting and re-validation after redirects, and a 20 MB response cap.
- Cache: `source-cache/<sha256(url)>.json` with ETag; re-runs send `If-None-Match`.
- Extraction: the selected TypeScript profile's `articleSelector` and chrome-removal selectors. The generic profile tries `article`, `main`, `[role=main]`, `#content`, or `.content`; there is no readability scoring stage yet.
