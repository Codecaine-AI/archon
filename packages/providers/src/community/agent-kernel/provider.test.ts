import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runProviderConformance } from '@archon/provider-contract/conformance';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

import { getRegistration } from '../../registry';
import { createArchonAgentKernelProvider, registerAgentKernelProvider } from './registration';

/** A Responses SSE stream with one text message, the shape Pi's openai-responses client reads. */
function textStream(text: string): Response {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'in_progress',
    content: [],
  };
  const events = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        ...item,
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  ];
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const previousHome = process.env.ARCHON_HOME;
const home = mkdtempSync(join(tmpdir(), 'archon-agent-kernel-'));
const stub = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => textStream('{"echo":"hi"}'),
});
let assistantConfig: Record<string, unknown>;

beforeAll(() => {
  process.env.ARCHON_HOME = home;
  const piAgentDir = join(home, 'pi-agent');
  mkdirSync(piAgentDir, { recursive: true });
  writeFileSync(
    join(piAgentDir, 'models.json'),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${String(stub.port)}`,
          api: 'openai-responses',
          apiKey: 'sk-stub-0123456789',
          models: [
            {
              id: 'stub-model',
              name: 'Stub',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    })
  );
  const bundle = join(home, 'bundles', 'echo-bundle');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, 'agent.json'),
    JSON.stringify({ name: 'echo-bundle', description: 'Echoes.', model: 'standard' })
  );
  writeFileSync(
    join(bundle, 'prompt.json'),
    JSON.stringify({
      kind: 'prompt',
      schemaVersion: 'prompt-kit/v1',
      id: 'echoBundlePrompt',
      nodes: [
        {
          type: 'section',
          tag: 'task',
          children: [{ type: 'paragraph', content: ['Answer with one JSON object.'] }],
        },
      ],
    })
  );
  assistantConfig = {
    catalogRoots: [join(home, 'bundles')],
    aliases: { fast: 'stub/stub-model', standard: 'stub/stub-model', strong: 'stub/stub-model' },
    piAgentDir,
  };
});

afterAll(async () => {
  stub.stop(true);
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  await removeTempTree(home);
});

const env = {
  TRACE_ENGINE: 'archon',
  TRACE_RUN: 'run-1',
  TRACE_NODE_PATH: 'echo',
  TRACE_INVOCATION: 'inv-1',
  TRACE_ATTEMPT: 'att-1',
  TRACE_LOOP_PATH: '',
};

/** One node attempt through the registered factory, as Archon runs it. */
function turn(options: { model?: string; env?: Record<string, string> } = {}) {
  return createArchonAgentKernelProvider().sendQuery('hi', home, undefined, {
    model: options.model ?? 'echo-bundle',
    env: options.env ?? env,
    assistantConfig,
    outputFormat: { type: 'json_schema', schema: { type: 'object' } },
  });
}

describe('agent-kernel provider', () => {
  test('conforms to the provider contract', async () => {
    const provider = createArchonAgentKernelProvider();
    const violations = await runProviderConformance({
      capabilities: provider.getCapabilities(),
      failureCases: [
        {
          name: 'unknown bundle',
          expected: 'misconfigured',
          evidence: 'no-such-bundle',
          run: () => turn({ model: 'no-such-bundle' }),
        },
        {
          name: 'node environment without trace tags',
          expected: 'misconfigured',
          evidence: 'TRACE_RUN',
          run: () => turn({ env: {} }),
        },
      ],
      turns: [{ name: 'echo bundle', run: () => turn() }],
    });
    expect(violations).toEqual([]);
  });

  test('returns the bundle answer as structured output', async () => {
    const chunks = [];
    for await (const chunk of turn()) chunks.push(chunk);
    expect(chunks.find(chunk => chunk.type === 'result')).toMatchObject({
      structuredOutput: { echo: 'hi' },
    });
  });

  test('registers with enforced structured output and a strict config parser', () => {
    registerAgentKernelProvider();
    const registration = getRegistration('agent-kernel');
    expect(registration.capabilities.structuredOutput).toBe('enforced');
    expect(registration.parseConfig(assistantConfig, 'install')).toEqual(assistantConfig);
    expect(() => registration.parseConfig({ ...assistantConfig, model: 'x' }, 'install')).toThrow(
      'unknown provider setting'
    );
  });
});
