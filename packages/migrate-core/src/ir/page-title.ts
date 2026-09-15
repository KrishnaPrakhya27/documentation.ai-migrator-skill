/**
 * Which heading of a rendered article states the page's title.
 *
 * A page usually says so with an `<h1>`. Not every generator writes one: a MadCap Flare topic
 * keeps `<h1>` for the skin's masthead and opens the article itself at `<h2>`, so reading only
 * `<h1>` finds no title on a page that plainly states one. The heading an article *opens* with is
 * its title whatever its level; a heading further down is a section of the page, never its name,
 * so nothing below the first block is considered.
 */
import type { Block } from './types.js';

export function titleHeading(children: readonly Block[]): Block | undefined {
  const h1 = children.find((block) => block.type === 'heading' && block.depth === 1);
  if (h1) return h1;
  const opening = children[0];
  return opening?.type === 'heading' ? opening : undefined;
}
