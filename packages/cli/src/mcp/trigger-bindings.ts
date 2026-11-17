/**
 * The binding files of one install's bindings folder, and the LaunchAgent each one
 * schedules. A binding file is `<bindings folder>/<bindingId>.json`; the folder is a
 * convention of the operator, so every tool here takes it from the server's context.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { StartBindingInspection } from '@archon/workflows/resource-start-store';
import { FileStoreLockHeldError, withFileStoreLock } from '@archon/workflows/file-store';
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

/**
 * The file's text, read without following a symbolic link: a link could make one id act
 * on another binding's document and schedule. Null when the file does not exist.
 */
async function readBindingText(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error('The binding file is a symbolic link.');
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error('The binding file is not a regular file.');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

/** The binding at `path`, valid only when it is a plain file whose bindingId is `bindingId`. */
async function readBinding(path: string, bindingId: string): Promise<ReadBinding> {
  try {
    const text = await readBindingText(path);
    if (text === null) return { kind: 'missing' };
    const config = validateBindingDocument(JSON.parse(text) as unknown);
    if (config.binding.bindingId !== bindingId)
      throw new Error(
        `Its binding.bindingId '${config.binding.bindingId}' differs from its file name '${bindingId}.json'.`
      );
    return { kind: 'valid', config };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** How long a tool waits for another call on the same binding before it refuses. */
const BINDING_LOCK_TIMEOUT_MS = 5_000;

/**
 * The tail of each binding lock's queue in this process. The file-store lock queues
 * callers of one process before its timed acquisition, so a deadline there would not
 * cover the wait behind a slow or hung call. This queue sits in front of it and counts
 * that wait against the same deadline.
 */
const bindingQueues = new Map<string, Promise<void>>();

function busyError(bindingId: string, holder: string, cause?: unknown): Error {
  return new Error(
    `Binding '${bindingId}' is busy: another set_binding, remove_binding or fire_binding holds its lock${holder}. Try again shortly.`,
    cause === undefined ? undefined : { cause }
  );
}

/** True when `previous` settles before `deadline`; false when the deadline comes first. */
async function settlesBefore(previous: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>(resolveExpired => {
    timer = setTimeout(() => resolveExpired(false), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([previous.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `operation` holding the lock of one binding: `<bindings folder>/.locks/<bindingId>/lock`,
 * shared by every server process on this install. One deadline covers the wait behind
 * earlier calls in this process and the acquisition of the lock file. A caller whose
 * deadline passes is refused and never runs. A lock file whose owner process is provably
 * gone on this host is broken; a live or unprovable owner is waited on, then refused.
 */
async function withBindingLock<T>(
  context: TriggerToolContext,
  bindingId: string,
  operation: () => Promise<T>
): Promise<T> {
  bindingFilePath(context.bindingsDir, bindingId);
  const deadline = Date.now() + BINDING_LOCK_TIMEOUT_MS;
  const root = join(context.bindingsDir, '.locks', bindingId);
  const previous = bindingQueues.get(root) ?? Promise.resolve();
  let finish!: () => void;
  const finished = new Promise<void>(resolveFinished => (finish = resolveFinished));
  // A later caller waits for this one and every caller before it, even when this one gives up.
  const tail = previous.then(() => finished);
  bindingQueues.set(root, tail);
  try {
    if (!(await settlesBefore(previous, deadline))) throw busyError(bindingId, ' in this server');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw busyError(bindingId, ' in this server');
    return await withFileStoreLock(root, operation, remaining);
  } catch (error) {
    if (!(error instanceof FileStoreLockHeldError)) throw error;
    const owner = error.owner ? ` (process ${String(error.owner.pid)} on ${error.owner.host})` : '';
    const busy = busyError(bindingId, owner, error);
    busy.message += ` If no Archon process holds it, remove ${error.path}.`;
    throw busy;
  } finally {
    finish();
    if (bindingQueues.get(root) === tail) bindingQueues.delete(root);
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
  const read = await readBinding(join(context.bindingsDir, file), file.slice(0, -'.json'.length));
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
    workflowName: config.binding.launch.workflowName,
    cwd: config.binding.launch.cwd,
    hostId: config.binding.hostId,
    schedule: config.schedule,
    scheduleInstalled: installed,
    ...(scheduleError === undefined ? {} : { scheduleError }),
  };
}

/**
 * Every `*.json` file in the bindings folder. A file that fails the schema, is a symbolic
 * link, or names another bindingId than its file name is listed as invalid with the reason.
 */
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
  const read = await readBinding(path, bindingId);
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
  const receipt = await withBindingLock(context, bindingId, async () => {
    const { path } = await requireBinding(context, bindingId);
    return await fireTimerBinding(context.host, path, context.dispatch, context.env);
  });
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
  config: TimerTriggerConfig,
  path: string
): Promise<ScheduleAction> {
  const options = context.nativeSchedule;
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
  config: TimerTriggerConfig
): Promise<string> {
  try {
    return (await scheduleInstalled(config, context.nativeSchedule))
      ? 'A LaunchAgent for this binding is installed; it may be the old schedule.'
      : 'No LaunchAgent for this binding is installed.';
  } catch (error) {
    return `Unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * A new `sourceInstanceId` names a different LaunchAgent, and the old one would keep
 * firing this file. It is removed before the document is replaced: once the new document
 * is on disk, nothing records the old job, so a retry could not find it.
 */
async function removeReplacedSchedule(
  context: TriggerToolContext,
  previous: TimerTriggerConfig | undefined,
  config: TimerTriggerConfig
): Promise<boolean> {
  if (!previous || timerScheduleId(previous) === timerScheduleId(config)) return false;
  try {
    return await removeTimerSchedule(previous, context.nativeSchedule);
  } catch (error) {
    throw new Error(
      `The schedule of the previous document (sourceInstanceId '${previous.sourceInstanceId}') could not be removed, so nothing was written: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The write failed after the previous document's schedule was removed. The previous
 * document is still on disk, since the write replaces the file only by its final rename,
 * so its schedule is installed again from it. The error says whether that worked.
 */
async function restorePreviousSchedule(
  context: TriggerToolContext,
  bindingId: string,
  path: string,
  previous: TimerTriggerConfig,
  writeError: unknown
): Promise<BindingScheduleError> {
  let installed: string;
  try {
    await installTimerSchedule(context.host, previous, path, context.nativeSchedule);
    installed = "The previous document's schedule is installed again.";
  } catch (error) {
    installed = `The previous document's schedule is NOT installed: ${errorText(error)}`;
  }
  const message = errorText(writeError);
  return new BindingScheduleError(`Binding file ${path} was not written: ${message} ${installed}`, {
    bindingId,
    file: path,
    onDisk: 'The previous binding document, unchanged.',
    installed,
    error: message,
  });
}

async function writeAndSchedule(
  context: TriggerToolContext,
  bindingId: string,
  document: unknown,
  config: TimerTriggerConfig
) {
  const path = bindingFilePath(context.bindingsDir, bindingId);
  const before = await readBinding(path, bindingId);
  const previous = before.kind === 'valid' ? before.config : undefined;
  const removedPrevious = await removeReplacedSchedule(context, previous, config);
  try {
    await mkdir(context.bindingsDir, { recursive: true, mode: 0o700 });
    await writeBindingFile(path, document);
  } catch (error) {
    if (!removedPrevious || !previous) throw error;
    throw await restorePreviousSchedule(context, bindingId, path, previous, error);
  }
  const changes =
    before.kind === 'valid'
      ? changedPaths(before.config, config)
      : [before.kind === 'missing' ? '(new binding)' : '(replaced an invalid file)'];
  let schedule: ScheduleAction;
  try {
    schedule = await applySchedule(context, config, path);
  } catch (error) {
    const message = errorText(error);
    const installed = await installedState(context, config);
    throw new BindingScheduleError(
      `Binding file ${path} was written, but its schedule was not installed: ${message} ${installed}`,
      { bindingId, file: path, onDisk: 'The new binding document.', installed, error: message }
    );
  }
  return { bindingId, file: path, created: before.kind === 'missing', changes, schedule };
}

/**
 * Validate and write one binding, then put its schedule in place. Validation, the run-as
 * user and the launchd session are checked before the write, so a refusal writes nothing.
 * The read, the write and the schedule change hold the binding's lock. A schedule failure
 * after the write is a `BindingScheduleError` that says what is on disk and what is installed.
 */
export async function setBinding(
  context: TriggerToolContext,
  bindingId: string,
  document: unknown
) {
  bindingFilePath(context.bindingsDir, bindingId);
  const config = validateBindingDocument(document);
  if (config.binding.bindingId !== bindingId)
    throw new Error(
      `The document's binding.bindingId '${config.binding.bindingId}' differs from the target '${bindingId}'.`
    );
  await assertKnownRunAsUser(context.host, config);
  await assertMacosLaunchdSession(context.nativeSchedule);
  return await withBindingLock(context, bindingId, () =>
    writeAndSchedule(context, bindingId, document, config)
  );
}

/** Remove one binding's LaunchAgent, then its file. A failed removal keeps the file. */
export async function removeBinding(context: TriggerToolContext, bindingId: string) {
  return await withBindingLock(context, bindingId, async () => {
    const { path, config } = await requireBinding(context, bindingId);
    if (await scheduleInstalled(config, context.nativeSchedule))
      await assertMacosLaunchdSession(context.nativeSchedule);
    const scheduleRemoved = await removeTimerSchedule(config, context.nativeSchedule);
    await unlink(path);
    return { bindingId, file: path, scheduleRemoved, fileRemoved: true };
  });
}
