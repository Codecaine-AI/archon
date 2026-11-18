/**
 * The read-only views an agent needs around a binding: the workflows its launch folder
 * offers, recent runs, and one run with its node events and logs. Each calls the
 * function behind the matching `archon workflow` command instead of its printer.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { readResourceStartReceiptId } from '@archon/workflows/schemas/resource-start';
import { getTerminalRecord } from '@archon/workflows/terminal-record';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { loadWorkflows, type WorkflowJsonEntry } from '../commands/workflow-list';
import { workflowJsonEntry, workflowLoadErrorsJson } from '../commands/workflow-query';
import { buildRunNodes, listRunEvents } from '../commands/workflow-node-summaries';
import { resolveRunTranscriptPath } from '../commands/workflow-shared';
import { listBindings } from '@archon/core/workflows/timer-bindings';
import type { TriggerToolContext } from './trigger-bindings';

export type FolderWorkflows =
  | {
      cwd: string;
      bindingIds: string[];
      workflows: WorkflowJsonEntry[];
      errors: ReturnType<typeof workflowLoadErrorsJson>;
    }
  | { cwd: string; bindingIds: string[]; error: string };

/** The workflows of each distinct launch folder the valid bindings name. */
export async function listWorkflows(
  context: TriggerToolContext
): Promise<{ folders: FolderWorkflows[] }> {
  const { bindings } = await listBindings(context);
  const folders = new Map<string, string[]>();
  for (const binding of bindings) {
    if (binding.status !== 'valid') continue;
    folders.set(binding.cwd, [...(folders.get(binding.cwd) ?? []), binding.bindingId]);
  }
  const results: FolderWorkflows[] = [];
  for (const [cwd, bindingIds] of folders) {
    try {
      const { workflows, errors } = await loadWorkflows(cwd);
      results.push({
        cwd,
        bindingIds,
        workflows: workflows.map(entry => workflowJsonEntry(entry, false)),
        errors: workflowLoadErrorsJson(errors),
      });
    } catch (error) {
      results.push({ cwd, bindingIds, error: String(error) });
    }
  }
  return { folders: results };
}

/** Recent runs across every project, as `archon workflow runs --all --json` lists them. */
export async function listRuns(context: TriggerToolContext, limit: number) {
  return await context.host.deps.store.listWorkflowRuns({ limit });
}

const DEFAULT_LOG_BYTES = 64 * 1024;

type LogTail =
  | { path: string; text: string; truncated: boolean }
  | { path: string; text: null; reason: string };

/** The last `maxBytes` of a log, from a line start. The tool result redacts it. */
async function readLogTail(path: string, maxBytes: number): Promise<LogTail> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { path, text: null, reason: 'The file does not exist.' };
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) return { path, text: null, reason: 'The file is empty.' };
    const length = Math.min(size, maxBytes);
    const buffer = new Uint8Array(length);
    await file.read(buffer, 0, length, size - length);
    let text = new TextDecoder().decode(buffer);
    const truncated = length < size;
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    return { path, text, truncated };
  } finally {
    await file.close();
  }
}

/**
 * The detached `trigger execute` log of a run a trigger started. It is the one place a run
 * that failed before its executor wrote a transcript leaves its error.
 */
async function executorLogPath(
  context: TriggerToolContext,
  run: WorkflowRun
): Promise<string | null> {
  const receiptId = readResourceStartReceiptId(run.metadata);
  if (!receiptId) return null;
  const receipt = await context.host.deps.store.getStartReceipt(receiptId);
  const requestId = receipt?.bindings.find(
    binding => binding.disposition?.status === 'admitted' && binding.disposition.runId === run.id
  )?.disposition?.requestId;
  return requestId ? join(getArchonHome(), 'logs', `trigger-run-${requestId}.log`) : null;
}

/** One run: its row, node states, terminal record, transcript tail and executor log tail. */
export async function getRun(
  context: TriggerToolContext,
  runId: string,
  maxLogBytes = DEFAULT_LOG_BYTES
) {
  const { host } = context;
  const run = await host.deps.store.getWorkflowRun(runId);
  if (!run) throw new Error(`Workflow run not found: ${runId}. Pass the full run id.`);
  const events = await listRunEvents(host, run.id, false);
  const transcriptPath = await resolveRunTranscriptPath(host, run);
  const executorLog = await executorLogPath(context, run);
  return {
    run,
    nodes: buildRunNodes(run, events),
    terminalRecord: getTerminalRecord(run.status, events),
    transcript: transcriptPath
      ? await readLogTail(transcriptPath, maxLogBytes)
      : { path: null, text: null, reason: 'The run has no storage root, so no transcript path.' },
    executorLog: executorLog ? await readLogTail(executorLog, maxLogBytes) : null,
  };
}
