#!/usr/bin/env bun
/**
 * [fork-only] Imports the upstream Archon docs into the fork's docs-system corpus.
 *
 * Reads the Starlight pages in packages/docs-web/src/content/docs and writes one
 * docs-system bundle (<page>/doc.json) per page under docs/, in the layers
 * 00-foundation, 10-system-design, 20-implementation and 30-authoring. It also writes
 * one parent doc per layer, and a parent doc for each upstream folder without index.md.
 *
 * Pipeline for each page (the same steps as `docs-cli migrate` of docs-system):
 *   1. Preprocess Starlight-only syntax into Markdown that the docs-system converter reads:
 *      asides become <Callout> tags, <Card> tags become headings, indentation fits the
 *      converter, site links become corpus doc links, and pipe tables and multi-block
 *      asides become placeholders.
 *      Each em dash in the prose becomes other punctuation by the rules in em-dash.ts,
 *      because the docs-system lint rejects em dashes.
 *   2. mdxToDoc (docs-system docs-cli) converts the Markdown into a DocDocument.
 *   3. applyOps (docs-system docs-model) turns each placeholder into a structured-table
 *      block or into the children of its callout.
 *   4. validateDocDocument and serializeDocDocument (docs-system docs-model) give doc.json.
 *
 * The script is rerunnable. Its output depends only on the upstream pages and this file.
 * It owns only bundles whose root carries `generated_by` with this script's path:
 *   - it rewrites such a bundle only when the content changes,
 *   - it deletes such a bundle when its upstream page is gone,
 *   - it never writes over or deletes a bundle without the marker, so pages that the fork
 *     writes through the docs tools (FORK_PAGES and any later page) stay as they are.
 *
 * It needs a docs-system checkout (github.com/Codecaine-AI/docs-system) with its
 * dependencies installed: DOCS_SYSTEM_DIR, else ../docs-system next to the main checkout.
 *
 * Usage: bun scripts/codecaine/import-upstream-docs.ts [--renumber <corpus folder>]...
 *   --renumber names the bundles of one folder (for example 30-authoring/20-guides) again in
 *   sidebar order. Use it when the script stops because new pages do not fit in order.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { type EmDashRule, emptyCounts, replaceEmDashes } from './em-dash';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const SCRIPT_PATH = 'scripts/codecaine/import-upstream-docs.ts';
const UPSTREAM_DIR = 'packages/docs-web/src/content/docs';
const DOCS_DIR = 'docs';
/** The published upstream site. Links to site paths that are not pages point here. */
const UPSTREAM_SITE = 'https://archon.diy';

/** The upstream home page. */
const HOME = { source: 'docs.mdx', target: '00-foundation/20-archon' };

/** Each upstream folder and the corpus section it becomes. */
const SECTIONS: { source: string; target: string; title: string }[] = [
  { source: 'brand', target: '00-foundation/30-brand', title: 'Brand' },
  { source: 'reference', target: '10-system-design/10-reference', title: 'Reference' },
  { source: 'adapters', target: '10-system-design/20-adapters', title: 'Adapters' },
  { source: 'contributing', target: '20-implementation/10-contributing', title: 'Contributing' },
  { source: 'deployment', target: '20-implementation/20-deployment', title: 'Deployment' },
  {
    source: 'getting-started',
    target: '30-authoring/10-getting-started',
    title: 'Getting Started',
  },
  { source: 'guides', target: '30-authoring/20-guides', title: 'Guides' },
];

/** Titles for upstream subfolders that have no index.md. */
const SUBFOLDER_TITLES: Record<string, string> = {
  'adapters/community': 'Community Adapters',
};

/** Said on each layer page, after its lead. */
const PUNCTUATION_NOTE =
  'The import replaces each em dash of the upstream prose with a colon, a comma, parentheses or a hyphen.';

const LAYERS: { dir: string; title: string; lead: string[] }[] = [
  {
    dir: '00-foundation',
    title: 'Foundation',
    lead: [
      'Foundation says what Archon is and why this fork exists.',
      'The purpose page belongs to the fork. The other pages are converted copies of the upstream Archon docs.',
    ],
  },
  {
    dir: '10-system-design',
    title: 'System Design',
    lead: [
      'System Design says how Archon behaves: the workflow language, the engine, the adapters and the node modes of the fork.',
      'The node modes page belongs to the fork. The other pages are converted copies of the upstream Archon docs.',
    ],
  },
  {
    dir: '20-implementation',
    title: 'Implementation',
    lead: [
      'Implementation says how the Archon code is built, tested, released and deployed.',
      'Each page is a converted copy of the upstream Archon docs.',
    ],
  },
  {
    dir: '30-authoring',
    title: 'Authoring',
    lead: [
      'Authoring is a guides tier. It holds the procedures to install Archon and to write workflows, commands and nodes.',
      'The guides do not set contracts. System Design holds the contracts.',
      'Each page is a converted copy of the upstream Archon docs.',
    ],
  },
];

