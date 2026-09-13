/**
 * One contract for every native source, and one place that knows which is which.
 *
 * Platform knowledge had spread into three chains that had to be kept in step by hand: discovery
 * decided what a repository was, the navigation witness decided again at verification, and each
 * adapter returned a different shape that the calling stage had to unpack itself. Adding a platform
 * meant finding all three; getting one wrong meant a source read one way and verified another.
 *
 * An adapter here answers three questions about a frozen repository — do I recognise it, what does
 * it contain, and what navigation does it state — and the stages ask the registry rather than the
 * platform. The adapters themselves are untouched: this is the contract around them, so a platform
 * can be added by registering one entry, and so every adapter can be held to the same conformance
 * suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readGitbookRepo } from './gitbook.js';
import { readMintlifyRepo } from './mintlify.js';
import { readReadmeRepo } from './readme.js';
import { readFernRepo } from './fern.js';
import { readDocusaurusRepo, DOCUSAURUS_CONFIGS } from './docusaurus.js';
import { nextraContentRoot, readNextraRepo } from './nextra.js';
import { flareProjectFile, readMadcapRepo } from './madcap.js';
import { sourceFiles } from '../cli/io.js';
import type { SourceNavigationNode, Tree } from '../nav/tree.js';

export interface NativeSourceRead {
  tree: Tree;
  /** Site-level facts for inventory/platform-meta.json, as the adapter recorded them. */
  meta: Record<string, unknown>;
  /** What an operator must be told about this source before approving its scope. */
  notes: string[];
  /** The stage's own summary line for this source. */
  summary: string;
}

export interface NativeSourceAdapter {
  platform: string;
  /** Whether this adapter recognises the repository at `root`, from what the platform itself writes there. */
  detect: (root: string) => boolean;
  read: (root: string) => NativeSourceRead;
  /**
   * The navigation the source declares, re-read from the frozen bytes at verification. Undefined
   * when the platform declares none, which is not a failure here: `source-navigation-proven` is
   * where navigation that was inferred rather than stated is judged.
   */
  navigationWitness: (root: string) => SourceNavigationNode[] | undefined;
}

const versions = (tree: Tree): number => new Set(tree.pages.map((page) => page.version).filter(Boolean)).size || 1;

