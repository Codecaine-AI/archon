import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  allocateNames,
  collectFolder,
  convertCards,
  type Existing,
  fitIndentation,
  type Page,
  type Parent,
  rewriteLinks,
} from './import-upstream-docs';

const trackTempRoot = trackTempRoots();

describe('fitIndentation', () => {
  test('keeps the indentation of nested lists and of fenced code', () => {
    const lines = [
      '```yaml',
      'assistants:',
      '  claude:',
      '    model: sonnet',
      '```',
      '1. Create the app:',
      '   - App Name: any name',
      '     - a nested item',
    ];
    expect(fitIndentation(lines)).toEqual(lines);
  });

  test('removes the list indentation of fenced code in a list item', () => {
    expect(
      fitIndentation(['1. Set the config:', '   ```yaml', '   a:', '     b: 1', '   ```'])
    ).toEqual(['1. Set the config:', '```yaml', 'a:', '  b: 1', '```']);
  });

  test('removes the list indentation of tab-indented fenced code, by Markdown columns', () => {
    expect(
      fitIndentation(['1. Set the config:', '\t```yaml', '\ta:', '\t  b: 1', '\t```'])
    ).toEqual(['1. Set the config:', '```yaml', 'a:', '  b: 1', '```']);
    // A tab advances to column 4, so 1 of its columns is past a fence at column 3.
    expect(fitIndentation(['1. Set:', '   ```yaml', '   a:', '\tb: 1', '   ```'])).toEqual([
      '1. Set:',
      '```yaml',
      'a:',
      ' b: 1',
      '```',
    ]);
  });

  test('removes the indentation of other lines, such as a card body', () => {
    const cards = convertCards([
      '<CardGrid>',
      '  <Card title="Workflows you own" icon="document">',
      '    The workflow fixes the steps.',
      '  </Card>',
      '</CardGrid>',
    ]);
    expect(fitIndentation(cards)).toEqual([
      '### Workflows you own\n',
      'The workflow fixes the steps.',
    ]);
  });
});

describe('rewriteLinks', () => {
  const page: Page = {
    source: 'adapters/github.md',
    target: '10-system-design/20-adapters/40-github',
    title: 'GitHub',
    description: '',
  };
  const siteTargets = new Map([
    ['adapters/github', '10-system-design/20-adapters/40-github'],
    ['adapters/github-app-setup', '10-system-design/20-adapters/50-github-app-setup'],
    ['reference/cli', '10-system-design/10-reference/20-cli'],
  ]);

  test('resolves a link to a source file beside the source file', () => {
    expect(rewriteLinks('[setup](./github-app-setup.md#keys)', page, siteTargets)).toBe(
      '[setup](/docs/10-system-design/20-adapters/50-github-app-setup.md#keys)'
    );
  });

  test('resolves a site path beneath the page URL', () => {
    expect(rewriteLinks('[cli](../../reference/cli/)', page, siteTargets)).toBe(
      '[cli](/docs/10-system-design/10-reference/20-cli.md)'
    );
  });
});

describe('collectFolder', () => {
  /** Writes one upstream page per entry, with its sidebar order. */
  function writeUpstream(root: string, folder: string, orders: Record<string, number>): void {
    mkdirSync(join(root, folder), { recursive: true });
    for (const [name, order] of Object.entries(orders)) {
      writeFileSync(
        join(root, folder, `${name}.md`),
        `---\ntitle: ${name}\nsidebar:\n  order: ${order}\n---\n\nBody.\n`
      );
    }
  }

  function plan(root: string, existing: Existing): Map<string, string> {
    const pages: Page[] = [];
    const parents: Parent[] = [];
    collectFolder(root, 'guides', '30-authoring/20-guides', pages, parents, 'Guides', existing);
    return new Map(pages.map(page => [page.source, page.target]));
  }

  /** The corpus that a run with `targets` leaves on disk. */
  function existingFrom(targets: Map<string, string>): Existing {
    return {
      targets,
      names: folder =>
        [...targets.values()].filter(target => dirname(target) === folder).map(t => basename(t)),
    };
  }

  test('keeps every existing bundle path when upstream adds and removes pages', () => {
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'import-docs-')));
    const eight = { a: 10, b: 20, c: 30, d: 40, e: 50, f: 60, g: 70, h: 80 };
    writeUpstream(root, 'guides', eight);
    const before = plan(root, existingFrom(new Map()));
    expect(before.get('guides/a.md')).toBe('30-authoring/20-guides/10-a');
    expect(before.get('guides/h.md')).toBe('30-authoring/20-guides/80-h');

    // Two pages added (one between b and c, crossing 8 siblings) and one page removed.
    writeUpstream(root, 'guides', { 'b-and-a-half': 25, z: 90 });
    unlinkSync(join(root, 'guides', 'e.md'));
    const after = plan(root, existingFrom(before));

    for (const [source, target] of before) {
      if (source !== 'guides/e.md') expect(after.get(source)).toBe(target);
    }
    expect(after.has('guides/e.md')).toBe(false);
    expect(after.get('guides/b-and-a-half.md')).toBe('30-authoring/20-guides/25-b-and-a-half');
    expect(after.get('guides/z.md')).toBe('30-authoring/20-guides/90-z');
  });
});

describe('allocateNames', () => {
  const folder = '30-authoring/20-guides';

  /** Allocates names for `slugs` in sidebar order, where `named` maps a slug to its bundle. */
  function allocate(slugs: string[], named: Record<string, string>, renumber = false): string[] {
    const targets = new Map(
      Object.entries(named).map(([slug, name]) => [`guides/${slug}.md`, `${folder}/${name}`])
    );
    const existing: Existing = {
      targets,
      names: () => Object.values(named),
      renumber: renumber ? new Set([folder]) : undefined,
    };
    return allocateNames(
      folder,
      slugs.map(slug => ({ source: `guides/${slug}.md`, slug })),
      existing
    );
  }

  test('spreads the new pages of one gap over its free prefixes in sidebar order', () => {
    expect(allocate(['a', 'n1', 'n2', 'n3', 'n4', 'b'], { a: '10-a', b: '15-b' })).toEqual([
      '10-a',
      '11-n1',
      '12-n2',
      '13-n3',
      '14-n4',
      '15-b',
    ]);
  });

  test('fails, naming the folder and the pages, when the new pages do not fit in the gap', () => {
    expect(() =>
      allocate(['a', 'n1', 'n2', 'n3', 'n4', 'n5', 'b'], { a: '10-a', b: '15-b' })
    ).toThrow(
      'docs/30-authoring/20-guides: 4 free prefixes between 10 and 15 for the new pages: ' +
        'guides/n1.md, guides/n2.md, guides/n3.md, guides/n4.md, guides/n5.md. ' +
        'Run the import with `--renumber 30-authoring/20-guides`'
    );
  });

  test('places new pages at the start and at the end of a folder in order', () => {
    expect(
      allocate(['s1', 's2', 's3', 'a', 'b', 'e1', 'e2', 'e3'], { a: '04-a', b: '96-b' })
    ).toEqual(['01-s1', '02-s2', '03-s3', '04-a', '96-b', '97-e1', '98-e2', '99-e3']);
  });

  test('fails when existing bundles are out of sidebar order, and --renumber fixes it', () => {
    const named = { a: '20-a', b: '10-b' };
    expect(() => allocate(['a', 'b'], named)).toThrow('out of sidebar order: guides/b.md');
    expect(allocate(['a', 'b'], named, true)).toEqual(['10-a', '20-b']);
  });
});