/** Pages that the fork writes through the docs tools. The script lists them and never writes them. */
const FORK_PAGES: { path: string; title: string; summary: string }[] = [
  {
    path: '00-foundation/10-purpose',
    title: 'Purpose',
    summary: 'What the fork is, what it changes, and what stays upstream code.',
  },
  {
    path: '10-system-design/60-node-modes',
    title: 'Node Modes: extract and decide',
    summary: 'The two node modes that the fork adds to the workflow grammar.',
  },
];

// ---------------------------------------------------------------------------
// docs-system library
// ---------------------------------------------------------------------------

type Span = { insert: string; attributes?: Record<string, unknown> };
type Block = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  text?: Span[];
  children: string[];
};
type Doc = { root: string; blocks: Record<string, Block> };
type Op = Record<string, unknown> & { type: string };
type Issue = { path: string; message: string };
type TableCell = string | Span[];

interface DocsSystem {
  mdxToDoc(source: string, docPath: string): { doc: Doc; warnings: string[] };
  applyOps(doc: Doc, ops: Op[]): { ok: true; doc: Doc } | { ok: false; issues: Issue[] };
  validateDocDocument(doc: unknown): { ok: true; document: Doc } | { ok: false; issues: Issue[] };
  serializeDocDocument(doc: Doc): string;
  parseTableCellInput(value: string): TableCell;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function loadDocsSystem(repoRoot: string): Promise<DocsSystem> {
  const mainCheckout = dirname(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)));
  const dir = process.env.DOCS_SYSTEM_DIR || resolve(mainCheckout, '..', 'docs-system');
  const file = (path: string): string => join(dir, path);
  const converter = file('packages/docs-cli/src/migrate/mdx-to-doc.ts');
  if (!existsSync(converter)) {
    throw new Error(
      `docs-system not found at ${dir}. Clone github.com/Codecaine-AI/docs-system, run ` +
        '`bun install` in it, and set DOCS_SYSTEM_DIR to its path.'
    );
  }
  const [cli, ops, schema, table] = await Promise.all([
    import(converter),
    import(file('packages/docs-model/src/doc-ops.ts')),
    import(file('packages/docs-model/src/doc-schema.ts')),
    import(file('packages/docs-model/src/components/structured-table/lib.ts')),
  ]);
  return {
    mdxToDoc: cli.mdxToDoc,
    applyOps: ops.applyOps,
    validateDocDocument: schema.validateDocDocument,
    serializeDocDocument: schema.serializeDocDocument,
    parseTableCellInput: table.parseTableCellInput,
  };
}

// ---------------------------------------------------------------------------
// Upstream pages
// ---------------------------------------------------------------------------

export type Page = {
  /** Path relative to UPSTREAM_DIR. */
  source: string;
  /** Bundle path relative to DOCS_DIR. */
  target: string;
  title: string;
  description: string;
};

type Frontmatter = {
  lines: string[];
  body: string;
  title: string;
  description: string;
  order: number;
};

/** Replaces the em dashes in `text`, and adds the replacements to `counts` when given. */
function noEmDash(text: string, counts?: Record<EmDashRule, number>): string {
  const result = replaceEmDashes(text);
  if (counts) {
    for (const rule of Object.keys(counts) as EmDashRule[]) counts[rule] += result.counts[rule];
  }
  return result.text;
}

/** Reads the frontmatter. Em dashes in the title and description become other punctuation. */
function readFrontmatter(source: string, counts?: Record<EmDashRule, number>): Frontmatter {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  const head = match ? match[1] : '';
  const body = match ? source.slice(match[0].length) : source;
  const lines = head
    .split('\n')
    .map(line =>
      line.replace(
        /^(title|description):(.*)$/,
        (_whole, key: string, text: string) => `${key}:${noEmDash(text, counts)}`
      )
    );
  const value = (key: string): string =>
    (lines.find(line => line.startsWith(`${key}:`)) ?? '')
      .slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  const order = head.match(/^sidebar:\s*\n(?:[ \t]+.*\n)*?[ \t]+order:\s*(\d+)/m);
  return {
    // Flat top-level keys only. Nested keys (sidebar, hero) are Starlight site settings.
    lines: lines.filter(
      line => /^[A-Za-z0-9_.-]+:\s*\S/.test(line) && !line.startsWith('template:')
    ),
    body,
    title: value('title'),
    description: value('description'),
    order: order ? Number(order[1]) : Number.MAX_SAFE_INTEGER,
  };
}

