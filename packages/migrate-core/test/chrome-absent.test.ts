/**
 * Theme chrome must never reach migrated output, and authored content must never be
 * mistaken for it. The words themes use ("Copy", "Next", "Previous", "Updated") are
 * ordinary English, so the check reads the line a string occupies rather than the
 * string alone: chrome renders as a block of its own, content does not.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeAbsent } from '../src/verify/source-truth.js';
import { getProfile } from '../src/scrape/profiles.js';

const chrome = getProfile('readme').chromeStrings!;

const check = (body: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'dai-chrome-')), 'page.mdx');
  writeFileSync(file, body);
  return chromeAbsent({ pageId: 'p', path: '/p', route: 'p', outputFile: file }, chrome);
};

describe('platform chrome in migrated output', () => {
  it('passes authored prose that happens to use the theme\'s words', () => {
    const result = check([
      '# Install',
      '',
      '3. Enter your password and click **Next**.',
      '- Select **Previous step** to go back to [Step 1](#step-1).',
      '',
      '### Copy and paste a dataflow',
      '',
      '| Field | Meaning |',
      '| --- | --- |',
      '| Last Updated By | Identifier of the user who last updated the badge. |',
      '',
      '```json',
      '{ "pointsPreviousExpiryDate": "2025-10-28", "Copy": true }',
      '```',
      '',
    ].join('\n'));
    expect(result).toMatchObject({ pass: true });
  });

  it.each([
    ['a feedback prompt on its own', 'Was this page helpful?', '"Was this page helpful?"'],
    ['a pager holding nothing else', 'Previous Next', '"Previous"'],
    ['an edit link, by its rendered text', '[Edit this page](https://example.test/edit)', '"Edit this page"'],
    ['a bare button label', 'Copy', '"Copy"'],
    ['a chrome heading', '## On this page', '"On this page"'],
  ])('fails %s', (_name, line, expected) => {
    const result = check(`# Install\n\nSet the token, then restart.\n\n${line}\n`);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain(expected);
  });

  it('reports rather than passes when a profile supplies no chrome evidence', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dai-chrome-')), 'page.mdx');
    writeFileSync(file, '# Install\n');
    expect(chromeAbsent({ pageId: 'p', path: '/p', route: 'p', outputFile: file }, [])).toMatchObject({
      pass: false, detail: 'no platform chrome evidence was supplied',
    });
  });
});
