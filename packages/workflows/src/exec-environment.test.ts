import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import { buildAiNodeEnvironment, type NodeExecutionIdentity } from './exec-environment';
import { readT3ThreadId, startingThreadId, startingThreadMetadata } from './schemas/run-metadata';
import { runWithPackDir } from './workflow-variables';

const execution = (
  loopPath: NodeExecutionIdentity['invocation']['loopPath']
): NodeExecutionIdentity => ({
  runId: 'run-1',
  path: 'review-loop.review-codex',
  invocation: { id: 'inv-1', startedAt: '2026-11-10T00:00:00.000Z', loopPath },
  attempt: { id: 'att-1', startedAt: '2026-11-10T00:00:00.000Z' },
});

describe('buildAiNodeEnvironment trace tags', () => {
  test('a node in nested loops gets the 6 headers and variables, outer loop first', () => {
    const env = buildAiNodeEnvironment(
      execution([
        { groupId: 'outer', iteration: 1 },
        { groupId: 'review-loop', iteration: 2 },
      ]),
      undefined,
      undefined,
      undefined
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      [
        'X-Trace-Engine: archon',
        'X-Trace-Run: run-1',
        'X-Trace-Node-Path: review-loop.review-codex',
        'X-Trace-Invocation: inv-1',
        'X-Trace-Attempt: att-1',
        'X-Trace-Loop-Path: outer:1/review-loop:2',
      ].join('\n')
    );
    expect(env).toMatchObject({
      TRACE_ENGINE: 'archon',
      TRACE_RUN: 'run-1',
      TRACE_NODE_PATH: 'review-loop.review-codex',
      TRACE_INVOCATION: 'inv-1',
      TRACE_ATTEMPT: 'att-1',
      TRACE_LOOP_PATH: 'outer:1/review-loop:2',
    });
  });

  test('outside a loop there is no loop path, and parent headers are kept except X-Trace-*', () => {
    const env = buildAiNodeEnvironment(
      execution([]),
      undefined,
      'X-Team: core\nx-trace-run: stale',
      undefined
    );
    expect(env.TRACE_LOOP_PATH).toBe('');
    expect(env.ANTHROPIC_CUSTOM_HEADERS?.split('\n')).toEqual([
      'X-Team: core',
      'X-Trace-Engine: archon',
      'X-Trace-Run: run-1',
      'X-Trace-Node-Path: review-loop.review-codex',
      'X-Trace-Invocation: inv-1',
      'X-Trace-Attempt: att-1',
    ]);
  });

  test('outside a loop an inherited TRACE_LOOP_PATH does not reach the child', () => {
    const saved = process.env.TRACE_LOOP_PATH;
    process.env.TRACE_LOOP_PATH = 'old-loop:9';
    try {
      const child = buildProviderSubprocessEnv({
        env: buildAiNodeEnvironment(execution([]), undefined, undefined, undefined),
      });
      expect(child.TRACE_LOOP_PATH).toBe('');
    } finally {
      if (saved === undefined) delete process.env.TRACE_LOOP_PATH;
      else process.env.TRACE_LOOP_PATH = saved;
    }
  });

  test('outside a loop an inherited X-Trace-Loop-Path header line does not reach the child', () => {
    const env = buildAiNodeEnvironment(
      execution([]),
      undefined,
      'X-Trace-Loop-Path: old-loop:9\nX-Team: core',
      undefined
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('Loop-Path');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('old-loop');
    expect(env.ANTHROPIC_CUSTOM_HEADERS?.split('\n')[0]).toBe('X-Team: core');
  });
});

describe('buildAiNodeEnvironment X-Trace-Parent', () => {
  test('the thread that started the run reaches Claude as a header and Codex as T3CODE_THREAD_ID', () => {
    const child = buildProviderSubprocessEnv({
      env: buildAiNodeEnvironment(execution([]), undefined, 'X-Team: core', 'thread-a'),
    });
    expect(child.T3CODE_THREAD_ID).toBe('thread-a');
    expect(child.ANTHROPIC_CUSTOM_HEADERS?.split('\n')).toContain('X-Trace-Parent: thread-a');
    expect(child.ANTHROPIC_CUSTOM_HEADERS?.split('\n')[0]).toBe('X-Team: core');
  });

  test('an unsafe parent never reaches a header or a Codex child, even when a caller passes one', () => {
    for (const unsafe of ['a\r\nX-Evil: 1', 'th"read', ' ']) {
      const child = buildProviderSubprocessEnv({
        env: buildAiNodeEnvironment(execution([]), undefined, 'X-Team: core', unsafe),
      });
      expect(child.T3CODE_THREAD_ID).toBe('');
      expect(child.ANTHROPIC_CUSTOM_HEADERS).not.toMatch(/x-trace-parent|x-evil/i);
    }
  });

  test("a stale parent in the node env or in Archon's own env never reaches another thread's child", () => {
    const saved = process.env.T3CODE_THREAD_ID;
    process.env.T3CODE_THREAD_ID = 'thread-old';
    try {
      // The stored node env holds an old thread in both places a child could read it.
      const nodeEnv = {
        T3CODE_THREAD_ID: 'thread-old',
        ANTHROPIC_CUSTOM_HEADERS: 'X-Trace-Parent: thread-old\nX-Team: core',
      };
      for (const [current, header] of [
        ['thread-b', ['X-Trace-Parent: thread-b']],
        [undefined, []],
      ] as const) {
        const child = buildProviderSubprocessEnv({
          env: {
            ...nodeEnv,
            ...buildAiNodeEnvironment(
              execution([]),
              undefined,
              nodeEnv.ANTHROPIC_CUSTOM_HEADERS,
              current
            ),
          },
        });
        expect(child.T3CODE_THREAD_ID).toBe(current ?? '');
        expect(
          child.ANTHROPIC_CUSTOM_HEADERS?.split('\n').filter(l => /x-trace-parent/i.test(l))
        ).toEqual([...header]);
      }
    } finally {
      if (saved === undefined) delete process.env.T3CODE_THREAD_ID;
      else process.env.T3CODE_THREAD_ID = saved;
    }
  });
});

describe('startingThreadId', () => {
  test('a set thread id is the parent, and an unset, blank or unsafe one is none', () => {
    expect(startingThreadId({ T3CODE_THREAD_ID: ' thread-a ' })).toBe('thread-a');
    for (const real of [
      'mcp:e0068795-e892-4644-bebd-bfa95e80dac9',
      'thread:delegated-task:command%3Amcp%3A1c50%3Adelegate-task%3A4430',
    ]) {
      expect(startingThreadId({ T3CODE_THREAD_ID: real })).toBe(real);
      expect(readT3ThreadId({ t3_thread_id: real })).toBe(real);
    }
    for (const value of [undefined, '', '   ', 'a\r\nX-Evil: 1', 'a b', 'th"read', "th'read"]) {
      expect(startingThreadId({ T3CODE_THREAD_ID: value })).toBeUndefined();
      expect(readT3ThreadId({ t3_thread_id: value })).toBeUndefined();
    }
    expect(startingThreadMetadata({})).toEqual({});
    expect(startingThreadMetadata({ T3CODE_THREAD_ID: 'thread-a' })).toEqual({
      t3_thread_id: 'thread-a',
    });
  });
});

describe('buildAiNodeEnvironment PACK_DIR', () => {
  const intakePackRoot = join(
    import.meta.dir,
    'schemas/__fixtures__/model-node-modes/.archon/workflows/intake'
  );

  test('an AI node of the intake fixture pack gets the pack root', async () => {
    const env = await runWithPackDir({ kind: 'dir', dir: intakePackRoot }, async () =>
      buildAiNodeEnvironment(execution([]), undefined, undefined, undefined)
    );
    expect(env.PACK_DIR).toBe(intakePackRoot);
    expect(env.PACK_DIR?.endsWith('/.archon/workflows/intake')).toBe(true);
  });

  test('an AI node outside a pack gets an empty PACK_DIR', async () => {
    const env = await runWithPackDir({ kind: 'none' }, async () =>
      buildAiNodeEnvironment(execution([]), undefined, undefined, undefined)
    );
    expect(env.PACK_DIR).toBe('');
  });
});