export type Parent = { target: string; title: string; source: string };

/**
 * The bundles that the corpus holds already. `targets` maps the upstream source of each
 * generated bundle (a page path, or a folder path for a folder page) to its bundle path.
 * `names` lists the bundle folders inside one corpus folder. `renumber` lists the corpus
 * folders whose bundles take new names (the --renumber flag).
 */
export type Existing = {
  targets: Map<string, string>;
  names: (folder: string) => string[];
  renumber?: Set<string>;
};

function slug(name: string): string {
  return name.replace(/\.(md|mdx)$/, '');
}

function prefixOf(name: string): number {
  return Number(name.match(/^(\d+)-/)?.[1] ?? Number.NaN);
}

/** The flag that renumbers the bundles of one corpus folder. */
const RENUMBER_FLAG = '--renumber';

/**
 * Names the bundles of one folder's siblings, given in sidebar order. A sibling with a
 * bundle in `folder` keeps its name, so an upstream page that is added or removed never
 * moves another bundle. A bundle is the sibling's when its upstream_path names the
 * sibling, or when it has the sibling's slug and no source claims it.
 *
 * The new siblings between two named neighbors (or a folder end) form one run. A run takes
 * free two-digit prefixes in that gap: the rank prefixes (gaps of 10, or of 5 above 8
 * siblings) when they all fit, else prefixes spread evenly over the free ones. When the gap
 * has fewer free prefixes than the run, or the existing names are out of sidebar order, it
 * throws, so the script never writes a corpus in the wrong order. A folder in
 * `existing.renumber` keeps no names and takes the rank prefixes again.
 */
export function allocateNames(
  folder: string,
  siblings: { source: string; slug: string }[],
  existing: Existing
): string[] {
  const step = siblings.length > 8 ? 5 : 10;
  const claimed = new Set(existing.targets.values());
  const renumber = existing.renumber?.has(folder) ?? false;
  const names: (string | undefined)[] = siblings.map(sibling => {
    if (renumber) return undefined;
    const target = existing.targets.get(sibling.source);
    if (target !== undefined && dirname(target) === folder) return basename(target);
    // A bundle with the same slug that no source claims, such as a folder page written
    // before folder pages carried upstream_path, belongs to this sibling.
    return existing
      .names(folder)
      .find(
        name => name.replace(/^\d+-/, '') === sibling.slug && !claimed.has(`${folder}/${name}`)
      );
  });
  const used = new Set(
    [
      // A renumbered folder drops its generated bundles, so only the others hold prefixes.
      ...existing.names(folder).filter(name => !renumber || !claimed.has(`${folder}/${name}`)),
      ...names.filter(name => name !== undefined),
    ].map(prefixOf)
  );
  const fail = (problem: string, pages: number[]): never => {
    throw new Error(
      `${DOCS_DIR}/${folder}: ${problem}: ${pages.map(i => siblings[i].source).join(', ')}. ` +
        `Run the import with \`${RENUMBER_FLAG} ${folder}\` to renumber the bundles of this ` +
        'folder in sidebar order. Links to its pages change with the paths.'
    );
  };
  for (let i = 0; i < siblings.length; i++) {
    if (names[i] !== undefined) continue;
    let last = i;
    while (last + 1 < siblings.length && names[last + 1] === undefined) last += 1;
    const run = Array.from({ length: last - i + 1 }, (_, k) => i + k);
    const prev = i > 0 ? prefixOf(names[i - 1] as string) : 0;
    const next = last + 1 < siblings.length ? prefixOf(names[last + 1] as string) : 100;
    const free = Array.from(
      { length: Math.max(0, next - prev - 1) },
      (_, k) => prev + 1 + k
    ).filter(n => !used.has(n));
    if (free.length < run.length) {
      fail(`${free.length} free prefixes between ${prev} and ${next} for the new pages`, run);
    }
    const ranks = run.map(s => 10 + s * step);
    const chosen = ranks.every(n => free.includes(n))
      ? ranks
      : run.map((_, k) => free[Math.floor(((k + 1) * (free.length + 1)) / (run.length + 1)) - 1]);
    run.forEach((s, k) => {
      used.add(chosen[k]);
      names[s] = `${String(chosen[k]).padStart(2, '0')}-${siblings[s].slug}`;
    });
    i = last;
  }
  const outOfOrder = siblings
    .map((_, i) => i)
    .filter(i => i > 0 && prefixOf(names[i] as string) <= prefixOf(names[i - 1] as string));
  if (outOfOrder.length > 0) fail('the bundle prefixes are out of sidebar order', outOfOrder);
  return names as string[];
}

