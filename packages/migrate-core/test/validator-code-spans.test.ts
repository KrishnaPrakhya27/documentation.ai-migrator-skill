/**
 * The strict validator reads any `{…}` on a prose line as an expression. A code span is not prose,
 * and a span may open with several backticks so it can hold backticks inside; the validator only
 * knew the single-backtick form, so a page explaining fences (```` ``` ````) had its next code span
 * read as prose and its `{variable}` refused — on a page the platform itself compiles fine.
 */
import { describe, it, expect } from 'vitest';
import { validateMdx } from '@dai/content-contract';

const page = (line: string) => `---\ntitle: T\n---\n\n${line}\n`;

describe('code spans in the strict validator', () => {
  it('ignores braces inside a span that opens with several backticks', () => {
    expect(validateMdx(page('Inside fences (```` ``` ````) you can write `{variable}` directly.')).filter((i) => i.code === 'expression')).toEqual([]);
  });
  it('still refuses an expression in prose', () => {
    expect(validateMdx(page('Write {variable} here.')).some((i) => i.code === 'expression')).toBe(true);
  });
});
