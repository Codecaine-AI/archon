import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
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
/** A credential-named env key, so the server's redaction treats its value as a secret. */
const SECRET_ENV_KEY = 'ARCHON_MCP_TEST_TOKEN';
const SECRET = 'hub-secret-value-4242';
// Restore the keys in place: assigning a new object to process.env drops Bun's
// case-insensitive Windows env.
const prior = Object.fromEntries(
  ['ARCHON_HOME', 'DATABASE_URL', 'GITHUB_APP_ID', SECRET_ENV_KEY].map(key => [
    key,
    process.env[key],
  ])
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
  /** Request ids the server handed to its executor. */
  dispatched: string[];
  /** Runs before each faked launchctl call, to stall it or change the disk under it. */
  hooks: { beforeLaunchctl?: (args: readonly string[]) => Promise<void> };
  client: Client;
}

let fixture: Fixture;

beforeEach(async () => {
  // The real path: preparation canonicalizes the launch folder (/var is /private/var on macOS).
  const home = await realpath(roots(await mkdtemp(join(tmpdir(), 'archon-trigger-mcp-'))));
  process.env.ARCHON_HOME = home;
  process.env.DATABASE_URL = '';
  process.env.GITHUB_APP_ID = '';
  process.env[SECRET_ENV_KEY] = SECRET;
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
  const dispatched: string[] = [];
  const hooks: Fixture['hooks'] = {};
  const server = createTriggerMcpServer({
    host,
    bindingsDir,
    // Record the hand-off only; the admitted run stays pending and holds its resource.
    dispatch: async requestId => {
      dispatched.push(requestId);
    },
    env: {},
    nativeSchedule: {
      platform: 'darwin',
      uid: 501,
      launchAgentsDirectory: launchAgents,
      runCommand: async (_executable, args) => {
        launchctl.push([...args]);
        await hooks.beforeLaunchctl?.(args);
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
    dispatched,
    hooks,
    client,
  };
});

afterEach(async () => {
  // A test can make the bindings folder unwritable; the temp tree must stay removable.
  if (existsSync(fixture.bindingsDir)) await chmod(fixture.bindingsDir, 0o700);
  await fixture.client.close();
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function binding(
  overrides: {
    schedule?: unknown;
    inputs?: unknown;
    bindingId?: string;
    sourceInstanceId?: string;
    runAsUserId?: string;
  } = {}
) {
  return {
    version: 1,
    sourceInstanceId: overrides.sourceInstanceId ?? 'hub-refresh',
    binding: {
      bindingId: overrides.bindingId ?? 'refresh',
      bindingRevision: null,
      hostId: 'hub',
      runAsUserId: overrides.runAsUserId ?? fixture.userId,
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

/** The binding files only; the folder also holds the `.locks` folder of binding locks. */
async function bindingFiles(): Promise<string[]> {
  return existsSync(fixture.bindingsDir)
    ? (await readdir(fixture.bindingsDir)).filter(name => name.endsWith('.json'))
    : [];
}

/** Registers the launch folder as a folder project, so registration reads no git remote. */
async function registerProject(): Promise<string> {
  const existing = await fixture.host.records.codebases.findCodebaseByDefaultCwd(fixture.project);
  if (existing) return existing.id;
  const codebase = await fixture.host.records.codebases.createCodebase({
    name: 'project',
    default_cwd: fixture.project,
    kind: 'folder',
  });
  return codebase.id;
}

async function writeWorkflow(description = 'Refresh state'): Promise<void> {
  await writeFile(
    join(fixture.project, '.archon', 'workflows', 'refresh.yaml'),
    `name: refresh\ndescription: ${description}\nnodes:\n  - id: run\n    bash: echo ok\n`
  );
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
  async function createRun(userMessage = ''): Promise<string> {
    const run = await fixture.host.deps.store.createWorkflowRun({
      workflow_name: 'bash-only',
      user_message: userMessage,
      codebase_id: await registerProject(),
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
    await writeWorkflow();
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

describe('redaction of successful results', () => {
  async function createRun(userMessage: string): Promise<string> {
    const run = await fixture.host.deps.store.createWorkflowRun({
      workflow_name: 'bash-only',
      user_message: userMessage,
      codebase_id: await registerProject(),
      working_path: fixture.project,
    });
    return run.id;
  }

  test('list_runs redacts a credential value stored in a run field', async () => {
    await createRun(`deploy with ${SECRET}`);

    const result = await call('list_runs', { limit: 5 });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain('deploy with [REDACTED]');
  });

  test('get_run redacts the run row, node event fields and the transcript tail', async () => {
    const runId = await createRun(`token ${SECRET}`);
    await fixture.host.deps.store.persistWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'node_failed',
      step_name: 'boom',
      data: { error: `curl failed with ${SECRET}` },
    });
    const first = await callOk('get_run', { runId });
    const transcriptPath = first.transcript.path;
    if (!transcriptPath) throw new Error('The run has no transcript path.');
    await mkdir(join(transcriptPath, '..'), { recursive: true });
    await writeFile(transcriptPath, `${JSON.stringify({ type: 'assistant', content: SECRET })}\n`);

    const result = await call('get_run', { runId });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(SECRET);
    const detail = JSON.parse(result.text) as ToolResults['get_run'];
    expect(detail.run.user_message).toBe('token [REDACTED]');
    expect(detail.nodes).toMatchObject([
      { nodeId: 'boom', state: 'failed', error: 'curl failed with [REDACTED]' },
    ]);
    expect(detail.transcript.text).toContain('[REDACTED]');
  });

  test('list_workflows redacts a credential value in a workflow field', async () => {
    await writeWorkflow(`Uses ${SECRET}`);
    await mkdir(fixture.bindingsDir, { recursive: true });
    await writeFile(join(fixture.bindingsDir, 'refresh.json'), JSON.stringify(binding()));

    const result = await call('list_workflows');

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain('Uses [REDACTED]');
  });
});

describe('a changed sourceInstanceId', () => {
  test('a failed removal of the old schedule writes nothing, and a retry leaves one schedule', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    const [oldPlist] = await launchAgentFiles();
    const moved = binding({ sourceInstanceId: 'hub-refresh-moved' });
    fixture.failLaunchctl.add('bootout');

    const refused = await call('set_binding', { bindingId: 'refresh', document: moved });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("sourceInstanceId 'hub-refresh') could not be removed");
    expect(refused.text).toContain('nothing was written');
    const path = join(fixture.bindingsDir, 'refresh.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(binding());
    expect(await launchAgentFiles()).toEqual([oldPlist]);

    fixture.failLaunchctl.delete('bootout');
    await callOk('set_binding', { bindingId: 'refresh', document: moved });

    const plists = await launchAgentFiles();
    expect(plists).toHaveLength(1);
    expect(plists[0]).not.toBe(oldPlist);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(moved);
  });
});

describe('the binding lock', () => {
  function lockPath(bindingId: string): string {
    return join(fixture.bindingsDir, '.locks', bindingId, 'lock');
  }

  test('two set_binding calls at once leave one schedule for the file', async () => {
    const results = await Promise.all([
      call('set_binding', { bindingId: 'refresh', document: binding({ sourceInstanceId: 'a' }) }),
      call('set_binding', { bindingId: 'refresh', document: binding({ sourceInstanceId: 'b' }) }),
    ]);

    expect(results.map(result => result.isError)).toEqual([false, false]);
    expect(await launchAgentFiles()).toHaveLength(1);
    const listed = await callOk('list_bindings');
    expect(listed.bindings).toMatchObject([{ status: 'valid', scheduleInstalled: true }]);
    expect(existsSync(lockPath('refresh'))).toBe(false);
  });

  test('a lock held by another live process is refused with a plain error', async () => {
    await mkdir(join(lockPath('refresh'), '..'), { recursive: true });
    // The parent process is alive, so it stands for another server holding the lock.
    await writeFile(
      lockPath('refresh'),
      JSON.stringify({ host: hostname(), pid: process.ppid, instance: crypto.randomUUID() })
    );

    const result = await call('set_binding', { bindingId: 'refresh', document: binding() });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Binding 'refresh' is busy");
    expect(result.text).toContain(`process ${String(process.ppid)}`);
    expect(await bindingFiles()).toEqual([]);
  }, 15_000);

  test('a lock whose owner process is gone is broken and the call proceeds', async () => {
    const exited = Bun.spawn([process.execPath, '-e', '0']);
    await exited.exited;
    await mkdir(join(lockPath('refresh'), '..'), { recursive: true });
    await writeFile(
      lockPath('refresh'),
      JSON.stringify({ host: hostname(), pid: exited.pid, instance: crypto.randomUUID() })
    );

    await callOk('set_binding', { bindingId: 'refresh', document: binding() });

    expect(await bindingFiles()).toEqual(['refresh.json']);
    expect(existsSync(lockPath('refresh'))).toBe(false);
  });
});

describe('a binding file that names another binding', () => {
  test('a symbolic link is listed as invalid and cannot remove or fire its target', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    await symlink(
      join(fixture.bindingsDir, 'refresh.json'),
      join(fixture.bindingsDir, 'alias.json')
    );
    fixture.launchctl.length = 0;

    const removed = await call('remove_binding', { bindingId: 'alias' });
    const fired = await call('fire_binding', { bindingId: 'alias' });
    const listed = await callOk('list_bindings');

    expect(removed.isError).toBe(true);
    expect(removed.text).toContain('symbolic link');
    expect(fired.isError).toBe(true);
    expect(fired.text).toContain('symbolic link');
    expect(subcommands()).not.toContain('bootout');
    expect(await launchAgentFiles()).toHaveLength(1);
    expect(await fixture.host.deps.store.listStartReceipts()).toEqual([]);
    expect(listed.bindings).toMatchObject([
      { file: 'alias.json', status: 'invalid', reason: expect.stringContaining('symbolic link') },
      { file: 'refresh.json', status: 'valid' },
    ]);
  });

  test('a document whose bindingId differs from its file name is invalid', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    await writeFile(join(fixture.bindingsDir, 'copy.json'), JSON.stringify(binding()));

    const removed = await call('remove_binding', { bindingId: 'copy' });
    const listed = await callOk('list_bindings');

    expect(removed.isError).toBe(true);
    expect(removed.text).toContain("differs from its file name 'copy.json'");
    expect(await launchAgentFiles()).toHaveLength(1);
    expect(listed.bindings).toMatchObject([
      { file: 'copy.json', status: 'invalid', reason: expect.stringContaining('differs') },
      { file: 'refresh.json', status: 'valid' },
    ]);
  });
});

describe('fire_binding starts', () => {
  test('returns the run id of a started run, then the reason for a skipped start', async () => {
    await writeWorkflow();
    await registerProject();
    await mkdir(fixture.bindingsDir, { recursive: true });
    await writeFile(join(fixture.bindingsDir, 'refresh.json'), JSON.stringify(binding()));

    const started = await call('fire_binding', { bindingId: 'refresh' });
    expect(started.isError, started.text).toBe(false);
    const first = JSON.parse(started.text) as { started: boolean; runId: string | null };
    expect(first).toMatchObject({ started: true, reason: null });
    expect(first.runId).toEqual(expect.any(String));
    expect(fixture.dispatched).toHaveLength(1);

    // The first run is still pending, so it holds the resource and `overlap: skip` applies.
    const skipped = await call('fire_binding', { bindingId: 'refresh' });
    expect(skipped.isError, skipped.text).toBe(false);
    expect(JSON.parse(skipped.text)).toMatchObject({
      started: false,
      runId: null,
      reason: `The start was skipped: run ${String(first.runId)} holds the binding's resource.`,
    });
    expect(fixture.dispatched).toHaveLength(1);
  });
});

describe('set_binding run-as user', () => {
  test('refuses an unknown run-as user and writes nothing', async () => {
    const result = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ runAsUserId: crypto.randomUUID() }),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown run-as user');
    expect(await bindingFiles()).toEqual([]);
    expect(fixture.launchctl).toEqual([]);
  });
});

describe('a failed write after the old schedule is removed', () => {
  /** Changes sourceInstanceId; the removal of the old job succeeds, then the folder refuses the file. */
  async function failWriteAfterBootout(
    failReinstall: boolean
  ): Promise<{ text: string; oldPlist: string }> {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    const [oldPlist] = await launchAgentFiles();
    if (!oldPlist) throw new Error('The first set_binding installed no LaunchAgent.');
    fixture.hooks.beforeLaunchctl = async args => {
      if (args[0] !== 'bootout') return;
      await chmod(fixture.bindingsDir, 0o500);
      if (failReinstall) fixture.failLaunchctl.add('bootstrap');
    };
    const result = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ sourceInstanceId: 'hub-refresh-moved' }),
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(await readFile(join(fixture.bindingsDir, 'refresh.json'), 'utf8'))).toEqual(
      binding()
    );
    return { text: result.text, oldPlist };
  }

  test('installs the old schedule again and says so', async () => {
    const { text, oldPlist } = await failWriteAfterBootout(false);

    expect(JSON.parse(text)).toMatchObject({
      onDisk: 'The previous binding document, unchanged.',
      installed: "The previous document's schedule is installed again, from its saved plist.",
      error: expect.stringContaining('EACCES'),
    });
    expect(await launchAgentFiles()).toEqual([oldPlist]);
  });

  test('says the old schedule is not installed when that install fails too', async () => {
    const { text } = await failWriteAfterBootout(true);

    expect(JSON.parse(text)).toMatchObject({
      onDisk: 'The previous binding document, unchanged.',
      installed:
        "The previous document's schedule is NOT installed: launchctl bootstrap failed: 125",
      error: expect.stringContaining('EACCES'),
    });
    expect(await launchAgentFiles()).toEqual([]);
  });
});

describe('structural fields and free text', () => {
  const GHS_SHAPED = 'ghs_ABCDEFGHIJKLMNOPQRSTUVWX';

  test('a ghs_-shaped binding id round-trips through list_bindings and remove_binding', async () => {
    const written = await callOk('set_binding', {
      bindingId: GHS_SHAPED,
      document: binding({ bindingId: GHS_SHAPED }),
    });
    expect(written.bindingId).toBe(GHS_SHAPED);

    const listed = await callOk('list_bindings');
    expect(listed.bindings).toMatchObject([
      { file: `${GHS_SHAPED}.json`, status: 'valid', bindingId: GHS_SHAPED },
    ]);

    const removed = await callOk('remove_binding', { bindingId: GHS_SHAPED });
    expect(removed).toMatchObject({ bindingId: GHS_SHAPED, fileRemoved: true });
    expect(await bindingFiles()).toEqual([]);
  });

  test('a free-text field with the same shape is still redacted', async () => {
    await fixture.host.deps.store.createWorkflowRun({
      workflow_name: 'bash-only',
      user_message: `use ${GHS_SHAPED}`,
      codebase_id: await registerProject(),
      working_path: fixture.project,
    });

    const result = await call('list_runs', { limit: 5 });

    expect(result.text).not.toContain(GHS_SHAPED);
    expect(result.text).toContain('use [REDACTED]');
  });

  test('a structural field that holds a real credential value is still redacted', async () => {
    await callOk('set_binding', { bindingId: SECRET, document: binding({ bindingId: SECRET }) });

    const result = await call('list_bindings');

    expect(result.text).not.toContain(SECRET);
    expect(JSON.parse(result.text)).toMatchObject({
      bindings: [{ file: '[REDACTED].json', bindingId: '[REDACTED]' }],
    });
  });
});

describe('the in-process wait for the binding lock', () => {
  test('a call queued behind a hung call is refused at the deadline and never runs', async () => {
    let release!: () => void;
    const hung = new Promise<void>(resolveHung => (release = resolveHung));
    fixture.hooks.beforeLaunchctl = async args => {
      if (args[0] === 'bootstrap') await hung;
    };
    const first = call('set_binding', { bindingId: 'refresh', document: binding() });
    while (!fixture.launchctl.some(args => args[0] === 'bootstrap')) await Bun.sleep(5);

    const started = Date.now();
    const second = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ inputs: { late: true } }),
    });
    const waitedMs = Date.now() - started;

    expect(second.isError).toBe(true);
    expect(second.text).toContain("Binding 'refresh' is busy");
    expect(second.text).toContain('in this server');
    expect(waitedMs).toBeLessThan(6_000);
    release();
    expect((await first).isError).toBe(false);
    // Let a wrongly queued second call run, if it were still waiting.
    await Bun.sleep(50);
    expect(JSON.parse(await readFile(join(fixture.bindingsDir, 'refresh.json'), 'utf8'))).toEqual(
      binding()
    );
    expect(fixture.launchctl.filter(args => args[0] === 'bootstrap')).toHaveLength(1);
  }, 15_000);
});