/** Lists the pages of one upstream folder, in sidebar order, under one corpus folder. */
export function collectFolder(
  upstreamRoot: string,
  source: string,
  target: string,
  pages: Page[],
  parents: Parent[],
  title: string,
  existing: Existing
): void {
  const dir = join(upstreamRoot, source);
  const entries = readdirSync(dir, { withFileTypes: true });
  const index = entries.find(entry => entry.isFile() && /^index\.mdx?$/.test(entry.name));
  if (index) {
    const fm = readFrontmatter(readFileSync(join(dir, index.name), 'utf8'));
    pages.push({
      source: `${source}/${index.name}`,
      target,
      title: fm.title,
      description: fm.description,
    });
  } else {
    parents.push({ target, title, source });
  }

  const files = entries
    .filter(entry => entry.isFile() && /\.mdx?$/.test(entry.name) && entry !== index)
    .map(entry => {
      const fm = readFrontmatter(readFileSync(join(dir, entry.name), 'utf8'));
      return { name: entry.name, fm };
    })
    .sort(
      (a, b) =>
        a.fm.order - b.fm.order ||
        a.fm.title.localeCompare(b.fm.title, 'en') ||
        a.name.localeCompare(b.name, 'en')
    );
  const folders = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const names = allocateNames(
    target,
    [
      ...files.map(file => ({ source: `${source}/${file.name}`, slug: slug(file.name) })),
      ...folders.map(folder => ({ source: `${source}/${folder}`, slug: folder })),
    ],
    existing
  );
  files.forEach((file, i) => {
    pages.push({
      source: `${source}/${file.name}`,
      target: `${target}/${names[i]}`,
      title: file.fm.title,
      description: file.fm.description,
    });
  });
  folders.forEach((folder, i) => {
    const sub = `${source}/${folder}`;
    collectFolder(
      upstreamRoot,
      sub,
      `${target}/${names[files.length + i]}`,
      pages,
      parents,
      SUBFOLDER_TITLES[sub] ?? folder,
      existing
    );
  });
}

/** The upstream site path of a page: reference/cli.md -> reference/cli, guides/index.md -> guides. */
function sitePath(source: string): string {
  if (source === HOME.source) return '';
  return slug(source).replace(/(^|\/)index$/, '');
}

// ---------------------------------------------------------------------------
// Preprocessing: Starlight Markdown -> docs-system Markdown
// ---------------------------------------------------------------------------

const ASIDE_END = 'ARCHONIMPORTASIDEEND';
const TABLE_MARK = 'ARCHONIMPORTTABLE';
const ASIDE_TONES: Record<string, string> = {
  note: 'info',
  tip: 'success',
  caution: 'warning',
  warning: 'warning',
  danger: 'risk',
};

/** Applies `edit` to each line outside fenced code. */
function outsideFences(lines: string[], edit: (line: string) => string): string[] {
  let fence: string | null = null;
  return lines.map(line => {
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
      return line;
    }
    return fence === null ? edit(line) : line;
  });
}

/**
 * Points each relative link at its corpus page, or at the upstream site when no page has
 * that path. A relative link to a .md or .mdx file names a source file, so it resolves
 * beside the page's source file. Any other relative link is a site path, so it resolves
 * beneath the page's site URL, as the browser does.
 */
export function rewriteLinks(line: string, page: Page, siteTargets: Map<string, string>): string {
  return line.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return whole;
    const sourceFile = !href.startsWith('/') && /\.mdx?(?:#|$)/.test(href);
    const base = sourceFile
      ? `${UPSTREAM_SITE}/${page.source}`
      : `${UPSTREAM_SITE}/${sitePath(page.source)}${page.source === HOME.source ? '' : '/'}`;
    const url = new URL(href, base);
    const path = sourceFile
      ? sitePath(decodeURIComponent(url.pathname.slice(1)))
      : url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.(md|mdx)$/, '');
    const target = siteTargets.get(path);
    if (target === undefined) return `](${UPSTREAM_SITE}${url.pathname}${url.hash})`;
    return `](/${DOCS_DIR}/${target}.md${url.hash})`;
  });
}

/** Turns each <Card> into a heading and drops the <CardGrid> and <Card> wrapper lines. */
export function convertCards(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^import .* from '@astrojs\/starlight\/components';$/.test(trimmed)) continue;
    if (/^<\/?CardGrid\b[^>]*>$/.test(trimmed) || trimmed === '</Card>') continue;
    const card = trimmed.match(/^<Card\b[^>]*\btitle="([^"]*)"[^>]*>$/);
    out.push(card ? `### ${card[1]}\n` : line);
  }
  return out;
}

