/**
 * [fork-only] Replaces the em dashes of imported upstream prose with other punctuation.
 *
 * The docs-system lint (writing.no-em-dash) rejects an em dash in authored prose, and the
 * upstream Archon docs use many. import-upstream-docs.ts runs this rule on each Markdown
 * prose unit (a paragraph, list item, heading or table cell) before conversion.
 *
 * The rules, in order. Each em dash takes the first rule that matches:
 *   1. empty-cell: a text that is only an em dash (a table cell meaning "none") becomes "-".
 *   2. term: an em dash right after a bold or linked term that opens a list item becomes a
 *      colon: "- **Logo** — the shield mark" -> "- **Logo**: the shield mark".
 *   3. pair: exactly two other em dashes in one sentence, inside the same brackets, enclose
 *      an aside. They become a pair of parentheses: "X — aside — Y" -> "X (aside) Y". When the
 *      sentence opens with a condition (CONDITION_WORDS) and has no comma before the aside, a
 *      comma follows it: "If X — aside — do Y" -> "If X (aside), do Y".
 *   4. comma: an em dash before a connecting word (COMMA_WORDS) becomes a comma:
 *      "X — or Y" -> "X, or Y".
 *   5. paren-tail: the only em dash of a sentence that already has a colon before it opens a
 *      parenthesis that closes at the end of the sentence, so the sentence keeps one colon:
 *      "Bash nodes: Not affected — bash skips it." -> "Bash nodes: Not affected (bash skips it)."
 *   6. colon: every other em dash introduces a definition, a list or an explanation, so it
 *      becomes a colon: "X — Y" -> "X: Y". This covers headings too.
 *
 * The rule changes only the em dash and the spaces around it. It never changes inline code
 * (`...`), a Markdown link target (the "(...)" after "]", with its title) or the destination
 * and title of a reference definition, also when they start on the next line, and it
 * rewrites nothing else.
 * En dashes (–) stay: the lint allows them.
 */

export type EmDashRule = 'empty-cell' | 'term' | 'pair' | 'comma' | 'paren-tail' | 'colon';

export type EmDashResult = { text: string; counts: Record<EmDashRule, number> };

/** Words that continue the clause before the dash, so a comma reads better than a colon. */
const COMMA_WORDS = new Set([
  'or',
  'and',
  'but',
  'so',
  'yet',
  'nor',
  'not',
  'which',
  'unless',
  'except',
  'including',
  'plus',
  'rather',
  'otherwise',
  'see',
  'whichever',
  'e.g.',
  'i.e.',
]);

/** Words that open a condition clause. A pair inside the clause closes with "),". */
const CONDITION_WORDS = /^\W*(?:If|When|Once|Unless|Because|While|Although|After|Before)\b[^,]*$/;

const PLACEHOLDER = '\uE000';
const DASH = '\u2014';

/** A bold or linked term that opens a list item. */
const LEADING_TERM =
  /^\s*(?:>\s*)?(?:[-*+]|\d+\.)\s+(?:\*\*[^*]+\*\*|\[[^\]]*\]\uE000*|\*\*\[[^\]]*\]\uE000*\*\*)$/;

export function emptyCounts(): Record<EmDashRule, number> {
  return { 'empty-cell': 0, term: 0, pair: 0, comma: 0, 'paren-tail': 0, colon: 0 };
}

/**
 * The end of the inline link target that opens at `open` (the "(" after "]"), or -1 when
 * the text there is not a link target. A target is an optional destination, either in angle
 * brackets or with balanced parentheses, then an optional title in quotes or parentheses.
 */
function targetEnd(text: string, open: number): number {
  let i = open + 1;
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  skipSpace();
  if (text[i] === '<') {
    while (i < text.length && text[i] !== '>' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '>') return -1;
    i += 1;
  } else {
    let depth = 0;
    for (; i < text.length && !/\s/.test(text[i]); i++) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && depth-- === 0) break;
    }
    if (depth > 0) return -1;
  }
  skipSpace();
  const quote = { '"': '"', "'": "'", '(': ')' }[text[i] ?? ''];
  if (quote !== undefined) {
    for (i += 1; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i += 1;
    if (i >= text.length) return -1;
    i += 1;
    skipSpace();
  }
  return text[i] === ')' ? i + 1 : -1;
}

/**
 * The end of the destination and title of the reference definition whose label ends at
 * `start` ("[label]:"), or `start` when none follows. As CommonMark defines, the
 * destination and the title can each start on the next line, and the title can span lines
 * up to a blank line and must end its line.
 */
function definitionEnd(text: string, start: number): number {
  let i = start;
  /** Skips spaces and at most one line end. False when a blank line comes first. */
  const skipSpace = (): boolean => {
    for (let newlines = 0; i < text.length && /\s/.test(text[i]); i++) {
      if (text[i] === '\n' && ++newlines > 1) return false;
    }
    return true;
  };
  if (!skipSpace()) return start;
  const destination = i;
  if (text[i] === '<') {
    while (i < text.length && text[i] !== '>' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '>') return start;
    i += 1;
  } else {
    while (i < text.length && !/\s/.test(text[i])) i += 1;
  }
  if (i === destination) return start;
  const end = i;
  if (!skipSpace()) return end;
  const quote = { '"': '"', "'": "'", '(': ')' }[text[i] ?? ''];
  if (quote === undefined) return end;
  for (i += 1; i < text.length && text[i] !== quote; i++) {
    if (text[i] === '\\') i += 1;
    else if (/^\n[ \t]*\n/.test(text.slice(i))) return end;
  }
  if (i >= text.length) return end;
  const rest = text.slice(i + 1).match(/^[ \t]*(?:\n|$)/);
  return rest ? i + 1 : end;
}

