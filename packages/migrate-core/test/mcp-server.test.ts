/**
 * `dai-migrate mcp` serves the migrator to hosts that have no shell of their own. It is a door onto
 * the CLI and nothing more, so what matters is what the door refuses: a workspace inside the plugin,
 * a command that is not a stage, a word smuggled in as a second workspace, a file that is not
 * review material. Everything a stage itself refuses is the CLI's to refuse, and is tested there.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMessage, RUNNABLE, TOOLS } from '../src/mcp-server.js';

const pluginRoot = fileURLToPath(new URL('../../../', import.meta.url));
const options = { pluginRoot, cliEntry: join(pluginRoot, 'packages/migrate-core/src/cli.ts'), version: 'test' };
const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const answer = await handleMessage(options, { id: 1, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: answer.result.content[0].text, isError: !!answer.result.isError };
};

describe('the migrator as a local MCP server', () => {
  it('introduces itself, lists its four tools, and answers nothing to a notification', async () => {
    const hello = await handleMessage(options, { id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string } };
    expect(hello.result).toMatchObject({ protocolVersion: '2025-03-26', serverInfo: { name: 'dai-migrate' } });
    expect(hello.result.instructions).toContain('migration_guide');
    expect(await handleMessage(options, { method: 'notifications/initialized' })).toBeUndefined();
    const listed = await handleMessage(options, { id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['migration_guide', 'migration_status', 'migration_run', 'migration_read']);
    expect(TOOLS.find((tool) => tool.name === 'migration_run')!.description).toContain('only after that person has reviewed');
    expect(RUNNABLE).not.toContain('mcp');
  });

  it('hands any host the same operating guide the skills hold', async () => {
    const guide = await call('migration_guide', {});
    expect(guide.text).toContain('call the migration_run tool');
    expect(guide.text).toMatch(/human gate/i);
    expect((await call('migration_guide', { topic: 'verify' })).isError).toBe(false);
    expect((await call('migration_guide', { topic: '../../etc/passwd' })).isError).toBe(true);
  });

  it('keeps customer content out of the plugin, and reads only what a person reviews', async () => {
    expect((await call('migration_status', { workspace: join(pluginRoot, 'somewhere') })).text).toContain('outside the plugin repository');
    expect((await call('migration_status', { workspace: 'relative/path' })).isError).toBe(true);
    const workspace = mkdtempSync(join(tmpdir(), 'dai-mcp-server-'));
    expect((await call('migration_status', { workspace })).text).toContain('No migration at');
    mkdirSync(join(workspace, 'plan')); mkdirSync(join(workspace, 'source-cache'));
    writeFileSync(join(workspace, 'plan', 'tree.yaml'), 'pages: []\n'); writeFileSync(join(workspace, 'source-cache', 'secret.json'), '{}');
    expect((await call('migration_read', { workspace })).text).toContain('plan/tree.yaml');
    expect((await call('migration_read', { workspace, file: 'plan/tree.yaml' })).text).toBe('pages: []\n');
    expect((await call('migration_read', { workspace, file: 'source-cache/secret.json' })).isError).toBe(true);
    expect((await call('migration_read', { workspace, file: '../outside.txt' })).isError).toBe(true);
  });

  it('runs a stage through the real CLI and returns what it said, refusing anything that is not a stage', async () => {
    const workspace = join(mkdtempSync(join(tmpdir(), 'dai-mcp-server-')), 'ws');
    expect((await call('migration_run', { command: 'rm', workspace })).text).toContain('command must be one of');
    expect((await call('migration_run', { command: 'verify', workspace, args: ['--workspace', '/elsewhere'] })).text).toContain('not in args');
    const ran = await call('migration_run', { command: 'init', workspace, args: [] });
    expect(ran.text).toContain('--source is required');
    expect(ran.text).toContain('exited with code 1');
  }, 60_000);
});