/**
 * Fits indentation to the docs-system converter, which reads each line by itself.
 *   - A list item line keeps its indentation, which sets its nesting.
 *   - A line of fenced code loses only the indentation of its opening fence, measured in
 *     Markdown columns (a tab advances to the next multiple of 4), so the code keeps the
 *     indentation that upstream gives it. A tab that crosses the fence column leaves its
 *     columns past it as spaces.
 *   - Every other line loses its indentation, so a card body, or a table or an aside
 *     inside a list item, starts at column 0. The converter makes a continuation line of
 *     a list item its own paragraph with or without the indentation.
 */
export function fitIndentation(lines: string[]): string[] {
  let fence: { marker: string; indent: number } | null = null;
  return lines.map(line => {
    const marker = line.match(/^(\s*)(```+|~~~+)/);
    if (fence === null && marker) {
      fence = { marker: marker[2], indent: dedent(marker[1], Number.POSITIVE_INFINITY).columns };
      return line.trimStart();
    }
    if (fence !== null) {
      if (marker?.[2].startsWith(fence.marker)) {
        fence = null;
        return line.trimStart();
      }
      return dedent(line, fence.indent).line;
    }
    return /^\s*(?:[-*+]|\d+\.)\s/.test(line) ? line : line.trimStart();
  });
}

/**
 * Removes up to `columns` Markdown columns of leading spaces and tabs from `line`. A tab
 * advances to the next multiple of 4, as CommonMark defines. Also gives the columns removed.
 */
function dedent(line: string, columns: number): { line: string; columns: number } {
  let column = 0;
  let i = 0;
  for (; i < line.length && column < columns; i++) {
    if (line[i] === ' ') column += 1;
    else if (line[i] === '\t') column += 4 - (column % 4);
    else break;
  }
  const over = Math.max(0, column - columns);
  return { line: ' '.repeat(over) + line.slice(i), columns: column - over };
}

/** Replaces each raw <iframe> with a link to the page it embeds on the upstream site. */
function convertIframes(body: string): string {
  return body.replace(/<iframe\b([\s\S]*?)><\/iframe>/g, (_whole, attrs: string) => {
    const src = attrs.match(/\bsrc="([^"]*)"/)?.[1] ?? '';
    const title = attrs.match(/\btitle="([^"]*)"/)?.[1] ?? src;
    return `[${title}](${new URL(src, UPSTREAM_SITE).href})`;
  });
}

function isPlainParagraph(lines: string[]): boolean {
  return (
    lines.length > 0 &&
    !lines.some(line => line.trim() === '' || /^\s*(```|~~~|[-*+] |\d+\. |\||#|>)/.test(line))
  );
}

function convertAsides(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
    }
    const open = fence === null ? line.match(/^:::(\w+)(?:\[(.*)\])?\s*$/) : null;
    if (!open || !(open[1] in ASIDE_TONES)) {
      out.push(line);
      continue;
    }
    const body: string[] = [];
    let inner: string | null = null;
    for (i += 1; i < lines.length; i++) {
      const bodyMarker = lines[i].match(/^\s*(```+|~~~+)/)?.[1];
      if (bodyMarker) {
        if (inner === null) inner = bodyMarker;
        else if (bodyMarker.startsWith(inner)) inner = null;
      }
      if (inner === null && /^:::\s*$/.test(lines[i])) break;
      body.push(lines[i]);
    }
    while (body.length > 0 && body[0].trim() === '') body.shift();
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    const title = open[2] ?? open[1][0].toUpperCase() + open[1].slice(1);
    const quote = title.includes('"') ? "'" : '"';
    const tag = `<Callout tone="${ASIDE_TONES[open[1]]}" title=${quote}${title}${quote}>`;
    const blank = body.indexOf(body.find(l => l.trim() === '') ?? '\u0000');
    const leadEnd = blank < 0 ? body.length : blank;
    const lead = isPlainParagraph(body.slice(0, leadEnd)) ? body.slice(0, leadEnd) : [];
    const rest = body.slice(lead.length);
    out.push('', tag, ...lead, '</Callout>', '');
    if (rest.some(l => l.trim() !== '')) out.push(...rest, '', ASIDE_END, '');
  }
  return out;
}

function splitRow(row: string): string[] {
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\' && inner[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (char === '`') {
      code = !code;
      cell += char;
    } else if (char === '|' && !code) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * Runs the em dash rule on each prose unit outside fenced code. A unit is a paragraph or
 * a list item with its continuation lines. A line that opens with a bold label
 * ("**Code:**") starts a new unit. A heading or an HTML or component tag line is a unit by
 * itself, so the rule never pairs dashes across two blocks.
 */
function replaceProseDashes(lines: string[], counts: Record<EmDashRule, number>): string[] {
  const out: string[] = [];
  let unit: string[] = [];
  const flush = (): void => {
    if (unit.length > 0) out.push(...noEmDash(unit.join('\n'), counts).split('\n'));
    unit = [];
  };
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) {
      flush();
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
      out.push(line);
    } else if (fence !== null || line.trim() === '') {
      flush();
      out.push(line);
    } else if (/^\s*(#|<)/.test(line)) {
      flush();
      unit.push(line);
      flush();
    } else {
      if (/^\s*([-*+]|\d+\.)\s|^\s*(>|:::|\||\*\*[^*]+:\*\*)/.test(line)) flush();
      unit.push(line);
    }
  }
  flush();
  return out;
}

function convertTables(
  lines: string[],
  tables: string[][][],
  counts: Record<EmDashRule, number>
): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence)) fence = null;
    }
    const isTable =
      fence === null &&
      lines[i].startsWith('|') &&
      /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '');
    if (!isTable) {
      out.push(lines[i]);
      continue;
    }
    const row = (line: string): string[] => splitRow(line).map(cell => noEmDash(cell, counts));
    const rows: string[][] = [row(lines[i])];
    for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(row(lines[i]));
    i -= 1;
    out.push('', `${TABLE_MARK} ${tables.length}`, '');
    tables.push(rows);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function plainText(block: Block): string {
  return (block.text ?? []).map(span => span.insert).join('');
}

