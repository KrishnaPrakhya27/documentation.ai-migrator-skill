/**
 * Publishing through the Authoring MCP server needs no API key: whoever migrates into a project
 * already has a Documentation.AI account with access to it, so they sign in the way every MCP host
 * signs in - in the browser. These cases run the real flow (discovery, self-registration, PKCE,
 * the loopback callback, the token exchange) against a stand-in authorization server that checks
 * what a real one checks, and pin how the project is chosen when an account can reach several.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chooseProject, discoverAuthorization, signInWithBrowser, writableProjects, type AccessibleProject } from '../src/publish/mcp-oauth.js';
import { publishThroughMcp } from '../src/publish/publish.js';

const MCP = 'https://api.example.com/mcp';
const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An authorization server as the MCP specification describes one, holding the checks that matter. */
function authorizationServer(overrides: { registration?: boolean } = {}) {
  const seen = { registered: undefined as Record<string, unknown> | undefined, token: undefined as URLSearchParams | undefined };
  let challenge = '';
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.example.com/.well-known/oauth-protected-resource/mcp') return reply({ resource: MCP, authorization_servers: ['https://login.example.com'], scopes_supported: ['profile', 'email'] });
    if (url === 'https://login.example.com/.well-known/oauth-authorization-server') return reply({ issuer: 'https://login.example.com', authorization_endpoint: 'https://login.example.com/oauth/authorize', token_endpoint: 'https://login.example.com/oauth/token', ...(overrides.registration === false ? {} : { registration_endpoint: 'https://login.example.com/oauth/register' }), code_challenge_methods_supported: ['S256'] });
    if (url === 'https://login.example.com/oauth/register') { seen.registered = JSON.parse(init!.body as string) as Record<string, unknown>; return reply({ client_id: 'client-123' }, 201); }
    if (url === 'https://login.example.com/oauth/token') {
      const form = new URLSearchParams(init!.body as string); seen.token = form;
      // PKCE: the verifier sent now must hash to the challenge sent when the sign-in started
      const proves = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === challenge;
      return form.get('code') === 'the-code' && proves ? reply({ access_token: 'token-abc', token_type: 'Bearer', expires_in: 3600 }) : reply({ error: 'invalid_grant' }, 400);
    }
    return reply({}, 404);
  }) as unknown as typeof fetch;
  /** The person's browser: reads the sign-in address, "signs in", and is sent back to the loopback address. */
  const browser = (behaviour: 'approve' | 'wrong-state-then-approve' | 'deny') => async (address: string): Promise<void> => {
    const url = new URL(address); challenge = url.searchParams.get('code_challenge') ?? '';
    const back = (query: string): Promise<globalThis.Response> => fetch(`${url.searchParams.get('redirect_uri')}?${query}`);
    const state = url.searchParams.get('state');
    if (behaviour === 'wrong-state-then-approve') expect((await back('code=stolen&state=someone-elses')).status).toBe(400);
    void back(behaviour === 'deny' ? `error=access_denied&error_description=The+user+said+no&state=${state}` : `code=the-code&state=${state}`);
  };
  return { fetchImpl, browser, seen, authorizeUrl: () => challenge };
}

