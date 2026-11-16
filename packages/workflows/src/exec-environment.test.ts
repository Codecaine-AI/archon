import { describe, expect, test } from 'bun:test';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import { buildAiNodeEnvironment, type NodeExecutionIdentity } from './exec-environment';

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
      'X-Team: core\nx-trace-run: stale'
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
        env: buildAiNodeEnvironment(execution([]), undefined, undefined),
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
      'X-Trace-Loop-Path: old-loop:9\nX-Team: core'
    );
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('Loop-Path');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('old-loop');
    expect(env.ANTHROPIC_CUSTOM_HEADERS?.split('\n')[0]).toBe('X-Team: core');
  });
});
