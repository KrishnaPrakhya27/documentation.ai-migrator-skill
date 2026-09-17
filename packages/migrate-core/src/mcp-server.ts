/**
 * `dai-migrate mcp`: the migrator as a local MCP server, for any host that speaks the protocol.
 *
 * The skills in this repository drive the CLI from an agent that has a shell (Claude Code, Codex).
 * A desktop chat host has no shell of its own, but it can start a local MCP server and call its
 * tools: Claude Desktop, Cursor, VS Code, Windsurf, the Codex and Gemini command lines. This is
 * that server. It exposes the same CLI and nothing else: one tool runs a stage, one reads the
 * workspace's plans and reports for review, one says where a migration stands, and one returns the
 * operating guide the skills hold, so a host that has never seen this repository follows the same
 * procedure, the same four human gates included.
 *
 * It is a thin door onto the CLI on purpose. Every rule the migration keeps - refuse rather than
 * guess, nothing pushed unapproved, no crawl without the customer's authorisation - lives in the
 * CLI, so it holds whichever host is asking.
 *
 * Transport: MCP over stdio, one JSON-RPC message per line. Nothing but protocol messages is ever
 * written to stdout.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** Stages and review commands a host may run. `mcp` itself is not among them. */
export const RUNNABLE = ['init', 'fingerprint', 'discover', 'approve', 'acquire', 'inventory', 'plan', 'assets', 'convert', 'nav', 'verify', 'write', 'publish', 'accept', 'release', 'report', 'rebase'] as const;
/** Folders of a workspace a host may read for review. The sealed source, the snapshot and the repository clone are not review material. */
const READABLE = ['plan', 'report', 'quarantine'];
const MAX_OUTPUT = 24_000;
const MAX_FILE = 120_000;

export interface McpServerOptions { pluginRoot: string; cliEntry: string; version: string }

interface ToolDefinition { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }

export const TOOLS: ToolDefinition[] = [
  {
    name: 'migration_guide', title: 'Migration guide',
    description: 'Returns the operating guide for migrating a documentation site onto Documentation.AI: the stages in order, the four human gates, the three ways to deliver (git, clone, MCP) and the rules that are never broken. Read it before running anything. Pass a topic to read one of the detailed guides instead.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Omit for the main guide. Otherwise a skill name, e.g. "verify", "report", "migrate-mintlify", "migrate-gitbook", "migrate-readme", "migrate-document360", "migrate-generic".' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'migration_status', title: 'Migration status',
    description: 'Says where a migration stands: which stages are done, which human gates are approved, the preview URL if there is one, the checks that are failing, and the next step.',
    inputSchema: { type: 'object', required: ['workspace'], properties: { workspace: { type: 'string', description: 'Absolute path of the migration workspace (outside the plugin).' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'migration_run', title: 'Run a migration stage',
    description: 'Runs one dai-migrate command in a workspace and returns what it printed. Stages stop and name what to fix rather than guess; never work around a stopped stage. `approve` and `accept` record a decision a named person made: call them only after that person has reviewed what the gate asks for and said yes, with their name in --by. `publish` opens the person\'s browser so they can sign in to Documentation.AI; tell them to look for it before you call it.',
    inputSchema: {
      type: 'object', required: ['command', 'workspace'],
      properties: {
        command: { type: 'string', enum: [...RUNNABLE] },
        workspace: { type: 'string', description: 'Absolute path of the migration workspace. Must be outside the plugin repository.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Further flags, one array item per word, e.g. ["--source", "https://docs.acme.com", "--clone", "/home/me/acme-docs"]. Run migration_guide for what each stage takes.' },
      },
    },
  },
  {
    name: 'migration_read', title: 'Read a plan or report',
    description: 'Reads a file from the workspace for review: the plans a person approves (plan/tree.yaml, plan/urls.yaml, plan/component-plan.yaml, plan/site.yaml), the findings (report/review-queue.md, report/gates.json, report/preview-routes.json) or the customer report. Omit `file` to list what there is.',
    inputSchema: { type: 'object', required: ['workspace'], properties: { workspace: { type: 'string' }, file: { type: 'string', description: 'Path inside the workspace, under plan/, report/ or quarantine/.' }, offset: { type: 'integer', minimum: 0, description: 'Character to start from, for a file longer than one answer.' } } },
    annotations: { readOnlyHint: true },
  },
];

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function workspaceOf(value: unknown, pluginRoot: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('workspace must be an absolute path');
  const workspace = resolve(value);
  if (inside(pluginRoot, workspace)) throw new Error('the workspace must be outside the plugin repository: customer content never lives beside the migrator');
  return workspace;
}

function guide(options: McpServerOptions, topic: unknown): string {
  const skills = join(options.pluginRoot, 'skills');
  const name = typeof topic === 'string' && topic.trim() ? topic.trim() : 'migrate';
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('topic must be a skill name such as "verify" or "migrate-gitbook"');
  const file = join(skills, name, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`no guide named ${name}; there are: ${readdirSync(skills).filter((entry) => existsSync(join(skills, entry, 'SKILL.md'))).join(', ')}`);
  const preface = name === 'migrate' ? 'You are driving dai-migrate through this MCP server: where the guide says to run `npx dai-migrate <command> …`, call the migration_run tool with that command and its flags; where it says to read a file, call migration_read.\n\n' : '';
  return preface + readFileSync(file, 'utf8');
}

function status(workspace: string): string {
  const sessionFile = join(workspace, 'session.json');
  if (!existsSync(sessionFile)) return `No migration at ${workspace} yet. Start one with migration_run: command "init", args ["--source", "<site URL or folder>", "--clone", "<your clone of the Documentation.AI repository>"] (see migration_guide).`;
  const session = JSON.parse(readFileSync(sessionFile, 'utf8')) as { migrationId?: string; source?: { location?: string; platform?: string }; fidelityMode?: string; target?: { previewUrl?: string; repoRemote?: string; cloneDir?: string }; stages?: Record<string, { status?: string; note?: string }>; approvals?: Record<string, { by?: string; at?: string }> };
  const lines = [`Migration ${session.migrationId ?? ''} of ${session.source?.location ?? 'unknown source'} (${session.source?.platform ?? 'platform not fingerprinted'}, ${session.fidelityMode ?? 'exact'})`];
  lines.push(`Delivers to: ${session.target?.cloneDir ? `your clone at ${session.target.cloneDir}` : session.target?.repoRemote ?? 'not set (publish through MCP, or pass --clone/--remote at init)'}`);
  for (const [stage, state] of Object.entries(session.stages ?? {})) lines.push(`  ${state.status === 'done' ? '✔' : state.status === 'failed' ? '✖' : '·'} ${stage}${state.note ? `: ${state.note}` : ''}`);
  for (const gate of ['1', '2', '3', '4']) { const approval = session.approvals?.[gate]; lines.push(`  human gate ${gate}: ${approval?.by ? `approved by ${approval.by}` : 'not approved'}`); }
  if (session.target?.previewUrl) lines.push(`Preview: ${session.target.previewUrl}`);
  const gatesFile = join(workspace, 'report', 'gates.json');
  if (existsSync(gatesFile)) {
    const gates = (JSON.parse(readFileSync(gatesFile, 'utf8')) as { gates?: Array<{ id: string; status: string; detail: string }> }).gates ?? [];
    const failing = gates.filter((gate) => gate.status === 'fail');
    lines.push(failing.length ? `Checks failing (${failing.length} of ${gates.length}):` : `All ${gates.length} checks that ran are passing.`);
    for (const gate of failing.slice(0, 12)) lines.push(`  ✖ ${gate.id}: ${gate.detail.slice(0, 240)}`);
  }
  return lines.join('\n');
}

function readForReview(workspace: string, file: unknown, offset: unknown): string {
  if (file === undefined || file === '') {
    const listing: string[] = [];
    for (const folder of READABLE) {
      const dir = join(workspace, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) { const path = join(dir, name); if (statSync(path).isFile()) listing.push(`${folder}/${name} (${statSync(path).size} bytes)`); }
    }
    return listing.length ? listing.join('\n') : 'nothing to review yet: run discover first';
  }
  if (typeof file !== 'string') throw new Error('file must be a path inside the workspace');
  const path = resolve(workspace, file);
  if (!READABLE.some((folder) => inside(join(workspace, folder), path))) throw new Error(`only files under ${READABLE.join('/, ')}/ can be read for review`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${file} does not exist in this workspace`);
  if (/\.(?:pdf|png|jpe?g|gif|webp|zip)$/i.test(path)) throw new Error(`${file} is not text; open it from ${path.split(sep).join('/')}`);
  const text = readFileSync(path, 'utf8');
  const start = typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0;
  const slice = text.slice(start, start + MAX_FILE);
  return start + slice.length < text.length ? `${slice}\n\n[… ${text.length - start - slice.length} more characters: call again with offset ${start + slice.length}]` : slice;
}

function run(options: McpServerOptions, command: unknown, workspace: string, args: unknown): Promise<string> {
  if (typeof command !== 'string' || !(RUNNABLE as readonly string[]).includes(command)) throw new Error(`command must be one of: ${RUNNABLE.join(', ')}`);
  const flags = Array.isArray(args) ? args : [];
  if (flags.some((flag) => typeof flag !== 'string')) throw new Error('args must be an array of strings, one per word');
  if ((flags as string[]).some((flag) => flag === '--workspace' || flag.startsWith('--workspace='))) throw new Error('pass the workspace as the workspace argument, not in args');
  return new Promise((done) => {
    // no shell: the words go to the CLI exactly as given, so nothing in them can be read as a command
    const child = spawn(process.execPath, ['--import', 'tsx', options.cliEntry, command, ...(flags as string[]), '--workspace', workspace], { cwd: options.pluginRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer): void => { output += chunk.toString('utf8'); if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (error) => done(`could not start dai-migrate: ${error.message}`));
    child.on('close', (code) => {
      const shown = output.length > MAX_OUTPUT ? `[… earlier output left out]\n${output.slice(-MAX_OUTPUT)}` : output;
      done(`${shown.trim()}\n\n[dai-migrate ${command} exited with code ${code ?? 'unknown'}${code === 2 ? ': findings were recorded; read report/review-queue.md' : code ? ': the stage stopped; fix what it names and run it again' : ''}]`);
    });
  });
}

export async function handleMessage(options: McpServerOptions, message: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const failure = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
  if (message.id === undefined) return undefined; // a notification: nothing to answer
  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'dai-migrate', title: 'Documentation.AI migrator', version: options.version },
        instructions: 'Migrates a documentation site onto Documentation.AI exactly. Call migration_guide first and follow it: stages run in order through migration_run, and four human gates are decisions a named person makes, never the assistant.',
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'prompts/list': return reply({ prompts: [{ name: 'migrate-docs', title: 'Migrate a documentation site', description: 'Start a migration onto Documentation.AI', arguments: [{ name: 'source', description: 'The site URL, export or repository to migrate', required: true }] }] });
    case 'prompts/get': {
      if (message.params?.name !== 'migrate-docs') return failure(-32602, 'unknown prompt');
      const source = (message.params?.arguments as { source?: string } | undefined)?.source ?? '<source>';
      return reply({ messages: [{ role: 'user', content: { type: 'text', text: `Migrate ${source} onto Documentation.AI. First call migration_guide and follow it exactly.` } }] });
    }
    case 'tools/call': {
      const name = message.params?.name; const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        let text: string;
        if (name === 'migration_guide') text = guide(options, args.topic);
        else if (name === 'migration_status') text = status(workspaceOf(args.workspace, options.pluginRoot));
        else if (name === 'migration_read') text = readForReview(workspaceOf(args.workspace, options.pluginRoot), args.file, args.offset);
        else if (name === 'migration_run') text = await run(options, args.command, workspaceOf(args.workspace, options.pluginRoot), args.args);
        else return failure(-32602, `unknown tool ${String(name)}`);
        return reply({ content: [{ type: 'text', text }] });
      } catch (error) {
        return reply({ content: [{ type: 'text', text: (error as Error).message }], isError: true });
      }
    }
    default: return failure(-32601, `method not found: ${String(message.method)}`);
  }
}

/** Serves MCP on stdin/stdout until the host closes the stream. */
export function serveStdio(options: McpServerOptions): Promise<void> {
  return new Promise((closed) => {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let pending = Promise.resolve();
    lines.on('line', (line) => {
      if (!line.trim()) return;
      // answered in the order asked, one stage at a time: two stages in one workspace would contend for its lock
      pending = pending.then(async () => {
        let answer: Record<string, unknown> | undefined;
        try { answer = await handleMessage(options, JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> }); }
        catch { answer = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }; }
        if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
      });
    });
    lines.on('close', () => { void pending.then(() => closed()); });
  });
}
