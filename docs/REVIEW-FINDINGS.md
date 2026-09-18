# Adversarial review, 9 September 2026

Independent review of the hardened tree before the baseline commit. Every item was verified by reading or executing code. Status reflects the state at commit time.

| # | Sev | Area | Finding | Status |
|---|---|---|---|---|
| 1 | Critical | `.env.example` | A live Firecrawl key was present in the example file and in the first commit | Fixed: history rewritten and force-pushed; key must be rotated (owner action) |
| 2 | High | sanitiser | `iframe` allowlist checked `src` only; `srcdoc` passed through | Fixed: iframe attributes restricted to src, title, width, height, loading, allowfullscreen |
| 3 | High | contract validator | Line-based scan could be split by newlines inside tags, expressions and imports; a mid-line fence hid the rest of the document | Fixed: fences count only at line start; tags, expressions and import statements folded before scanning. A parser-based validator remains the stronger option (open) |
| 4 | High | git writer | Remote allowlist ignored the host | Fixed: allowlist entries are host/org pairs; bare org implies github.com |
| 5 | High | git writer | Push went to `origin` while only `--remote` was validated | Fixed by the hardening pass: origin is always validated |
| 6 | High | rules engine | Plan lookup hashed the node after its children were resolved, so nested clusters never matched their plan entry and subtree marks used resolved ids | Fixed: signature computed before recursion; subtree marks use the original node |
| 7 | High | fetcher | Validated DNS answer discarded; undici resolved again (rebinding) | Fixed: dispatcher connects only to addresses validated by `assertPublicHost` (proxy mode delegates to the proxy) |
| 8 | High | browser | Chrome followed redirects without revalidation | Fixed: `--host-resolver-rules` pins the preview host and maps every other name to NOTFOUND |
| 9 | High | gates | Determinism compared two verify runs over the same files | Fixed: convert records its output hash; the gate compares consecutive converts over identical inputs |
| 10 | High | gates | Prose normaliser applied to output only | Fixed: shared normaliser on both sides |
| 11 | High | gates | Fence regex missed indented fences inside components and lists | Fixed: indented fences matched and dedented |
| 12 | Medium | serialiser | Backticks in fence meta broke the fence | Fixed: backticks and tildes stripped from meta and title |
| 13 | Medium | markdown adapter | Platform rewrites ran inside fenced and inline code | Fixed: rewrites apply outside code only |
| 14 | Medium | cli | `plan` re-pinned hashes without invalidating verified output | Fixed: `plan` clears the canonical output hash |
| 15 | Medium | cli | `gates.json` not bound to the output it described | Fixed: gates carry the output hash; `write --push` checks it |
| 16 | Medium | browser | Anchor regex had no left boundary | Fixed |
| 17 | Medium | document360 | Metadata comment matched anywhere in the file | Fixed: anchored to the start |
| 18 | Medium | document360 | Article lookup keyed by basename across workspaces | Fixed: keyed by workspace and basename |
| 19 | Medium | fetcher | robots.txt checked for the first URL only | Fixed: checked on every redirect hop |
| 20 | Medium | cli | Errors printed unredacted | Fixed: `fail()` redacts |
| 21 | Medium | firecrawl | `zeroDataRetention` defaulted to false | Superseded 10 September 2026 by owner decision: the Firecrawl account has no ZDR agreement and Firecrawl rejects jobs that request it, so it is opt-in (`--zero-data-retention` or `FIRECRAWL_ZERO_DATA_RETENTION=1`). Without it Firecrawl may retain scraped pages |
| 22 | Medium | contract validator | Snippet import allowlist accepted `..` paths and `export` | Fixed: strict single-import form under `/snippets/` without `..` |
| 23 | Low | fetcher | Body size checked after full buffering | Fixed: streamed read with a byte cap |
| 24 | Low | gates | Single-column tables never matched | Fixed |
| 25 | Low | writer, document360 | scp remotes with subgroups refused; directory exports followed symlinks | Fixed: subgroups parsed; symlinks skipped |

Phase 2 modules reviewed in the same pass:

| Area | Finding | Status |
|---|---|---|
| asset providers | Failed entries were never retried on a later run | Fixed: retried when local bytes exist |
| discovery | `truncated` was false when the limit refused candidates but the queue drained | Fixed: counts refusals |
| dai-api provider | Rewritten 2026-09-18 for the platform's real `POST /api/v1/media` multipart route; the presign endpoints it targeted were never built. `dai-mcp` (sign-in, `import_media`) is now the key-free default | Resolved, pending platform deploy |
| discovery | Crawls serially at the fetcher's rate; 5,000 pages at 2 rps is ~40 minutes | Accepted for now |

Open, by design or pending platform work: parser-based contract validation (3), preview search index, `contentContractVersion` exposure, atomic bulk write session, API-key asset ingestion, wildcard redirects, custom heading anchors.
