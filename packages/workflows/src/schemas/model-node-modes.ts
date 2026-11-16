/**
 * Fork-only node modes `extract:` and `decide:` (Codecaine). Each one makes a single
 * model call with no agent turn, so each loads as an agent node on provider
 * `agent-kernel` that carries a `model_node` config. The provider reads
 * `nodeConfig.model_node` and runs the call; the rendered `input` template arrives as
 * the prompt, and the pack root arrives as `options.env.PACK_DIR`.
 *
 * All grammar lives here. The upstream modules hold only the hooks: the two shapes in
 * `NODE_MODE_SHAPES` (dag-node.ts), the two validators in `MODE_VALIDATORS`
 * (node-validation.ts), the two builders in `NODE_BUILDERS` (node-normalize.ts), the
 * `model_node` field (agent-node.ts) and its copy into `nodeConfig` (provider-resolution.ts),
 * and the `isModelNode` guards that keep workflow and config defaults off a model node
 * (include/workflow-scope.ts at load time, node-model-resolution.ts at run time).
 */
import { z } from 'zod';
import type { NodeModelResolution } from '../node-model-resolution';
import type { AgentNode } from './agent-node';
import type { DagNode, DagNodeFields } from './dag-node';

/** The provider that runs every extract and decide node. */
export const MODEL_NODE_PROVIDER = 'agent-kernel';

/** The classifier a decide node runs when the YAML names none. */
export const DEFAULT_DECIDE_CLASSIFIER = 'typesafe/jev-1.13.0';

/** The enum value every decide node must offer: an abstained answer returns it. */
export const DECIDE_FALLBACK_CHOICE = 'other';

const DEFAULT_EXTRACT_TIER = 'fast';
const DEFAULT_EXTRACT_RETRIES = 2;

const templateSchema = (key: string) =>
  z.string({ error: `'${key}' is required: the template that renders the call input` }).min(1);

const extractConfigSchema = z
  .object({
    function: z.string().trim().min(1).optional(),
    schema: z.string().trim().min(1).optional(),
    input: templateSchema('extract.input'),
  })
  .strict();

const decideConfigSchema = z
  .object({
    question: z.string({ error: "'decide.question' is required" }).trim().min(1),
    enum: z
      .array(z.string().trim().min(1), { error: "'decide.enum' is required" })
      .min(2, "'decide.enum' must list at least 2 values"),
    input: templateSchema('decide.input'),
    classifier: z.string().trim().min(1).optional(),
    threshold: z
      .object({
        minProbability: z.number().min(0).max(1),
        minMargin: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const modelTierSchema = z.enum(['fast', 'standard', 'strong']);

/** The keys the extract mode owns, spread into `NODE_MODE_SHAPES`. */
export const EXTRACT_MODE_SHAPE = {
  extract: extractConfigSchema,
  tier: modelTierSchema,
  retries: z.number().int().min(0),
} as const satisfies z.ZodRawShape;

/** The keys the decide mode owns, spread into `NODE_MODE_SHAPES`. */
export const DECIDE_MODE_SHAPE = {
  decide: decideConfigSchema,
} as const satisfies z.ZodRawShape;

/** The config the provider reads from `nodeConfig.model_node`. */
export const modelNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('extract'),
    function: z.string(),
    tier: modelTierSchema,
    retries: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('decide'),
    question: z.string(),
    enum: z.array(z.string()),
    classifier: z.string(),
    threshold: decideConfigSchema.shape.threshold,
  }),
]);
export type ModelNode = z.infer<typeof modelNodeSchema>;

/** An extract or decide node: it runs on `agent-kernel` and takes no workflow or config default. */
export function isModelNode(node: DagNode): boolean {
  return node.kind === 'agent' && node.model_node !== undefined;
}

/**
 * The run-time resolution of every model node: provider `agent-kernel` and no model, tier,
 * preset or effort, whatever the workflow scope, the default assistant or the tiers say.
 * The provider picks the model from `model_node`.
 */
export const MODEL_NODE_RESOLUTION = {
  provider: MODEL_NODE_PROVIDER,
  model: undefined,
  effort: undefined,
  declaredEffort: undefined,
  tier: undefined,
  preset: undefined,
  providerOrigin: 'node',
  modelOrigin: 'unset',
  effortOrigin: 'unset',
} as const satisfies Omit<NodeModelResolution, 'authoredIn'>;

// ---------------------------------------------------------------------------
// Validation — registered in MODE_VALIDATORS
// ---------------------------------------------------------------------------

/**
 * Agent-node keys a model node never reads. The builders drop them, so a node that sets
 * one fails the load rather than losing it silently (#2478). `allowed_tools`,
 * `denied_tools`, `mcp` and `skills` are the tool keys: the call runs no agent turn.
 */
const AGENT_TURN_KEYS = [
  'allowed_tools',
  'denied_tools',
  'mcp',
  'skills',
  'model',
  'context',
  'hooks',
  'plugins',
  'agents',
  'pi',
  'effort',
  'maxBudgetUsd',
  'systemPrompt',
  'fallbackModel',
  'settingSources',
  'betas',
  'sandbox',
  'persist_session',
] as const satisfies readonly (keyof DagNodeFields)[];

