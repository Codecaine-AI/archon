import { z } from 'zod';
import { configStringSchema, parseConfigSchema } from '../../shared/run-config';

/** `assistants.agent-kernel`: where the kernel finds bundles and models. Same settings at every scope. */
export const configSchema = z.strictObject({
  /** Folders the kernel scans for `agent.json` bundles. A node names a bundle as its `model`. */
  catalogRoots: z.array(configStringSchema).min(1).optional(),
  /** Model aliases a bundle names, such as `fast`, `standard` and `strong`, each a `<provider>/<model>` ref. */
  aliases: z.record(z.string(), configStringSchema).optional(),
  /** Pi agent dir with the `models.json` the bundles' models come from. */
  piAgentDir: configStringSchema.optional(),
});

export type AgentKernelProviderDefaults = z.output<typeof configSchema>;

/** Strict parser for authored config: `.archon/config.yaml` and per-run layers. */
export function parseAgentKernelConfigStrict(
  raw: Record<string, unknown>
): AgentKernelProviderDefaults {
  return parseConfigSchema(configSchema, raw);
}
