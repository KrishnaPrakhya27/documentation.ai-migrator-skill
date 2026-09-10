/**
 * Image dimensions, read the same way from every adapter.
 *
 * The target `Image` contract carries an integer pixel count and nothing else, so
 * `width="100%"`, `width="2rem"` and `width="auto"` state something it cannot
 * hold. Guessing a number (`parseInt("2rem") === 2`) ships a wrong size silently
 * and throwing inside the parser ends a whole run over one attribute, so the
 * reader does neither: it reports the raw text back and lets the stage that knows
 * `fidelityMode` decide whether to stop.
 */

import { walkBlocks, type DocIR, type ImageNode, type Inline } from './types.js';

/** A dimension the target can carry, or the source text it could not read. Never guesses and never throws. */
export interface PixelDimension {
  value?: number;
  /** The attribute exactly as authored, when it is not a positive integer count of pixels. */
  unreadable?: string;
}

const POSITIVE_INTEGER = /^\d+$/;

export function readPixelDimension(raw: string | number | boolean | null | undefined): PixelDimension {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? { value: raw } : { unreadable: String(raw) };
  if (typeof raw === 'boolean') return { unreadable: String(raw) };
  const text = raw.trim();
  if (!text) return {};
  if (POSITIVE_INTEGER.test(text) && Number(text) > 0) return { value: Number(text) };
  return { unreadable: raw };
}

/** One image whose stated size the target cannot carry, named so a stop or a report says which page and attribute. */
export interface UnreadableDimension {
  pageId: string;
  /** Source path or URL of the page, for the operator-facing message. */
  source: string;
  src: string;
  attribute: 'width' | 'height';
  stated: string;
}

function collectImage(image: ImageNode, doc: DocIR, out: UnreadableDimension[]): void {
  if (image.unreadableWidth !== undefined) out.push({ pageId: doc.pageId, source: doc.source, src: image.url, attribute: 'width', stated: image.unreadableWidth });
  if (image.unreadableHeight !== undefined) out.push({ pageId: doc.pageId, source: doc.source, src: image.url, attribute: 'height', stated: image.unreadableHeight });
}

function collectInline(nodes: Inline[], doc: DocIR, out: UnreadableDimension[]): void {
  for (const node of nodes) {
    if (node.type === 'image') collectImage(node, doc, out);
    else if ('children' in node) collectInline(node.children, doc, out);
  }
}

/** Every stated dimension in one document that the target's `Image` contract cannot carry, in document order. */
export function unreadableImageDimensions(doc: DocIR): UnreadableDimension[] {
  const out: UnreadableDimension[] = [];
  walkBlocks(doc.children, (block) => {
    if (block.type === 'image') collectImage(block, doc, out);
    else if (block.type === 'figure') collectImage(block.image, doc, out);
    else if (block.type === 'paragraph' || block.type === 'heading') collectInline(block.children, doc, out);
    else if (block.type === 'table') for (const row of block.children) for (const cell of row.children) collectInline(cell.children, doc, out);
  });
  return out;
}

/** `guides/setup.md: image /d.png states width "100%"`, the wording both the exact-mode stop and the permissive report use. */
export function describeUnreadableDimension(entry: UnreadableDimension): string {
  return `${entry.source}: image ${entry.src || '(no src)'} states ${entry.attribute} ${JSON.stringify(entry.stated)}, which the target Image contract (integer pixels) cannot carry`;
}
