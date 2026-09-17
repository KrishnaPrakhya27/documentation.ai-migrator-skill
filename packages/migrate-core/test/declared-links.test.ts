/**
 * Two kinds of link are written by rules rather than by the author, and they go opposite ways. A
 * link a handler draws between pages (a MadCap tile menu read from the table of contents) follows
 * those pages to their new routes. A link a rule writes by an operator's decision — a card to a live
 * tool that still lives on the source site — points there on purpose, and retargeting it turned it
 * into a link to the very page it sits on.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RulesEngine, loadMappings } from '../src/components/rules-engine.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { ensureWorkspace } from '../src/session/workspace.js';
import { markdownToIr } from '../src/ir/from-markdown.js';
import { retargetDocLinks } from '../src/urls/site-links.js';
import { docToMdx } from '../src/ir/to-dai-mdx.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('a link a rule wrote by an operator\'s decision', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dai-declared-')); ensureWorkspace(workspace);
  const engine = new RulesEngine({ platform: 'mintlify', mappings: loadMappings([join(repoRoot, 'skills/migrate-mintlify/mappings/mintlify.yaml'), join(repoRoot, 'skills/migrate-generic/mappings/generic.yaml')]), ledger: new Ledger(workspace), log: new DecisionLog(workspace) });
  const source = 'https://www.mintlify.com/docs/deploy/vercel';
  // every link to the source site is moved to its migrated route, as convert does
  const toRoute = (url: string): string => (url.startsWith('https://www.mintlify.com/docs/') ? url.replace('https://www.mintlify.com', '') : url);

  it('stays where that person pointed it, while an authored link on the same page still moves', () => {
    const doc = markdownToIr('See [the quickstart](https://www.mintlify.com/docs/quickstart).\n\n<VercelJsonGenerator />\n', { platform: 'mintlify', file: 'deploy/vercel.mdx', pageId: 'vercel' });
    const resolved = engine.resolveDoc({ ...doc, source });
    expect([...engine.declaredLinks('vercel')]).toEqual([source]);
    const mdx = docToMdx(retargetDocLinks(resolved, toRoute, engine.declaredLinks('vercel')));
    expect(mdx).toContain(`<Card title="Vercel rewrites generator" href="${source}" />`);
    expect(mdx).toContain('[the quickstart](/docs/quickstart)');
    // without the exception the card linked to the page it sits on
    expect(docToMdx(retargetDocLinks(resolved, toRoute))).toContain('href="/docs/deploy/vercel"');
  });

  it('is scoped to the page it was declared on', () => {
    expect([...engine.declaredLinks('another-page')]).toEqual([]);
  });
});
