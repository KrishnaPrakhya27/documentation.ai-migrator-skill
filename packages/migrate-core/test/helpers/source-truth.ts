/**
 * Loader for the externally stored raw source of a migrated site. The saved
 * source (rendered HTML, published .md, llms.txt, robots.txt, sitemap.xml and
 * the hand-verified truth.json) is never vendored into this repository; tests
 * reach it only through DAI_SOURCE_TRUTH_DIR and fail closed when it is unset
 * or incomplete.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_TRUTH_ENV = 'DAI_SOURCE_TRUTH_DIR';
export const SOURCE_TRUTH_FILES = ['truth.json', 'llms.txt', 'robots.txt', 'sitemap.xml'] as const;
export const SOURCE_TRUTH_DIRECTORIES = ['html', 'md'] as const;

export interface SourceTruthSite {
  name: string;
  theme: string;
  colors: { primary: string; light: string; dark: string };
  favicon: string;
  logo: { light: string; dark: string };
  navbarLinks: Array<{ href: string; label: string }>;
  footerSocials: Record<string, string>;
}

export interface SourceTruthPageMetadata {
  title: string | null;
  sidebarTitle?: string;
  description: string | null;
  href: string;
}

export interface SourceTruthPlacement {
  groupPath: string[];
  sidebarLabel: string;
  navTitle: string | null;
  navDescription: string | null;
}

export interface SourceTruthCounts {
  paragraphs: number;
  topLevelParagraphs: number;
  listItems: number;
  boldSpans: number;
  brTags: number;
  linkCount: number;
  mdBytes: number;
  bodyNonEmptyLines: number;
}

export interface SourceTruthHeading { level: number; text: string }
export interface SourceTruthLink { text: string; href: string }
export interface SourceTruthImage { src: string; alt: string; width: string; height: string; 'data-path': string }
export interface SourceTruthVideo { src: string; controls: boolean; 'data-path': string }
export interface SourceTruthCodeBlock { language: string; meta: string; lines: number }
/** Authored props of one component instance (for example `title`, `icon`, `href` on a Card); `_selfClosing` marks `<Card />`. */
export type SourceTruthComponentProps = Record<string, string | boolean>;

export interface SourceTruthPage {
  path: string;
  mdUrl: string;
  htmlUrl: string;
  title: string;
  description: string | null;
  llmsTxt: { title: string; description: string | null };
  htmlTitleTag: string;
  pageMetadata: SourceTruthPageMetadata;
  sidebarLabel: string;
  groupPath: string[];
  placements: SourceTruthPlacement[];
  counts: SourceTruthCounts;
  headings: Record<string, number>;
  headingList: SourceTruthHeading[];
  links: SourceTruthLink[];
  images: SourceTruthImage[];
  videos: SourceTruthVideo[];
  codeBlocks: SourceTruthCodeBlock[];
  components: Record<string, number>;
  componentDetail: Record<string, SourceTruthComponentProps[]>;
  sidebarLabelSource: string;
  placementsNote: string | null;
  groupEyebrowInHtml: string | null;
  groupPathNote?: string;
}

export interface SourceTruthNavigationPage { href: string; sidebarTitle: string; note?: string }
export interface SourceTruthNavigationGroup { group: string; pages: SourceTruthNavigationPage[] }
/** An ungrouped top-level sidebar entry. */
export interface SourceTruthNavigationLeaf { page: string; sidebarTitle: string; note?: string }
export type SourceTruthNavigationEntry = SourceTruthNavigationGroup | SourceTruthNavigationLeaf;

export interface SourceTruthPagination {
  prev: [label: string, path: string] | null;
  next: [label: string, path: string] | null;
}

export interface SourceTruth {
  site: SourceTruthSite;
  pageCount: number;
  pages: SourceTruthPage[];
  navigationHierarchy: SourceTruthNavigationEntry[];
  navigationNotes: string[];
  paginationSequence: string[];
  paginationPerPage: Record<string, SourceTruthPagination>;
  /** Theme strings keyed by UI region; the `note` entry is prose. */
  uiChromeStringsInHtml: Record<string, string | string[]>;
  htmlVsMd: Record<string, unknown>;
  /** Source defects per page path that an exact migration must preserve; the `note` entry is prose. */
  authoringAnomalies: Record<string, string | string[]>;
  files: Record<string, string>;
}

export interface LoadedSourceTruth extends SourceTruth {
  readonly dir: string;
  /** Throws for a path truth.json does not describe, so a typo can never pass as an absent page. */
  pageByPath(path: string): SourceTruthPage;
  /** Literal theme strings from uiChromeStringsInHtml; none of them may survive into migrated output. */
  chromeStrings(): string[];
}

export function isNavigationGroup(entry: SourceTruthNavigationEntry): entry is SourceTruthNavigationGroup {
  return 'group' in entry;
}

export function isNavigationLeaf(entry: SourceTruthNavigationEntry): entry is SourceTruthNavigationLeaf {
  return 'page' in entry;
}

