---
name: scrape-mintlify
description: "Acquire hosted Mintlify pages when the source repository is unavailable, using recursive sitemaps, ordered sidebar links, same-origin crawling, Mintlify article selectors, and rendered-component recognisers."
---
# Scrape Mintlify

- Fingerprint (`profiles.ts` mintlify signals): `<meta name="generator" content="Mintlify">`, `application-name=Mintlify`, `#content-area`, `#sidebar-content`, `#navigation-items`, `mintcdn.com` assets, `docs.json` / `mint.json` in a repo, and the published `.md` suffix.
- Discovery: recursive sitemap indexes ∪ ordered Mintlify sidebar links ∪ recursive same-origin links ∪ optional Firecrawl map. Sitemap order and locale/version hints are used only when stronger sidebar/path evidence is absent.
- Article: `#content-area`. Before conversion the profile removes theme chrome: `header` (group eyebrow, `#page-title`, description — title and description come from llms.txt and the published `.md`), `nav`, `footer`, `#table-of-contents-content`, `#sidebar-content`, `#navigation-items`, `#pagination`, `[data-feedback]`, the assistant bar and everything inside it (`[data-assistant-bar]`, `.chat-assistant-floating-input`, the `⌘I` shortcut hint, textarea and send button), code-block floating buttons, the "Expand image" lightbox button and the per-heading "Navigate to header" anchors. `profile.chromeStrings` lists the theme strings that must never reach migrated output.
- Rendered structure: `span[data-as="p"]` is a paragraph (`paragraphSelectors`); `[data-component-part="step-title"]` and `[data-component-part="card-title"]` are lifted into the Step / Card `title` prop and removed from the children (`@part:`), Step numbers are dropped; `CardGroup` cols come from `style="--cols:n"` (`@style-var:`); the code language comes from the `language` attribute with highlighter ids normalised to fence names (`shellscript` → `bash`, `plaintext` → none) and the `language-*` class as the fallback; callout kind comes from `data-callout-type`.
- Rendered components lose their MDX names; the profile maps rendered DOM back to source names where the markup is stable (callouts, accordion groups, card grids, steps, tabs, frames). Card `href`s are applied client-side and are absent from the rendered HTML, so the published `.md` is the content source and the HTML is used for reconciliation. Everything else is a T7 candidate and appears in the component plan.
- Prefer asking the customer for the source repo; scraping a Mintlify site is strictly the fallback.

## Navigation recovery
The rendered navigation lives in the Next.js Flight payload as `scopedNav`. On scoped deployments `docsConfig.navigation` is stripped to `{"pages": []}` server-side, so `scopedNav` is what the sidebar actually renders and what the migration reproduces. The extractor:

- reassembles the payload from every `self.__next_f.push` chunk before searching it, so a navigation larger than one chunk is not lost;
- walks every container Mintlify nests navigation under (`versions`, `languages`, `products`, `dropdowns`, `anchors`, `tabs`, `groups`, `pages`), so tabbed and versioned sites keep their structure;
- records each placement separately, so a page listed in two groups appears in both.

`extractDomSidebarNavigation` reads the rendered `#sidebar-content` (group headings via `.sidebar-group-header`) as a second, independent witness. It is the navigation source on sites that embed none, and elsewhere the `navigation-exact` gate cross-checks the written navigation against a fresh extraction from the frozen source.

`docsConfig` in the same payload carries the site name, colours, logo and favicon; these are written to `inventory/platform-meta.json` and into `documentation.json`.

## Canonical hosts
A Mintlify site is served under both `<slug>.mintlify.site` and `<slug>.mintlify.app`. The profile declares the pair, so a URL on either host is the same page: the fetch allowlist admits both and every discovered URL is rewritten onto the seed origin. Without this the sitemap Mintlify publishes on the paired host is silently dropped and no page gets sitemap provenance.