/**
 * mdxToDoc keeps backticks inside link text as literal characters. Splits each linked
 * span at its backtick pairs and marks the code parts, so [`x`](y) becomes code x linked to y.
 */
function codeInLinks(spans: Span[]): Span[] | null {
  let changed = false;
  const out = spans.flatMap(span => {
    const attrs = span.attributes ?? {};
    if (!(attrs.link || attrs.reference) || !/`[^`]+`/.test(span.insert)) return [span];
    changed = true;
    return span.insert
      .split(/(`[^`]+`)/)
      .filter(part => part !== '')
      .map(part =>
        /^`[^`]+`$/.test(part)
          ? { insert: part.slice(1, -1), attributes: { ...attrs, code: true } }
          : { insert: part, attributes: attrs }
      );
  });
  return changed ? out : null;
}

function cellWithCode(cell: TableCell): TableCell {
  return typeof cell === 'string' ? cell : (codeInLinks(cell) ?? cell);
}

function blockId(docPath: string, kind: string, n: number): string {
  return `${kind}-${n}-${createHash('sha1').update(docPath).digest('hex').slice(0, 8)}`;
}

/** Marks code in link text, turns table placeholders into structured-table blocks and closes multi-block asides. */
function structureOps(ds: DocsSystem, doc: Doc, docPath: string, tables: string[][][]): Op[] {
  const ops: Op[] = [];
  for (const block of Object.values(doc.blocks)) {
    const text = block.text ? codeInLinks(block.text) : null;
    if (text) ops.push({ type: 'updateBlock', blockId: block.id, text });
  }
  const children = [...doc.blocks[doc.root].children];
  // Blocks that the ops insert are not in doc.blocks yet, so they read as empty text.
  const textOf = (id: string): string => {
    const block = doc.blocks[id];
    return block ? plainText(block) : '';
  };

  // Tables first: each placeholder paragraph is replaced in place.
  for (const id of [...children]) {
    const mark = textOf(id).match(new RegExp(`^${TABLE_MARK} (\\d+)$`));
    if (!mark) continue;
    const rows = tables[Number(mark[1])];
    const parse = (cell: string): TableCell => cellWithCode(ds.parseTableCellInput(cell));
    const columns = rows[0].map(parse);
    const width = columns.length;
    const body = rows
      .slice(1)
      .map(row => Array.from({ length: width }, (_, c) => parse(row[c] ?? '')));
    const index = children.indexOf(id);
    const tableId = blockId(docPath, 'table', Number(mark[1]));
    ops.push(
      {
        type: 'insertBlock',
        blockId: tableId,
        parentId: doc.root,
        index,
        blockType: 'structured-table',
        props: { columns, rows: body },
      },
      { type: 'deleteBlock', blockId: id }
    );
    children.splice(index, 1, tableId);
  }

  // Asides: move each block between a callout and its end marker into the callout.
  for (let i = 0; i < children.length; i++) {
    if (textOf(children[i]) !== ASIDE_END) continue;
    let start = i - 1;
    while (start >= 0 && doc.blocks[children[start]]?.type !== 'callout') start -= 1;
    if (start < 0) throw new Error(`${docPath}: aside end marker without a callout`);
    const callout = children[start];
    const moved = children.slice(start + 1, i);
    moved.forEach((id, n) => {
      ops.push({ type: 'moveBlock', blockId: id, toParentId: callout, toIndex: n });
    });
    ops.push({ type: 'deleteBlock', blockId: children[i] });
    children.splice(start + 1, moved.length + 1);
    i = start;
  }
  return ops;
}

function convert(ds: DocsSystem, markdown: string, target: string, tables: string[][][]): string {
  const docPath = `${DOCS_DIR}/${target}.md`;
  const { doc, warnings } = ds.mdxToDoc(markdown, docPath);
  for (const warning of warnings) console.warn(`[import] ${target}: ${warning}`);
  const applied = ds.applyOps(doc, structureOps(ds, doc, docPath, tables));
  if (!applied.ok) {
    throw new Error(`${target}: ${applied.issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
  }
  const valid = ds.validateDocDocument(applied.doc);
  if (!valid.ok) {
    throw new Error(`${target}: ${valid.issues.map(i => `${i.path} ${i.message}`).join('; ')}`);
  }
  return ds.serializeDocDocument(valid.document);
}

function pageMarkdown(
  source: string,
  page: Page,
  commit: string,
  siteTargets: Map<string, string>,
  tables: string[][][],
  counts: Record<EmDashRule, number>
): string {
  const fm = readFrontmatter(source, counts);
  let lines = fitIndentation(convertCards(convertIframes(fm.body).split('\n')));
  lines = outsideFences(lines, line =>
    rewriteLinks(line, page, siteTargets).replace(/<code\b[^>]*>([^<]*)<\/code>/g, '`$1`')
  );
  lines = replaceProseDashes(convertTables(convertAsides(lines), tables, counts), counts);
  const head = [
    ...fm.lines,
    `upstream_path: ${UPSTREAM_DIR}/${page.source}`,
    `upstream_commit: ${commit}`,
    `generated_by: ${SCRIPT_PATH}`,
  ];
  return `---\n${head.join('\n')}\n---\n\n${lines.join('\n')}`;
}

type Entry = { target: string; title: string; summary: string };

function indexMarkdown(title: string, lead: string[], entries: Entry[], source?: string): string {
  const items = entries.map(
    entry => `- [${entry.title}](/${DOCS_DIR}/${entry.target}.md): ${entry.summary}`
  );
  return [
    '---',
    `title: ${title}`,
    ...(source === undefined ? [] : [`upstream_path: ${UPSTREAM_DIR}/${source}`]),
    `generated_by: ${SCRIPT_PATH}`,
    '---',
    '',
    ...lead.flatMap(sentence => [sentence, '']),
    '## Contents',
    '',
    ...items,
    '',
  ].join('\n');
}

/** The direct children of `parent` among `entries`, sorted by path. */
function childrenOf(parent: string, entries: Entry[]): Entry[] {
  return entries
    .filter(entry => dirname(entry.target) === parent)
    .sort((a, b) => a.target.localeCompare(b.target, 'en'));
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** The root props of a bundle that this script generated, or null for any other bundle. */
function generatedProps(file: string): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Doc;
    const props = doc.blocks?.[doc.root]?.props;
    return props?.generated_by === SCRIPT_PATH ? props : null;
  } catch {
    return null;
  }
}

