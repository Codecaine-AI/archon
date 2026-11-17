import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

/**
 * Two redactions for text an agent reads from this server.
 *
 * - `exact` replaces only this process's real credential values: the values of
 *   secret-named env keys and `DATABASE_URL`.
 * - `full` also applies the pattern heuristics: GitHub App installation tokens (`ghs_…`)
 *   and credentials embedded in URLs. It is the policy `archon trigger` applies to drain errors.
 *
 * The values are collected once, when the redactor is made.
 */
export interface SecretRedactor {
  exact(text: string): string;
  full(text: string): string;
}

export function secretRedactor(): SecretRedactor {
  const credentials = collectCredentialValues(process.env);
  return {
    exact: text =>
      credentials.reduce((result, value) => result.replaceAll(value, '[REDACTED]'), text),
    full: text => sanitizeCredentials(redactCredentialValues(text, credentials)),
  };
}

export function redactSecrets(text: string): string {
  return secretRedactor().full(text);
}

/**
 * Keys whose string values are structural references: an agent passes them back to a
 * tool, or needs them exact. A heuristic match would turn a valid id into an unusable
 * `[REDACTED]`, so these get only the exact-value redaction. Every other key is free text
 * (user messages, descriptions, errors, reasons, node output, log tails, inputs) and gets
 * the full redaction, so a new field is redacted by default. An array takes the rule of
 * the key that holds it.
 */
const STRUCTURAL_KEYS = new Set([
  // Bindings and their files.
  'bindingId',
  'bindingIds',
  'bindingsDir',
  'file',
  'path',
  'cwd',
  'hostId',
  'sourceInstanceId',
  'runAsUserId',
  'resource',
  'workflowName',
  // Runs, receipts, requests and nodes.
  'id',
  'runId',
  'receiptId',
  'requestId',
  'nodeId',
  'workflow_name',
  'codebase_id',
  'conversation_id',
  'parent_run_id',
  'working_path',
  'name',
  'filename',
  // Status values and timestamps.
  'status',
  'state',
  'kind',
  'errorType',
  'started_at',
  'completed_at',
  'last_activity_at',
  'created_at',
  'updated_at',
  'startedAt',
]);

function redactValue(value: unknown, structural: boolean, redact: SecretRedactor): unknown {
  if (typeof value === 'string') return structural ? redact.exact(value) : redact.full(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, structural, redact));
  if (value instanceof Date) return redactValue(value.toISOString(), structural, redact);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, STRUCTURAL_KEYS.has(key), redact),
      ])
    );
  return value;
}

/** `value` as JSON, each string redacted by the rule of the key that holds it. */
export function redactedJson(value: unknown): string {
  return JSON.stringify(redactValue(value, false, secretRedactor()), null, 2);
}
