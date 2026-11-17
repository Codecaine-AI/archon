/**
 * The binding files of one install's bindings folder, and the LaunchAgent each one
 * schedules. A binding file is `<bindings folder>/<bindingId>.json`; the folder is a
 * convention of the operator, so every tool here takes it from the server's context.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { StartBindingInspection } from '@archon/workflows/resource-start-store';
import {
  assertKnownRunAsUser,
  fireTimerBinding,
  installTimerSchedule,
  parseTimerConfig,
  removeTimerSchedule,
  timerScheduleId,
  timerTriggerConfigSchema,
  type TimerTriggerConfig,
  type TriggerDispatch,
} from '../commands/trigger';
import {
  assertMacosLaunchdSession,
  macosNativeScheduleInstalled,
  NativeScheduleConflictError,
  type NativeScheduleOptions,
} from '../triggers/native-schedule';

export interface TriggerToolContext {
  host: WorkflowHost;
  /** Absolute folder that holds `<bindingId>.json` binding files. */
  bindingsDir: string;
  /** Hands an admitted start to its executor; the CLI spawns a detached `trigger execute`. */
  dispatch: TriggerDispatch;
  /** The environment a fire reads a calling node's identity from. */
  env: NodeJS.ProcessEnv;
  /** launchd seams; tests replace the launchctl call and the LaunchAgents folder. */
  nativeSchedule?: NativeScheduleOptions;
}

/** A plain file-name slug: no separators and no leading dot, so it cannot leave the folder. */
const BINDING_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function bindingFilePath(bindingsDir: string, bindingId: string): string {
  if (!BINDING_ID.test(bindingId))
    throw new Error(
      `Binding id '${bindingId}' is not a plain slug: use letters, digits, '-', '_' and '.', and do not start with '.'.`
    );
  return join(bindingsDir, `${bindingId}.json`);
}

/** Every schema issue with its field and message, for an agent to fix the document. */
function validateBindingDocument(document: unknown): TimerTriggerConfig {
  const parsed = timerTriggerConfigSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `The binding document fails the schema: ${parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(document)'}: ${issue.message}`)
        .join('; ')}`
    );
  return parseTimerConfig(parsed.data);
}

type ReadBinding =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; config: TimerTriggerConfig };

async function readBinding(path: string): Promise<ReadBinding> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    return { kind: 'valid', config: validateBindingDocument(JSON.parse(text) as unknown) };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function scheduleInstalled(
  config: TimerTriggerConfig,
  options: NativeScheduleOptions | undefined
): Promise<boolean> {
  return await macosNativeScheduleInstalled(timerScheduleId(config), options);
}

export type ListedBinding =
  | {
      file: string;
      status: 'valid';
      bindingId: string;
      /** False when the file name is not `<bindingId>.json`; the other tools cannot target it. */
      fileMatchesBindingId: boolean;
      workflowName: string;
      cwd: string;
      hostId: string;
      schedule: TimerTriggerConfig['schedule'];
      scheduleInstalled: boolean | null;
      scheduleError?: string;
    }
  | { file: string; status: 'invalid'; reason: string };

async function listedBinding(
  context: TriggerToolContext,
  file: string
): Promise<ListedBinding | undefined> {
  const read = await readBinding(join(context.bindingsDir, file));
  if (read.kind === 'missing') return undefined;
  if (read.kind === 'invalid') return { file, status: 'invalid', reason: read.reason };
  const { config } = read;
  let installed: boolean | null = null;
  let scheduleError: string | undefined;
  try {
    installed = await scheduleInstalled(config, context.nativeSchedule);
  } catch (error) {
    scheduleError = error instanceof Error ? error.message : String(error);
  }
  return {
    file,
    status: 'valid',
    bindingId: config.binding.bindingId,
    fileMatchesBindingId: file === `${config.binding.bindingId}.json`,
    workflowName: config.binding.launch.workflowName,
    cwd: config.binding.launch.cwd,
    hostId: config.binding.hostId,
    schedule: config.schedule,
    scheduleInstalled: installed,
    ...(scheduleError === undefined ? {} : { scheduleError }),
  };
}

/** Every `*.json` file in the bindings folder; an invalid file is listed with its reason. */
export async function listBindings(
  context: TriggerToolContext
): Promise<{ bindingsDir: string; bindings: ListedBinding[] }> {
  let files: string[];
  try {
    files = (await readdir(context.bindingsDir)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { bindingsDir: context.bindingsDir, bindings: [] };
    throw error;
  }
  const bindings: ListedBinding[] = [];
  for (const file of files) {
    const entry = await listedBinding(context, file);
    if (entry) bindings.push(entry);
  }
  return { bindingsDir: context.bindingsDir, bindings };
}

/** The valid binding at `<bindingId>.json`, or an error that says why there is none. */
export async function requireBinding(
  context: TriggerToolContext,
  bindingId: string
): Promise<{ path: string; config: TimerTriggerConfig }> {
  const path = bindingFilePath(context.bindingsDir, bindingId);
  const read = await readBinding(path);
  if (read.kind === 'missing')
    throw new Error(`No binding '${bindingId}': ${path} does not exist.`);
  if (read.kind === 'invalid') throw new Error(`Binding file ${path} is invalid: ${read.reason}`);
  return { path, config: read.config };
}

function fireOutcome(binding: StartBindingInspection | undefined): {
  started: boolean;
  runId: string | null;
  reason: string | null;
} {
  const disposition = binding?.disposition;
  if (disposition?.status === 'admitted')
    return { started: true, runId: disposition.runId, reason: null };
  if (disposition)
    return {
      started: false,
      runId: null,
      reason: `The start was ${disposition.status}: ${disposition.blocker.kind} ${disposition.blocker.id} holds the binding's resource.`,
    };
  return {
    started: false,
    runId: null,
    reason: `Preparation is ${binding?.status ?? 'unknown'}${binding?.error ? `: ${binding.error}` : ''}.`,
  };
}

