import { sanitizeCredentials } from './credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

/**
 * Two redactions for text read back out of this install: the trigger MCP server's tool
 * results and the console's binding list apply the same rule.
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
 * A place in a tool result that holds a structural reference the tool itself built, such
 * as a binding id, a file path or a run id: `bindings[].file` is the `file` of every entry
 * of `bindings`. An agent passes these values back to a tool or needs them exact, so a
 * heuristic match would turn a valid id into an unusable `[REDACTED]`.
 */
export type StructuralPath = string;

/** `bindings[].file` as segments: `["bindings", "[]", "file"]`. */
function pathSegments(path: StructuralPath): string[] {
  return path
    .split('.')
    .flatMap(segment => (segment.endsWith('[]') ? [segment.slice(0, -2), '[]'] : [segment]));
}

/**
 * Segments are compared as a JSON array, so a stored key that contains `.` or `[]` stays
 * one segment and cannot spell a listed path.
 */
const pathKey = (segments: readonly string[]): string => JSON.stringify(segments);

function redactValue(
  value: unknown,
  segments: readonly string[],
  structural: ReadonlySet<string>,
  redact: SecretRedactor
): unknown {
  if (typeof value === 'string')
    return structural.has(pathKey(segments)) ? redact.exact(value) : redact.full(value);
  if (value instanceof Date) return redactValue(value.toISOString(), segments, structural, redact);
  if (Array.isArray(value))
    return value.map(item => redactValue(item, [...segments, '[]'], structural, redact));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, [...segments, key], structural, redact),
      ])
    );
  return value;
}

/**
 * `value` as JSON with every string redacted. A string at one of `structuralPaths` gets
 * only the exact-value redaction. Every other string gets the full redaction, whatever its
 * key is named: caller and stored data (`metadata`, `inputs`, node output, user messages,
 * errors, log tails) and any field or subtree a tool adds later without listing it.
 */
export function redactedJson(value: unknown, structuralPaths: readonly StructuralPath[]): string {
  return JSON.stringify(redactedValue(value, structuralPaths), null, 2);
}

/**
 * `value` with every string redacted by the same rule as `redactedJson`. A `Date` becomes
 * its ISO string, so pass a value without dates to keep its type truthful.
 */
export function redactedValue<T>(value: T, structuralPaths: readonly StructuralPath[]): T {
  const structural = new Set(structuralPaths.map(path => pathKey(pathSegments(path))));
  return redactValue(value, [], structural, secretRedactor()) as T;
}
