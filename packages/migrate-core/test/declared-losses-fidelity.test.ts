/**
 * Exact fidelity compares the frozen source with the written output. The mapping rules an operator
 * approves at gate 2 deliberately change some of what the source states: a wrapper's props go when
 * its children are unwrapped, a platform widget's subtree is dropped as chrome, a named prop is
 * dropped because the target contract cannot express it. Comparing against a source that still
 * carries those reports the page as different for a reason the operator already accepted — on the
 * demo-64 GitBook migration, 16 of 41 pages quarantined that way with no content actually lost.
 *
 * The source is put through the same declarations the conversion used, and two spellings that read
 * the same are canonicalised on both sides. The gate must still be able to fail: a handler that
 * loses a paragraph, a rename that loses a prop, and any loss no approved rule declared, all stay
 * failures. These tests hold that line.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RulesEngine, applyDeclaredLosses, type MappingTable } from '../src/components/rules-engine.js';
import { Ledger } from '../src/ledger/dispositions.js';
import { DecisionLog } from '../src/log/decisions.js';
import { authoredContentSnapshot, fidelityEqual, firstFidelityDifference } from '../src/verify/fidelity.js';
import type { Block, DocIR } from '../src/ir/types.js';

let seq = 0;
const id = () => `n${seq++}`;

function doc(children: Block[]): DocIR {
  return { pageId: 'p1', platform: 'gitbook', source: 'https://demo.gitbook.io/docs/page', frontmatter: { title: 'Page' }, children };
}

function component(name: string, props: Record<string, string | number | boolean | null>, children: Block[] = []): Block {
  return { id: id(), type: 'component', name, platform: 'gitbook', props, children };
}

function para(value: string): Block {
  return { id: id(), type: 'paragraph', children: [{ id: id(), type: 'text', value }] };
}

function heading(depth: 1 | 2 | 3 | 4 | 5 | 6, value: string): Block {
  return { id: id(), type: 'heading', depth, children: [{ id: id(), type: 'text', value }] };
}

/** The declarations at issue, in the shape skills/migrate-gitbook/mappings/gitbook.yaml states them. */
const MAPPINGS: MappingTable[] = [{
  platform: 'gitbook',
  version: 1,
  rules: [
    { id: 'gitbook/ask-button', tier: 'T7', match: { name: 'button', props: { 'data-action': 'ask' } }, children: 'drop' },
    { id: 'gitbook/content-ref', tier: 'T4', match: { name: 'content-ref' }, children: 'unwrap' },
    { id: 'gitbook/column', tier: 'T4', match: { name: 'column' }, children: 'unwrap', drop: ['width', 'valign'] },
    { id: 'gitbook/update', tier: 'T2', match: { name: 'update' }, to: { name: 'Update', props: { label: '$date' } }, drop: ['tags'] },
    { id: 'gitbook/step', tier: 'T3', match: { name: 'step' }, handler: 'step-title-from-heading' },
  ],
}];

