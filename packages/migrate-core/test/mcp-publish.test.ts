/**
 * The MCP flow: a migration published straight into a Documentation.AI project through the
 * platform's Authoring MCP server, with no git on the customer's side.
 *
 * The platform validates every write, so the order and the size of the writes are the design:
 * a navigation entry naming a page that does not exist is refused, and so is a write that drops
 * more than a quarter of the navigation's paths at once - which replacing a starter site with a
 * migrated one always would. The stand-in below enforces both rules the way the platform's
 * validator does, so a publish that passes here was never refused.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpClient, McpToolError } from '../src/publish/mcp-client.js';
import { droppable, navigationPaths, navigationSteps, publishThroughMcp, withTemporaryGroup, type PublishProgress } from '../src/publish/publish.js';

type Json = Record<string, unknown>;

function output(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dai-mcp-publish-'));
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  return dir;
}

/** A project as the Authoring MCP server presents it, holding the platform's two rules. */
function project(starter: { files: Record<string, string>; config: Json }) {
  const branches = new Map<string, { files: Map<string, string>; config: Json }>();
  const live = { files: new Map(Object.entries(starter.files)), config: starter.config };
  const calls: Array<{ tool: string; args: Json }> = [];
  const published: string[] = [];
  const call = async (tool: string, args: Json) => {
    calls.push({ tool, args });
    const ok = (structured: Json) => ({ structured, text: '' }) as never;
    if (tool === 'create_branch') {
      const name = args.branchName as string;
      if (branches.has(name)) throw new McpToolError(tool, `A working version named "${name}" already exists`);
      branches.set(name, { files: new Map(live.files), config: JSON.parse(JSON.stringify(live.config)) as Json });
      return ok({ branchName: name, sourceBranch: 'main', sourceSha: 'abc1234' });
    }
    const version = branches.get(args.branch as string);
    if (!version) throw new McpToolError(tool, `no working version ${String(args.branch)}`);
    if (tool === 'list_pages') return ok({ total: version.files.size, pages: [...version.files.keys()].map((path) => ({ path })) });
    if (tool === 'create_page') {
      if (version.files.has(args.path as string)) throw new McpToolError(tool, `${String(args.path)} already exists`);
      version.files.set(args.path as string, args.content as string); return ok({ path: args.path });
    }
    if (tool === 'rewrite_page') { version.files.set(args.path as string, args.content as string); return ok({ path: args.path, applied: 1, total: 1 }); }
    if (tool === 'delete_page') { version.files.delete(args.path as string); return ok({ path: args.path }); }
    if (tool === 'get_site_config') return ok({ config: version.config });
    if (tool === 'update_site_config') {
      const next = JSON.parse(JSON.stringify(version.config)) as Json;
      for (const patch of args.patches as Array<{ op: string; path: string; value?: unknown }>) next[patch.path.slice(1)] = patch.value;
      const before = navigationPaths(version.config.navigation); const after = navigationPaths(next.navigation);
      const missing = [...after].filter((path) => !version.files.has(`${path}.mdx`));
      if (missing.length) throw new McpToolError(tool, `nav_path_missing: ${missing.join(', ')}`);
      const dropped = [...before].filter((path) => !after.has(path));
      if (before.size >= 4 && dropped.length / before.size > 0.25) throw new McpToolError(tool, `nav_mass_removal: this write removes ${dropped.length} of ${before.size} navigation paths`);
      version.config = next;
      return ok({ changed: true, patches: (args.patches as unknown[]).length, warnings: [] });
    }
    if (tool === 'publish') { published.push(args.branch as string); return ok({ status: 'published', commitSha: 'feedc0de', branch: args.branch }); }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { call, calls, branches, published };
}

const page = (title: string): string => `---\ntitle: ${title}\n---\n\n${title} body.\n`;
const starter = () => ({
  files: Object.fromEntries(['welcome', 'quickstart', 'guides/first', 'guides/second', 'api/overview', 'changelog'].map((path) => [`${path}.mdx`, page(path)])),
  config: { name: 'Starter', navigation: { groups: [{ group: 'Start', pages: ['welcome', 'quickstart', 'guides/first', 'guides/second', 'api/overview', 'changelog'] }] } } as Json,
});

describe('publishing a migration through the Authoring MCP server', () => {
  it('sends every file before the navigation names it, replaces a starter site in steps the drift guard accepts, and publishes once', async () => {
    const migrated = { name: 'Acme', template: 'atlas', colors: { light: { brand: '#0c6b56' } }, navigation: { tabs: [{ tab: 'Docs', groups: [{ group: 'Guides', pages: [{ title: 'Install', path: 'docs/install' }, { title: 'Use', path: 'docs/use' }, { title: 'Keys', path: 'docs/keys' }] }] }] } };
    const dir = output({ 'documentation.json': JSON.stringify(migrated), 'docs/install.mdx': page('Install'), 'docs/use.mdx': page('Use'), 'docs/keys.mdx': page('Keys'), 'styles/migration.css': '.dai-mig-badge{}' });
    const platform = project(starter());
    const result = await publishThroughMcp({ client: platform, outputDir: dir, branch: 'migration/mig-1', commitMessage: 'Migrate Acme docs' });

    expect(result).toMatchObject({ status: 'published', created: 4, rewritten: 0, commitSha: 'feedc0de' });
    const version = platform.branches.get('migration/mig-1')!;
    // the project ends on exactly the migrated settings and navigation, the temporary group gone
    expect(version.config).toEqual(migrated);
    expect(JSON.stringify(version.config)).not.toContain('being replaced');
    // six previous paths against three new ones cannot go in one write: the guard would have refused it, and nothing was refused
    expect(result.configWrites).toBeGreaterThan(2);
    const order = platform.calls.map((entry) => entry.tool);
    expect(order.lastIndexOf('create_page')).toBeLessThan(order.indexOf('update_site_config'));
    expect(order.filter((tool) => tool === 'publish')).toHaveLength(1);
    expect(order.at(-1)).toBe('publish');
    // the project's previous pages are out of the navigation, so not served, and still there: deleting is the owner's call
    expect(result.replacedPages).toHaveLength(6);
    expect(result.removedPages).toEqual([]);
    expect(version.files.has('welcome.mdx')).toBe(true);
  });

  it('continues a run that stopped half-way instead of sending everything again, and deletes previous pages only when asked', async () => {
    const migrated = { name: 'Acme', navigation: { groups: [{ group: 'Guides', pages: Array.from({ length: 30 }, (_, index) => ({ title: `Page ${index}`, path: `docs/p${index}` })) }] } };
    const dir = output({ 'documentation.json': JSON.stringify(migrated), ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`docs/p${index}.mdx`, page(`Page ${index}`)])) });
    const platform = project(starter());
    let saved: PublishProgress | undefined;
    const first = await publishThroughMcp({ client: platform, outputDir: dir, branch: 'migration/mig-2', commitMessage: 'm', saveProgress: (progress) => { saved = JSON.parse(JSON.stringify(progress)) as PublishProgress; } });
    expect(first.created).toBe(30);
    // thirty new paths against six previous ones: the union, then the migrated navigation
    expect(first.configWrites).toBe(2);
    const sentBefore = platform.calls.filter((entry) => entry.tool === 'create_page' || entry.tool === 'rewrite_page').length;
    const again = await publishThroughMcp({ client: platform, outputDir: dir, branch: 'migration/mig-2', commitMessage: 'm', progress: saved, removeOldPages: true });
    expect(again).toMatchObject({ created: 0, rewritten: 0, alreadySent: 30 });
    expect(platform.calls.filter((entry) => entry.tool === 'create_page' || entry.tool === 'rewrite_page')).toHaveLength(sentBefore);
    expect(again.removedPages).toHaveLength(6);
    expect(platform.branches.get('migration/mig-2')!.files.has('welcome.mdx')).toBe(false);
  });

  it('refuses output that holds a file which is not text: media is hosted, never published as a file', async () => {
    const dir = output({ 'documentation.json': '{"navigation":{"pages":[]}}', 'images/logo.png': 'not really a png' });
    await expect(publishThroughMcp({ client: project(starter()), outputDir: dir, branch: 'b', commitMessage: 'm' })).rejects.toThrow(/not text/);
  });
});

