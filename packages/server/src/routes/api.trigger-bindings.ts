import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  listBindings,
  nextTimerFire,
  type LaunchAgentsLocation,
  type ListedBinding,
} from '@archon/core/workflows/timer-bindings';
import { redactedValue, type StructuralPath } from '@archon/core/utils/secret-redaction';
import type { IWorkflowStore } from '@archon/workflows/store';
import { apiError, getLog, jsonError, openApiRouteRegistrar } from './api-route-kit';
import { toISOString } from './api-serializers';
import {
  triggerBindingsResponseSchema,
  type TriggerBindingsResponse,
} from './schemas/trigger-bindings.schemas';

const listTriggerBindingsRoute = createRoute({
  method: 'get',
  path: '/api/trigger-bindings',
  tags: ['Workflows'],
  summary: 'List the scheduled jobs (timer bindings) of this install',
  description:
    'Every `<bindingId>.json` file in the bindings folder, with its schedule, whether its LaunchAgent is installed, the newest run it started and its next fire time. A file that fails validation is listed with the reason. Read-only.',
  responses: {
    200: {
      content: { 'application/json': { schema: triggerBindingsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

export interface TriggerBindingsRouteDeps {
  store: Pick<IWorkflowStore, 'listWorkflowRuns'>;
  /**
   * The absolute folder that holds `<bindingId>.json` binding files, read on each request:
   * the default folder depends on `ARCHON_HOME`, and route registration does no I/O.
   */
  bindingsDir: () => string;
  /** Where the LaunchAgents live; tests replace the folder. */
  nativeSchedule?: LaunchAgentsLocation;
  /** The clock next fire times count from; tests fix it. */
  now?: () => Date;
}

/**
 * The places that hold values this route built or read as identifiers, as the MCP
 * `list_bindings` tool lists them: they get only the exact-value redaction. Every other
 * string, such as an invalid file's reason, gets the full redaction.
 */
const STRUCTURAL_PATHS: readonly StructuralPath[] = [
  'timeZone',
  'generatedAt',
  'bindings[].file',
  'bindings[].status',
  'bindings[].bindingId',
  'bindings[].workflowName',
  'bindings[].cwd',
  'bindings[].hostId',
  'bindings[].nextFireAt',
  'bindings[].lastRun.runId',
  'bindings[].lastRun.status',
  'bindings[].lastRun.startedAt',
  'bindings[].lastRun.completedAt',
];

type ApiBinding = TriggerBindingsResponse['bindings'][number];

async function apiBinding(
  deps: TriggerBindingsRouteDeps,
  binding: ListedBinding,
  now: Date
): Promise<ApiBinding> {
  if (binding.status === 'invalid') return binding;
  const { runs } = await deps.store.listWorkflowRuns({
    resourceStartBindingId: binding.bindingId,
    limit: 1,
  });
  const run = runs[0];
  const lastRun = run
    ? {
        runId: run.id,
        status: run.status,
        outcome: run.outcome,
        startedAt: toISOString(run.started_at),
        completedAt: toISOString(run.completed_at),
      }
    : null;
  const next =
    binding.scheduleInstalled === true
      ? nextTimerFire(binding.schedule, now, lastRun ? new Date(lastRun.startedAt) : null)
      : null;
  return { ...binding, lastRun, nextFireAt: next?.toISOString() ?? null };
}

/** `GET /api/trigger-bindings`: the console's Scheduled jobs page. It writes nothing. */
export function registerTriggerBindingsRoute(
  app: OpenAPIHono,
  deps: TriggerBindingsRouteDeps
): void {
  openApiRouteRegistrar(app)(listTriggerBindingsRoute, async c => {
    try {
      const now = deps.now?.() ?? new Date();
      const { bindings } = await listBindings({
        bindingsDir: deps.bindingsDir(),
        nativeSchedule: deps.nativeSchedule,
      });
      const response: TriggerBindingsResponse = {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        generatedAt: now.toISOString(),
        bindings: await Promise.all(bindings.map(binding => apiBinding(deps, binding, now))),
      };
      return c.json(redactedValue(response, STRUCTURAL_PATHS), 200);
    } catch (error) {
      getLog().error({ err: error }, 'list_trigger_bindings_failed');
      return apiError(c, 500, 'Failed to list scheduled jobs');
    }
  });
}
