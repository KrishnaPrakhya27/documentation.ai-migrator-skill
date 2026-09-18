# Platform dependency G7: hosting pictures without Documentation.AI's own storage keys

**Built on 18 September 2026** in `documentation-ai-backend` on `feature/media-mcp`, not yet merged or deployed. Until it is deployed, `assets --provider dai-mcp` stops with a message saying the server has no media import, and `dai-api` reports the media API as unavailable. Use `--provider none --keep-external --by "<who>"` meanwhile.

The earlier design in this file (an API-key presign and confirm pair, plus `contentContractVersion` on `GET /api/v1/config`) was never merged. The contract version is still not exposed, so `verify --preview` keeps assuming it. What shipped instead:

## What the migrator uses

| Provider | Authenticates with | Platform surface | Carries |
|---|---|---|---|
| `dai-mcp` | Browser sign-in (or `DAI_API_KEY`) | Authoring MCP tool `import_media`, 10 URLs per call | Files the platform can fetch from their public https address |
| `dai-api` | `DAI_API_KEY` + `DAI_API_BASE` | `POST /api/v1/media`, multipart, 10 files per request | The captured bytes, for anything |

`dai-mcp` falls back to `dai-api` for a file with no public address, a cleaned SVG, a file the platform could not fetch, or (exact mode) one the source now serves at a different size, when a key is set. Without a key those files fail with that reason, and the person decides.

## What the platform guarantees

- Every path runs the same checks as a dashboard upload: type read from the bytes, SVG screening, the plan's per-file size, the storage quota, and deduplication by content (a re-run gets `reused`, not a second copy).
- A taken name gets a suffix (`diagram-2.png`) instead of a refusal.
- One result per file. `import_media` names each stored file's `source` URL; the REST route answers in the order sent, with `207` when some files failed.
- 120 files a minute per organisation across the API and MCP. A file past that fails with `Retry in N seconds`; the migrator paces itself under it and retries.

## How to check a deployment

1. `dai-migrate project --workspace <w>`, then `dai-migrate assets --workspace <w> --provider dai-mcp` on a workspace with downloaded assets: every asset `ingested`, and `plan/assets.json` records `org-<id>/doc-<id>/…` storage paths.
2. The dashboard's media library for that project lists them, and its Activity panel names the person who signed in.
3. Running `assets` again sends nothing.