export const NATIVE_ADAPTERS: readonly NativeSourceAdapter[] = [
  {
    platform: 'mintlify',
    detect: (root) => existsSync(join(root, 'docs.json')) || existsSync(join(root, 'mint.json')),
    read: (root) => {
      const repo = readMintlifyRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'mintlify', configFile: repo.configFile, name: repo.name, colors: repo.colors, logo: repo.logo, favicon: repo.favicon, redirects: repo.redirects, openapi: repo.openapi, missing: repo.missing },
        notes: repo.missing.length ? [`${repo.missing.length} page(s) listed in ${repo.configFile} are not in the repository`] : [],
        summary: `${repo.tree.pages.length} pages from ${repo.configFile} (${versions(repo.tree)} version(s)); ${repo.missing.length} listed pages missing; ${repo.redirects.exact.length} exact + ${repo.redirects.wildcard.length} wildcard redirects; ${repo.openapi.length} openapi group(s)`,
      };
    },
    navigationWitness: (root) => readMintlifyRepo(root).tree.navigation,
  },
  {
    platform: 'gitbook',
    detect: (root) => existsSync(join(root, 'SUMMARY.md')) || existsSync(join(root, '.gitbook.yaml')),
    read: (root) => {
      const repo = readGitbookRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'gitbook', redirects: { exact: repo.redirects, wildcard: [] }, missing: repo.missing, unlisted: repo.unlisted },
        notes: [
          ...(repo.missing.length ? [`${repo.missing.length} page(s) listed in SUMMARY.md are not in the repository`] : []),
          ...(repo.unlisted.length ? [`${repo.unlisted.length} file(s) in the repository are not listed in SUMMARY.md; review plan/tree.yaml`] : []),
        ],
        summary: `${repo.tree.pages.length} pages from SUMMARY.md; ${repo.missing.length} missing, ${repo.unlisted.length} unlisted files (review plan/tree.yaml)`,
      };
    },
    navigationWitness: (root) => readGitbookRepo(root).tree.navigation,
  },
  {
    platform: 'fern',
    detect: (root) => ['docs.yml', 'docs.yaml'].some((name) => existsSync(join(root, 'fern', name))),
    read: (root) => {
      const repo = readFernRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'fern', missing: repo.missing, unreferenced: repo.unreferenced, apiSections: repo.apiSections },
        notes: [
          ...(repo.missing.length ? [`${repo.missing.length} page(s) named in fern/docs.yml are not in the repository`] : []),
          ...(repo.unreferenced.length ? [`${repo.unreferenced.length} file(s) under fern/ are in no navigation entry; Fern does not publish them either`] : []),
          ...(repo.apiSections.length ? [`${repo.apiSections.length} API reference section(s); their specs are captured by the OpenAPI stage`] : []),
        ],
        summary: `${repo.tree.pages.length} pages from fern/docs.yml; ${repo.missing.length} missing, ${repo.unreferenced.length} unreferenced`,
      };
    },
    navigationWitness: (root) => readFernRepo(root).tree.navigation,
  },
  {
    platform: 'docusaurus',
    detect: (root) => DOCUSAURUS_CONFIGS.some((name) => existsSync(join(root, name))),
    read: (root) => {
      const repo = readDocusaurusRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'docusaurus', docsRoot: repo.docsRoot, hidden: repo.hidden, sidebarsFile: repo.sidebarsFile, versions: repo.versions, locales: repo.locales },
        notes: [
          ...(repo.hidden.length ? [`${repo.hidden.length} draft or unlisted page(s) are not published by Docusaurus and are not migrated`] : []),
          ...(repo.sidebarsFile ? [`${repo.sidebarsFile} states this site's navigation in code, which is not read: review plan/tree.yaml, because exact mode will not certify a sidebar it could not read`] : []),
        ],
        summary: `${repo.tree.pages.length} pages from the Docusaurus docs tree${repo.versions?.length ? `; ${repo.versions.length} released version(s)` : ''}${repo.locales?.length ? `; ${repo.locales.length} locale(s)` : ''}${repo.sidebarsFile ? `; navigation is declared in ${repo.sidebarsFile} and was not read` : '; navigation from the docs tree and _category_ files'}`,
      };
    },
    navigationWitness: (root) => readDocusaurusRepo(root).tree.navigation,
  },
  {
    platform: 'nextra',
    detect: (root) => {
      const manifest = join(root, 'package.json');
      if (!existsSync(manifest)) return false;
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const declares = 'nextra' in { ...parsed.dependencies, ...parsed.devDependencies };
        return declares && !!nextraContentRoot(root);
      } catch { return false; }
    },
    read: (root) => {
      const repo = readNextraRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'nextra', contentRoot: repo.contentRoot, metaFiles: repo.metaFiles },
        notes: repo.metaFiles.length
          ? [`${repo.metaFiles.length} _meta module(s) state this site's sidebar in code, which is not read: review plan/tree.yaml, because exact mode will not certify a sidebar it could not read`]
          : [],
        summary: `${repo.tree.pages.length} pages from ${repo.contentRoot}; navigation is declared in ${repo.metaFiles.length} _meta module(s) and was not read`,
      };
    },
    // Nextra states its sidebar only in JavaScript; there is no witness to re-read.
    navigationWitness: () => undefined,
  },
  {
    platform: 'madcap',
    detect: (root) => !!flareProjectFile(root),
    read: (root) => {
      const repo = readMadcapRepo(root);
      const unplaced = repo.tree.pages.filter((page) => !page.migrate).length;
      return {
        tree: repo.tree,
        meta: { platform: 'madcap', toc: repo.toc, target: repo.target, missing: repo.missing, refusals: repo.refusals },
        notes: [
          ...repo.refusals.map((refusal) => `the table of contents was not read: ${refusal}`),
          ...(repo.missing.length ? [`${repo.missing.length} table-of-contents entr(ies) name a topic that is not in the project`] : []),
          ...(unplaced ? [`${unplaced} topic(s) are in Content/ but not placed by the table of contents; Flare publishes a topic only where it is linked`] : []),
        ],
        summary: repo.tree.navigation?.length
          ? `${repo.tree.pages.filter((page) => page.migrate).length} topics from ${repo.toc}${repo.target ? ` (target ${repo.target})` : ''}; ${unplaced} unplaced`
          : `${repo.tree.pages.length} topics found, but the table of contents was not read: ${repo.refusals[0] ?? 'no TOC could be identified'}`,
      };
    },
    navigationWitness: (root) => readMadcapRepo(root).tree.navigation,
  },
  {
    platform: 'readme',
    // A ReadMe sync repository is a docs/ tree whose files carry ReadMe's own frontmatter.
    detect: (root) => !DOCUSAURUS_CONFIGS.some((name) => existsSync(join(root, name)))
      && existsSync(join(root, 'docs'))
      && sourceFiles(join(root, 'docs')).some((file) => /^---[\s\S]*?^(slug|excerpt):/m.test(readFileSync(file, 'utf8'))),
    read: (root) => {
      const repo = readReadmeRepo(root);
      return {
        tree: repo.tree,
        meta: { platform: 'readme', hidden: repo.hidden },
        notes: repo.hidden.length ? [`${repo.hidden.length} hidden page(s) are published by ReadMe as unlisted and are not migrated`] : [],
        summary: `${repo.tree.pages.length} pages from the ReadMe sync repository; ${repo.hidden.length} hidden pages skipped`,
      };
    },
    navigationWitness: (root) => readReadmeRepo(root).tree.navigation,
  },
];

/**
 * The adapter for a repository: the one the operator named, or the one that recognises what is
 * there. A named platform is honoured even when its markers are missing, so the stage can report
 * what the platform's own reader says is wrong rather than silently migrating it as a generic
 * folder of Markdown.
 */
export function adapterFor(root: string, platform?: string): NativeSourceAdapter | undefined {
  if (platform) return NATIVE_ADAPTERS.find((adapter) => adapter.platform === platform);
  return NATIVE_ADAPTERS.find((adapter) => adapter.detect(root));
}
