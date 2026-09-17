/**
 * The clone flow: someone migrating their own documentation has cloned the repository
 * Documentation.AI created for their project, and migrates into that clone.
 *
 * Nothing about it needs a Documentation.AI API key: their own git credentials push the branch, and
 * the platform builds a preview of a pushed branch by itself. Nor does it need the team's
 * vocabulary - a landing option, a list of allowed organisations - because they have named the one
 * repository they mean by cloning it. This drives the real CLI with every DAI_ and MIGRATION_
 * variable removed, against a local stand-in for the git host.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = (): string => mkdtempSync(join(tmpdir(), 'dai-clone-flow-'));
const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string => execFileSync('git', args, { cwd, env: env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('the MCP flow chooses its project before pictures are hosted', () => {
  it('refuses to file pictures under whichever project the environment names, and says what to run first', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const root = temp(); const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'SUMMARY.md'), '# Table of contents\n\n* [Welcome](README.md)\n');
    writeFileSync(join(source, 'README.md'), '# Welcome\n\nStart here.\n');
    const workspace = join(root, 'ws');
    // storage fully configured, as on the team's machines, with another project's id left in the environment
    const storageEnv = { CLOUDFLARE_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_IMAGES_BUCKET_NAME: 'images', MEDIA_IMAGE_CDN_BASE: 'https://img.example', DAI_ORGANIZATION_ID: 'org-from-env', DAI_DOCUMENTATION_ID: 'doc-from-env' };
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_|R2_|AWS_|CLOUDFLARE_|MEDIA_)/.test(key))), ...storageEnv, MIGRATION_WORKSPACE: workspace };
    const cli = (...args: string[]): string => {
      try { return execFileSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { const failed = error as { stdout?: string; stderr?: string }; throw new Error(`${failed.stdout ?? ''}${failed.stderr ?? ''}`); }
    };
    // no --clone and no --remote: this migration will be published through the MCP server
    cli('init', '--source', source, '--platform', 'gitbook');
    for (const [stage, ...rest] of [['discover'], ['approve', '--gate', '1', '--by', 'owner'], ['acquire'], ['inventory'], ['plan'], ['approve', '--gate', '2', '--by', 'owner']]) cli(stage, ...rest);
    expect(() => cli('assets', '--provider', 's3')).toThrow(/project this migration goes into is not chosen yet[\s\S]*dai-migrate project --workspace/);
  }, 240_000);
});

describe('migrating into your own clone, with no API key', () => {
  it('takes the remote from the clone, scopes the write to its organisation, builds the branch there and says where the preview URL comes from', () => {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const root = temp();
    const hosted = 'https://github.com/acme-docs/handbook.git';
    // a bare repository stands in for the git host; one global rule maps the hosted URL onto it for every git the CLI starts
    const bare = join(root, 'host.git'); const seed = join(root, 'seed'); const clone = join(root, 'handbook');
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, `[url "file://${bare}"]\n\tinsteadOf = ${hosted}\n[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n`);
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
    git(root, ['init', '--quiet', '--bare', bare], gitEnv);
    git(root, ['clone', '--quiet', bare, seed], gitEnv);
    writeFileSync(join(seed, 'documentation.json'), '{"name":"Handbook","navigation":{"pages":[]}}\n');
    git(seed, ['add', '-A'], gitEnv); git(seed, ['commit', '--quiet', '-m', 'quickstart'], gitEnv); git(seed, ['branch', '-M', 'main'], gitEnv); git(seed, ['push', '--quiet', '-u', 'origin', 'main'], gitEnv);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'], gitEnv);
    git(root, ['clone', '--quiet', hosted, clone], gitEnv);
    writeFileSync(join(clone, 'my-notes.txt'), 'uncommitted work in the clone\n');

    const source = join(root, 'source'); mkdirSync(source);
    writeFileSync(join(source, 'SUMMARY.md'), '# Table of contents\n\n* [Welcome](README.md)\n\n## Guides\n\n* [Install](install.md)\n');
    writeFileSync(join(source, 'README.md'), '# Welcome\n\nStart here, then read the guides.\n');
    writeFileSync(join(source, 'install.md'), '# Install\n\nRun the installer and follow it.\n');
    const workspace = join(root, 'ws');
    const env = { ...Object.fromEntries(Object.entries(gitEnv).filter(([key]) => !/^(DAI_|MIGRATION_|FIRECRAWL_|README_|R2_|AWS_)/.test(key))), MIGRATION_WORKSPACE: workspace };
    const cli = (...args: string[]): string => {
      try { return execFileSync(process.execPath, [join(repo, 'node_modules/tsx/dist/cli.mjs'), join(repo, 'packages/migrate-core/src/cli.ts'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { const failed = error as { stdout?: string; stderr?: string }; throw new Error(`dai-migrate ${args.join(' ')}\n${failed.stdout ?? ''}${failed.stderr ?? ''}`); }
    };

    // no --target, no --remote, no --allowed-orgs, no key
    const init = cli('init', '--source', source, '--platform', 'gitbook', '--clone', clone, '--template', 'atlas');
    expect(init).toContain('this migration may write only to github.com/acme-docs');
    expect(init).toContain('DAI_API_KEY not configured');
    const session = JSON.parse(readFileSync(join(workspace, 'session.json'), 'utf8')) as { target: Record<string, unknown> };
    expect(session.target).toMatchObject({ landing: 'customer-org', cloneDir: clone, repoRemote: hosted, pushAccessVerified: true, template: 'atlas' });
    expect(JSON.parse(readFileSync(join(workspace, 'plan', 'allowed-orgs.json'), 'utf8'))).toEqual(['github.com/acme-docs']);

    for (const [stage, ...rest] of [['discover'], ['approve', '--gate', '1', '--by', 'owner'], ['acquire'], ['inventory'], ['plan'], ['approve', '--gate', '2', '--by', 'owner'], ['assets', '--provider', 'none'], ['convert'], ['convert'], ['nav']]) cli(stage, ...rest);
    // the theme chosen at init reached the site's settings
    expect(JSON.parse(readFileSync(join(workspace, 'output', 'documentation.json'), 'utf8'))).toMatchObject({ template: 'atlas' });
    try { cli('verify'); } catch { /* findings never withhold the branch; this run has no gate-3 approval yet */ }
    cli('approve', '--gate', '3', '--by', 'owner');

    const written = cli('write', '--push');
    expect(written).toMatch(/migration\/mig-[0-9a-f]+ at [0-9a-f]{8} \(pushed\)/);
    // with no key the preview address is not looked up, and the message says where to read it and what to run next
    expect(written).toContain('Deployments → Preview');
    expect(written).toContain('verify --workspace');
    const branch = /migration\/mig-[0-9a-f]+/.exec(written)![0];
    expect(git(bare, ['show', `${branch}:install.mdx`], gitEnv)).toContain('Run the installer and follow it.');
    // the clone itself is where the owner left it: same branch, their uncommitted file untouched
    expect(git(clone, ['branch', '--show-current'], gitEnv)).toBe('main');
    expect(readFileSync(join(clone, 'my-notes.txt'), 'utf8')).toBe('uncommitted work in the clone\n');
  }, 240_000);
});