type ModelNodeKind = ModelNode['kind'];

function addIssue(ctx: z.RefinementCtx, message: string, path: readonly PropertyKey[]): void {
  ctx.addIssue({ code: 'custom', message, path: [...path] });
}

/** The rules both modes share: the fixed provider, and no agent-turn keys. */
function validateModelNodeCommon(
  data: DagNodeFields,
  kind: ModelNodeKind,
  ctx: z.RefinementCtx
): void {
  if (data.provider !== undefined && data.provider !== MODEL_NODE_PROVIDER) {
    addIssue(
      ctx,
      `must be '${MODEL_NODE_PROVIDER}' on ${kind} nodes, which always run on that provider`,
      ['provider']
    );
  }
  for (const key of AGENT_TURN_KEYS) {
    if (data[key] === undefined) continue;
    addIssue(
      ctx,
      `is not supported on ${kind} nodes: the node makes one model call and runs no agent turn`,
      [key]
    );
  }
}

export function validateExtractNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  validateModelNodeCommon(data, 'extract', ctx);
  if (data.output_format === undefined) {
    addIssue(ctx, 'is required on extract nodes: the engine checks the extract result against it', [
      'output_format',
    ]);
  }
  const extract = data.extract;
  if (extract === undefined) return;
  // The pair check comes first, so a node with both keys names the pair rule.
  if (extract.function !== undefined && extract.schema !== undefined) {
    addIssue(ctx, "sets both 'extract.function' and 'extract.schema': set one of them", [
      'extract',
    ]);
  } else if (extract.schema !== undefined) {
    addIssue(
      ctx,
      "is not supported in version 1 of the extract mode: use 'extract.function' with a BAML function",
      ['extract', 'schema']
    );
  } else if (extract.function === undefined) {
    addIssue(ctx, 'is required: the BAML function the extract node calls', ['extract', 'function']);
  }
}

export function validateDecideNode(data: DagNodeFields, ctx: z.RefinementCtx): void {
  validateModelNodeCommon(data, 'decide', ctx);
  if (data.output_format !== undefined) {
    addIssue(
      ctx,
      'is not supported on decide nodes: a decide node always outputs {choice, reason, probability, abstained}',
      ['output_format']
    );
  }
  const decide = data.decide;
  if (decide === undefined) return;
  if (!decide.enum.includes(DECIDE_FALLBACK_CHOICE)) {
    addIssue(
      ctx,
      `must include '${DECIDE_FALLBACK_CHOICE}': an answer that abstains returns '${DECIDE_FALLBACK_CHOICE}'`,
      ['decide', 'enum']
    );
  }
  if (new Set(decide.enum).size !== decide.enum.length) {
    addIssue(ctx, 'must not repeat a value', ['decide', 'enum']);
  }
}

// ---------------------------------------------------------------------------
// Builders — registered in NODE_BUILDERS
// ---------------------------------------------------------------------------

/** The structural and scheduling fields node-normalize.ts derives for every executable node. */
type ExecutableFields = Omit<AgentNode, 'kind' | 'source'>;

function selected<T>(value: T | undefined, kind: ModelNodeKind): T {
  if (value === undefined)
    throw new Error(`unreachable: ${kind} must be defined after superRefine`);
  return value;
}

export function buildExtractNode(data: DagNodeFields, fields: ExecutableFields): AgentNode {
  const extract = selected(data.extract, 'extract');
  return {
    ...fields,
    kind: 'agent',
    provider: MODEL_NODE_PROVIDER,
    output_format: data.output_format,
    source: { kind: 'inline', prompt: extract.input.trim() },
    model_node: {
      kind: 'extract',
      function: selected(extract.function, 'extract'),
      tier: data.tier ?? DEFAULT_EXTRACT_TIER,
      retries: data.retries ?? DEFAULT_EXTRACT_RETRIES,
    },
  };
}

export function buildDecideNode(data: DagNodeFields, fields: ExecutableFields): AgentNode {
  const decide = selected(data.decide, 'decide');
  return {
    ...fields,
    kind: 'agent',
    provider: MODEL_NODE_PROVIDER,
    output_format: decideOutputFormat(decide.enum),
    source: { kind: 'inline', prompt: decide.input.trim() },
    model_node: {
      kind: 'decide',
      question: decide.question,
      enum: decide.enum,
      classifier: decide.classifier ?? DEFAULT_DECIDE_CLASSIFIER,
      ...(decide.threshold !== undefined ? { threshold: decide.threshold } : {}),
    },
  };
}

/** The fixed output contract of a decide node; `choice` is one value of its enum. */
export function decideOutputFormat(choices: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      choice: { type: 'string', enum: [...choices] },
      reason: { type: 'string' },
      probability: { type: 'number', minimum: 0, maximum: 1 },
      abstained: { type: 'boolean' },
    },
    required: ['choice', 'reason', 'probability', 'abstained'],
    additionalProperties: false,
  };
}
