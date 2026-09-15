/**
 * Gate ids as a customer reads them.
 *
 * A gate id is an engineering handle: `html-reconciliation` tells the person who wrote it exactly
 * what ran, and tells the customer nothing. The customer report is the one artefact written for
 * someone outside the team, so every gate needs a sentence in their language — what the check
 * proves about *their* documentation, not what the code did.
 *
 * Nothing here softens a result. A failure is still reported as a failure, with the gate's own
 * detail and samples; this only supplies the words around it.
 */

export type GateGroup = 'content' | 'structure' | 'links' | 'media' | 'process';

export interface GateLanguage {
  /** What passing this gate proves, as a statement about the customer's documentation. */
  title: string;
  group: GateGroup;
}

export const GATE_GROUP_TITLES: Record<GateGroup, string> = {
  content: 'Your content',
  structure: 'Structure and navigation',
  links: 'Links and URLs',
  media: 'Images and files',
  process: 'How this migration was produced',
};

/** The order the groups read in: what the customer cares about most, first. */
export const GATE_GROUP_ORDER: GateGroup[] = ['content', 'structure', 'links', 'media', 'process'];

export const GATE_LANGUAGE: Record<string, GateLanguage> = {
  // content
  'prose-match': { title: 'Body text matches your source word for word', group: 'content' },
  'code-blocks-exact': { title: 'Code samples are character-for-character identical', group: 'content' },
  'tables-exact': { title: 'Tables keep their rows, columns and alignment', group: 'content' },
  'source-content-exact': { title: 'Every page matches the sealed copy of your source', group: 'content' },
  'source-metadata-exact': { title: 'Page titles and descriptions match your source', group: 'content' },
  'html-reconciliation': { title: 'Every element of your source pages is accounted for', group: 'content' },
  'chrome-absent': { title: 'No interface text from the old platform leaked into your pages', group: 'content' },
  'conversion-fidelity': { title: 'Converted pages carry the same content as the source', group: 'content' },
  'serialized-output-exact': { title: 'The written files match the converted content exactly', group: 'content' },
  'no-authored-exclusions': { title: 'Nothing your authors wrote was dropped', group: 'content' },
  'no-unresolved-blocks': { title: 'No unresolved placeholders remain in any page', group: 'content' },
  'headings-sequence': { title: 'Heading levels are preserved as authored', group: 'content' },
  'openapi-preserved': { title: 'API reference specifications carried over unchanged', group: 'content' },

  // structure
  'navigation-exact': { title: 'The sidebar matches your source site exactly', group: 'structure' },
  'source-navigation-proven': { title: 'The sidebar came from your own site definition, not a guess', group: 'structure' },
  'navigation-valid': { title: 'Every sidebar entry points at a page that exists', group: 'structure' },
  'contract-valid': { title: 'Every page is valid on Documentation.AI', group: 'structure' },
  'pages-accounted': { title: 'Every page in the agreed scope was written', group: 'structure' },
  'source-universe-accounted': { title: 'Every page found on your source site is accounted for', group: 'structure' },
  'block-dispositions': { title: 'Every piece of content has a recorded outcome', group: 'structure' },
  'exclusions-attributed': { title: 'Anything left out records who decided it and why', group: 'structure' },

  // links
  'internal-links': { title: 'Links between your pages resolve', group: 'links' },
  'unmigrated-links': { title: 'Links leaving this migration are identified, not broken silently', group: 'links' },
  'fragments-resolve': { title: 'Deep links to a section land on the right heading', group: 'links' },
  'redirects-clean': { title: 'Your old URLs redirect cleanly, with no loops or dead ends', group: 'links' },
  'no-unsafe-urls': { title: 'No unsafe or malformed links in the output', group: 'links' },
  'browser-fragments': { title: 'Deep links work in the rendered preview', group: 'links' },

  // media
  'assets-ready': { title: 'Every image, video and download is hosted and reachable', group: 'media' },

  // process
  'deterministic-rerun': { title: 'Running the migration again produces byte-identical files', group: 'process' },
  'source-manifest-pinned': { title: 'The captured copy of your source is sealed and unchanged', group: 'process' },
  'plans-pinned': { title: 'The approved plans match what was produced', group: 'process' },
  'migrator-pinned': { title: 'The output came from the recorded migration build', group: 'process' },
  'human-gates-approved': { title: 'All four review points were signed off', group: 'process' },
  'no-unreviewed-decisions': { title: 'Every conversion decision was reviewed by a person', group: 'process' },
  'browser-content': { title: 'The rendered preview shows the expected content', group: 'process' },
  'responsive-layout': { title: 'Pages render correctly on phone, tablet and desktop', group: 'process' },
  'preview-contract-version': { title: 'The preview runs the platform version this migration targeted', group: 'process' },
};

/** A gate with no entry still reaches the report — under its own id, rather than being dropped. */
export function gateLanguage(id: string): GateLanguage {
  return GATE_LANGUAGE[id] ?? { title: id, group: 'process' };
}