describe('getting from the previous navigation to the migrated one', () => {
  it('never drops more than a quarter of the paths in one write, and ends on the migrated navigation', () => {
    for (const [previousCount, migratedCount] of [[6, 3], [12, 4], [40, 5], [6, 30], [3, 50], [200, 1]]) {
      const previous = { groups: [{ group: 'Old', pages: Array.from({ length: previousCount }, (_, index) => `old/${index}`) }] };
      const migrated = { tabs: [{ tab: 'Docs', groups: [{ group: 'New', pages: Array.from({ length: migratedCount }, (_, index) => ({ title: `N${index}`, path: `new/${index}` })) }] }] };
      const steps = navigationSteps(previous, migrated);
      expect(steps.at(-1)).toEqual(migrated);
      let before = navigationPaths(previous);
      for (const step of steps) {
        const after = navigationPaths(step);
        const dropped = [...before].filter((path) => !after.has(path)).length;
        if (before.size >= 4) expect(dropped / before.size).toBeLessThanOrEqual(0.25);
        before = after;
      }
    }
    // a project whose navigation the migration mostly keeps is written in one go
    expect(navigationSteps({ pages: ['a', 'b', 'c', 'd'] }, { pages: ['a', 'b', 'c', 'e'] })).toHaveLength(1);
    expect(droppable(3)).toBe(3);
    expect(droppable(13)).toBe(3);
  });

  it('holds the previous pages in a group wherever the migrated structure allows one, past a link-only tab', () => {
    const migrated = { languages: [{ language: 'en', tabs: [{ tab: 'Blog', href: 'https://blog.example' }, { tab: 'Docs', groups: [{ group: 'G', pages: ['x'] }] }] }] };
    const held = withTemporaryGroup(migrated, ['old/a']) as { languages: Array<{ tabs: Array<{ groups?: Array<{ group: string; pages: unknown[] }> }> }> };
    expect(held.languages[0].tabs[1].groups!.at(-1)).toEqual({ group: 'Pages being replaced by the migration', pages: [{ title: 'old/a', path: 'old/a' }] });
    expect(migrated.languages[0].tabs[1].groups).toHaveLength(1);
  });
});

