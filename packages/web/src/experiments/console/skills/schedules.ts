import { requestJson } from '../lib/http';
import type { ScheduledJobsList } from '../primitives/schedule';

/** Every scheduled job (timer binding) of the install, with its last and next run. */
export async function listScheduledJobs(): Promise<ScheduledJobsList> {
  return await requestJson('/api/trigger-bindings', 'get');
}
