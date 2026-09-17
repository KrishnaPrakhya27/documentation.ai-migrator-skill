/**
 * Signing in to Documentation.AI's Authoring MCP server the way every MCP host does: in the browser.
 *
 * Whoever migrates into a Documentation.AI project already has an account with access to it, so
 * asking them to go and mint an API key first is a detour. The server publishes the standard
 * discovery documents (RFC 9728 for the resource, RFC 8414 for the authorization server) and lets
 * a client register itself (RFC 7591), which is how Claude, Cursor and the rest connect. This does
 * the same from the command line: register as a public client, open the sign-in page, receive the
 * authorization code on a loopback address (RFC 8252), and exchange it with PKCE (RFC 7636).
 *
 * The token lives in this process's memory and nowhere else: it is never written to the workspace,
 * a file, a log or a report, so there is nothing to leak and nothing to clean up. Signing in again
 * on the next run is one click, because the browser remembers the account.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface AuthorizationDiscovery {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes: string[];
}

export interface SignInOptions {
  mcpUrl: string;
  fetchImpl?: typeof fetch;
  /** Opens the sign-in page. Defaults to the operating system's browser; the address is always printed as well. */
  openBrowser?: (url: string) => void | Promise<void>;
  log?: (message: string) => void;
  /** How long to wait for the person to finish signing in. */
  timeoutMs?: number;
  clientName?: string;
}

export interface SignedIn { accessToken: string; expiresInSeconds?: number }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A sign-in endpoint is https, or this machine: a credential never travels in the clear. */
function secureUrl(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`the server's sign-in discovery names no ${what}`);
  const url = new URL(value);
  if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) throw new Error(`refusing a ${what} that is not https: ${value}`);
  return url.toString();
}

async function json(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return undefined;
    const body = await response.json() as unknown;
    return body && typeof body === 'object' ? body as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Where to sign in for this MCP server, from the documents the server itself publishes. */
export async function discoverAuthorization(mcpUrl: string, fetchImpl: typeof fetch = fetch): Promise<AuthorizationDiscovery> {
  const mcp = new URL(secureUrl(mcpUrl, 'MCP endpoint'));
  const path = mcp.pathname.replace(/\/+$/, '');
  // RFC 9728: the path-suffixed document first, then the root one
  const resource = await json(fetchImpl, `${mcp.origin}/.well-known/oauth-protected-resource${path}`) ?? await json(fetchImpl, `${mcp.origin}/.well-known/oauth-protected-resource`);
  const issuers = Array.isArray(resource?.authorization_servers) ? resource!.authorization_servers.filter((entry): entry is string => typeof entry === 'string') : [];
  if (!issuers.length) throw new Error(`${mcp.origin} does not say where to sign in (no OAuth protected-resource document). Set DAI_API_KEY to publish with the project's API key instead`);
  const issuer = secureUrl(issuers[0], 'authorization server').replace(/\/+$/, '');
  const metadata = await json(fetchImpl, `${issuer}/.well-known/oauth-authorization-server`) ?? await json(fetchImpl, `${issuer}/.well-known/openid-configuration`) ?? await json(fetchImpl, `${mcp.origin}/.well-known/oauth-authorization-server`);
  if (!metadata) throw new Error(`the authorization server ${issuer} publishes no metadata, so sign-in cannot start. Set DAI_API_KEY to publish with the project's API key instead`);
  const methods = Array.isArray(metadata.code_challenge_methods_supported) ? metadata.code_challenge_methods_supported : ['S256'];
  if (!methods.includes('S256')) throw new Error('the authorization server does not support PKCE with S256, which a command-line sign-in requires');
  const challenged = Array.isArray(resource?.scopes_supported) ? resource!.scopes_supported.filter((scope): scope is string => typeof scope === 'string') : [];
  return {
    resource: typeof resource?.resource === 'string' ? resource.resource : mcp.toString(),
    issuer,
    authorizationEndpoint: secureUrl(metadata.authorization_endpoint, 'authorization endpoint'),
    tokenEndpoint: secureUrl(metadata.token_endpoint, 'token endpoint'),
    ...(typeof metadata.registration_endpoint === 'string' ? { registrationEndpoint: secureUrl(metadata.registration_endpoint, 'registration endpoint') } : {}),
    scopes: challenged,
  };
}

/** The operating system's browser, started detached; failing to start one is not an error, because the address is printed too. */
export function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] as const
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] as const
      : ['xdg-open', [url]] as const;
  try { const child = spawn(command, [...args], { stdio: 'ignore', detached: true }); child.on('error', () => undefined); child.unref(); } catch { /* the address was printed */ }
}

const base64url = (bytes: Buffer): string => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const PAGE = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1a1a1a"><h1 style="font-size:1.35rem">${title}</h1><p>${body}</p>`;

