import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ScheduledJobsBody, SchedulesPage } from './SchedulesPage';
import { invalidate, set } from '../store/cache';
import { K } from '../store/keys';
import type { ScheduledJobsList, ValidScheduledJob } from '../primitives/schedule';

afterEach(() => {
  invalidate(K.scheduledJobs);
});

function job(overrides: Partial<ValidScheduledJob>): ValidScheduledJob {
  return {
    file: 'nightly.json',
    status: 'valid',
    bindingId: 'nightly',
    workflowName: 'nightly-digest',
    cwd: '/srv/jobs',
    hostId: 'hub',
    schedule: { calendar: [{ hour: 4, minute: 0 }], runAtLoad: false },
    scheduleInstalled: true,
    lastRun: null,
    nextFireAt: '2026-11-19T04:00:00.000Z',
    ...overrides,
  };
}

function renderPage(list: ScheduledJobsList): string {
  set(K.scheduledJobs, list);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/console/schedules']}>
      <Routes>
        <Route path="/console/schedules" element={<SchedulesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const list = (bindings: ScheduledJobsList['bindings']): ScheduledJobsList => ({
  timeZone: 'America/New_York',
  generatedAt: '2026-11-18T08:00:00.000Z',
  bindings,
});

describe('SchedulesPage', () => {
  test('a row shows the job, its workflow and folder, the schedule in words and its state', () => {
    const html = renderPage(list([job({})]));

    expect(html).toContain('nightly');
    expect(html).toContain('nightly-digest · /srv/jobs');
    expect(html).toContain('Daily 04:00');
    expect(html).toContain('data-job-state="scheduled"');
    expect(html).toContain('Never ran');
    expect(html).toContain('America/New_York');
  });

  test('each schedule shape reads in plain words', () => {
    const html = renderPage(
      list([
        job({
          bindingId: 'poll',
          file: 'poll.json',
          schedule: { intervalSeconds: 300, runAtLoad: true },
        }),
        job({
          bindingId: 'weekly',
          file: 'weekly.json',
          schedule: { calendar: [{ weekday: 0, hour: 10, minute: 0 }], runAtLoad: false },
        }),
      ])
    );

    expect(html).toContain('Every 5 minutes');
    expect(html).toContain('Sunday 10:00');
  });

  test('the next run of an interval job reads as an estimate, and a calendar time does not', () => {
    const interval = renderPage(
      list([job({ schedule: { intervalSeconds: 3600, runAtLoad: false } })])
    );
    const calendar = renderPage(
      list([job({ schedule: { calendar: [{ hour: 4, minute: 0 }], runAtLoad: false } })])
    );

    expect(interval).toContain('>about<');
    expect(interval).toContain('launchd counts from the load of the job');
    expect(calendar).not.toContain('>about<');
  });

  test('the last run shows its status pill and duration', () => {
    const html = renderPage(
      list([
        job({
          lastRun: {
            runId: 'run-1',
            status: 'failed',
            outcome: null,
            startedAt: '2026-11-18T04:00:00.000Z',
            completedAt: '2026-11-18T04:02:05.000Z',
          },
        }),
      ])
    );

    expect(html).toContain('data-run-status="failed"');
    expect(html).toContain('02:05');
  });

  test('a job without a LaunchAgent and an invalid file get their own pills', () => {
    const html = renderPage(
      list([
        job({ scheduleInstalled: false, nextFireAt: null }),
        { file: 'broken.json', status: 'invalid', reason: 'The binding file is a symbolic link.' },
      ])
    );

    expect(html).toContain('data-job-state="no schedule"');
    expect(html).toContain('data-job-state="invalid"');
    expect(html).toContain('broken.json');
    expect(html).toContain('The binding file is a symbolic link.');
  });

  test('an install with no bindings shows the empty state', () => {
    expect(renderPage(list([]))).toContain('No scheduled jobs yet.');
  });
});

describe('ScheduledJobsBody', () => {
  test('a load failure shows the error, even while a load is still marked in flight', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ScheduledJobsBody data={undefined} error={new Error('API error 500')} loading />
      </MemoryRouter>
    );

    expect(html).toContain('Could not load scheduled jobs.');
    expect(html).toContain('API error 500');
  });

  test('before the first response it shows the loading state', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ScheduledJobsBody data={undefined} error={undefined} loading />
      </MemoryRouter>
    );

    expect(html).toContain('Loading…');
  });
});