describe('signing in to the Authoring MCP server from the command line', () => {
  it('finds where to sign in from the documents the server publishes, and refuses one that is not https', async () => {
    const { fetchImpl } = authorizationServer();
    expect(await discoverAuthorization(MCP, fetchImpl)).toEqual({ resource: MCP, issuer: 'https://login.example.com', authorizationEndpoint: 'https://login.example.com/oauth/authorize', tokenEndpoint: 'https://login.example.com/oauth/token', registrationEndpoint: 'https://login.example.com/oauth/register', scopes: ['profile', 'email'] });
    await expect(discoverAuthorization('http://api.example.com/mcp', fetchImpl)).rejects.toThrow(/not https/);
    const silent = (async () => reply({}, 404)) as unknown as typeof fetch;
    await expect(discoverAuthorization(MCP, silent)).rejects.toThrow(/does not say where to sign in.*DAI_API_KEY/);
  });

  it('registers itself, proves the exchange with PKCE, and takes the code only from the sign-in it started', async () => {
    const server = authorizationServer();
    const lines: string[] = [];
    const signedIn = await signInWithBrowser({ mcpUrl: MCP, fetchImpl: server.fetchImpl, openBrowser: server.browser('wrong-state-then-approve'), log: (line) => lines.push(line) });
    expect(signedIn).toEqual({ accessToken: 'token-abc', expiresInSeconds: 3600 });
    // a public client on a loopback address, asking for the MCP server by name
    expect(server.seen.registered).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'profile email' });
    expect((server.seen.registered!.redirect_uris as string[])[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(server.seen.token!.get('resource')).toBe(MCP);
    expect(server.seen.token!.get('client_id')).toBe('client-123');
    // the address is printed as well as opened, for a browser that did not start
    expect(lines.join('\n')).toContain('https://login.example.com/oauth/authorize?');
    // nothing about the token is ever logged
    expect(lines.join('\n')).not.toContain('token-abc');
  });

  it('says what happened when the person declines, and what to do when the server offers no self-registration', async () => {
    const declined = authorizationServer();
    await expect(signInWithBrowser({ mcpUrl: MCP, fetchImpl: declined.fetchImpl, openBrowser: declined.browser('deny') })).rejects.toThrow(/sign-in was refused: The user said no/);
    const closed = authorizationServer({ registration: false });
    await expect(signInWithBrowser({ mcpUrl: MCP, fetchImpl: closed.fetchImpl, openBrowser: closed.browser('approve') })).rejects.toThrow(/cannot sign in.*DAI_API_KEY/);
  });
});

describe('which project a signed-in person publishes into', () => {
  const listing = { projects: [
    { organizationId: 'org-1', organizationName: 'Acme', role: 'admin', documentation: [{ documentationId: 'doc-1', name: 'Acme Docs' }, { documentationId: 'doc-2', name: 'Acme API' }] },
    { organizationId: 'org-2', organizationName: 'Partner', role: 'viewer', documentation: [{ documentationId: 'doc-3', name: 'Partner Docs' }] },
  ] };
  const projects = writableProjects(listing);

  it('offers only projects the account can change', () => {
    expect(projects.map((project: AccessibleProject) => project.name)).toEqual(['Acme Docs', 'Acme API']);
  });

  it('takes the one named, then the one this migration went into before, then the only one there is', () => {
    expect(chooseProject(projects, 'acme api').documentationId).toBe('doc-2');
    expect(chooseProject(projects, 'doc-1').name).toBe('Acme Docs');
    expect(chooseProject(projects, undefined, 'doc-2').name).toBe('Acme API');
    expect(chooseProject(projects.slice(0, 1)).documentationId).toBe('doc-1');
  });

  it('refuses to guess between several, naming them, and says so when there is nothing to publish into', () => {
    expect(() => chooseProject(projects)).toThrow(/can edit 2 projects.*--project.*"Acme Docs" in Acme \(doc-1\).*"Acme API" in Acme \(doc-2\)/);
    expect(() => chooseProject(projects, 'Partner Docs')).toThrow(/no project named "Partner Docs" that this account can edit/);
    expect(() => chooseProject([])).toThrow(/can edit no Documentation.AI project/);
  });

  it('names the project on every call, so a selection made in another conversation cannot redirect the publish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dai-mcp-project-'));
    for (const [path, content] of Object.entries({ 'documentation.json': JSON.stringify({ name: 'Acme', navigation: { pages: [{ title: 'A', path: 'a' }] } }), 'a.mdx': '---\ntitle: A\n---\n\nA.\n' })) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = { call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      const structured = tool === 'list_pages' ? { pages: [] } : tool === 'get_site_config' ? { config: { navigation: { pages: [] } } } : tool === 'publish' ? { status: 'published', commitSha: 'abc' } : {};
      return { structured, text: '' } as never;
    } };
    await publishThroughMcp({ client, outputDir: dir, branch: 'migration/mig-9', commitMessage: 'm', project: { organizationId: 'org-1', documentationId: 'doc-2' } });
    expect(calls.length).toBeGreaterThan(4);
    for (const entry of calls) expect(entry.args, entry.tool).toMatchObject({ organizationId: 'org-1', documentationId: 'doc-2' });
  });
});
