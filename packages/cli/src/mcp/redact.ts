import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

/**
 * A redactor for text an agent reads from this server: it removes this process's
 * credential values and credential-shaped tokens, the same policy `archon trigger`
 * applies to drain errors. The values are collected once, when the redactor is made.
 */
export function secretRedactor(): (text: string) => string {
  const credentials = collectCredentialValues(process.env);
  return text => sanitizeCredentials(redactCredentialValues(text, credentials));
}

export function redactSecrets(text: string): string {
  return secretRedactor()(text);
}

/**
 * `value` as JSON with every string value redacted, including the strings nested in
 * run rows, node events and log tails. A Date is redacted as its ISO string.
 */
export function redactedJson(value: unknown): string {
  const redact = secretRedactor();
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'string' ? redact(item) : item),
    2
  );
}
