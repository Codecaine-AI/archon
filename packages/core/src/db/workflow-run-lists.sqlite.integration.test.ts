// @archon-test-isolated
/**
 * Run list filters against a REAL bun:sqlite database.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { expect, mock, test } from 'bun:test';

const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

const realConnection = await import('./connection');
mock.module('./connection', () => ({
  ...realConnection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { listDashboardRuns } = await import('./workflow-run-lists');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'cli', 'conv-1-platform')`,
  []
);

async function insertRun(id: string, startedAt: string, metadata: unknown): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, started_at, metadata)
     VALUES ($1, 'nightly', 'conv-1', '', 'completed', $2, $3)`,
    [id, startedAt, JSON.stringify(metadata)]
  );
}

test('the resource-start binding filter returns only that binding’s runs, newest first', async () => {
  const started = (bindingId: string) => ({ resource_start: { receiptId: 'r-1', bindingId } });
  await insertRun('old-sweep', '2026-11-01 04:00:00', started('sweep'));
  await insertRun('new-sweep', '2026-11-02 04:00:00', started('sweep'));
  await insertRun('other-binding', '2026-11-03 04:00:00', started('digest'));
  await insertRun('manual', '2026-11-04 04:00:00', {});

  const result = await listDashboardRuns({ resourceStartBindingId: 'sweep', limit: 1 });

  expect(result.runs.map(run => run.id)).toEqual(['new-sweep']);
  expect(result.total).toBe(2);
});
