import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  macosTriggerJobLabel,
  timerScheduleId,
  timerTriggerConfigSchema,
} from '@archon/core/workflows/timer-bindings';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ListDashboardRunsOptions } from '@archon/workflows/schemas/workflow-run-listing';
import type { IWorkflowStore } from '@archon/workflows/store';
import { registerTriggerBindingsRoute } from './api.trigger-bindings';
import {
  triggerBindingsResponseSchema,
  type TriggerBindingsResponse,
} from './schemas/trigger-bindings.schemas';

const tempRoot = trackTempRoots();

/** Wednesday 18 November 2026, 03:00 in the test process's local time zone. */
const NOW = new Date(2026, 10, 18, 3, 0);

function bindingDocument(bindingId: string, schedule: unknown) {
  return {
    version: 1,
    sourceInstanceId: 'hub',
    binding: {
      bindingId,
      bindingRevision: null,
      hostId: 'hub-host',
      runAsUserId: 'operator',
      resource: `binding:${bindingId}`,
      capacity: 1,
      overlap: 'skip',
      launch: {
        cwd: '/srv/jobs',
        workflowName: `${bindingId}-workflow`,
        inputs: {},
        isolation: { kind: 'in-place' },
      },
    },
    schedule,
  };
}

type Run = Awaited<ReturnType<IWorkflowStore['listWorkflowRuns']>>['runs'][number];

function storedRun(id: string, startedAt: Date, completedAt: Date | null): Run {
  return {
    origin: { conversationId: 'conv-1' },
    id,
    workflow_name: 'any',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: completedAt === null ? 'running' : 'completed',
    outcome: null,
    user_message: '',
    metadata: {},
    started_at: startedAt,
    completed_at: completedAt,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    adopted_from_run_id: null,
    codebase_name: null,
    platform_type: null,
    worker_platform_id: null,
    parent_platform_id: null,
    active_nodes: [],
    current_step_name: null,
    total_steps: null,
    current_step_status: null,
    agents_completed: null,
    agents_failed: null,
    agents_total: null,
  };
}

interface Fixture {
  /** Binding documents by id; `installed` ones get a LaunchAgent plist. */
  bindings: { id: string; schedule: unknown; installed: boolean }[];
  /** Raw file contents that are not valid binding documents, by file name. */
  invalidFiles?: Record<string, string>;
  /** The newest run each binding started. */
  lastRuns?: Record<string, Run>;
}