/** Start one run of a binding now, as `archon trigger fire --config <file>` does. */
export async function fireBinding(context: TriggerToolContext, bindingId: string) {
  const { path } = await requireBinding(context, bindingId);
  const receipt = await fireTimerBinding(context.host, path, context.dispatch, context.env);
  if (!receipt) throw new Error('The start was accepted, but its receipt is not readable.');
  const binding = receipt.bindings.find(entry => entry.bindingId === bindingId);
  return {
    bindingId,
    receiptId: receipt.id,
    ...fireOutcome(binding),
    requestId: binding?.disposition?.requestId ?? null,
  };
}

/** Dotted paths of the values that differ between two JSON documents. */
function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(before) || !isObject(after))
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix || '(document)'];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap(key =>
    changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key)
  );
}

/** Writes the document as the caller wrote it, not its parsed form with defaults filled in. */
async function writeBindingFile(path: string, document: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

type ScheduleAction = 'installed' | 'unchanged' | 'replaced';

/**
 * Install the new document's LaunchAgent. An identical job stays loaded, so a change that
 * leaves the plist alone (inputs, workflow, resource) does not reload it or fire `runAtLoad`.
 * A job whose plist differs is removed and installed again.
 */
async function applySchedule(
  context: TriggerToolContext,
  previous: TimerTriggerConfig | undefined,
  config: TimerTriggerConfig,
  path: string
): Promise<ScheduleAction> {
  const options = context.nativeSchedule;
  // A new source instance names a different job; the old one would keep firing this file.
  if (previous && timerScheduleId(previous) !== timerScheduleId(config))
    await removeTimerSchedule(previous, options);
  const wasInstalled = await scheduleInstalled(config, options);
  try {
    await installTimerSchedule(context.host, config, path, options);
    return wasInstalled ? 'unchanged' : 'installed';
  } catch (error) {
    if (!(error instanceof NativeScheduleConflictError)) throw error;
  }
  await removeTimerSchedule(config, options);
  await installTimerSchedule(context.host, config, path, options);
  return 'replaced';
}

export class BindingScheduleError extends Error {
  constructor(
    message: string,
    readonly state: {
      bindingId: string;
      file: string;
      onDisk: string;
      installed: string;
      error: string;
    }
  ) {
    super(message);
    this.name = 'BindingScheduleError';
  }
}

async function installedState(
  context: TriggerToolContext,
  previous: TimerTriggerConfig | undefined,
  config: TimerTriggerConfig
): Promise<string> {
  const options = context.nativeSchedule;
  try {
    if (await scheduleInstalled(config, options))
      return 'A LaunchAgent for this binding is installed; it may be the old schedule.';
    if (previous && (await scheduleInstalled(previous, options)))
      return 'The LaunchAgent of the previous document (another sourceInstanceId) is still installed.';
    return 'No LaunchAgent for this binding is installed.';
  } catch (error) {
    return `Unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Validate and write one binding, then put its schedule in place. Validation, the run-as
 * user and the launchd session are checked before the write, so a refusal writes nothing.
 * A schedule failure after the write is a `BindingScheduleError` that says what is on disk
 * and what is installed.
 */
export async function setBinding(
  context: TriggerToolContext,
  bindingId: string,
  document: unknown
) {
  const path = bindingFilePath(context.bindingsDir, bindingId);
  const config = validateBindingDocument(document);
  if (config.binding.bindingId !== bindingId)
    throw new Error(
      `The document's binding.bindingId '${config.binding.bindingId}' differs from the target '${bindingId}'.`
    );
  await assertKnownRunAsUser(context.host, config);
  await assertMacosLaunchdSession(context.nativeSchedule);
  const before = await readBinding(path);
  const previous = before.kind === 'valid' ? before.config : undefined;
  await mkdir(context.bindingsDir, { recursive: true, mode: 0o700 });
  await writeBindingFile(path, document);
  const changes =
    before.kind === 'valid'
      ? changedPaths(before.config, config)
      : [before.kind === 'missing' ? '(new binding)' : '(replaced an invalid file)'];
  let schedule: ScheduleAction;
  try {
    schedule = await applySchedule(context, previous, config, path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const installed = await installedState(context, previous, config);
    throw new BindingScheduleError(
      `Binding file ${path} was written, but its schedule was not installed: ${message} ${installed}`,
      { bindingId, file: path, onDisk: 'The new binding document.', installed, error: message }
    );
  }
  return { bindingId, file: path, created: before.kind === 'missing', changes, schedule };
}

/** Remove one binding's LaunchAgent, then its file. A failed removal keeps the file. */
export async function removeBinding(context: TriggerToolContext, bindingId: string) {
  const { path, config } = await requireBinding(context, bindingId);
  if (await scheduleInstalled(config, context.nativeSchedule))
    await assertMacosLaunchdSession(context.nativeSchedule);
  const scheduleRemoved = await removeTimerSchedule(config, context.nativeSchedule);
  await unlink(path);
  return { bindingId, file: path, scheduleRemoved, fileRemoved: true };
}
