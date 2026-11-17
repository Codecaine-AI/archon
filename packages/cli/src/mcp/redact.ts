import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

/**
 * Text an agent reads from this server, with this process's credential values and
 * credential-shaped tokens removed: the same policy `archon trigger` applies to drain errors.
 */
export function redactSecrets(text: string): string {
  return sanitizeCredentials(redactCredentialValues(text, collectCredentialValues(process.env)));
}