/**
 * Hides inline code and link targets behind placeholders of the same length. A link target
 * is the whole "(...)" after "]", with its title, and the destination and title of a
 * reference definition ("[label]: url "title""), on its label line or the next lines.
 */
function mask(text: string): string {
  const hide = (m: string): string => PLACEHOLDER.repeat(m.length);
  let masked = text.replace(/(`+)[\s\S]*?\1/g, hide);
  for (const label of masked.matchAll(/^ {0,3}\[[^\]\n]+\]:/gm)) {
    const start = (label.index ?? 0) + label[0].length;
    const end = definitionEnd(masked, start);
    const hidden = masked.slice(start, end).replace(/[^\n]/g, PLACEHOLDER);
    masked = masked.slice(0, start) + hidden + masked.slice(end);
  }
  for (let open = masked.indexOf('](') + 1; open > 0; open = masked.indexOf('](', open) + 1) {
    const end = targetEnd(masked, open);
    if (end > 0) masked = masked.slice(0, open) + hide(masked.slice(open, end)) + masked.slice(end);
  }
  return masked;
}

type Dash = {
  start: number;
  end: number;
  /** Sentence and enclosing bracket group: the dashes that can pair. */
  group: string;
  /** Outside brackets, after a colon of the same sentence. */
  afterColon: boolean;
  sentence: number;
};

/**
 * Finds each em dash with its surrounding spaces, and where each sentence ends: the index
 * of its final . ! or ?, or the end of the text without trailing spaces and emphasis.
 */
function findDashes(masked: string): { dashes: Dash[]; ends: number[] } {
  const dashes: Dash[] = [];
  const ends: number[] = [];
  let colon = false;
  let nextGroup = 0;
  const groups: number[] = [0];
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (char === '(' || char === '[') groups.push(++nextGroup);
    else if ((char === ')' || char === ']') && groups.length > 1) groups.pop();
    else if (char === ':' && groups.length === 1 && /^\**\s/.test(masked.slice(i + 1)))
      colon = true;
    else if (
      /[.!?]/.test(char) &&
      /^["')\]*_]*\s/.test(masked.slice(i + 1)) &&
      !/(?:^|[\s(])(?:e\.g|i\.e|vs|etc)$/.test(masked.slice(0, i))
    ) {
      ends.push(i);
      colon = false;
    } else if (char === DASH) {
      let start = i;
      while (start > 0 && /\s/.test(masked[start - 1])) start -= 1;
      let end = i + 1;
      while (end < masked.length && /\s/.test(masked[end])) end += 1;
      const sentence = ends.length;
      const group = groups[groups.length - 1];
      dashes.push({
        start,
        end,
        group: `${sentence}:${group}`,
        afterColon: colon && group === 0,
        sentence,
      });
    }
  }
  const tail = masked.replace(/[\s*_"']*$/, '');
  ends.push(/[.!?]$/.test(tail) ? tail.length - 1 : tail.length);
  return { dashes, ends };
}

export function replaceEmDashes(text: string): EmDashResult {
  const counts = emptyCounts();
  if (!text.includes(DASH)) return { text, counts };
  if (text.trim() === DASH) {
    counts['empty-cell'] = 1;
    return { text: text.replace(DASH, '-'), counts };
  }
  const masked = mask(text);
  const { dashes, ends } = findDashes(masked);
  const isTerm = (dash: Dash): boolean => LEADING_TERM.test(masked.slice(0, dash.start));
  const size = new Map<string, number>();
  for (const dash of dashes) {
    if (!isTerm(dash)) size.set(dash.group, (size.get(dash.group) ?? 0) + 1);
  }

  // Each edit replaces text[start, end). A paren-tail adds an empty-range edit that closes it.
  const edits: { start: number; end: number; text: string }[] = [];
  let openPair: string | null = null;
  let condition = false;
  for (const dash of dashes) {
    const after = masked.slice(dash.end);
    const atEnd = after === '' || /^[.,;:!?)\]]/.test(after);
    let replacement: string;
    if (isTerm(dash)) {
      counts.term += 1;
      replacement = ': ';
    } else if (size.get(dash.group) === 2 && openPair === dash.group) {
      counts.pair += 1;
      replacement = atEnd ? ')' : condition ? '), ' : ') ';
      openPair = null;
    } else if (size.get(dash.group) === 2) {
      counts.pair += 1;
      replacement = ' (';
      openPair = dash.group;
      const from = dash.sentence === 0 ? 0 : ends[dash.sentence - 1] + 1;
      condition = CONDITION_WORDS.test(masked.slice(from, dash.start));
    } else if (COMMA_WORDS.has(after.match(/^[a-z.]+?(?=[\s,]|$)/)?.[0] ?? '')) {
      counts.comma += 1;
      replacement = ', ';
    } else if (dash.afterColon && size.get(dash.group) === 1 && ends[dash.sentence] > dash.end) {
      counts['paren-tail'] += 1;
      replacement = ' (';
      edits.push({ start: ends[dash.sentence], end: ends[dash.sentence], text: ')' });
    } else {
      counts.colon += 1;
      replacement = atEnd ? ':' : ': ';
    }
    edits.push({
      start: dash.start,
      end: dash.end,
      text: dash.start === 0 ? replacement.trimStart() : replacement,
    });
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { text: out + text.slice(cursor), counts };
}
