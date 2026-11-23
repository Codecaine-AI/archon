import type { NodeExecutionMetadata } from './schemas/node-execution';
import { USER_CONTROLLED_VARIABLES } from './user-controlled-variables';
import { currentPackDir } from './workflow-variables';
import { packDirOrThrow, type PackDirScope } from './pack-dir';

/** The part of a node's execution record its own process may read. */
export type NodeExecutionIdentity = Pick<
  NodeExecutionMetadata,
  'runId' | 'path' | 'invocation' | 'attempt'
>;

export interface ExecNodeEnvironmentContext {
  artifactsDir: string;
  stateDir: string;
  logDir: string;
  workflowId: string;
  baseBranch: string;
  userMessage: string;
  loopUserInput: string;
  loopPrevOutput: string;
  rejectionReason: string;
  issueContext?: string;
  adoptedRunDir?: string | undefined;
  /**
   * This invocation's typed-artifact listing. Required so a real invocation cannot
   * forget it and hand its script an empty pointer; only a caller with no listing
   * (the dry run) passes `''` explicitly. The path is inside the run's artifact dir,
   * so a container that mounts it reads the same bytes at the same path.
   */
  typedArtifactsFile: string;
  /** This invocation's node-outcome listing, required for the same reason. */
  nodeOutcomesFile: string;
  /**
   * The execution this process belongs to: identity plus the invocation's and this
   * attempt's checkout starts (#3375). Carries manifest pointers and digests, never
   * manifest contents. Required for the same reason as `typedArtifactsFile`; only a
   * caller with no execution record passes `null`, which delivers an empty value.
   */
  nodeExecution: NodeExecutionIdentity | null;
  inputEnvKeys: readonly string[];
}

export function buildExecNodeEnvironment(context: ExecNodeEnvironmentContext): NodeJS.ProcessEnv {
  const userVariables: Record<string, string> = {};
  for (const group of USER_CONTROLLED_VARIABLES) {
    for (const name of group.names) userVariables[name] = context[group.source] ?? '';
  }
  const env: Record<string, string> = {
    ARTIFACTS_DIR: context.artifactsDir,
    STATE_DIR: context.stateDir,
    LOG_DIR: context.logDir,
    ADOPTED_RUN_DIR: context.adoptedRunDir ?? '',
    // Read from the dispatch scope rather than passed by each caller, so no exec path can
    // forget it. Empty for a workflow outside a pack, as ADOPTED_RUN_DIR is without one;
    // a pack the run's source does not hold fails the node instead of reading ''.
    PACK_DIR: packDirEnvValue(currentPackDir()),
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: context.workflowId,
    BASE_BRANCH: context.baseBranch,
    ...userVariables,
    // The listing path, delivered like the other engine-reserved keys: configured
    // project env and node bindings spread before this bag, so neither can shadow it.
    TYPED_ARTIFACTS_FILE: context.typedArtifactsFile,
    NODE_OUTCOMES_FILE: context.nodeOutcomesFile,
    ARCHON_RUN_ENV_KEYS: '',
    ARCHON_NODE_EXECUTION:
      context.nodeExecution === null ? '' : nodeExecutionEnvValue(context.nodeExecution),
  };
  env.ARCHON_RUN_ENV_KEYS = JSON.stringify([...Object.keys(env), ...context.inputEnvKeys]);
  return env;
}

function nodeExecutionEnvValue(execution: NodeExecutionIdentity): string {
  return JSON.stringify({
    runId: execution.runId,
    path: execution.path,
    invocation: execution.invocation,
    attempt: execution.attempt,
  });
}

/**
 * The run identity an AI node's provider subprocess carries, so an `archon state`
 * write from the agent's shell records this run and node (#4059). Spread after the
 * configured project env so none of these keys can be shadowed by it. `ARCHON_CLI_COMMAND`
 * is always owned here, empty when the host has none to give (a container does not have the
 * host executable), so a project-env value never stands in for it.
 */
export function buildAiNodeEnvironment(
  execution: NodeExecutionIdentity,
  cliCommand: string | undefined,
  parentCustomHeaders: string | undefined,
  traceParent: string | undefined
): Record<string, string> {
  // Trace contract tags: Claude Code sends ANTHROPIC_CUSTOM_HEADERS, and the
  // Codex provider's env_http_headers reads the TRACE_* variables and T3CODE_THREAD_ID.
  // All 7 variables are always set, so none is inherited from Archon's own environment:
  // outside a loop TRACE_LOOP_PATH is '' and Codex sends no header for it, and with no
  // thread T3CODE_THREAD_ID is '' and no X-Trace-Parent goes out. The node's configured
  // custom headers (project env, else the host's) stay, except any X-Trace-* line, which
  // this node's values replace: a stored X-Trace-Parent never reaches another thread's child.
  const tags = traceTags(execution, traceParent);
  const kept = (parentCustomHeaders ?? '')
    .split('\n')
    .filter(line => line.trim() !== '' && !/^\s*x-trace-/i.test(line));
  return {
    WORKFLOW_ID: execution.runId,
    ARCHON_NODE_EXECUTION: nodeExecutionEnvValue(execution),
    ARCHON_CLI_COMMAND: cliCommand ?? '',
    // The pack root, as the exec environment delivers it; '' outside a pack.
    PACK_DIR: packDirEnvValue(currentPackDir()),
    ...Object.fromEntries(tags.map(t => [t.variable, t.value])),
    ANTHROPIC_CUSTOM_HEADERS: [
      ...kept,
      ...tags.filter(t => t.value !== '').map(t => `${t.header}: ${t.value}`),
    ].join('\n'),
  };
}

/**
 * The trace tags of one AI node attempt. Outside a loop the loop path value is ''. The
 * parent is the T3 Code thread that started the run's process, '' when it has none.
 */
function traceTags(
  execution: NodeExecutionIdentity,
  traceParent: string | undefined
): { header: string; variable: string; value: string }[] {
  const loopPath = execution.invocation.loopPath
    .map(entry => `${entry.groupId}:${entry.iteration}`)
    .join('/');
  return [
    { header: 'X-Trace-Engine', variable: 'TRACE_ENGINE', value: 'archon' },
    { header: 'X-Trace-Run', variable: 'TRACE_RUN', value: execution.runId },
    { header: 'X-Trace-Node-Path', variable: 'TRACE_NODE_PATH', value: execution.path },
    { header: 'X-Trace-Invocation', variable: 'TRACE_INVOCATION', value: execution.invocation.id },
    { header: 'X-Trace-Attempt', variable: 'TRACE_ATTEMPT', value: execution.attempt.id },
    { header: 'X-Trace-Loop-Path', variable: 'TRACE_LOOP_PATH', value: loopPath },
    { header: 'X-Trace-Parent', variable: 'T3CODE_THREAD_ID', value: traceParent ?? '' },
  ];
}

export const EXEC_NODE_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(
    buildExecNodeEnvironment({
      artifactsDir: '',
      stateDir: '',
      logDir: '',
      workflowId: '',
      baseBranch: '',
      userMessage: '',
      loopUserInput: '',
      loopPrevOutput: '',
      rejectionReason: '',
      typedArtifactsFile: '',
      nodeOutcomesFile: '',
      nodeExecution: null,
      inputEnvKeys: [],
    })
  )
);

function packDirEnvValue(scope: PackDirScope | undefined): string {
  return scope === undefined || scope.kind === 'none' ? '' : packDirOrThrow(scope);
}