describe('the Authoring MCP client', () => {
  it('opens a session, sends it back on every call, and reads an answer sent as a server-sent event', async () => {
    const seen: Array<{ headers: Record<string, string>; body: Json }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Json; seen.push({ headers: init.headers as Record<string, string>, body });
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'DocumentationAI', version: '1.0.0' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Created docs/a.mdx' }], structuredContent: { path: 'docs/a.mdx' } } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const client = new McpClient({ token: 'dai_key', fetchImpl, requestsPerMinute: 60_000 });
    await client.connect();
    expect(client.serverInfo.name).toBe('DocumentationAI');
    const made = await client.call<{ path: string }>('create_page', { path: 'docs/a.mdx', content: 'x' });
    expect(made).toEqual({ structured: { path: 'docs/a.mdx' }, text: 'Created docs/a.mdx' });
    expect(seen[0].headers.authorization).toBe('Bearer dai_key');
    expect(seen[2].headers['mcp-session-id']).toBe('session-1');
  });

  it('reports a tool that failed in the server\'s own words, and never sends a credential over plain HTTP', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Json;
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? {} : { isError: true, content: [{ type: 'text', text: 'duplicate_path: docs/a is named twice' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new McpClient({ token: 'k', fetchImpl, requestsPerMinute: 60_000 });
    await client.connect();
    await expect(client.call('update_site_config', { patches: [] })).rejects.toThrow(/duplicate_path: docs\/a is named twice/);
    expect(() => new McpClient({ token: 'k', url: 'http://mcp.example.com/mcp' })).toThrow(/must be https/);
  });
});
