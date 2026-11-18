import { afterEach, describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  installMacosNativeSchedule,
  removeMacosNativeSchedule,
  renderMacosLaunchAgent,
  type NativeScheduleConfig,
} from './native-schedule';
import { timerTriggerConfigSchema } from '@archon/core/workflows/timer-bindings';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

function config(overrides: Partial<NativeScheduleConfig> = {}): NativeScheduleConfig {
  return {
    id: 'source-refresh',
    programArguments: ['/opt/archon/bin/archon', 'trigger', 'fire', '--config', '/tmp/a&b.json'],
    workingDirectory: '/Users/example/Project <one>',
    archonHome: '/Users/example/.archon',
    path: '/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin',
    schedule: { intervalSeconds: 37, runAtLoad: false },
    ...overrides,
  };
}

async function scratchDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'archon-native-schedule-'));
  tempRoots.push(path);
  return path;
}

describe('renderMacosLaunchAgent', () => {
  it('renders escaped arguments as an argv array', () => {
    const rendered = renderMacosLaunchAgent(config());

    expect(rendered.label).toBe('com.archon.trigger.source-refresh');
    expect(rendered.plist).toContain('<string>/tmp/a&amp;b.json</string>');
    expect(rendered.plist).toContain('<string>/Users/example/Project &lt;one&gt;</string>');
    expect(rendered.plist).toContain('<integer>37</integer>');
    expect(rendered.plist).toContain('<false/>');
    expect(rendered.plist).not.toContain('<key>Program</key>');
    expect(rendered.plist).not.toContain('<key>ShellPath</key>');
  });

  it('rejects settings that cannot be represented by the owned launchd job', () => {
    expect(() => renderMacosLaunchAgent(config({ id: '../other-job' }))).toThrow(
      'Native schedule id must'
    );
    expect(() =>
      renderMacosLaunchAgent(config({ programArguments: ['archon', 'trigger', 'fire'] }))
    ).toThrow('executable must be an absolute path');
    expect(() =>
      renderMacosLaunchAgent(config({ schedule: { intervalSeconds: 0, runAtLoad: false } }))
    ).toThrow('positive integer');
    expect(() => renderMacosLaunchAgent(config({ path: '' }))).toThrow('PATH must not be empty');
  });

  it.skipIf(process.platform !== 'darwin')(
    'gives the job exactly ARCHON_HOME and the installing PATH as macOS reads them',
    async () => {
      const directory = await scratchDirectory();
      const path = join(directory, 'job.plist');
      const pathWithMarkup = '/Users/example/tools & <bin>:/usr/bin';
      await writeFile(path, renderMacosLaunchAgent(config({ path: pathWithMarkup })).plist);

      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-extract',
        'EnvironmentVariables',
        'json',
        '-o',
        '-',
        path,
      ]);
      expect(JSON.parse(stdout)).toEqual({
        ARCHON_HOME: '/Users/example/.archon',
        PATH: pathWithMarkup,
      });
    }
  );
});