function engine(): { engine: RulesEngine; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'declared-losses-'));
  return {
    engine: new RulesEngine({ platform: 'gitbook', mappings: MAPPINGS, ledger: new Ledger(workspace), log: new DecisionLog(workspace) }),
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

function declared(children: Block[]): DocIR {
  const { engine: e, cleanup } = engine();
  try { return applyDeclaredLosses(doc(children), e); } finally { cleanup(); }
}

describe('applyDeclaredLosses: the source as gate 2 approved it', () => {
  it("drops a subtree a rule declares as chrome, so an Assistant prompt is not a difference", () => {
    const out = declared([component('button', { 'data-action': 'ask' }, [para('Deploy your first project')]), para('Real prose')]);
    expect(out.children).toHaveLength(1);
    expect(authoredContentSnapshot(out)).toEqual(authoredContentSnapshot(doc([para('Real prose')])));
  });

  it('unwraps a wrapper, keeping its children in reading order and discarding only its own props', () => {
    const out = declared([component('content-ref', { src: '/pages/3fJme8PPaIs4eVzg3nXD' }, [para('Getting started checklist')])]);
    expect(out.children).toHaveLength(1);
    expect(out.children[0].type).toBe('paragraph');
  });

  it('removes exactly the props a rule names in drop, and no others', () => {
    const [update] = declared([component('update', { date: '2025-12-03', tags: 'feature,fix', title: 'Fixed' })]).children;
    expect(update.type).toBe('component');
    expect((update as { props: Record<string, unknown> }).props).toEqual({ date: '2025-12-03', title: 'Fixed' });
  });

  it('leaves a handler-driven node exactly as the source stated it, so the handler stays under test', () => {
    const [step] = declared([component('step', {}, [heading(3, 'Create an account'), para('Sign up.')])]).children;
    expect((step as { props: Record<string, unknown> }).props).toEqual({});
    expect((step as { children: Block[] }).children).toHaveLength(2);
  });

  it('applies declarations at any depth, not only at the top level', () => {
    const out = declared([component('column', { width: '50%' }, [component('button', { 'data-action': 'ask' }, [para('Ask')]), para('Kept')])]);
    expect(authoredContentSnapshot(out)).toEqual(authoredContentSnapshot(doc([para('Kept')])));
  });

  it('leaves a component no approved rule matches untouched, so an unmapped loss still fails', () => {
    const [kept] = declared([component('mystery', { caption: 'A caption the rules never mention' })]).children;
    expect((kept as { props: Record<string, unknown> }).props).toEqual({ caption: 'A caption the rules never mention' });
  });
});

describe('authoredContentSnapshot: two spellings of the same words', () => {
  /** GitBook states a step's title as its leading heading; Documentation.AI's Step requires a title prop. */
  it('reads a leading heading and a title prop as the same step', () => {
    const source = doc([component('step', {}, [heading(3, 'Create an account'), para('Sign up.')])]);
    const output = doc([component('Step', { title: 'Create an account', titleType: 'h3' }, [para('Sign up.')])]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it('renders an h4 step title at h3 without calling it a content change', () => {
    const source = doc([component('step', {}, [heading(4, 'Enable SSO'), para('Turn it on.')])]);
    const output = doc([component('Step', { title: 'Enable SSO', titleType: 'h3' }, [para('Turn it on.')])]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it('still fails when the promoted title is not the words the heading stated', () => {
    const source = doc([component('step', {}, [heading(3, 'Create an account'), para('Sign up.')])]);
    const output = doc([component('Step', { title: 'Something else', titleType: 'h3' }, [para('Sign up.')])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('still fails when the step body is lost behind a correct title', () => {
    const source = doc([component('step', {}, [heading(3, 'Create an account'), para('Sign up.')])]);
    const output = doc([component('Step', { title: 'Create an account', titleType: 'h3' }, [])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  /**
   * A GitBook `<update date="…">` opens with a heading the author wrote and the conversion keeps as
   * a heading; its date becomes the Update's label. Reading that heading as the update's title made
   * the source disagree with an output that was correct.
   */
  it('leaves an update\'s own leading heading a heading, and reads its date as the label', () => {
    const source = doc([component('update', { date: '2025-12-03' }, [heading(2, 'Product update'), para('See what is new.')])]);
    const output = doc([component('Update', { label: '2025-12-03' }, [heading(2, 'Product update'), para('See what is new.')])]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it("still fails when an update's leading heading is lost", () => {
    const source = doc([component('update', { date: '2025-12-03' }, [heading(2, 'Product update'), para('See what is new.')])]);
    const output = doc([component('Update', { label: '2025-12-03' }, [para('See what is new.')])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('still fails when an update label carries a date the source never stated', () => {
    const source = doc([component('update', { date: '2025-12-03' }, [para('See what is new.')])]);
    const output = doc([component('Update', { label: '2024-01-01' }, [para('See what is new.')])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('keeps both when a component states a title and opens with a heading', () => {
    const source = doc([component('card', { title: 'Stated' }, [heading(3, 'Also a heading'), para('Body.')])]);
    const output = doc([component('Card', { title: 'Stated' }, [para('Body.')])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  /** An embed of a host that is not allowlisted for iframes stays a link to the same address. */
  it('reads a bare embed and a link to its target as the same reference', () => {
    const source = doc([component('embed', { src: 'https://github.com/GitbookIO/gitbook-templates' })]);
    const output = doc([{ id: id(), type: 'paragraph', children: [{ id: id(), type: 'link', url: 'https://github.com/GitbookIO/gitbook-templates', children: [{ id: id(), type: 'text', value: 'https://github.com/GitbookIO/gitbook-templates' }] }] }]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it('still fails when an embed is kept as a link to a different address', () => {
    const source = doc([component('embed', { src: 'https://github.com/GitbookIO/gitbook-templates' })]);
    const output = doc([{ id: id(), type: 'paragraph', children: [{ id: id(), type: 'link', url: 'https://example.com/elsewhere', children: [{ id: id(), type: 'text', value: 'https://example.com/elsewhere' }] }] }]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('leaves a component that says more than its address alone', () => {
    const source = doc([component('embed', { src: 'https://youtube.com/watch?v=abc', title: 'Intro' })]);
    const output = doc([{ id: id(), type: 'paragraph', children: [{ id: id(), type: 'link', url: 'https://youtube.com/watch?v=abc', children: [{ id: id(), type: 'text', value: 'https://youtube.com/watch?v=abc' }] }] }]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });
});

describe('blocks that say nothing', () => {
  /** GitBook publishes spacer paragraphs between blocks; a re-parse of the written file returns none. */
  it('reads a spacer paragraph as nothing, on both sides', () => {
    const spacer: Block = { id: id(), type: 'paragraph', children: [{ id: id(), type: 'text', value: ' ' }] };
    const source = doc([spacer, para('Real prose')]);
    const output = doc([para('Real prose')]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it('still fails when a paragraph with words in it disappears', () => {
    const source = doc([para('Words'), para('Real prose')]);
    const output = doc([para('Real prose')]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('reads an uncaptioned figure as the image it frames', () => {
    const image = { id: id(), type: 'image' as const, url: 'https://cdn.example.net/a.png', alt: '' };
    const source = doc([{ id: id(), type: 'figure', image, caption: [] }]);
    const output = doc([image]);
    expect(fidelityEqual(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBe(true);
  });

  it('keeps a figure that carries a caption distinct from a bare image', () => {
    const image = { id: id(), type: 'image' as const, url: 'https://cdn.example.net/a.png', alt: '' };
    const source = doc([{ id: id(), type: 'figure', image, caption: [{ id: id(), type: 'text', value: 'Figure 1' }] }]);
    const output = doc([image]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });
});

describe('the gate still fails on a loss no rule declared', () => {
  it('fails when a handler silently loses a paragraph', () => {
    const source = declared([component('step', {}, [heading(3, 'Deploy'), para('First.'), para('Second.')])]);
    const output = doc([component('Step', { title: 'Deploy', titleType: 'h3' }, [para('First.')])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('fails when a prop no rule named goes missing', () => {
    const source = declared([component('update', { date: '2025-12-03', tags: 'feature', description: 'Version 2.1' })]);
    const output = doc([component('Update', { label: '2025-12-03' }, [])]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });

  it('fails when prose itself disappears', () => {
    const source = declared([component('column', { width: '50%' }, [para('Kept'), para('Lost')])]);
    const output = doc([para('Kept')]);
    expect(firstFidelityDifference(authoredContentSnapshot(source), authoredContentSnapshot(output))).toBeDefined();
  });
});
