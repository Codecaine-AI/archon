import { useEffect, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { elapsedSince, formatElapsed } from '../lib/format';
import { statusDotClass, statusTextClass, type RunStatus } from '../lib/run-status';
import { RunOutcomeBadge } from '../components/RunOutcomeBadge';
import {
  browserTimeZoneName,
  describeSchedule,
  formatLocalTime,
  scheduledJobState,
  timeUntil,
  type ScheduledJob,
  type ScheduledJobState,
  type ScheduledJobsList,
  type ValidScheduledJob,
} from '../primitives/schedule';

/**
 * Binding files and LaunchAgents change without any server push, and the next run moves
 * with the clock, so the page also refetches on this slow interval and on window focus.
 * Run changes arrive sooner, through the dashboard SSE (see `K.scheduledJobs`).
 */
const REFRESH_MS = 60_000;

const STATE_CLASS: Record<ScheduledJobState, string> = {
  scheduled: 'border-success/35 bg-success/[0.08] text-success',
  'no schedule': 'border-border bg-surface-elevated text-text-tertiary',
  unknown: 'border-warning/40 bg-warning/10 text-warning',
  invalid: 'border-error/35 bg-error/[0.08] text-error',
};

const PILL = 'rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase';
const CELL_LABEL =
  'font-mono text-[10.5px] font-bold uppercase tracking-[0.13em] text-text-tertiary md:hidden';
const ROW_GRID =
  'md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_7.5rem] md:items-center md:gap-4';

function StatePill({ state, title }: { state: ScheduledJobState; title?: string }): ReactElement {
  return (
    <span data-job-state={state} title={title} className={`${PILL} ${STATE_CLASS[state]}`}>
      {state}
    </span>
  );
}

function LastRun({ run }: { run: ValidScheduledJob['lastRun'] }): ReactElement {
  if (run === null) return <span className="text-[12.5px] text-text-tertiary">Never ran</span>;
  // `pending` has no colour of its own in the console's status maps.
  const status: RunStatus | null = run.status === 'pending' ? null : run.status;
  const duration = formatElapsed(elapsedSince(run.startedAt, run.completedAt ?? undefined));
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${status ? statusDotClass[status] : 'bg-text-tertiary'}`}
        />
        <span
          data-run-status={run.status}
          className={`font-mono text-[11px] font-semibold uppercase tracking-[0.05em] ${status ? statusTextClass[status] : 'text-text-tertiary'}`}
        >
          {run.status}
        </span>
        <RunOutcomeBadge outcome={run.outcome} />
      </span>
      <span className="font-mono text-[12px] tabular-nums text-text-secondary">
        {formatLocalTime(run.startedAt)}
        <span className="ml-2 whitespace-nowrap text-text-tertiary">
          {run.completedAt === null ? `running ${duration}` : duration}
        </span>
      </span>
    </span>
  );
}

function NextRun({ job }: { job: ValidScheduledJob }): ReactElement {
  if (job.nextFireAt !== null) {
    return (
      <span className="font-mono text-[12px] tabular-nums text-text-secondary">
        {formatLocalTime(job.nextFireAt)}
        <span className="ml-2 whitespace-nowrap text-text-tertiary">
          {timeUntil(job.nextFireAt)}
        </span>
      </span>
    );
  }
  const reason = job.scheduleInstalled
    ? 'Interval jobs count from their last run.'
    : 'No LaunchAgent fires this job.';
  return (
    <span className="text-[12.5px] text-text-tertiary" title={reason}>
      —
    </span>
  );
}

function Cell({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className={CELL_LABEL}>{label}</span>
      {children}
    </span>
  );
}

function ValidJobRow({ job }: { job: ValidScheduledJob }): ReactElement {
  const navigate = useNavigate();
  const state = scheduledJobState(job);
  // The runs page filters on its search text; the workflow name narrows it to this job.
  const open = (): void => {
    navigate(`/console?${new URLSearchParams({ q: job.workflowName }).toString()}`);
  };
  return (
    <div
      data-job-id={job.bindingId}
      role="button"
      tabIndex={0}
      aria-label={`Open the runs of ${job.bindingId}`}
      onClick={open}
      onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          open();
        }
      }}
      className={`flex cursor-pointer flex-col gap-3 border-b border-border/40 px-[18px] py-[13px] transition-colors last:border-b-0 hover:bg-surface-hover ${ROW_GRID}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-[13px] font-bold text-text-primary">
          {job.bindingId}
        </span>
        <span className="truncate text-[12px] text-text-tertiary" title={job.cwd}>
          {job.workflowName} · {job.cwd}
        </span>
      </span>
      <Cell label="Schedule">
        <span className="text-[12.5px] text-text-secondary">{describeSchedule(job.schedule)}</span>
      </Cell>
      <Cell label="Last run">
        <LastRun run={job.lastRun} />
      </Cell>
      <Cell label="Next run">
        <NextRun job={job} />
      </Cell>
      <span className="flex md:justify-end">
        <StatePill state={state} title={job.scheduleError} />
      </span>
    </div>
  );
}

