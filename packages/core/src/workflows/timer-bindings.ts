/**
 * Timer binding files and the read-only facts about them: the document schema, the
 * bindings folder, the listing, whether a binding's macOS LaunchAgent is installed, and
 * when its schedule fires next. Nothing here writes a file or calls launchctl, so the CLI
 * (which installs and fires bindings) and the server (which only shows them) share it.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from '@hono/zod-openapi';
import { getArchonHome } from '@archon/paths';
import {
  resourceStartBindingIntentSchema,
  timerCalendarSchema,
} from '@archon/workflows/schemas/resource-start';

export const timerTriggerConfigSchema = z
  .object({
    version: z.literal(1),
    sourceInstanceId: z.string().min(1),
    binding: resourceStartBindingIntentSchema.omit({ eventInputs: true }),
    schedule: z.union([
      z.object({ intervalSeconds: z.number().int().positive(), runAtLoad: z.boolean() }).strict(),
      z.object({ calendar: timerCalendarSchema, runAtLoad: z.boolean() }).strict(),
    ]),
  })
  .strict();

export type TimerTriggerConfig = z.infer<typeof timerTriggerConfigSchema>;
export type TimerSchedule = TimerTriggerConfig['schedule'];

/** A timer binding document, or the error naming the fields that fail the schema. */
export function parseTimerConfig(document: unknown): TimerTriggerConfig {
  const value = timerTriggerConfigSchema.safeParse(document);
  if (!value.success)
    throw new Error(
      `Invalid timer configuration fields: ${value.error.issues.map(issue => issue.path.join('.')).join(', ')}`
    );
  if (!isAbsolute(value.data.binding.launch.cwd))
    throw new Error('Trigger execution cwd must be absolute.');
  return value.data;
}

/**
 * The schedule's own id: one install, one source and one binding name one LaunchAgent, so
 * the same binding file reinstalls onto the job it replaced.
 */
export function timerScheduleId(config: TimerTriggerConfig): string {
  return createHash('sha256')
    .update(JSON.stringify([getArchonHome(), config.sourceInstanceId, config.binding.bindingId]))
    .digest('hex');
}

