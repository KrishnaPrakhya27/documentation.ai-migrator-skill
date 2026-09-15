/**
 * A migration branch records what was pushed and reviewed, so it is never rewritten. The rendered
 * preview is where a problem no local check can see turns up — on a Flare migration, 252 pages
 * answering 404 because the renderer serves only routes the navigation names — and the corrected
 * build then has nowhere to go unless it may take a new id. A revision does that, and says why.
 */
import { describe, it, expect } from 'vitest';
import { recordRevision, type Session } from '../src/session/workspace.js';

const session = (): Session => ({
  migrationId: 'mig-firstpush01', createdAt: '2026-09-15T00:00:00.000Z',
  source: { kind: 'url', location: 'https://x.test/home.htm', platform: 'madcap' },
  target: { landing: 'demo-org', previewUrl: 'https://old-preview.test', previewDeploymentId: 'dep-1', repoRemote: 'https://github.com/acme/docs' },
  scope: 'full', customerAuthorisedCrawl: false, fidelityMode: 'exact',
  migrator: { gitSha: 'a'.repeat(40), dirty: false, dirtyHash: null, packageVersion: '0.1.0' },
  versions: { core: '0.1.0', contentContract: '0.1.0', parsers: {} },
  hashes: {}, stages: {},
} as unknown as Session);

describe('a build that supersedes one already pushed', () => {
  const reason = 'the preview showed unlisted pages answering 404';

  it('takes the new id and keeps the one it replaces, with the reason and that build\'s preview', () => {
    const next = recordRevision(session(), reason, 'mig-secondpush', '2026-09-15T12:00:00.000Z');
    expect(next.migrationId).toBe('mig-secondpush');
    expect(next.revisions).toEqual([{ migrationId: 'mig-firstpush01', at: '2026-09-15T12:00:00.000Z', reason, previewUrl: 'https://old-preview.test' }]);
  });

  it('stops the replaced build\'s preview being read as this one\'s', () => {
    const next = recordRevision(session(), reason, 'mig-secondpush');
    expect(next.target.previewUrl).toBeUndefined();
    expect(next.target.previewDeploymentId).toBeUndefined();
    expect(next.target.repoRemote).toBe('https://github.com/acme/docs');
  });

  it('keeps every earlier revision, so the chain reads oldest first', () => {
    const first = recordRevision(session(), 'first fix', 'mig-second', '2026-09-15T12:00:00.000Z');
    const second = recordRevision({ ...first, target: { ...first.target, previewUrl: 'https://second-preview.test' } }, 'second fix', 'mig-third', '2026-09-15T13:00:00.000Z');
    expect(second.revisions?.map((entry) => entry.migrationId)).toEqual(['mig-firstpush01', 'mig-second']);
    expect(second.migrationId).toBe('mig-third');
  });

  it('leaves everything else about the session alone', () => {
    const next = recordRevision(session(), reason, 'mig-secondpush');
    expect(next.migrator).toEqual(session().migrator);
    expect(next.fidelityMode).toBe('exact');
    expect(next.createdAt).toBe('2026-09-15T00:00:00.000Z');
  });
});
