// @archon-test-isolated
/**
 * The fork-only `extract:` and `decide:` node modes, through real discovery of the two
 * fixture roots: the email-intake pack loads, each broken variant fails with its named
 * error, and each model node's `model_node` config reaches the provider's `nodeConfig`.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ProviderRegistry, SendQueryOptions } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import type { WorkflowConfig } from '../deps';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  minimalConfig,
  mockGetAgentProviderDag,
} from '../dag/test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { buildAiProfile } from '../model-validation';
import { assistantModelDefaults, resolveWorkflowModelScope } from '../node-model-resolution';
import { settlingProvider } from '../test-settling-provider';
import { discoverWorkflows } from '../workflow-discovery';
import { type DagNode, dagNodeSchema } from '.';

const FIXTURES = join(import.meta.dir, '__fixtures__');

/** The built-in providers plus `agent-kernel`, which cp6 registers in the host. */
function withAgentKernel(providers: ProviderRegistry): ProviderRegistry {
  const claude = providers.get('claude');
  if (!claude) throw new Error('claude must be registered');
  const agentKernel = { ...claude, id: 'agent-kernel', displayName: 'agent-kernel (test)' };
  return {
    get: id => (id === agentKernel.id ? agentKernel : providers.get(id)),
    list: () => [...providers.list(), agentKernel],
    unavailable: id => providers.unavailable?.(id),
  };
}
const providers = withAgentKernel(providerRegistry);

let archonHome: string;
const originalArchonHome = process.env.ARCHON_HOME;
beforeAll(async () => {
  archonHome = await mkdtemp(join(tmpdir(), 'model-node-modes-home-'));
  process.env.ARCHON_HOME = archonHome;
});
afterAll(async () => {
  await removeTempTree(archonHome);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

const discover = (root: string) =>
  discoverWorkflows(join(FIXTURES, root), { providers, loadDefaults: false });

describe('extract and decide loading', () => {
  test('the email-intake pack loads, with each model node as an agent-kernel agent node', async () => {
    const result = await discover('model-node-modes');
    expect(result.errors).toEqual([]);
    const workflow = result.workflows.find(w => w.workflow.name === 'email-intake')?.workflow;
    expect(workflow?.pack?.key).toBe('intake');
    const node = (id: string) => workflow?.nodes.find(n => n.id === id);

    expect(node('extract')).toEqual({
      id: 'extract',
      depends_on: ['route'],
      when: "$route.output.lane == 'support'",
      kind: 'agent',
      provider: 'agent-kernel',
      output_format: {
        type: 'object',
        properties: { sender: { type: 'string' }, ask: { type: 'string' } },
        required: ['sender', 'ask'],
      },
      source: { kind: 'inline', prompt: '$INPUTS.raw' },
      model_node: { kind: 'extract', function: 'ExtractSupportEmail', tier: 'fast', retries: 2 },
    });
    expect(node('classify')).toEqual({
      id: 'classify',
      depends_on: ['extract'],
      kind: 'agent',
      provider: 'agent-kernel',
      output_format: {
        type: 'object',
        properties: {
          choice: { type: 'string', enum: ['reply', 'code_change', 'ignore', 'other'] },
          reason: { type: 'string' },
          probability: { type: 'number', minimum: 0, maximum: 1 },
          abstained: { type: 'boolean' },
        },
        required: ['choice', 'reason', 'probability', 'abstained'],
        additionalProperties: false,
      },
      source: { kind: 'inline', prompt: '$extract.output' },
      model_node: {
        kind: 'decide',
        question: 'What does this email ask for?',
        enum: ['reply', 'code_change', 'ignore', 'other'],
        classifier: 'typesafe/jev-1.13.0',
      },
    });
  });

  test('each broken variant fails with its named error', async () => {
    const result = await discover('model-node-modes-broken');
    expect(result.workflows).toEqual([]);
    const errors = Object.fromEntries(
      result.errors.map(e => [
        e.filename
          .split('/')
          .at(-1)
          ?.replace(/\.yaml$/, ''),
        e.error,
      ])
    );
    expect(errors).toEqual({
      'extract-no-output-format':
        "DAG node validation failed: Node 'extract': 'output_format' is required on extract nodes: the engine checks the extract result against it",
      'decide-no-other':
        "DAG node validation failed: Node 'classify': 'decide.enum' must include 'other': an answer that abstains returns 'other'",
      'extract-with-tools':
        "DAG node validation failed: Node 'extract': 'allowed_tools' is not supported on extract nodes: the node makes one model call and runs no agent turn",
      'extract-function-and-schema':
        "DAG node validation failed: Node 'extract': 'extract' sets both 'extract.function' and 'extract.schema': set one of them",
      'decide-min-probability-zero':
        "DAG node validation failed: Node 'classify': 'decide.threshold.minProbability' must be greater than 0 and at most 1",
      'decide-min-margin-one':
        "DAG node validation failed: Node 'classify': 'decide.threshold.minMargin' must be at least 0 and less than 1",
      'extract-schema-only':
        "DAG node validation failed: Node 'extract': 'extract.schema' is not supported in version 1 of the extract mode: use 'extract.function' with a BAML function",
    });
  });
});

describe('model_node reaches the provider', () => {
  test('an extract node and a decide node each send their model_node in nodeConfig', async () => {
    const calls: { prompt: string; options: SendQueryOptions | undefined }[] = [];
    const deps = createMockDeps(createMockStore(), providers);
    deps.getAgentProvider = provider =>
      settlingProvider({
        ...mockGetAgentProviderDag(provider),
        getType: () => provider,
        sendQuery: mock(async function* (prompt: string, _cwd, _resume, options) {
          calls.push({ prompt, options });
          const kind = (options?.nodeConfig?.model_node as { kind: string } | undefined)?.kind;
          yield {
            type: 'result' as const,
            structuredOutput:
              kind === 'decide'
                ? { choice: 'reply', reason: 'top 0.9', probability: 0.9, abstained: false }
                : { sender: 'ana@example.com', ask: 'reset my password' },
          };
        }),
      });
    const nodes = [
      {
        id: 'extract',
        extract: { function: 'ExtractSupportEmail', input: 'Email: $ARGUMENTS' },
        tier: 'strong',
        output_format: {
          type: 'object',
          properties: { sender: { type: 'string' }, ask: { type: 'string' } },
          required: ['sender', 'ask'],
        },
      },
      {
        id: 'classify',
        depends_on: ['extract'],
        decide: {
          question: 'What does this email ask for?',
          enum: ['reply', 'other'],
          input: '$extract.output',
          threshold: { minProbability: 0.7, minMargin: 0.2 },
        },
      },
    ].map(node => dagNodeSchema.parse(node) as DagNode);

    const cwd = await mkdtemp(join(tmpdir(), 'model-node-modes-run-'));
    try {
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd,
          workflow: { name: 'model-nodes', nodes },
          workflowRun: makeWorkflowRun('model-nodes-run', { user_message: 'please reset' }),
        })
      );
    } finally {
      await removeTempTree(cwd);
    }

    expect(calls.map(c => c.options?.nodeConfig?.model_node)).toEqual([
      { kind: 'extract', function: 'ExtractSupportEmail', tier: 'strong', retries: 2 },
      {
        kind: 'decide',
        question: 'What does this email ask for?',
        enum: ['reply', 'other'],
        classifier: 'typesafe/jev-1.13.0',
        threshold: { minProbability: 0.7, minMargin: 0.2 },
      },
    ]);
    // Archon renders each input template before the call.
    expect(calls[0]?.prompt).toContain('Email: please reset');
    expect(calls[1]?.prompt).toContain('reset my password');
  });
});

