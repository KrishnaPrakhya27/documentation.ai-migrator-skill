/**
 * A Mintlify endpoint page is rendered from a spec. Its published Markdown restates that as a
 * trailing "## OpenAPI" section holding the spec cut down to that operation, and carrying the
 * section across as a code block showed a reader YAML where the source showed an API reference.
 * The section is read back into the statement it came from — a frontmatter line the platform
 * renders the same way — and the fragments of one spec are put together into the file it names.
 */
import { describe, it, expect } from 'vitest';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { mergeOperationDocuments, openapiAnchors, parameterLinkRewriter } from '../src/ir/mintlify-openapi.js';
import { inlineText } from '../src/ir/types.js';

const fragment = (path: string, method: string, summary: string, schema = 'Feedback'): string => [
  'openapi: 3.1.0', 'info:', '  title: Analytics API', '  version: 1.0.0', 'paths:', `  ${path}:`, `    ${method}:`, `      summary: ${summary}`,
  '      responses:', "        '200':", '          content:', '            application/json:', '              schema:', `                $ref: '#/components/schemas/${schema}'`,
  'components:', '  schemas:', `    ${schema}:`, '      type: object',
].join('\n');

const page = (spec: string, method: string, path: string) => `---
title: Get feedback
---

Authenticate with an admin API key.

## Usage

Paginate with the cursor.

## OpenAPI

\`\`\`yaml ${spec} ${method} ${path}
${fragment(path, method.toLowerCase(), 'Get feedback')}
\`\`\`
`;

const read = (source: string, platform = 'mintlify') => markdownToIr(source, { platform, file: 'api/analytics/feedback.md', pageId: 'p1' });

describe('a Mintlify endpoint page', () => {
  it('states its operation in the frontmatter the platform reads, and drops the rendered section', () => {
    const doc = read(page('analytics.openapi.json', 'GET', '/v1/analytics/{projectId}/feedback'));
    expect(doc.frontmatter.openapi).toBe('api-reference/analytics.openapi.json GET /v1/analytics/{projectId}/feedback');
    const headings = doc.children.filter((block) => block.type === 'heading').map((block) => block.type === 'heading' ? inlineText(block.children) : '');
    expect(headings).toEqual(['Usage']);
    expect(doc.children.some((block) => block.type === 'code')).toBe(false);
    expect(doc.openapiOperation).toMatchObject({ spec: 'analytics.openapi.json', method: 'GET', path: '/v1/analytics/{projectId}/feedback' });
    expect(doc.openapiOperation?.document).toContain('openapi: 3.1.0');
  });

  it('finds the section when the export appends related topics after it', () => {
    const source = page('analytics.openapi.json', 'GET', '/v1/x') + '\n## Related topics\n\n- [Views](/docs/api/analytics/views)\n';
    const doc = read(source);
    expect(doc.frontmatter.openapi).toBe('api-reference/analytics.openapi.json GET /v1/x');
    const headings = doc.children.filter((block) => block.type === 'heading').map((block) => block.type === 'heading' ? inlineText(block.children) : '');
    expect(headings).toEqual(['Usage', 'Related topics']);
  });

  it('keeps a spec path as the site wrote it, locale directory included', () => {
    // es/analytics.openapi.json and analytics.openapi.json are different documents, in different languages
    expect(read(page('es/analytics.openapi.json', 'GET', '/v1/x')).frontmatter.openapi).toBe('api-reference/es/analytics.openapi.json GET /v1/x');
  });

  it('leaves a page alone whose last fence does not name an operation', () => {
    const source = '---\ntitle: Config\n---\n\nText.\n\n## OpenAPI\n\n```yaml\nopenapi: 3.1.0\n```\n';
    const doc = read(source);
    expect(doc.frontmatter.openapi).toBeUndefined();
    expect(doc.children.some((block) => block.type === 'code')).toBe(true);
  });

  it('is read only for Mintlify, whose renderer wrote the section', () => {
    const doc = read(page('analytics.openapi.json', 'GET', '/v1/x'), 'generic');
    expect(doc.frontmatter.openapi).toBeUndefined();
    expect(doc.children.some((block) => block.type === 'code')).toBe(true);
  });
});

describe('the spec file, assembled from the pages', () => {
  it('holds every operation the site documented from it, with components merged once', () => {
    const a = read(page('analytics.openapi.json', 'GET', '/v1/feedback')).openapiOperation!;
    const b = read(page('analytics.openapi.json', 'GET', '/v1/views')).openapiOperation!;
    b.document = fragment('/v1/views', 'get', 'Get views', 'Views');
    const files = mergeOperationDocuments([b, a]);
    expect([...files.keys()]).toEqual(['analytics.openapi.json']);
    const spec = JSON.parse(files.get('analytics.openapi.json')!);
    expect(Object.keys(spec.paths)).toEqual(['/v1/feedback', '/v1/views']);
    expect(Object.keys(spec.components.schemas).sort()).toEqual(['Feedback', 'Views']);
    expect(spec.info.title).toBe('Analytics API');
  });

  it('writes YAML for a spec the site names as YAML, and is the same bytes on every run', () => {
    const a = read(page('admin.yaml', 'POST', '/jobs')).openapiOperation!;
    const one = mergeOperationDocuments([a]).get('admin.yaml')!;
    expect(one.startsWith('openapi: 3.1.0')).toBe(true);
    expect(mergeOperationDocuments([a]).get('admin.yaml')).toBe(one);
  });
});

describe('links into an endpoint page', () => {
  const spec = [
    'openapi: 3.1.0', 'info: {title: T, version: "1"}',
    'paths:', '  /v1/x/{id}:', '    parameters:', '      - {name: id, in: path}', '    get:', '      parameters:', '        - $ref: "#/components/parameters/Cursor"',
    '      requestBody:', '        content:', '          application/json:', '            schema:', '              $ref: "#/components/schemas/Body"',
    'components:', '  parameters:', '    Cursor: {name: cursor, in: query}', '  schemas:', '    Body:', '      properties:', '        projectId: {type: string}',
  ].join('\n');

  it('know the anchors the platform renders for every parameter', () => {
    expect([...openapiAnchors(spec, 'GET', '/v1/x/{id}')].sort()).toEqual(['body-projectId', 'path-id', 'query-cursor']);
  });

  it('follow a Mintlify #param- fragment to the platform\'s anchor, and leave what they cannot place', () => {
    const rewrite = parameterLinkRewriter(new Map([['api/x', openapiAnchors(spec, 'GET', '/v1/x/{id}')]]));
    expect(rewrite('/api/x#param-cursor')).toBe('/api/x#query-cursor');
    expect(rewrite('/api/x#param-projectId')).toBe('/api/x#body-projectId');
    expect(rewrite('/api/x#param-nothing')).toBe('/api/x#param-nothing');
    expect(rewrite('/other#param-cursor')).toBe('/other#param-cursor');
  });
});