function isGenerated(file: string): boolean {
  return generatedProps(file) !== null;
}

/** Reads the existing bundle of each upstream source from the upstream_path of generated bundles. */
function readExisting(docsRoot: string): Existing {
  const targets = new Map<string, string>();
  for (const file of listBundles(docsRoot)) {
    const path = generatedProps(file)?.upstream_path;
    if (typeof path !== 'string' || !path.startsWith(`${UPSTREAM_DIR}/`)) continue;
    // A folder's index page and a folder page without one both stand for the folder.
    const source = path.slice(UPSTREAM_DIR.length + 1).replace(/\/index\.mdx?$/, '');
    targets.set(source, relative(docsRoot, dirname(file)));
  }
  const names = (folder: string): string[] => {
    const dir = join(docsRoot, folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  };
  return { targets, names };
}

function listBundles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listBundles(path));
    else if (entry.name === 'doc.json') found.push(path);
  }
  return found;
}

function pruneEmptyDirs(dir: string, root: string): void {
  for (
    let current = dir;
    current !== root && current.startsWith(root);
    current = dirname(current)
  ) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
  }
}

/** The corpus folders that the --renumber flags name. */
function renumberFolders(args: string[]): Set<string> {
  const folders = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const folder = args[i] === RENUMBER_FLAG ? args[++i] : undefined;
    if (folder === undefined || folder.startsWith('-')) {
      throw new Error(`Unknown argument ${args[i] ?? ''}. Usage: ${RENUMBER_FLAG} <corpus folder>`);
    }
    folders.add(folder.replace(new RegExp(`^${DOCS_DIR}/|/+$`, 'g'), ''));
  }
  return folders;
}

