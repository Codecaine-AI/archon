import { describe, expect, test } from 'bun:test';
import { replaceEmDashes } from './em-dash';

// Each input is a real line of the upstream Archon docs.
const cases: { rule: string; input: string; output: string }[] = [
  { rule: 'empty-cell', input: '\u2014', output: '-' },
  {
    rule: 'term',
    input: '- **Logo** \u2014 the shield mark with the abstract Archon glyph',
    output: '- **Logo**: the shield mark with the abstract Archon glyph',
  },
  {
    rule: 'term',
    input: '- [Quick Start](/getting-started/quick-start/) \u2014 Run your first workflow',
    output: '- [Quick Start](/getting-started/quick-start/): Run your first workflow',
  },
  {
    rule: 'pair',
    input:
      'Anything gitignored \u2014 secrets, local planning docs, agent reports, IDE settings, data fixtures \u2014 is absent by default.',
    output:
      'Anything gitignored (secrets, local planning docs, agent reports, IDE settings, data fixtures) is absent by default.',
  },
  {
    rule: 'pair after a condition',
    input:
      'If the volume itself is gone \u2014 the only place the un-applied work lived \u2014 resume **fails loudly** rather than silently restarting from an empty overlay.',
    output:
      'If the volume itself is gone (the only place the un-applied work lived), resume **fails loudly** rather than silently restarting from an empty overlay.',
  },
  {
    rule: 'comma',
    input:
      '- **Server Channels**: @mention the bot (e.g., `@YourBotName help me with this code`) \u2014 or any authorized message when `DISCORD_REQUIRE_MENTION=false`',
    output:
      '- **Server Channels**: @mention the bot (e.g., `@YourBotName help me with this code`), or any authorized message when `DISCORD_REQUIRE_MENTION=false`',
  },
  {
    rule: 'paren-tail',
    input: '4. **Bash nodes:** Not affected \u2014 bash does not auto-load `.env` files.',
    output: '4. **Bash nodes:** Not affected (bash does not auto-load `.env` files).',
  },
  {
    rule: 'colon',
    input: 'Do not kill `claude.exe` processes \u2014 those are active Claude Code sessions.',
    output: 'Do not kill `claude.exe` processes: those are active Claude Code sessions.',
  },
  {
    rule: 'colon in a heading',
    input: '### `$STATE_DIR` \u2014 durable cross-run state',
    output: '### `$STATE_DIR`: durable cross-run state',
  },
  {
    rule: 'inline code stays',
    input:
      "`the prose 'loop_group.until' completion signal is deprecated. Declare 'loop_group.until_bash' instead \u2014 it can read a body node's structured output`",
    output:
      "`the prose 'loop_group.until' completion signal is deprecated. Declare 'loop_group.until_bash' instead \u2014 it can read a body node's structured output`",
  },
  {
    rule: 'en dash stays',
    input: 'Worktrees auto-allocate ports (3190\u20134089 range, hash-based on path).',
    output: 'Worktrees auto-allocate ports (3190\u20134089 range, hash-based on path).',
  },
];

// A link target keeps its em dash. The prose em dash before the link still changes.
const targets: { form: string; input: string; output: string }[] = [
  {
    form: 'title',
    input: 'Read this \u2014 [x](https://example.com/a\u2014b "the title").',
    output: 'Read this: [x](https://example.com/a\u2014b "the title").',
  },
  {
    form: 'nested parentheses',
    input: 'Read this \u2014 [x](https://example.com/a_(b)\u2014c).',
    output: 'Read this: [x](https://example.com/a_(b)\u2014c).',
  },
  {
    form: 'title in parentheses',
    input: 'Read this \u2014 [x](https://example.com/a\u2014b (a \u2014 title)).',
    output: 'Read this: [x](https://example.com/a\u2014b (a \u2014 title)).',
  },
  {
    form: 'angle brackets',
    input: 'Read this \u2014 [x](<https://example.com/a \u2014 b>).',
    output: 'Read this: [x](<https://example.com/a \u2014 b>).',
  },
  {
    form: 'reference definition',
    input: '[x]: https://example.com/a\u2014b "a \u2014 title"',
    output: '[x]: https://example.com/a\u2014b "a \u2014 title"',
  },
  {
    form: 'reference definition with the destination on the next line',
    input: '[x]:\n  https://example.com/a\u2014b',
    output: '[x]:\n  https://example.com/a\u2014b',
  },
  {
    form: 'reference definition with the title on the next line',
    input: '[x]: https://example.com/a\u2014b\n  "a \u2014 title"',
    output: '[x]: https://example.com/a\u2014b\n  "a \u2014 title"',
  },
  {
    form: 'reference definition with each part on its own line and a title over two lines',
    input: '[x]:\n<https://example.com/a\u2014b>\n(a \u2014 long\ntitle \u2014 here)',
    output: '[x]:\n<https://example.com/a\u2014b>\n(a \u2014 long\ntitle \u2014 here)',
  },
  {
    form: 'prose line after a reference definition',
    input: '[x]: https://example.com/a\u2014b\nRead this \u2014 now.',
    output: '[x]: https://example.com/a\u2014b\nRead this: now.',
  },
];

describe('replaceEmDashes in link targets', () => {
  for (const { form, input, output } of targets) {
    test(form, () => {
      expect(replaceEmDashes(input).text).toBe(output);
    });
  }
});

describe('replaceEmDashes', () => {
  for (const { rule, input, output } of cases) {
    test(rule, () => {
      expect(replaceEmDashes(input).text).toBe(output);
    });
  }

  test('leaves no em dash outside inline code', () => {
    for (const { input } of cases) {
      const prose = replaceEmDashes(input).text.replace(/`[^`]*`/g, '');
      expect(prose).not.toContain('\u2014');
    }
  });
});
