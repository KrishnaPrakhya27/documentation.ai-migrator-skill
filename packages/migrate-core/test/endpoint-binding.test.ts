/**
 * Documentation.AI renders an endpoint's reference only when the page's navigation entry names the
 * operation: the deployment step reads `openapi` beside `path` and injects the reference above the
 * page's own prose. An operation stated only in frontmatter renders nothing - which is what every
 * endpoint page of a migrated Mintlify site did.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentationNavigation, type SourceNavigationNode, type Tree, type TreePage } from '../src/nav/tree.js';

const page = (id: string, newPath: string, title: string): TreePage =>
  ({ id, title, group: [], order: 0, migrate: true, newPath, source: `https://site.test/${newPath}`, oldPath: `/${newPath}`, reason: 'sidebar' } as unknown as TreePage);

const tree: Tree = {
  scope: 'full', platform: 'mintlify',
  pages: [page('intro', 'docs/api/introduction', 'Introduction'), page('status', 'docs/api/update/status', 'Get deployment status')],
  navigation: [{ type: 'group', label: 'API reference', children: [{ type: 'page', pageId: 'intro' }, { type: 'page', pageId: 'status' }] }] as unknown as SourceNavigationNode[],
} as unknown as Tree;

const entries = (navigation: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
  if (Array.isArray(navigation)) navigation.forEach((item) => entries(item, out));
  else if (navigation && typeof navigation === 'object') {
    const record = navigation as Record<string, unknown>;
    if (typeof record.path === 'string' && typeof record.title === 'string') out.push(record);
    Object.values(record).forEach((child) => { if (Array.isArray(child)) entries(child, out); });
  }
  return out;
};

describe('an endpoint page bound where the platform reads it', () => {
  it('carries its operation on its own navigation entry, braces and all, and nothing else is bound', () => {
    const operation = 'api-reference/openapi.json GET /project/update-status/{statusId}';
    const { navigation } = buildDocumentationNavigation(tree, new Set(['docs/api/introduction', 'docs/api/update/status']), { pageOpenapi: { status: operation } });
    const byPath = new Map(entries(navigation).map((entry) => [entry.path, entry]));
    expect(byPath.get('docs/api/update/status')?.openapi).toBe(operation);
    // the sidebar draws the method badge from `method` alone; it is never read out of `openapi`
    expect(byPath.get('docs/api/update/status')?.method).toBe('GET');
    expect(byPath.get('docs/api/introduction')?.openapi).toBeUndefined();
    expect(byPath.get('docs/api/introduction')?.method).toBeUndefined();
  });

  it('binds nothing for a page that was not written', () => {
    const { navigation } = buildDocumentationNavigation(tree, new Set(['docs/api/introduction']), { pageOpenapi: { status: 'api-reference/openapi.json GET /x' } });
    expect(entries(navigation).some((entry) => 'openapi' in entry)).toBe(false);
  });

  it('keeps a bound page as its own entry rather than lifting it to its container\'s path', () => {
    const operation = 'api-reference/openapi.json POST /pet';
    const landing: Tree = {
      ...tree,
      pages: [page('doc-api', 'docs/create-content/openapi', 'Document an API'), page('add', 'docs/create-content/openapi/add-a-spec', 'Add a spec'), page('insert', 'docs/create-content/openapi/insert', 'Insert a reference')],
      navigation: [{ type: 'group', label: 'Document an API', children: [{ type: 'page', pageId: 'doc-api' }, { type: 'page', pageId: 'add' }, { type: 'page', pageId: 'insert' }] }] as unknown as SourceNavigationNode[],
    } as unknown as Tree;
    const written = new Set(['docs/create-content/openapi', 'docs/create-content/openapi/add-a-spec', 'docs/create-content/openapi/insert']);
    // without an operation the first page is the group's own landing page
    const plain = buildDocumentationNavigation(landing, written, {}).navigation;
    expect(JSON.stringify(plain)).toContain('"group":"Document an API","path":"docs/create-content/openapi"');
    // with one it stays a page entry, where the platform reads the operation
    const { navigation } = buildDocumentationNavigation(landing, written, { pageOpenapi: { 'doc-api': operation } });
    const byPath = new Map(entries(navigation).map((entry) => [entry.path, entry]));
    expect(byPath.get('docs/create-content/openapi')?.openapi).toBe(operation);
    expect(JSON.stringify(navigation)).not.toContain('"group":"Document an API","path"');
  });

  it('writes a container\'s own bound page as its first page entry rather than as the container\'s path', () => {
    const operation = 'api-reference/openapi.json POST /pet';
    const owned: Tree = {
      ...tree,
      pages: [page('doc-api', 'docs/create-content/openapi', 'Document an API'), page('add', 'docs/create-content/openapi/add-a-spec', 'Add a spec')],
      navigation: [{ type: 'group', label: 'Document an API', pageId: 'doc-api', children: [{ type: 'page', pageId: 'add' }] }] as unknown as SourceNavigationNode[],
    } as unknown as Tree;
    const written = new Set(['docs/create-content/openapi', 'docs/create-content/openapi/add-a-spec']);
    expect(JSON.stringify(buildDocumentationNavigation(owned, written, {}).navigation)).toContain('"group":"Document an API","path":"docs/create-content/openapi"');
    const { navigation } = buildDocumentationNavigation(owned, written, { pageOpenapi: { 'doc-api': operation } });
    const byPath = new Map(entries(navigation).map((entry) => [entry.path, entry]));
    expect(byPath.get('docs/create-content/openapi')?.openapi).toBe(operation);
    expect(JSON.stringify(navigation)).not.toContain('"group":"Document an API","path"');
  });
});
