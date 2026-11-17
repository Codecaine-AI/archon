import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowHost } from '@archon/core/workflows/file-host';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { createTriggerMcpServer } from './trigger-mcp-server';
import type { listBindings, removeBinding, setBinding } from './trigger-bindings';
import type { getRun, listRuns, listWorkflows } from './trigger-runs';

const roots = trackTempRoots();
// Restore the keys in place: assigning a new object to process.env drops Bun's
// case-insensitive Windows env.
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID'].map(key => [key, process.env[key]])
);

interface Fixture {
  home: string;
  project: string;
  bindingsDir: string;
  launchAgents: string;
  host: WorkflowHost;
  userId: string;
  launchctl: string[][];
  /** Make the next matching launchctl subcommand fail, as launchd does without a session. */
  failLaunchctl: Set<string>;
  client: Client;
}

let fixture: Fixture;

beforeEach(async () => {
  const home = roots(await mkdtemp(join(tmpdir(), 'archon-trigger-mcp-')));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  // Workflow discovery reads platform policies, as every CLI route sets them first.
  setPlatformPolicies(defaultPlatformPolicies);
  const project = join(home, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  const host = await createFileWorkflowHost(join(home, 'store'));
  const user = await host.records.users.findOrCreateUserByPlatformIdentity(
    'cli',
    'tester',
    'tester'
  );
  if (!user) throw new Error('The file host did not create the test user.');
  const launchctl: string[][] = [];
  const failLaunchctl = new Set<string>();
  const bindingsDir = join(home, 'triggers');
  const launchAgents = join(home, 'LaunchAgents');
  const server = createTriggerMcpServer({
    host,
    bindingsDir,
    dispatch: async () => {
      throw new Error('No run is dispatched in these tests.');
    },
    env: {},
    nativeSchedule: {
      platform: 'darwin',
      uid: 501,
      launchAgentsDirectory: launchAgents,
      runCommand: async (_executable, args) => {
        launchctl.push([...args]);
        if (failLaunchctl.has(args[0] ?? '')) throw new Error(`launchctl ${args[0]} failed: 125`);
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  fixture = {
    home,
    project,
    bindingsDir,
    launchAgents,
    host,
    userId: user.id,
    launchctl,
    failLaunchctl,
    client,
  };
});

afterEach(async () => {
  await fixture.client.close();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function binding(overrides: { schedule?: unknown; inputs?: unknown; bindingId?: string } = {}) {
  return {
    version: 1,
    sourceInstanceId: 'hub-refresh',
    binding: {
      bindingId: overrides.bindingId ?? 'refresh',
      bindingRevision: null,
      hostId: 'hub',
      runAsUserId: fixture.userId,
      resource: 'refresh',
      overlap: 'skip',
      launch: {
        cwd: fixture.project,
        workflowName: 'refresh',
        inputs: overrides.inputs ?? {},
        isolation: { kind: 'in-place' },
      },
    },
    schedule: overrides.schedule ?? { intervalSeconds: 1800, runAtLoad: false },
  };
}

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string }> {
  const result = await fixture.client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, text: content[0]?.text ?? '' };
}

/** Each tool's JSON result, typed by the function behind it. */
interface ToolResults {
  list_bindings: Awaited<ReturnType<typeof listBindings>>;
  set_binding: Awaited<ReturnType<typeof setBinding>>;
  remove_binding: Awaited<ReturnType<typeof removeBinding>>;
  get_run: Awaited<ReturnType<typeof getRun>>;
  list_runs: Awaited<ReturnType<typeof listRuns>>;
  list_workflows: Awaited<ReturnType<typeof listWorkflows>>;
}

async function callOk<Name extends keyof ToolResults>(
  name: Name,
  args: Record<string, unknown> = {}
): Promise<ToolResults[Name]> {
  const result = await call(name, args);
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as ToolResults[Name];
}

async function bindingFiles(): Promise<string[]> {
  return existsSync(fixture.bindingsDir) ? await readdir(fixture.bindingsDir) : [];
}

async function launchAgentFiles(): Promise<string[]> {
  return existsSync(fixture.launchAgents) ? await readdir(fixture.launchAgents) : [];
}

const subcommands = (): string[] => fixture.launchctl.map(args => args[0] ?? '');

describe('list_bindings', () => {
  test('lists a valid binding with its schedule and an invalid file with the reason', async () => {
    await mkdir(fixture.bindingsDir, { recursive: true });
    await writeFile(join(fixture.bindingsDir, 'refresh.json'), JSON.stringify(binding()));
    await writeFile(join(fixture.bindingsDir, 'broken.json'), JSON.stringify({ version: 1 }));

    const listed = await callOk('list_bindings');

    expect(listed.bindings).toEqual([
      {
        file: 'broken.json',
        status: 'invalid',
        reason: expect.stringContaining('binding'),
      },
      {
        file: 'refresh.json',
        status: 'valid',
        bindingId: 'refresh',
        fileMatchesBindingId: true,
        workflowName: 'refresh',
        cwd: fixture.project,
        hostId: 'hub',
        schedule: { intervalSeconds: 1800, runAtLoad: false },
        scheduleInstalled: false,
      },
    ]);
  });
});

describe('set_binding', () => {
  test('refuses an id that is not a plain slug and writes nothing', async () => {
    for (const bindingId of ['../escape', '.hidden', 'a/b']) {
      const result = await call('set_binding', {
        bindingId,
        document: binding({ bindingId }),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not a plain slug');
    }
    expect(await bindingFiles()).toEqual([]);
    expect(fixture.launchctl).toEqual([]);
  });

  test('refuses a document that fails the schema and writes nothing', async () => {
    const { schedule: _schedule, ...withoutSchedule } = binding();

    const result = await call('set_binding', { bindingId: 'refresh', document: withoutSchedule });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('schedule');
    expect(await bindingFiles()).toEqual([]);
    expect(fixture.launchctl).toEqual([]);
  });

  test('refuses a document whose bindingId differs from the target', async () => {
    const result = await call('set_binding', { bindingId: 'other', document: binding() });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("differs from the target 'other'");
    expect(await bindingFiles()).toEqual([]);
  });

  test('writes a new binding with mode 600 and installs its LaunchAgent', async () => {
    const written = await callOk('set_binding', { bindingId: 'refresh', document: binding() });

    expect(written).toMatchObject({ bindingId: 'refresh', created: true, schedule: 'installed' });
    const path = join(fixture.bindingsDir, 'refresh.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(binding());
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await bindingFiles()).toEqual(['refresh.json']);
    expect(subcommands()).toEqual(['print', 'bootstrap']);
    expect(await launchAgentFiles()).toHaveLength(1);
    const plist = await readFile(
      join(fixture.launchAgents, (await launchAgentFiles())[0]!),
      'utf8'
    );
    expect(plist).toContain(`<string>${path}</string>`);
    expect((await callOk('list_bindings')).bindings).toMatchObject([{ scheduleInstalled: true }]);
  });

  test('a changed schedule replaces the LaunchAgent and reports the change', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    fixture.launchctl.length = 0;

    const changed = await callOk('set_binding', {
      bindingId: 'refresh',
      document: binding({ schedule: { calendar: [{ hour: 4, minute: 0 }], runAtLoad: false } }),
    });

    expect(changed).toMatchObject({ created: false, schedule: 'replaced' });
    expect(changed.changes).toEqual(['schedule.calendar', 'schedule.intervalSeconds']);
    expect(subcommands()).toEqual(['print', 'bootout', 'bootstrap']);
    const [plist] = await launchAgentFiles();
    expect(await readFile(join(fixture.launchAgents, plist!), 'utf8')).toContain(
      'StartCalendarInterval'
    );
  });

  test('a change the plist does not carry leaves the loaded job alone', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    fixture.launchctl.length = 0;

    const changed = await callOk('set_binding', {
      bindingId: 'refresh',
      document: binding({ inputs: { repository: 'acme/widgets' } }),
    });

    expect(changed).toMatchObject({
      schedule: 'unchanged',
      changes: ['binding.launch.inputs.repository'],
    });
    expect(subcommands()).not.toContain('bootout');
    expect(subcommands()).not.toContain('bootstrap');
  });

  test('a failed install after the write says what is on disk and what is installed', async () => {
    fixture.failLaunchctl.add('bootstrap');

    const result = await call('set_binding', { bindingId: 'refresh', document: binding() });

    expect(result.isError).toBe(true);
    const state = JSON.parse(result.text);
    expect(state).toMatchObject({
      bindingId: 'refresh',
      file: join(fixture.bindingsDir, 'refresh.json'),
      onDisk: 'The new binding document.',
      installed: 'No LaunchAgent for this binding is installed.',
      error: 'launchctl bootstrap failed: 125',
    });
    expect(state.message).toContain('was written, but its schedule was not installed');
    expect(JSON.parse(await readFile(state.file, 'utf8'))).toEqual(binding());
    expect(await launchAgentFiles()).toEqual([]);
  });

  test('without a launchd GUI session it refuses before writing', async () => {
    fixture.failLaunchctl.add('print');

    const result = await call('set_binding', { bindingId: 'refresh', document: binding() });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('launchd GUI domain gui/501 is not available');
    expect(await bindingFiles()).toEqual([]);
  });
});

describe('remove_binding', () => {
  test('removes the LaunchAgent, then the file', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    fixture.launchctl.length = 0;

    const removed = await callOk('remove_binding', { bindingId: 'refresh' });

    expect(removed).toMatchObject({ scheduleRemoved: true, fileRemoved: true });
    expect(subcommands()).toEqual(['print', 'bootout']);
    expect(await bindingFiles()).toEqual([]);
    expect(await launchAgentFiles()).toEqual([]);
  });

  test('keeps the file when launchd cannot remove the schedule', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    fixture.failLaunchctl.add('bootout');

    const result = await call('remove_binding', { bindingId: 'refresh' });

    expect(result.isError).toBe(true);
    expect(await bindingFiles()).toEqual(['refresh.json']);
  });

  test('names the missing file for an unknown binding', async () => {
    const result = await call('remove_binding', { bindingId: 'absent' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No binding 'absent'");
  });
});

describe('fire_binding', () => {
  test('refuses an unknown binding without starting anything', async () => {
    const result = await call('fire_binding', { bindingId: 'absent' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No binding 'absent'");
    expect(await fixture.host.deps.store.listStartReceipts()).toEqual([]);
  });
});

describe('runs', () => {
  async function createRun(): Promise<string> {
    const codebase = await fixture.host.records.codebases.createCodebase({
      name: 'project',
      default_cwd: fixture.project,
      // A folder project, so registration reads no git remote.
      kind: 'folder',
    });
    const run = await fixture.host.deps.store.createWorkflowRun({
      workflow_name: 'bash-only',
      user_message: '',
      codebase_id: codebase.id,
      working_path: fixture.project,
    });
    return run.id;
  }

  test('get_run returns the run and states that it has no transcript', async () => {
    const runId = await createRun();

    const detail = await callOk('get_run', { runId });

    expect(detail.run).toMatchObject({ id: runId, workflow_name: 'bash-only', status: 'pending' });
    expect(detail.nodes).toEqual([]);
    expect(detail.transcript).toMatchObject({ text: null, reason: 'The file does not exist.' });
    expect(detail.executorLog).toBeNull();
  });

  test('get_run reports an unknown run as a tool error', async () => {
    const result = await call('get_run', { runId: crypto.randomUUID() });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Workflow run not found');
  });

  test('list_runs lists runs across projects up to the limit', async () => {
    const first = await createRun();

    const listed = await callOk('list_runs', { limit: 5 });

    expect(listed.runs.map(run => run.id)).toEqual([first]);
  });

  test('list_workflows lists the workflows of each binding launch folder', async () => {
    await writeFile(
      join(fixture.project, '.archon', 'workflows', 'refresh.yaml'),
      'name: refresh\ndescription: Refresh state\nnodes:\n  - id: run\n    bash: echo ok\n'
    );
    await mkdir(fixture.bindingsDir, { recursive: true });
    await writeFile(join(fixture.bindingsDir, 'refresh.json'), JSON.stringify(binding()));

    const listed = await callOk('list_workflows');

    expect(listed.folders).toHaveLength(1);
    const [folder] = listed.folders;
    expect(folder).toMatchObject({ cwd: fixture.project, bindingIds: ['refresh'], errors: [] });
    const names = folder && 'workflows' in folder ? folder.workflows.map(entry => entry.name) : [];
    expect(names).toContain('refresh');
  });
});