async function main(): Promise<void> {
  const repoRoot = git(['rev-parse', '--show-toplevel'], dirname(import.meta.path));
  const upstreamRoot = join(repoRoot, UPSTREAM_DIR);
  const docsRoot = join(repoRoot, DOCS_DIR);
  const ds = await loadDocsSystem(repoRoot);
  const commit = git(['log', '-1', '--format=%H', '--', UPSTREAM_DIR], repoRoot);

  const homeFm = readFrontmatter(readFileSync(join(upstreamRoot, HOME.source), 'utf8'));
  const pages: Page[] = [{ ...HOME, title: homeFm.title, description: homeFm.description }];
  const parents: Parent[] = [];
  const existing = readExisting(docsRoot);
  existing.renumber = renumberFolders(process.argv.slice(2));
  for (const section of SECTIONS) {
    collectFolder(
      upstreamRoot,
      section.source,
      section.target,
      pages,
      parents,
      section.title,
      existing
    );
  }
  for (const folder of existing.renumber) {
    if (![...pages, ...parents].some(page => page.target === folder)) {
      throw new Error(`${RENUMBER_FLAG} ${folder}: no generated corpus folder has this path.`);
    }
  }
  const covered = new Set([HOME.source, ...pages.map(page => page.source)]);
  for (const entry of readdirSync(upstreamRoot, { recursive: true, encoding: 'utf8' })) {
    if (/\.mdx?$/.test(entry) && !covered.has(entry)) {
      throw new Error(`Upstream page ${entry} has no section in SECTIONS.`);
    }
  }
  const siteTargets = new Map(pages.map(page => [sitePath(page.source), page.target]));

  const output = new Map<string, string>();
  const dashes = emptyCounts();
  for (const page of pages) {
    const tables: string[][][] = [];
    const markdown = pageMarkdown(
      readFileSync(join(upstreamRoot, page.source), 'utf8'),
      page,
      commit,
      siteTargets,
      tables,
      dashes
    );
    output.set(page.target, convert(ds, markdown, page.target, tables));
  }

  const entries: Entry[] = [
    ...pages.map(page => ({ target: page.target, title: page.title, summary: page.description })),
    ...parents.map(parent => ({
      target: parent.target,
      title: parent.title,
      summary: `The upstream ${parent.title} pages.`,
    })),
    ...FORK_PAGES.map(page => ({ target: page.path, title: page.title, summary: page.summary })),
  ];
  for (const parent of parents) {
    const lead = [
      `This section holds the converted copies of the upstream pages in \`${UPSTREAM_DIR}/${parent.source}\`.`,
    ];
    const markdown = indexMarkdown(
      parent.title,
      lead,
      childrenOf(parent.target, entries),
      parent.source
    );
    output.set(parent.target, convert(ds, markdown, parent.target, []));
  }
  for (const layer of LAYERS) {
    const lead = [...layer.lead, PUNCTUATION_NOTE];
    const markdown = indexMarkdown(layer.title, lead, childrenOf(layer.dir, entries));
    output.set(layer.dir, convert(ds, markdown, layer.dir, []));
  }

  let written = 0;
  let kept = 0;
  const skipped: string[] = [];
  for (const [target, content] of output) {
    const file = join(docsRoot, target, 'doc.json');
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') === content) {
        kept += 1;
        continue;
      }
      if (!isGenerated(file)) {
        skipped.push(target);
        continue;
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written += 1;
  }

  let removed = 0;
  for (const file of listBundles(docsRoot)) {
    const target = relative(docsRoot, dirname(file));
    if (output.has(target) || !isGenerated(file)) continue;
    rmSync(file);
    pruneEmptyDirs(dirname(file), docsRoot);
    removed += 1;
  }

  console.log(
    `[import] upstream ${commit.slice(0, 12)}: ${pages.length} pages, ${output.size} bundles; ` +
      `${written} written, ${kept} unchanged, ${removed} removed.`
  );
  const replaced = Object.entries(dashes).map(([rule, n]) => `${rule} ${n}`);
  console.log(
    `[import] em dashes replaced: ${Object.values(dashes).reduce((a, b) => a + b, 0)} (${replaced.join(', ')}).`
  );
  for (const target of skipped) {
    console.warn(`[import] kept ${target}: the bundle has no generated_by marker.`);
  }
}

if (import.meta.main) await main();
