import { getArchonHome } from '@archon/paths';
import type { IAgentProvider } from '@archon/provider-contract';
import {
  AGENT_KERNEL_CAPABILITIES,
  createAgentKernelProvider,
} from '@codecaine-ai/agent-kernel/archon-provider';

import { isRegisteredProvider, registerProvider } from '../../registry';
import { parseAgentKernelConfigStrict } from './config';

/** A provider over the kernel of the Archon home, so every run writes `~/.archon/.agent-kernel/trace.db`. */
export function createArchonAgentKernelProvider(): IAgentProvider {
  return createAgentKernelProvider({ root: getArchonHome() }) satisfies IAgentProvider;
}

/**
 * Register the agent-kernel provider: a node with `provider: agent-kernel` runs the
 * kernel bundle its `model` names. Idempotent.
 */
export function registerAgentKernelProvider(): void {
  if (isRegisteredProvider('agent-kernel')) return;
  registerProvider({
    id: 'agent-kernel',
    displayName: 'Agent Kernel (fork)',
    factory: createArchonAgentKernelProvider,
    capabilities: AGENT_KERNEL_CAPABILITIES,
    builtIn: false,
    parseConfig: parseAgentKernelConfigStrict,
    // Each bundle's model credentials live in its Pi agent dir, not in Archon.
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
  });
}