describe('model nodes take no provider or model from the workflow or the config', () => {
  const MODEL_NODES = `
nodes:
  - id: extract
    extract: { function: ExtractSupportEmail, input: $ARGUMENTS }
    output_format: { type: object, properties: { ask: { type: string } }, required: [ask] }
  - id: classify
    depends_on: [extract]
    decide: { question: What does this email ask for?, enum: [reply, other], input: $extract.output }
`;
  // A tier that names Claude, as an install's `tiers:` config can.
  const aiProfile = buildAiProfile('claude', {
    repoTiers: { large: { provider: 'claude', model: 'claude-opus-5-5' } },
  });
  const claudeConfig: WorkflowConfig = {
    ...minimalConfig,
    assistant: 'claude',
    assistants: { ...minimalConfig.assistants, claude: { model: 'claude-opus-5-5' } },
  };

  /** Discover one workflow file, run it with the scope the executor derives, and record each call. */
  async function runModelNodes(workflowTop: string, config: WorkflowConfig) {
    const root = await mkdtemp(join(tmpdir(), 'model-node-inherit-'));
    const calls: {
      provider: string;
      model?: string;
      fallbackModel?: string;
    }[] = [];
    try {
      const dir = join(root, '.archon', 'workflows');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'inherit.yaml'),
        `name: inherit\ndescription: model nodes under workflow defaults\n${workflowTop}${MODEL_NODES}`
      );
      const discovered = await discoverWorkflows(root, {
        providers,
        loadDefaults: false,
      });
      expect(discovered.errors).toEqual([]);
      const workflow = discovered.workflows[0]?.workflow;
      if (!workflow) throw new Error('the workflow must load');

      const deps = createMockDeps(createMockStore(), providers);
      deps.getAgentProvider = provider =>
        settlingProvider({
          ...mockGetAgentProviderDag(provider),
          getType: () => provider,
          sendQuery: mock(async function* (_prompt: string, _cwd, _resume, options) {
            calls.push({
              provider,
              model: options?.model,
              fallbackModel: options?.fallbackModel,
            });
            const kind = (options?.nodeConfig?.model_node as { kind: string } | undefined)?.kind;
            yield {
              type: 'result' as const,
              structuredOutput:
                kind === 'decide'
                  ? {
                      choice: 'reply',
                      reason: 'top 0.9',
                      probability: 0.9,
                      abstained: false,
                    }
                  : { ask: 'reset my password' },
            };
          }),
        });
      const scope = resolveWorkflowModelScope(
        workflow,
        config.assistant,
        assistantModelDefaults(config),
        aiProfile
      );
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: root,
          config,
          aiProfile,
          workflow,
          workflowProvider: scope.provider,
          workflowModel: scope.model,
          workflowPreset: scope.preset,
          workflowRun: makeWorkflowRun('inherit-run', {
            user_message: 'please reset',
          }),
        })
      );
    } finally {
      await removeTempTree(root);
    }
    return calls;
  }

  const onAgentKernel = [{ provider: 'agent-kernel' }, { provider: 'agent-kernel' }];

  test('a workflow-level provider and tier model do not reach a model node', async () => {
    const calls = await runModelNodes(
      'provider: agent-kernel\nmodel: large\nfallbackModel: claude-haiku-5-5\n',
      claudeConfig
    );
    expect(calls).toEqual(onAgentKernel);
  });

  test('the default assistant and its model do not reach a model node', async () => {
    expect(await runModelNodes('', claudeConfig)).toEqual(onAgentKernel);
  });

  test('agent-kernel as the default assistant gives a model node no model', async () => {
    const calls = await runModelNodes('', {
      ...minimalConfig,
      assistant: 'agent-kernel',
      assistants: { ...minimalConfig.assistants, 'agent-kernel': { model: 'kernel-default' } },
    });
    expect(calls).toEqual(onAgentKernel);
  });
});
