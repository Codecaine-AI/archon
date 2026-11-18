import type { components } from '@/lib/api.generated';
import { ensureUtc } from '../lib/format';

export type ScheduledJob = components['schemas']['TriggerBinding'];
export type ValidScheduledJob = Extract<ScheduledJob, { status: 'valid' }>;
export type TimerSchedule = components['schemas']['TimerSchedule'];
export type ScheduledJobsList = components['schemas']['TriggerBindingsResponse'];

/**
 * The state pill of one job:
 * - `scheduled`: its LaunchAgent is installed, so launchd fires it.
 * - `no schedule`: the binding file exists, but no LaunchAgent fires it.
 * - `unknown`: the server cannot tell (it is not a Mac, or the check failed).
 * - `invalid`: the binding file fails validation.
 */
export type ScheduledJobState = 'scheduled' | 'no schedule' | 'unknown' | 'invalid';

export function scheduledJobState(job: ScheduledJob): ScheduledJobState {
  if (job.status === 'invalid') return 'invalid';
  if (job.scheduleInstalled === null) return 'unknown';
  return job.scheduleInstalled ? 'scheduled' : 'no schedule';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const UNITS: readonly [seconds: number, singular: string][] = [
  [86_400, 'day'],
  [3_600, 'hour'],
  [60, 'minute'],
  [1, 'second'],
];

function describeInterval(seconds: number): string {
  for (const [size, unit] of UNITS) {
    if (seconds % size !== 0) continue;
    const count = seconds / size;
    return count === 1 ? `Every ${unit}` : `Every ${count.toString()} ${unit}s`;
  }
  return `Every ${seconds.toString()} seconds`;
}

type CalendarEntry = Extract<TimerSchedule, { calendar: unknown }>['calendar'][number];

function clock(entry: CalendarEntry): string {
  return `${entry.hour.toString().padStart(2, '0')}:${entry.minute.toString().padStart(2, '0')}`;
}

/** One launchd calendar entry; with both a weekday and a day, either one matches. */
function describeCalendarEntry(entry: CalendarEntry): string {
  const weekday = entry.weekday === undefined ? null : WEEKDAYS[entry.weekday];
  const day = entry.day === undefined ? null : `day ${entry.day.toString()} of the month`;
  if (weekday !== null && day !== null) return `${weekday} or ${day}, ${clock(entry)}`;
  if (weekday !== null) return `${weekday} ${clock(entry)}`;
  if (day !== null) return `Monthly, ${day.replace(' of the month', '')}, ${clock(entry)}`;
  return `Daily ${clock(entry)}`;
}

/** The schedule in plain words: "Every 5 minutes", "Daily 04:00", "Sunday 10:00". */
export function describeSchedule(schedule: TimerSchedule): string {
  if ('intervalSeconds' in schedule) return describeInterval(schedule.intervalSeconds);
  return schedule.calendar.map(describeCalendarEntry).join(' · ');
}

/** A date and clock time in the browser's local time, without the zone name. */
export function formatLocalTime(iso: string): string {
  return new Date(ensureUtc(iso)).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** The browser's short time zone name, such as "EST", named once on the page. */
export function browserTimeZoneName(at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(at)
    .find(entry => entry.type === 'timeZoneName');
  return part?.value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "in 5m", "in 3h", "in 2d"; "now" for a time already reached. */
export function timeUntil(iso: string, now: number = Date.now()): string {
  const seconds = Math.floor((new Date(ensureUtc(iso)).getTime() - now) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `in ${Math.floor(seconds / 60).toString()}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600).toString()}h`;
  return `in ${Math.floor(seconds / 86_400).toString()}d`;
}
