import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const roots = trackTempRoots();
const cliPath = resolve(import.meta.dir, '..', 'cli.ts');

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: {
    instructions?: string;
    tools?: { name: string }[];
    content?: { text: string }[];
    isError?: boolean;
  };
  error?: unknown;
}

describe('archon mcp serve', () => {
  test('writes only MCP frames to stdout and answers tools/list and a read tool', async () => {
    const home = roots(await mkdtemp(join(tmpdir(), 'archon-trigger-mcp-stdio-')));
    await writeFile(join(home, 'config.yaml'), 'store: files\n');
    const bindingsDir = join(home, 'bindings');
    await mkdir(bindingsDir);
    await writeFile(join(bindingsDir, 'broken.json'), '{ not json');

    const server = Bun.spawn(
      [process.execPath, cliPath, 'mcp', 'serve', '--bindings-dir', bindingsDir],
      {
        cwd: home,
        // '' suppresses an inherited key; deleting it lets `.env` loading restore it.
        env: { ...process.env, ARCHON_HOME: home, DATABASE_URL: '', LOG_LEVEL: 'debug' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_bindings', arguments: {} },
      },
    ];
    for (const request of requests) server.stdin.write(`${JSON.stringify(request)}\n`);
    await server.stdin.flush();

    // Read until all three responses arrive, then close stdin so the server exits.
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = '';
    while (stdout.split('\n').filter(line => line.length > 0).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    server.stdin.end();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    const exitCode = await server.exited;
    const stderr = await new Response(server.stderr).text();

    expect(exitCode, stderr).toBe(0);
    const lines = stdout.split('\n').filter(line => line.length > 0);
    const frames = lines.map(line => JSON.parse(line) as JsonRpcResponse);
    expect(frames.every(frame => frame.jsonrpc === '2.0')).toBe(true);
    expect(frames.map(frame => frame.id)).toEqual([1, 2, 3]);
    // A harness that shows its agent only this text still gets the rule for the write tools.
    expect(frames[0]?.result?.instructions).toContain(
      'before you fire, change or remove a binding'
    );
    expect(frames[1]?.result?.tools?.map(tool => tool.name).sort()).toEqual([
      'fire_binding',
      'get_run',
      'list_bindings',
      'list_runs',
      'list_workflows',
      'remove_binding',
      'set_binding',
    ]);
    const listed = JSON.parse(frames[2]?.result?.content?.[0]?.text ?? '') as {
      bindingsDir: string;
      bindings: { file: string; status: string }[];
    };
    expect(listed).toMatchObject({
      bindingsDir,
      bindings: [{ file: 'broken.json', status: 'invalid' }],
    });
  }, 30_000);
});
