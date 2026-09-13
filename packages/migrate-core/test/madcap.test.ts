/**
 * A Flare project states its sidebar in XML, which is readable. Two things about real projects are
 * not, and both are refused rather than guessed: which table of contents is the site, and what a
 * target's conditions mean for an entry tagged both included and excluded. On a real customer
 * project surveyed for this adapter, 55% of sidebar entries were tagged both ways, so a guess there
 * is not an edge case — it is most of the tree.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readMadcapRepo, flareProjectFile } from '../src/adapters/madcap.js';

const BOM = '﻿';
const write = (root: string, file: string, body: string): void => {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  // Flare writes every file with a byte order mark, which must come off before parsing.
  writeFileSync(join(root, file), BOM + body);
};

const topic = (title: string, heading: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns:MadCap="http://www.madcapsoftware.com/Schemas/MadCap.xsd"><head><title>${title}</title></head><body><h1>${heading}</h1><p>Body.</p></body></html>\n`;

function project(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'dai-flare-'));
  write(root, 'Content/GettingStarted.htm', topic('Getting Started', 'Getting Started'));
  build(root);
  return root;
}

describe('a Flare project', () => {
  it('is recognised by one .flprj beside Content/ and Project/', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Project/TOCs/Primary.fltoc', '<CatapultToc Version="1"><TocEntry Title="Start" Link="/Content/GettingStarted.htm" /></CatapultToc>');
    });
    expect(flareProjectFile(root)).toContain('AcmeDocs.flprj');
    expect(flareProjectFile(mkdtempSync(join(tmpdir(), 'dai-empty-')))).toBeUndefined();
  });

  it('reads the table of contents the project declares, with nesting and heading-only nodes', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Content/Reference/ApiKeys.htm', topic('', 'About API Keys'));
      write(r, 'Project/TOCs/Primary.fltoc', `<CatapultToc Version="1">
  <TocEntry Title="Getting Started" Link="/Content/GettingStarted.htm" />
  <TocEntry Title="Reference"><TocEntry Title="[%=System.LinkedTitle%]" Link="/Content/Reference/ApiKeys.htm" /></TocEntry>
</CatapultToc>`);
    });
    const repo = readMadcapRepo(root);
    expect(repo.refusals).toEqual([]);
    const strip = JSON.parse(JSON.stringify(repo.tree.navigation).replace(/"pageId":"[^"]+"/g, '"pageId":"id"')) as unknown;
    expect(strip).toEqual([
      { type: 'page', pageId: 'id', title: 'Getting Started' },
      // a node with no Link is a heading naming the group beneath it
      { type: 'group', label: 'Reference', children: [{ type: 'page', pageId: 'id', title: 'About API Keys' }] },
    ]);
  });

  it('resolves a linked title through the topic: its <title>, then its first heading', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Content/Titled.htm', topic('Stated in title', 'A different heading'));
      write(r, 'Content/Untitled.htm', topic('', 'Heading is the title'));
      write(r, 'Project/TOCs/Primary.fltoc', `<CatapultToc Version="1">
  <TocEntry Title="[%=System.LinkedTitle%]" Link="/Content/Titled.htm" />
  <TocEntry Title="[%=System.LinkedTitle%]" Link="/Content/Untitled.htm" />
</CatapultToc>`);
    });
    expect(readMadcapRepo(root).tree.pages.filter((page) => page.migrate).map((page) => page.title))
      .toEqual(['Stated in title', 'Heading is the title']);
  });

  it('refuses to pick between several tables of contents when nothing states which is the site', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" />');
      write(r, 'Project/TOCs/Primary.fltoc', '<CatapultToc Version="1"><TocEntry Title="Start" Link="/Content/GettingStarted.htm" /></CatapultToc>');
      write(r, 'Project/TOCs/Internal.fltoc', '<CatapultToc Version="1"><TocEntry Title="Other" Link="/Content/GettingStarted.htm" /></CatapultToc>');
    });
    const repo = readMadcapRepo(root);
    expect(repo.refusals.join(' ')).toContain('2 tables of contents');
    // the pages are still read; it is the sidebar that is not claimed
    expect(repo.tree.navigation).toBeUndefined();
    expect(repo.tree.pages.length).toBeGreaterThan(0);
  });

  it('refuses an entry a target both includes and excludes, which MadCap leaves undefined', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Project/Targets/Online.fltar', '<CatapultTarget Version="1" Type="WebHelp2" ConditionTagExpression="include[Primary.Online] exclude[Primary.Internal] " />');
      write(r, 'Project/TOCs/Primary.fltoc', `<CatapultToc Version="1">
  <TocEntry Title="Both ways" Link="/Content/GettingStarted.htm" conditions="Primary.Online,Primary.Internal" />
</CatapultToc>`);
    });
    expect(readMadcapRepo(root).refusals.join(' ')).toContain('tagged both included and excluded');
  });

  it('drops an entry the target plainly excludes, and keeps one it plainly includes', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Project/Targets/Online.fltar', '<CatapultTarget Version="1" Type="WebHelp2" ConditionTagExpression="include[Primary.Online] exclude[Primary.Internal] " />');
      write(r, 'Content/Internal.htm', topic('Internal', 'Internal'));
      write(r, 'Project/TOCs/Primary.fltoc', `<CatapultToc Version="1">
  <TocEntry Title="Public" Link="/Content/GettingStarted.htm" conditions="Primary.Online" />
  <TocEntry Title="Staff only" Link="/Content/Internal.htm" conditions="Primary.Internal" />
</CatapultToc>`);
    });
    const repo = readMadcapRepo(root);
    expect(repo.refusals).toEqual([]);
    expect(repo.tree.navigation?.map((node) => node.type === 'page' && node.title)).toEqual(['Public']);
  });

  it('merges a table of contents that points at another one', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Content/Extra.htm', topic('Extra', 'Extra'));
      write(r, 'Project/TOCs/Primary.fltoc', `<CatapultToc Version="1">
  <TocEntry Title="Start" Link="/Content/GettingStarted.htm" />
  <TocEntry Title="More" Link="/Project/TOCs/Sub.fltoc" />
</CatapultToc>`);
      write(r, 'Project/TOCs/Sub.fltoc', '<CatapultToc Version="1"><TocEntry Title="Extra" Link="/Content/Extra.htm" /></CatapultToc>');
    });
    const repo = readMadcapRepo(root);
    expect(repo.tree.navigation?.map((node) => node.type === 'page' && node.title)).toEqual(['Start', 'Extra']);
  });

  it('reports a topic the table of contents never places rather than migrating it silently', () => {
    const root = project((r) => {
      write(r, 'AcmeDocs.flprj', '<CatapultProject Version="1" MasterToc="/Project/TOCs/Primary.fltoc" />');
      write(r, 'Content/Orphan.htm', topic('Orphan', 'Orphan'));
      write(r, 'Project/TOCs/Primary.fltoc', '<CatapultToc Version="1"><TocEntry Title="Start" Link="/Content/GettingStarted.htm" /></CatapultToc>');
    });
    const repo = readMadcapRepo(root);
    const orphan = repo.tree.pages.find((page) => page.source.endsWith('Orphan.htm'));
    expect(orphan).toMatchObject({ migrate: false, reason: 'not placed by the table of contents' });
  });
});
