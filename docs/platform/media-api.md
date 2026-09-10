# Platform dependency G7: API-key media upload

Owner: backend (WS-A). **Implemented on 10 September 2026 as a working-tree change in `documentation-ai-backend`** (`src/modules/rest-api/media.routes.ts`, schemas in `restApi.schema.ts`, registered under `/api/v1/media`, tests in `__tests__/media.permissions.vitest.ts`); pending review, commit and deploy. Until it is deployed, migrations use `--provider s3` or `--provider none`; `init` detects availability automatically.

The same change exposes `contentContractVersion` on `GET /api/v1/config` (constant in `src/config/contentContract.ts`, must match the package's `contractVersion`), which closes the second blocker: `verify --preview` stops assuming the version once the environment reports it.

## The gap, verified

The backend has two authentication surfaces:

| Prefix | Auth | Media routes |
|---|---|---|
| `/api/v1/*` | API key (`requireApiKey`, key bound to one documentation, roles viewer/editor/admin) | none |
| `/organizations/:org/documentation/:doc/images/*` | dashboard session (`requireAuth` via Clerk) | presign, confirm, multipart, list, replace, delete |

Probing with a valid API key: the session route answers `401 Authentication required`; `/api/v1/...images` answers `404`. No header scheme changes that, because the session route never consults the API-key table.

## The change

Expose the existing image service under the API-key surface. No new storage logic; the service already enforces quota, magic-byte checks, SVG screening and dedupe at `confirm`.

New file `src/modules/rest-api/media.routes.ts`:

```ts
import { FastifyInstance } from 'fastify';
import { requireRole, type ApiKeyRequest } from '../../hooks/apiKeyAuth';
import { buildUploadRateLimitConfig } from '../../hooks/rateLimit';
import * as imagesService from '../documentation/images/images.service';
import { ApiKeysRepository } from '../api-keys/apiKeys.repository';
import type { GenerateUploadUrlRequest, ConfirmUploadRequest, ListImagesQuery } from '../documentation/images/images.types';

/**
 * API-key media surface. The key is bound to one documentation, so the org and
 * documentation come from the key context, never from the request. Uploads are
 * attributed to the user who created the key.
 */
export default async function mediaRoutes(fastify: FastifyInstance) {
  const actor = async (ctx: ApiKeyRequest['apiKeyContext']) => {
    const key = await ApiKeysRepository.findById(ctx!.keyId);
    return key!.createdBy;
  };

  fastify.get('/', async (request: ApiKeyRequest) => {
    const ctx = request.apiKeyContext!;
    requireRole(ctx, 'viewer');
    return imagesService.listImages(ctx.organizationId, ctx.documentationId, request.query as ListImagesQuery);
  });

  fastify.post('/upload-url', { config: { rateLimit: buildUploadRateLimitConfig() } }, async (request: ApiKeyRequest, reply) => {
    const ctx = request.apiKeyContext!;
    requireRole(ctx, 'editor');
    const result = await imagesService.generateImageUploadUrl(ctx.organizationId, ctx.documentationId, await actor(ctx), request.body as GenerateUploadUrlRequest);
    return reply.status(200).send(result);
  });

  fastify.post('/confirm', async (request: ApiKeyRequest, reply) => {
    const ctx = request.apiKeyContext!;
    requireRole(ctx, 'editor');
    const result = await imagesService.confirmImageUpload(ctx.organizationId, ctx.documentationId, await actor(ctx), request.body as ConfirmUploadRequest);
    return reply.status(201).send(result);
  });
}
```

Register it inside `restApiRoutes` (which already applies `requireApiKey` and the per-key rate limit):

```ts
// src/modules/rest-api/restApi.routes.ts
import mediaRoutes from './media.routes';
// ...inside restApiRoutes, after the preHandler:
await fastify.register(mediaRoutes, { prefix: '/media' });
```

Notes for the implementer:

- `buildUploadRateLimitConfig` keys on `params.organizationId`, which is absent here; pass `ctx.organizationId` through a small wrapper or key on `ctx.keyId` so the presign limiter still applies.
- `ApiKeysRepository.findById` may not exist yet; `findActiveByHash` returns `createdBy`, so either extend the repository or carry `createdBy` in `ApiKeyContext`.
- The media audit log records `actorUserId`; attributing to the key creator keeps the audit trail honest. If a dedicated "API key" actor type is preferred, add it to `media_audit_log.actor_type` first.
- Storage quota, plan limits and dedupe are unchanged: they live in `confirmImageUpload`.
- The migrator calls exactly `GET /api/v1/media?limit=1` (probe), `POST /api/v1/media/upload-url`, `PUT <signed url>`, `POST /api/v1/media/confirm`, and `GET /api/v1/media?search=<name>` on a 409.

## Verification

1. Create an editor API key for a documentation on a Standard plan.
2. `curl -H "authorization: Bearer $KEY" https://api.documentationai.app/api/v1/media?limit=1` returns 200.
3. `dai-migrate assets --provider dai-api` on a workspace with downloaded assets reports them as `ingested` with `blob-cdn.documentation.ai` URLs, and the media library in the dashboard shows them under the key's documentation.
4. A viewer key gets 403 on `upload-url`.