/** `ARCHON_TRIGGER_BINDINGS_DIR`, else `<ARCHON_HOME>/triggers`, as an absolute path. */
export function defaultTriggerBindingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ARCHON_TRIGGER_BINDINGS_DIR || join(getArchonHome(), 'triggers'));
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
export function validateBindingDocument(document: unknown): TimerTriggerConfig {
  const parsed = timerTriggerConfigSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(
      `The binding document fails the schema: ${parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(document)'}: ${issue.message}`)
        .join('; ')}`
    );
  return parseTimerConfig(parsed.data);
}

export type ReadBinding =
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
export async function readBinding(path: string, bindingId: string): Promise<ReadBinding> {
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

export const MACOS_TRIGGER_JOB_LABEL_PREFIX = 'com.archon.trigger.';
const OWNED_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** The launchd label of schedule `id`. */
export function macosTriggerJobLabel(id: string): string {
  if (!OWNED_ID.test(id)) {
    throw new Error(
      'Native schedule id must start and end with a letter or digit and contain only letters, digits, dots, underscores, or hyphens'
    );
  }
  return `${MACOS_TRIGGER_JOB_LABEL_PREFIX}${id}`;
}

/** Where this user's LaunchAgents live; tests pass their own folder. */
export interface LaunchAgentsLocation {
  platform?: NodeJS.Platform;
  launchAgentsDirectory?: string;
}

/** The LaunchAgents folder, or an error on a host that has no launchd. */
export function macosLaunchAgentsDirectory(location: LaunchAgentsLocation = {}): string {
  if ((location.platform ?? process.platform) !== 'darwin') {
    throw new Error(
      'Native schedule installation is supported only on macOS. Use the documented long-lived systemd or Task Scheduler host recipe on this host.'
    );
  }
  return location.launchAgentsDirectory ?? join(homedir(), 'Library', 'LaunchAgents');
}

/** Whether the LaunchAgent plist of schedule `id` exists. */
export async function macosNativeScheduleInstalled(
  id: string,
  location: LaunchAgentsLocation = {}
): Promise<boolean> {
  try {
    await access(
      join(macosLaunchAgentsDirectory(location), `${macosTriggerJobLabel(id)}.plist`),
      constants.F_OK
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export type ListedBinding =
  | {
      file: string;
      status: 'valid';
      bindingId: string;
      workflowName: string;
      cwd: string;
      hostId: string;
      schedule: TimerSchedule;
      scheduleInstalled: boolean | null;
      scheduleError?: string;
    }
  | { file: string; status: 'invalid'; reason: string };

export interface BindingsFolder {
  /** Absolute folder that holds `<bindingId>.json` binding files. */
  bindingsDir: string;
  /** Where the LaunchAgents live; tests replace the folder. */
  nativeSchedule?: LaunchAgentsLocation;
}

async function listedBinding(
  folder: BindingsFolder,
  file: string
): Promise<ListedBinding | undefined> {
  const read = await readBinding(join(folder.bindingsDir, file), file.slice(0, -'.json'.length));
  if (read.kind === 'missing') return undefined;
  if (read.kind === 'invalid') return { file, status: 'invalid', reason: read.reason };
  const { config } = read;
  let installed: boolean | null = null;
  let scheduleError: string | undefined;
  try {
    installed = await macosNativeScheduleInstalled(timerScheduleId(config), folder.nativeSchedule);
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
  folder: BindingsFolder
): Promise<{ bindingsDir: string; bindings: ListedBinding[] }> {
  let files: string[];
  try {
    files = (await readdir(folder.bindingsDir)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { bindingsDir: folder.bindingsDir, bindings: [] };
    throw error;
  }
  const bindings: ListedBinding[] = [];
  for (const file of files) {
    const entry = await listedBinding(folder, file);
    if (entry) bindings.push(entry);
  }
  return { bindingsDir: folder.bindingsDir, bindings };
}

type CalendarEntry = Extract<TimerSchedule, { calendar: unknown }>['calendar'][number];

/** Days searched for a calendar match: a 31st or a weekday-and-day pair can be months away. */
const CALENDAR_SEARCH_DAYS = 4 * 366;

/**
 * As launchd's `StartCalendarInterval` (and cron) read it: an omitted key matches every
 * value, and when both `weekday` and `day` are set, either one matching is enough.
 */
function calendarDayMatches(entry: CalendarEntry, day: Date): boolean {
  const weekday = entry.weekday === undefined ? null : day.getDay() === entry.weekday;
  const monthDay = entry.day === undefined ? null : day.getDate() === entry.day;
  if (weekday === null) return monthDay ?? true;
  if (monthDay === null) return weekday;
  return weekday || monthDay;
}

function nextCalendarFire(entry: CalendarEntry, now: Date): Date | null {
  for (let offset = 0; offset <= CALENDAR_SEARCH_DAYS; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    if (!calendarDayMatches(entry, day)) continue;
    const fire = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      entry.hour,
      entry.minute
    );
    if (fire.getTime() > now.getTime()) return fire;
  }
  return null;
}

/**
 * When the schedule fires next after `now`, in this process's local time zone (launchd
 * reads calendar entries in the Mac's local time). A calendar schedule takes its earliest
 * entry. An interval counts from the start of the last run, the closest record of a fire;
 * with no run there is no anchor and the answer is null. It is an estimate: launchd skips
 * fires while the Mac sleeps and runs one on wake, and it may run a time that a daylight
 * saving change skips at another moment than the one returned here.
 */
export function nextTimerFire(
  schedule: TimerSchedule,
  now: Date,
  lastFiredAt: Date | null
): Date | null {
  if ('intervalSeconds' in schedule) {
    if (lastFiredAt === null) return null;
    const step = schedule.intervalSeconds * 1000;
    const elapsed = now.getTime() - lastFiredAt.getTime();
    const steps = elapsed < 0 ? 1 : Math.floor(elapsed / step) + 1;
    return new Date(lastFiredAt.getTime() + steps * step);
  }
  let earliest: Date | null = null;
  for (const entry of schedule.calendar) {
    const fire = nextCalendarFire(entry, now);
    if (fire !== null && (earliest === null || fire < earliest)) earliest = fire;
  }
  return earliest;
}
