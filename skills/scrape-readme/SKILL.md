---
name: scrape-readme
description: "Scrape a hosted ReadMe site using the current sidebar, Markdown content container, hub state, Markdown-suffix endpoint when available, and readme-deploy metadata."
---
# Scrape ReadMe

- Fingerprint: `.rm-Sidebar` + `#hub-container` + `#ssr-props`, `cdn.readme.io` assets, `<meta name="readme-deploy">`. `rm-Article` is stale; do not rely on it.
- The acquire command tries a `.md` suffix and treats HTML as the fallback; confirm coverage because availability varies by site.
- The profile knows current sidebar and content selectors, but category/order reconstruction and `#ssr-props` version parsing are not wired into discovery. Reconcile them manually in `plan/tree.yaml`.
- Article: `.rm-Markdown.markdown-body`. Remove `.rm-Header`, `.rm-ToC`, `.rm-Pagination`, Try-It widgets (`.rm-TryIt`, `.rm-Playground*`).
- Emoji blockquotes (📘 👍 🚧 ❗) are recognised as `Callout` with kind info|success|alert|danger.