function InvalidJobRow({
  job,
}: {
  job: Extract<ScheduledJob, { status: 'invalid' }>;
}): ReactElement {
  return (
    <div
      data-job-file={job.file}
      className={`flex flex-col gap-3 border-b border-border/40 px-[18px] py-[13px] last:border-b-0 ${ROW_GRID}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5 md:col-span-4">
        <span className="truncate font-mono text-[13px] font-bold text-text-primary">
          {job.file}
        </span>
        <span className="text-[12px] text-error [overflow-wrap:anywhere]">{job.reason}</span>
      </span>
      <span className="flex md:justify-end">
        <StatePill state="invalid" />
      </span>
    </div>
  );
}

function ColumnHeaders(): ReactElement {
  const label = 'font-mono text-[10.5px] font-bold uppercase tracking-[0.13em] text-text-tertiary';
  return (
    <div
      aria-hidden
      className={`hidden border-b border-border px-[18px] py-2.5 ${ROW_GRID} md:grid`}
    >
      <span className={label}>Job</span>
      <span className={label}>Schedule</span>
      <span className={label}>Last run</span>
      <span className={label}>Next run</span>
      <span className={`${label} text-right`}>State</span>
    </div>
  );
}

export function ScheduledJobsBody({
  data,
  error,
  loading,
}: {
  data: ScheduledJobsList | undefined;
  error: Error | undefined;
  loading: boolean;
}): ReactElement {
  // Check the error first: `loading` can still be true when an error lands (see useEntity).
  if (error !== undefined) {
    return <EmptyState title="Could not load scheduled jobs." hint={error.message} />;
  }
  if (loading || data === undefined) return <EmptyState title="Loading…" />;
  if (data.bindings.length === 0) {
    return (
      <EmptyState
        title="No scheduled jobs yet."
        hint="A job is a binding file in the bindings folder. Install its schedule with archon trigger schedule install."
      />
    );
  }
  const browserZone = browserTimeZoneName();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-text-tertiary">
        Times are in your local time ({browserZone}). Calendar schedules run in the server&apos;s
        time zone ({data.timeZone}).
      </p>
      <div className="flex flex-col overflow-hidden rounded-[12px] border border-border bg-surface">
        <ColumnHeaders />
        {data.bindings.map(job =>
          job.status === 'valid' ? (
            <ValidJobRow key={job.file} job={job} />
          ) : (
            <InvalidJobRow key={job.file} job={job} />
          )
        )}
      </div>
    </div>
  );
}

/** `/console/schedules`: every scheduled job of the install. Read-only. */
export function SchedulesPage(): ReactElement {
  const { data, error, loading } = useEntity<ScheduledJobsList>(
    K.scheduledJobs,
    skill.listScheduledJobs,
    { revalidateOnSubscribe: true }
  );

  useEffect(() => {
    const refresh = (): void => {
      invalidate(K.scheduledJobs);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    return (): void => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-1 border-b border-border px-6 py-4">
        <h1 className="truncate text-base font-medium text-text-primary">Scheduled jobs</h1>
        <p className="text-xs text-text-tertiary">
          Every timer binding of this install, with its last and next run. Select a job to see its
          runs.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-4 pb-[30px] pt-[22px] md:px-[30px]">
        <ScheduledJobsBody data={data} error={error} loading={loading} />
      </div>
    </section>
  );
}