describe('renderMacosLaunchAgent schedules', () => {
  /** The schedule keys of a rendered plist, between the environment and `RunAtLoad`. */
  function startKeys(schedule: NativeScheduleConfig['schedule']): string {
    const { plist } = renderMacosLaunchAgent(config({ schedule }));
    return plist.slice(plist.indexOf('    </dict>\n') + 12, plist.indexOf('    <key>RunAtLoad'));
  }

  it('renders an interval job exactly as installed jobs already on disk', () => {
    // Installation refuses a plist whose bytes differ, so this text must not drift.
    expect(renderMacosLaunchAgent(config()).plist).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.archon.trigger.source-refresh</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/archon/bin/archon</string>
      <string>trigger</string>
      <string>fire</string>
      <string>--config</string>
      <string>/tmp/a&amp;b.json</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/example/Project &lt;one&gt;</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ARCHON_HOME</key>
      <string>/Users/example/.archon</string>
      <key>PATH</key>
      <string>/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartInterval</key>
    <integer>37</integer>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`);
  });

  it('renders one clock time as StartCalendarInterval in place of StartInterval', () => {
    expect(startKeys({ calendar: [{ hour: 4, minute: 0 }], runAtLoad: true })).toBe(
      `    <key>StartCalendarInterval</key>
    <array>
      <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>0</integer>
      </dict>
    </array>
`
    );
    expect(
      renderMacosLaunchAgent(
        config({ schedule: { calendar: [{ hour: 4, minute: 0 }], runAtLoad: true } })
      ).plist
    ).toContain('<key>RunAtLoad</key>\n    <true/>');
  });

  it('renders several clock times, keeping weekday and day only where given', () => {
    expect(
      startKeys({
        calendar: [
          { hour: 4, minute: 30 },
          { hour: 10, minute: 0, weekday: 0, day: 1 },
        ],
        runAtLoad: false,
      })
    ).toBe(
      `    <key>StartCalendarInterval</key>
    <array>
      <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>30</integer>
      </dict>
      <dict>
        <key>Hour</key>
        <integer>10</integer>
        <key>Minute</key>
        <integer>0</integer>
        <key>Weekday</key>
        <integer>0</integer>
        <key>Day</key>
        <integer>1</integer>
      </dict>
    </array>
`
    );
  });

  it('rejects a calendar launchd cannot run', () => {
    expect(() =>
      renderMacosLaunchAgent(config({ schedule: { calendar: [], runAtLoad: false } }))
    ).toThrow('calendar is invalid');
    expect(() =>
      renderMacosLaunchAgent(
        config({ schedule: { calendar: [{ hour: 24, minute: 0 }], runAtLoad: false } })
      )
    ).toThrow('calendar is invalid: 0.hour');
  });

  it.skipIf(process.platform !== 'darwin')(
    'gives the job the calendar as macOS reads it',
    async () => {
      const directory = await scratchDirectory();
      const path = join(directory, 'job.plist');
      const calendar = [
        { hour: 4, minute: 0 },
        { hour: 10, minute: 0, weekday: 0 },
      ];
      await writeFile(
        path,
        renderMacosLaunchAgent(config({ schedule: { calendar, runAtLoad: false } })).plist
      );

      const { stdout } = await execFileAsync('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        path,
      ]);
      const job = JSON.parse(stdout) as Record<string, unknown>;
      expect(job.StartCalendarInterval).toEqual([
        { Hour: 4, Minute: 0 },
        { Hour: 10, Minute: 0, Weekday: 0 },
      ]);
      expect(job).not.toHaveProperty('StartInterval');
    }
  );
});

describe('timer binding schedule', () => {
  function parse(schedule: unknown): boolean {
    return timerTriggerConfigSchema.safeParse({
      version: 1,
      sourceInstanceId: 'source-1',
      binding: {
        bindingId: 'binding-1',
        bindingRevision: null,
        hostId: 'host-1',
        runAsUserId: 'user-1',
        resource: 'refresh',
        overlap: 'skip',
        launch: {
          cwd: '/Users/example/project',
          workflowName: 'refresh',
          inputs: {},
          isolation: { kind: 'default' },
        },
      },
      schedule,
    }).success;
  }

  it.each([
    ['an interval', { intervalSeconds: 900, runAtLoad: true }],
    ['one clock time', { calendar: [{ hour: 4, minute: 0 }], runAtLoad: false }],
    [
      'clock times with weekday and day',
      {
        calendar: [
          { hour: 10, minute: 0, weekday: 0 },
          { hour: 0, minute: 59, day: 31 },
        ],
        runAtLoad: false,
      },
    ],
  ])('accepts %s', (_name, schedule) => {
    expect(parse(schedule)).toBe(true);
  });

  it.each([
    ['both forms', { intervalSeconds: 900, calendar: [{ hour: 4, minute: 0 }], runAtLoad: true }],
    ['neither form', { runAtLoad: true }],
    ['an empty calendar', { calendar: [], runAtLoad: false }],
    [
      'more than 24 clock times',
      {
        calendar: Array.from({ length: 25 }, (_, minute) => ({ hour: 1, minute })),
        runAtLoad: false,
      },
    ],
    ['hour 24', { calendar: [{ hour: 24, minute: 0 }], runAtLoad: false }],
    ['minute 60', { calendar: [{ hour: 4, minute: 60 }], runAtLoad: false }],
    ['weekday 7', { calendar: [{ hour: 4, minute: 0, weekday: 7 }], runAtLoad: false }],
    ['day 0', { calendar: [{ hour: 4, minute: 0, day: 0 }], runAtLoad: false }],
    ['a fractional minute', { calendar: [{ hour: 4, minute: 0.5 }], runAtLoad: false }],
    ['a missing hour', { calendar: [{ minute: 0 }], runAtLoad: false }],
    ['an unknown entry key', { calendar: [{ hour: 4, minute: 0, month: 1 }], runAtLoad: false }],
  ])('rejects %s', (_name, schedule) => {
    expect(parse(schedule)).toBe(false);
  });
});

describe('native schedule installation', () => {
  it('installs and removes only the exact owned launch agent', async () => {
    const directory = await scratchDirectory();
    const commands: Array<{ executable: string; args: readonly string[] }> = [];
    const runCommand = async (executable: string, args: readonly string[]): Promise<void> => {
      commands.push({ executable, args });
    };

    const path = await installMacosNativeSchedule(config(), {
      platform: 'darwin',
      uid: 501,
      launchAgentsDirectory: directory,
      runCommand,
    });

    expect(path).toBe(join(directory, 'com.archon.trigger.source-refresh.plist'));
    expect(await readFile(path, 'utf8')).toBe(renderMacosLaunchAgent(config()).plist);
    expect(commands[0]).toEqual({
      executable: '/bin/launchctl',
      args: ['bootstrap', 'gui/501', path],
    });

    expect(
      await removeMacosNativeSchedule('source-refresh', {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand,
      })
    ).toBe(true);
    expect(commands[1]).toEqual({
      executable: '/bin/launchctl',
      args: ['bootout', 'gui/501', path],
    });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to replace a different configuration under the same owned id', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');
    await writeFile(path, 'user-owned or stale contents');
    let commandRan = false;

    await expect(
      installMacosNativeSchedule(config(), {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          commandRan = true;
        },
      })
    ).rejects.toThrow('Refusing to replace');
    expect(commandRan).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('user-owned or stale contents');
  });

  it('rolls back a newly written plist when launchd rejects installation', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');

    await expect(
      installMacosNativeSchedule(config(), {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          throw new Error('bootstrap failed');
        },
      })
    ).rejects.toThrow('bootstrap failed');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the plist when launchd refuses removal', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');
    await writeFile(path, renderMacosLaunchAgent(config()).plist);

    await expect(
      removeMacosNativeSchedule('source-refresh', {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async () => {
          throw new Error('bootout failed');
        },
      })
    ).rejects.toThrow('bootout failed');
    expect(await readFile(path, 'utf8')).toBe(renderMacosLaunchAgent(config()).plist);
  });

  it('rejects installation on unsupported hosts', async () => {
    await expect(installMacosNativeSchedule(config(), { platform: 'linux' })).rejects.toThrow(
      'supported only on macOS'
    );
  });
});

describe('workflow wake native schedule', () => {
  it('installs the generated wake argv, preserves configuration and removes only that job', async () => {
    const { workflowWakeScheduleConfig } = await import('../commands/workflow-continuations');
    const generated = workflowWakeScheduleConfig(5);
    const originalId = generated.id;
    expect(workflowWakeScheduleConfig(10).id).toBe(originalId);
    expect(generated.programArguments.slice(-4)).toEqual(['workflow', 'wake', '--watch', '--json']);
    expect(generated.programArguments[0]).toBe(process.execPath);
    expect(generated.programArguments[1]).toBe(resolve(process.argv[1]));
    expect(generated.workingDirectory).toBe(generated.archonHome);
    expect(generated.path).toBe(process.env.PATH ?? '');
    const directory = await mkdtemp(join(tmpdir(), 'archon-wake-schedule-'));
    tempRoots.push(directory);
    const commands: string[][] = [];
    const runtime = {
      platform: 'darwin' as const,
      uid: 501,
      launchAgentsDirectory: directory,
      runCommand: async (executable: string, args: readonly string[]) => {
        commands.push([executable, ...args]);
      },
    };
    const installed = await installMacosNativeSchedule(generated, runtime);
    expect(await readFile(installed, 'utf8')).toContain('<string>wake</string>');
    expect(await installMacosNativeSchedule(generated, runtime)).toBe(installed);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual([
      '/bin/launchctl',
      'print',
      `gui/501/com.archon.trigger.${originalId}`,
    ]);
    await expect(
      installMacosNativeSchedule(workflowWakeScheduleConfig(10), runtime)
    ).rejects.toThrow(
      /different configuration.*PATH.*archon workflow wake schedule remove.*install it again/
    );
    expect(await removeMacosNativeSchedule(originalId, runtime)).toBe(true);
    expect(commands[2]).toEqual(['/bin/launchctl', 'bootout', 'gui/501', installed]);
    expect(await removeMacosNativeSchedule(originalId, runtime)).toBe(false);
  });

  it('rejects an identical install when launchd registration cannot be verified and keeps the plist', async () => {
    const directory = await scratchDirectory();
    const path = join(directory, 'com.archon.trigger.source-refresh.plist');
    const plist = renderMacosLaunchAgent(config()).plist;
    await writeFile(path, plist);
    const commands: string[][] = [];
    await expect(
      installMacosNativeSchedule(config(), {
        platform: 'darwin',
        uid: 501,
        launchAgentsDirectory: directory,
        runCommand: async (executable, args) => {
          commands.push([executable, ...args]);
          throw new Error('service not registered');
        },
      })
    ).rejects.toThrow('service not registered');
    expect(commands).toEqual([
      ['/bin/launchctl', 'print', 'gui/501/com.archon.trigger.source-refresh'],
    ]);
    expect(await readFile(path, 'utf8')).toBe(plist);
  });
});
