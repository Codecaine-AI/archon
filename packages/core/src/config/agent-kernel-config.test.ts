import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerAgentKernelProvider } from '@archon/providers/community/agent-kernel';
import { loadGlobalConfig } from './config-loader';

registerAgentKernelProvider();

/** A real config file under a temporary ARCHON_HOME, read the way the CLI reads it. */
describe('assistants.agent-kernel config', () => {
  const previousHome = process.env.ARCHON_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'archon-config-'));
    process.env.ARCHON_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    await removeTempTree(home);
  });

  function load(yaml: string): ReturnType<typeof loadGlobalConfig> {
    writeFileSync(join(home, 'config.yaml'), yaml);
    return loadGlobalConfig(true, { readOnly: true });
  }

  test('a config file with an assistants.agent-kernel block loads its settings', async () => {
    const config = await load(`
assistants:
  agent-kernel:
    catalogRoots:
      - /bundles
    aliases:
      fast: codex-lb/gpt-5.5
      standard: codex-lb/gpt-5.6-sol
      strong: codex-lb/gpt-5.6-sol
    piAgentDir: /pi-agent
`);
    expect(config.assistants?.['agent-kernel']).toEqual({
      catalogRoots: ['/bundles'],
      aliases: {
        fast: 'codex-lb/gpt-5.5',
        standard: 'codex-lb/gpt-5.6-sol',
        strong: 'codex-lb/gpt-5.6-sol',
      },
      piAgentDir: '/pi-agent',
    });
  });

  test('an unknown key in assistants.agent-kernel fails the load', async () => {
    await expect(
      load(`
assistants:
  agent-kernel:
    catalogRoots:
      - /bundles
    catalogRoot: /typo
`)
    ).rejects.toThrow("'assistants.agent-kernel.catalogRoot': unknown provider setting");
  });
});