describe('the restore keeps the installed plist', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test('a failed rename puts back the plist bytes of the first install, not this server PATH', async () => {
    process.env.PATH = '/original-install/bin';
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    const [plistName] = await launchAgentFiles();
    if (!plistName) throw new Error('The first set_binding installed no LaunchAgent.');
    const installedBytes = await readFile(join(fixture.launchAgents, plistName), 'utf8');
    expect(installedBytes).toContain('/original-install/bin');
    process.env.PATH = '/ssh-server/bin';
    fixture.hooks.beforeLaunchctl = async args => {
      if (args[0] === 'bootout') await chmod(fixture.bindingsDir, 0o500);
    };

    const result = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ sourceInstanceId: 'hub-refresh-moved' }),
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({
      installed: "The previous document's schedule is installed again, from its saved plist.",
    });
    expect(await launchAgentFiles()).toEqual([plistName]);
    expect(await readFile(join(fixture.launchAgents, plistName), 'utf8')).toBe(installedBytes);
  });

  test('a document that cannot be prepared leaves the old schedule alone', async () => {
    await callOk('set_binding', { bindingId: 'refresh', document: binding() });
    const plists = await launchAgentFiles();
    fixture.launchctl.length = 0;
    await chmod(fixture.bindingsDir, 0o500);

    const result = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ sourceInstanceId: 'hub-refresh-moved' }),
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('EACCES');
    expect(subcommands()).not.toContain('bootout');
    expect(await launchAgentFiles()).toEqual(plists);
    expect(JSON.parse(await readFile(join(fixture.bindingsDir, 'refresh.json'), 'utf8'))).toEqual(
      binding()
    );
  });
});

