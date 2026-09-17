/**
 * A small client for Documentation.AI's Authoring MCP server (`https://api.documentation.ai/mcp`).
 *
 * The server speaks MCP over Streamable HTTP: JSON-RPC requests POSTed to one URL, a session id
 * returned by `initialize` and sent back on every later request, answers as JSON or as a single
 * server-sent event. It is authenticated with `Authorization: Bearer <token>`, where the token is
 * an OAuth access token or a project's Documentation.AI API key; with a key the session is already
 * bound to that key's project.
 *
 * It is driven from code, not from a model: publishing a migration is a thousand identical calls
 * whose content must arrive byte for byte, and a page that passed through a model's context is a
 * page nobody can certify. The agent decides that the migration is published; this sends it.
 */

export const DEFAULT_MCP_URL = 'https://api.documentation.ai/mcp';
const PROTOCOL_VERSION = '2025-06-18';

export class McpToolError extends Error {
  constructor(readonly tool: string, message: string, readonly structured?: unknown) { super(message); }
}

export interface McpClientOptions {
  url?: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Requests a minute this client allows itself; the server limits a key to its own rate, 120 by default. */
  requestsPerMinute?: number;
  sleep?: (ms: number) => Promise<void>;
  clientName?: string; clientVersion?: string;
}

interface RpcResponse { jsonrpc: '2.0'; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export interface ToolResult<T = Record<string, unknown>> { structured: T; text: string }

export class McpClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly spacingMs: number;
  private lastRequestAt = 0;
  serverInfo: { name?: string; version?: string } = {};

  constructor(private readonly options: McpClientOptions) {
    if (!options.token) throw new Error('an API key or access token is required to reach the Authoring MCP server');
    this.url = options.url ?? DEFAULT_MCP_URL;
    const parsed = new URL(this.url);
    // the token travels in a header: never over plain HTTP to anything but this machine
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new Error(`refusing to send a credential to ${this.url}: the MCP endpoint must be https`);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.spacingMs = Math.ceil(60_000 / Math.max(1, options.requestsPerMinute ?? 100));
  }

  private async post(body: unknown, expectAnswer: boolean): Promise<RpcResponse | undefined> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastRequestAt + this.spacingMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          authorization: `Bearer ${this.options.token}`,
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
      // the server's own limiter, or a deployment restarting: wait as told and send the same request again
      if ((response.status === 429 || response.status >= 502) && attempt < 6) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new Error(`the Authoring MCP server refused the credential (HTTP ${response.status}): check that DAI_API_KEY is this project's key and has not been revoked`);
      if (response.status === 404 && this.sessionId) throw new Error('the Authoring MCP session expired; run publish again, it continues where it stopped');
      if (!response.ok) throw new Error(`Authoring MCP server answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (!expectAnswer) return undefined;
      const text = await response.text();
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        // one request, one answer: the event whose data carries a result or an error for it
        for (const event of text.split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { const message = JSON.parse(data) as RpcResponse; if (message.result !== undefined || message.error) return message; } catch { /* a keep-alive or a partial event */ }
        }
        throw new Error('the Authoring MCP server closed the stream without an answer');
      }
      return JSON.parse(text) as RpcResponse;
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const answer = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, true);
    if (answer?.error) throw new Error(`${method}: ${answer.error.message}`);
    return answer?.result;
  }

  async connect(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: this.options.clientName ?? 'dai-migrate', version: this.options.clientVersion ?? '0' },
    }) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.serverInfo = result?.serverInfo ?? {};
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  }

  /** Calls one tool. A tool that reports failure (`isError`) throws with the server's own words, which name what to fix. */
  async call<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>): Promise<ToolResult<T>> {
    const result = await this.request('tools/call', { name: tool, arguments: args }) as { content?: Array<{ type: string; text?: string }>; structuredContent?: T; isError?: boolean } | undefined;
    const text = (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    if (result?.isError) throw new McpToolError(tool, text || `${tool} failed`, result.structuredContent);
    return { structured: (result?.structuredContent ?? {}) as T, text };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try { await this.fetchImpl(this.url, { method: 'DELETE', headers: { authorization: `Bearer ${this.options.token}`, 'mcp-session-id': this.sessionId }, signal: AbortSignal.timeout(10_000) }); } catch { /* the session expires by itself */ }
    this.sessionId = undefined;
  }
}
