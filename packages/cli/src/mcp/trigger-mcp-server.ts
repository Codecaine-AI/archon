/**
 * `archon mcp serve`: the trigger tools over MCP on stdio. An agent on another machine
 * starts it with `ssh <hub> …`, so SSH is the authentication and no port opens.
 *
 * No tool writes a workflow file; a workflow ships through a pull request to its repo.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BUNDLED_VERSION } from '@archon/paths';
import {
  BindingScheduleError,
  fireBinding,
  listBindings,
  removeBinding,
  setBinding,
  type TriggerToolContext,
} from './trigger-bindings';
import { getRun, listRuns, listWorkflows } from './trigger-runs';
import { redactedJson, redactSecrets } from './redact';

/** A successful result: every string in it is redacted before it is serialized. */
function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: redactedJson(value) }] };
}

/** A tool's failure as an MCP tool error: a plain, redacted message, plus state when known. */
function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const text =
    error instanceof BindingScheduleError
      ? JSON.stringify({ message, ...error.state }, null, 2)
      : message;
  return { isError: true, content: [{ type: 'text', text: redactSecrets(text) }] };
}

interface TriggerTool<Args extends z.ZodObject> {
  name: string;
  description: string;
  annotations: NonNullable<Tool['annotations']>;
  args: Args;
  call: (context: TriggerToolContext, args: z.output<Args>) => Promise<unknown>;
}

/** Keeps each tool's handler typed by its own argument schema inside one list. */
function tool<Args extends z.ZodObject>(definition: TriggerTool<Args>): TriggerTool<z.ZodObject> {
  return definition as unknown as TriggerTool<z.ZodObject>;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const bindingIdArgs = z
  .object({
    bindingId: z
      .string()
      .min(1)
      .describe('The binding id; its file is <bindings folder>/<bindingId>.json.'),
  })
  .strict();
const noArgs = z.object({}).strict();

export const TRIGGER_TOOLS = [
  tool({
    name: 'list_workflows',
    description:
      'List the workflows of each distinct launch folder (binding.launch.cwd) the valid bindings name, with the folder and binding ids each list came from.',
    annotations: READ_ONLY,
    args: noArgs,
    call: context => listWorkflows(context),
  }),
  tool({
    name: 'list_runs',
    description: 'List recent workflow runs across all projects, newest first.',
    annotations: READ_ONLY,
    args: z
      .object({
        limit: z.number().int().min(1).max(200).default(20).describe('Most runs to return.'),
      })
      .strict(),
    call: (context, { limit }) => listRuns(context, limit),
  }),
  tool({
    name: 'get_run',
    description:
      'Get one run by its full id: the run row, node states, terminal record, the tail of its JSONL transcript, and for a trigger-started run the tail of its detached executor log. A missing transcript is reported with the reason, not as an error.',
    annotations: READ_ONLY,
    args: z
      .object({
        runId: z.string().min(1).describe('The full run id.'),
        maxLogBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024)
          .default(64 * 1024)
          .describe('Most bytes to return from the end of each log.'),
      })
      .strict(),
    call: (context, { runId, maxLogBytes }) => getRun(context, runId, maxLogBytes),
  }),
  tool({
    name: 'list_bindings',
    description:
      'List the binding files in the bindings folder: each one with its schedule and whether its LaunchAgent is installed. A file that fails the schema is listed as invalid with the reason.',
    annotations: READ_ONLY,
    args: noArgs,
    call: context => listBindings(context),
  }),
  tool({
    name: 'fire_binding',
    description:
      'Start one run of a binding now, as `archon trigger fire --config <file>` does. Returns the run id, or the reason the start did not begin (queued, skipped, or preparation failed).',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    args: bindingIdArgs,
    call: (context, { bindingId }) => fireBinding(context, bindingId),
  }),
  tool({
    name: 'set_binding',
    description:
      "Validate a full binding document (version 1, sourceInstanceId, binding, schedule), write it to <bindings folder>/<bindingId>.json with mode 600, and install its schedule, replacing the old LaunchAgent when the job changed. A document that fails validation writes nothing. Needs the hub user's launchd GUI session.",
    annotations: WRITES,
    args: bindingIdArgs.extend({
      document: z
        .record(z.string(), z.unknown())
        .describe('The whole binding document; binding.bindingId must equal bindingId.'),
    }),
    call: (context, { bindingId, document }) => setBinding(context, bindingId, document),
  }),
  tool({
    name: 'remove_binding',
    description:
      "Remove one binding's LaunchAgent, then its file. When the schedule cannot be removed, the file stays. Needs the hub user's launchd GUI session when a schedule is installed.",
    annotations: WRITES,
    args: bindingIdArgs,
    call: (context, { bindingId }) => removeBinding(context, bindingId),
  }),
];

function listedTool(definition: TriggerTool<z.ZodObject>): Tool {
  const schema = z.toJSONSchema(definition.args, { io: 'input' });
  const properties: Record<string, object> = {};
  for (const [key, value] of Object.entries(schema.properties ?? {}))
    if (typeof value === 'object') properties[key] = value;
  return {
    name: definition.name,
    description: definition.description,
    annotations: definition.annotations,
    inputSchema: {
      type: 'object',
      properties,
      ...(schema.required ? { required: schema.required } : {}),
      additionalProperties: false,
    },
  };
}

async function callTool(
  context: TriggerToolContext,
  name: string,
  rawArgs: unknown
): Promise<CallToolResult> {
  const definition = TRIGGER_TOOLS.find(entry => entry.name === name);
  if (!definition) return toolError(new Error(`Unknown tool: ${name}`));
  const args = definition.args.safeParse(rawArgs ?? {});
  if (!args.success)
    return toolError(
      new Error(
        `Invalid arguments: ${args.error.issues.map(issue => `${issue.path.join('.') || '(arguments)'}: ${issue.message}`).join('; ')}`
      )
    );
  try {
    return toolResult(await definition.call(context, args.data));
  } catch (error) {
    return toolError(error);
  }
}

export function createTriggerMcpServer(context: TriggerToolContext): Server {
  const server = new Server(
    { name: 'archon-triggers', version: BUNDLED_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TRIGGER_TOOLS.map(listedTool),
  }));
  server.setRequestHandler(CallToolRequestSchema, request =>
    callTool(context, request.params.name, request.params.arguments)
  );
  return server;
}

/**
 * Anything an in-process module prints through `console` goes to stderr: stdout carries
 * MCP frames only, and one stray line breaks the client's framing.
 */
function routeConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
}

/** Serve the tools on stdio until the client closes stdin. */
export async function serveTriggerMcp(context: TriggerToolContext): Promise<void> {
  routeConsoleToStderr();
  const server = createTriggerMcpServer(context);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>(resolveClosed => {
    transport.onclose = resolveClosed;
    process.stdin.once('end', resolveClosed);
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