describe('structural paths only where the tool builds them', () => {
  const GHS_SHAPED = 'ghs_ABCDEFGHIJKLMNOPQRSTUVWX';

  test('caller data under run metadata is fully redacted whatever its keys are named', async () => {
    const run = await fixture.host.deps.store.createWorkflowRun({
      workflow_name: 'bash-only',
      user_message: '',
      codebase_id: await registerProject(),
      working_path: fixture.project,
      // `run.id` as one key: a stored key that spells a result path is still caller data.
      metadata: {
        id: GHS_SHAPED,
        'run.id': GHS_SHAPED,
        inputs: { name: GHS_SHAPED, description: GHS_SHAPED },
      },
    });

    const result = await call('get_run', { runId: run.id });
    const listed = await call('list_runs', { limit: 5 });

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(GHS_SHAPED);
    const detail = JSON.parse(result.text) as ToolResults['get_run'];
    expect(detail.run.id).toBe(run.id);
    expect(detail.run.metadata).toMatchObject({
      id: '[REDACTED]',
      'run.id': '[REDACTED]',
      inputs: { name: '[REDACTED]', description: '[REDACTED]' },
    });
    expect(listed.text).not.toContain(GHS_SHAPED);
  });
});

describe('the in-process queue after a caller gave up', () => {
  test('a third call behind a hung call and a refused one is refused too and never runs', async () => {
    let release!: () => void;
    const hung = new Promise<void>(resolveHung => (release = resolveHung));
    fixture.hooks.beforeLaunchctl = async args => {
      if (args[0] === 'bootstrap') await hung;
    };
    const first = call('set_binding', { bindingId: 'refresh', document: binding() });
    while (!fixture.launchctl.some(args => args[0] === 'bootstrap')) await Bun.sleep(5);
    const second = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ inputs: { second: true } }),
    });
    expect(second.text).toContain('in this server');

    const started = Date.now();
    const third = await call('set_binding', {
      bindingId: 'refresh',
      document: binding({ inputs: { third: true } }),
    });
    const waitedMs = Date.now() - started;

    expect(third.isError).toBe(true);
    expect(third.text).toContain('in this server');
    expect(waitedMs).toBeLessThan(6_000);
    release();
    expect((await first).isError).toBe(false);
    await Bun.sleep(50);
    expect(JSON.parse(await readFile(join(fixture.bindingsDir, 'refresh.json'), 'utf8'))).toEqual(
      binding()
    );
    expect(fixture.launchctl.filter(args => args[0] === 'bootstrap')).toHaveLength(1);

    // Once every caller has settled, the queue is empty and a new call runs at once.
    fixture.hooks.beforeLaunchctl = undefined;
    const next = Date.now();
    await callOk('set_binding', { bindingId: 'refresh', document: binding({ inputs: { d: 1 } }) });
    expect(Date.now() - next).toBeLessThan(1_000);
  }, 25_000);
});