const LAYOUT_DESCRIPTION = [...SOURCE_TRUTH_FILES, ...SOURCE_TRUTH_DIRECTORIES.map((directory) => `${directory}/`)].join(', ');

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function assertSourceTruthLayout(dir: string): void {
  if (!isDirectory(dir)) throw new Error(`${SOURCE_TRUTH_ENV}: ${dir} is not a directory; it must hold the saved raw source (${LAYOUT_DESCRIPTION})`);
  const missing = [
    ...SOURCE_TRUTH_FILES.filter((file) => !isFile(join(dir, file))),
    ...SOURCE_TRUTH_DIRECTORIES.filter((directory) => !isDirectory(join(dir, directory))).map((directory) => `${directory}/`),
  ];
  if (missing.length) throw new Error(`${SOURCE_TRUTH_ENV}: ${dir} is missing ${missing.join(', ')}; it must hold the saved raw source (${LAYOUT_DESCRIPTION})`);
}

export function resolveSourceTruthDir(): string {
  const dir = process.env[SOURCE_TRUTH_ENV];
  if (!dir) throw new Error(`${SOURCE_TRUTH_ENV} is not set; point it at the saved raw source directory (${LAYOUT_DESCRIPTION}) to run the proof tier`);
  assertSourceTruthLayout(dir);
  return dir;
}

function assertSourceTruthShape(value: unknown, file: string): asserts value is SourceTruth {
  const truth = value as Partial<SourceTruth> | null;
  const problems: string[] = [];
  if (!truth || typeof truth !== 'object') problems.push('root is not an object');
  else {
    if (typeof truth.site?.name !== 'string') problems.push('site.name');
    if (typeof truth.pageCount !== 'number') problems.push('pageCount');
    if (!Array.isArray(truth.pages)) problems.push('pages[]');
    else {
      if (truth.pages.length !== truth.pageCount) problems.push(`pages.length ${truth.pages.length} differs from pageCount ${truth.pageCount}`);
      if (truth.pages.some((page) => typeof page?.path !== 'string')) problems.push('pages[].path');
    }
    if (!Array.isArray(truth.navigationHierarchy)) problems.push('navigationHierarchy[]');
    if (!truth.uiChromeStringsInHtml || typeof truth.uiChromeStringsInHtml !== 'object') problems.push('uiChromeStringsInHtml');
  }
  if (problems.length) throw new Error(`${file} does not have the source-truth shape: ${problems.join('; ')}`);
}

/**
 * uiChromeStringsInHtml mixes literal theme strings, optionally followed by one
 * parenthesised annotation ("Expand image (image lightbox button aria-label)"),
 * with prose that describes strings instead of quoting one ("group labels: …",
 * "Steps numbering "1".."7" (…)", "Previous: <sidebarTitle> / Next: <sidebarTitle>").
 * Descriptions cite text in double quotes, use <placeholders>, separate
 * alternatives with "/", introduce a list with ": ", or carry an "(e.g. …)"
 * annotation listing the varying strings they stand for. The `note`, `meta`
 * and `notPresentInThisTheme` sections hold prose, tag attributes and strings
 * that are absent by definition. Entries whose annotation traces them to
 * docs.json (navbar links, footer socials) are authored site configuration
 * that the migration carries, not theme chrome.
 */
const DESCRIPTIVE_SECTIONS = new Set(['note', 'meta', 'notPresentInThisTheme']);
const DESCRIPTION_MARKERS = /["<\/]|:\s/;
const ANNOTATED_ENTRY = /^(.*?)\s+\(([^()]*)\)$/;
const EXAMPLES_ANNOTATION = /^e\.g\./;
const SITE_CONFIGURATION_SOURCE = 'docs.json';

function literalChromeStrings(sections: SourceTruth['uiChromeStringsInHtml']): string[] {
  const strings: string[] = [];
  for (const [section, entries] of Object.entries(sections)) {
    if (DESCRIPTIVE_SECTIONS.has(section) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      const annotated = entry.match(ANNOTATED_ENTRY);
      const text = annotated ? annotated[1] : entry;
      const annotation = annotated ? annotated[2] : '';
      if (DESCRIPTION_MARKERS.test(text) || EXAMPLES_ANNOTATION.test(annotation) || annotation.includes(SITE_CONFIGURATION_SOURCE)) continue;
      strings.push(text);
    }
  }
  return strings;
}

export function loadTruth(dir: string = resolveSourceTruthDir()): LoadedSourceTruth {
  assertSourceTruthLayout(dir);
  const file = join(dir, 'truth.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assertSourceTruthShape(parsed, file);
  const pagesByPath = new Map(parsed.pages.map((page): [string, SourceTruthPage] => [page.path, page]));
  return {
    ...parsed,
    dir,
    pageByPath: (path) => {
      const page = pagesByPath.get(path);
      if (!page) throw new Error(`${file} has no page at ${path}; known paths: ${[...pagesByPath.keys()].join(', ')}`);
      return page;
    },
    chromeStrings: () => literalChromeStrings(parsed.uiChromeStringsInHtml),
  };
}