async function listScheduledJobs(fixture: Fixture): Promise<TriggerBindingsResponse> {
  const root = tempRoot(await mkdtemp(join(tmpdir(), 'archon-trigger-bindings-route-')));
  const bindingsDir = join(root, 'triggers');
  const launchAgentsDirectory = join(root, 'LaunchAgents');
  await mkdir(bindingsDir);
  await mkdir(launchAgentsDirectory);
  for (const { id, schedule, installed } of fixture.bindings) {
    const document = bindingDocument(id, schedule);
    await writeFile(join(bindingsDir, `${id}.json`), JSON.stringify(document));
    if (installed) {
      const label = macosTriggerJobLabel(timerScheduleId(timerTriggerConfigSchema.parse(document)));
      await writeFile(join(launchAgentsDirectory, `${label}.plist`), '<plist/>');
    }
  }
  for (const [file, text] of Object.entries(fixture.invalidFiles ?? {}))
    await writeFile(join(bindingsDir, file), text);

  const store: Pick<IWorkflowStore, 'listWorkflowRuns'> = {
    listWorkflowRuns: async (options?: ListDashboardRunsOptions) => {
      const run = fixture.lastRuns?.[options?.resourceStartBindingId ?? ''];
      return {
        runs: run ? [run] : [],
        total: run ? 1 : 0,
        counts: {
          all: 0,
          running: 0,
          pending: 0,
          paused: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
      };
    },
  };
  const app = new OpenAPIHono();
  registerTriggerBindingsRoute(app, {
    store,
    bindingsDir: () => bindingsDir,
    nativeSchedule: { platform: 'darwin', launchAgentsDirectory },
    now: () => NOW,
  });
  const response = await app.request('/api/trigger-bindings');
  expect(response.status).toBe(200);
  return triggerBindingsResponseSchema.parse(await response.json());
}

function valid(response: TriggerBindingsResponse, bindingId: string) {
  const binding = response.bindings.find(
    entry => entry.status === 'valid' && entry.bindingId === bindingId
  );
  if (binding?.status !== 'valid') throw new Error(`No valid binding ${bindingId}`);
  return binding;
}

const DAILY = { calendar: [{ hour: 4, minute: 0 }], runAtLoad: false };

describe('GET /api/trigger-bindings', () => {
  test('a binding with an installed schedule is scheduled with its next fire time', async () => {
    const response = await listScheduledJobs({
      bindings: [{ id: 'nightly', schedule: DAILY, installed: true }],
    });

    expect(valid(response, 'nightly')).toMatchObject({
      file: 'nightly.json',
      workflowName: 'nightly-workflow',
      cwd: '/srv/jobs',
      hostId: 'hub-host',
      schedule: DAILY,
      scheduleInstalled: true,
      lastRun: null,
      nextFireAt: new Date(2026, 10, 18, 4, 0).toISOString(),
    });
  });

  test('a binding file without a LaunchAgent has no next fire time', async () => {
    const response = await listScheduledJobs({
      bindings: [{ id: 'paused-job', schedule: DAILY, installed: false }],
    });

    expect(valid(response, 'paused-job')).toMatchObject({
      scheduleInstalled: false,
      nextFireAt: null,
    });
  });

  test('an invalid file is listed with its name and the reason', async () => {
    const response = await listScheduledJobs({
      bindings: [],
      invalidFiles: { 'broken.json': '{"version": 2}' },
    });

    expect(response.bindings).toHaveLength(1);
    expect(response.bindings[0]).toMatchObject({ file: 'broken.json', status: 'invalid' });
    expect(response.bindings[0]).toHaveProperty(
      'reason',
      expect.stringContaining('fails the schema')
    );
  });

  test('a binding reports the newest run it started, and null when it started none', async () => {
    const started = new Date(2026, 10, 18, 2, 0);
    const completed = new Date(2026, 10, 18, 2, 7);
    const response = await listScheduledJobs({
      bindings: [
        { id: 'with-run', schedule: DAILY, installed: true },
        { id: 'never-ran', schedule: DAILY, installed: true },
      ],
      lastRuns: { 'with-run': storedRun('run-1', started, completed) },
    });

    expect(valid(response, 'with-run').lastRun).toEqual({
      runId: 'run-1',
      status: 'completed',
      outcome: null,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
    });
    expect(valid(response, 'never-ran').lastRun).toBeNull();
  });

  test('an interval binding fires one interval after its last run', async () => {
    const lastStart = new Date(NOW.getTime() - 2 * 60_000);
    const response = await listScheduledJobs({
      bindings: [
        { id: 'poll', schedule: { intervalSeconds: 300, runAtLoad: true }, installed: true },
      ],
      lastRuns: { poll: storedRun('run-poll', lastStart, null) },
    });

    expect(valid(response, 'poll').nextFireAt).toBe(
      new Date(lastStart.getTime() + 300_000).toISOString()
    );
  });

  test('a weekday entry fires on the next matching weekday', async () => {
    const response = await listScheduledJobs({
      bindings: [
        {
          id: 'weekly',
          schedule: { calendar: [{ weekday: 0, hour: 10, minute: 0 }], runAtLoad: false },
          installed: true,
        },
      ],
    });

    // NOW is a Wednesday; weekday 0 is Sunday.
    expect(valid(response, 'weekly').nextFireAt).toBe(new Date(2026, 10, 22, 10, 0).toISOString());
  });

  test('a free-text reason is redacted like the MCP tool result', async () => {
    const secret = 'ghs_abcdefghijklmnopqrstuvwxyz0123456789';
    const response = await listScheduledJobs({
      bindings: [],
      // The reason quotes the document's bindingId, which differs from the file name.
      invalidFiles: { 'leaky.json': JSON.stringify(bindingDocument(secret, DAILY)) },
    });

    expect(response.bindings[0]).toHaveProperty('reason', expect.stringContaining('differs'));
    expect(JSON.stringify(response)).not.toContain(secret);
  });
});