/** Signs the person in through their browser and returns an access token for the MCP server. */
export async function signInWithBrowser(options: SignInOptions): Promise<SignedIn> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const discovery = await discoverAuthorization(options.mcpUrl, fetchImpl);
  if (!discovery.registrationEndpoint) throw new Error('the authorization server does not let a client register itself, so the command line cannot sign in. Set DAI_API_KEY to publish with the project\'s API key instead');

  // The loopback listener first: its port is part of the redirect address the client registers.
  const state = base64url(randomBytes(24));
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const arrived = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
    const finish = (status: number, title: string, body: string): void => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, body)); };
    if (url.searchParams.get('state') !== state) { finish(400, 'This sign-in did not start here', 'Close this tab and run the command again.'); return; }
    const error = url.searchParams.get('error');
    if (error) { finish(400, 'Sign-in was not completed', 'You can close this tab. The command line says what happened.'); settle?.reject(new Error(`sign-in was refused: ${url.searchParams.get('error_description') ?? error}`)); return; }
    const code = url.searchParams.get('code');
    if (!code) { finish(400, 'Sign-in was not completed', 'No authorization code arrived. Close this tab and run the command again.'); return; }
    finish(200, 'Signed in to Documentation.AI', 'You can close this tab and go back to the terminal. The migration is being published.');
    settle?.resolve(code);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;

  try {
    const scope = (discovery.scopes.length ? discovery.scopes : ['profile', 'email']).join(' ');
    const registered = await fetchImpl(discovery.registrationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ client_name: options.clientName ?? 'Documentation.AI migrator (dai-migrate)', redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope }),
    });
    if (!registered.ok) throw new Error(`the authorization server refused to register this command line (HTTP ${registered.status}): ${(await registered.text()).slice(0, 200)}`);
    const client = await registered.json() as { client_id?: string; client_secret?: string };
    if (!client.client_id) throw new Error('the authorization server registered this command line without returning a client id');

    const verifier = base64url(randomBytes(48));
    const authorize = new URL(discovery.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, scope, state, code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: discovery.resource })) authorize.searchParams.set(key, value);
    log('sign in to Documentation.AI in your browser to continue. If it did not open, visit:');
    log(`  ${authorize.toString()}`);
    await (options.openBrowser ?? openInBrowser)(authorize.toString());

    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([arrived, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`nobody signed in within ${Math.round(timeoutMs / 60_000)} minutes. Run the command again, or set DAI_API_KEY to publish with the project's API key`)), timeoutMs); })]).finally(() => clearTimeout(timer));

    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: discovery.resource });
    if (client.client_secret) form.set('client_secret', client.client_secret);
    const exchanged = await fetchImpl(discovery.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), signal: AbortSignal.timeout(30_000) });
    if (!exchanged.ok) throw new Error(`the authorization server did not issue a token (HTTP ${exchanged.status})`);
    const tokens = await exchanged.json() as { access_token?: string; expires_in?: number };
    if (!tokens.access_token) throw new Error('the authorization server answered without an access token');
    return { accessToken: tokens.access_token, ...(typeof tokens.expires_in === 'number' ? { expiresInSeconds: tokens.expires_in } : {}) };
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

export interface AccessibleProject { organizationId: string; organizationName: string; role: string; documentationId: string; name: string }

/** The projects a signed-in person may publish into, flattened from the server's `list_projects`. */
export function writableProjects(listing: { projects?: Array<{ organizationId: string; organizationName: string; role: string; documentation?: Array<{ documentationId: string; name: string }> }> }): AccessibleProject[] {
  return (listing.projects ?? []).filter((organization) => organization.role === 'admin' || organization.role === 'editor')
    .flatMap((organization) => (organization.documentation ?? []).map((project) => ({ organizationId: organization.organizationId, organizationName: organization.organizationName, role: organization.role, documentationId: project.documentationId, name: project.name })));
}

/**
 * Which project this migration goes into. Named by the person (`--project`), remembered from the
 * last publish of this migration, or the only one there is. With several and none named, this
 * refuses and lists them: a migration published into the wrong project is not a guess to make.
 */
export function chooseProject(projects: readonly AccessibleProject[], wanted?: string, remembered?: string): AccessibleProject {
  const describe = (project: AccessibleProject): string => `"${project.name}" in ${project.organizationName} (${project.documentationId})`;
  if (!projects.length) throw new Error('this account can edit no Documentation.AI project. Ask an admin of the organisation for the editor role, or sign in with another account');
  if (wanted) {
    const needle = wanted.trim().toLowerCase();
    const matches = projects.filter((project) => project.documentationId.toLowerCase() === needle || project.name.toLowerCase() === needle);
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error(`no project named ${JSON.stringify(wanted)} that this account can edit. There ${projects.length === 1 ? 'is' : 'are'}: ${projects.map(describe).join('; ')}`);
    throw new Error(`${matches.length} projects are named ${JSON.stringify(wanted)}; pass --project with the id of one: ${matches.map(describe).join('; ')}`);
  }
  const before = remembered ? projects.find((project) => project.documentationId === remembered) : undefined;
  if (before) return before;
  if (projects.length === 1) return projects[0];
  throw new Error(`this account can edit ${projects.length} projects; say which one this migration goes into with --project "<name or id>": ${projects.map(describe).join('; ')}`);
}
