import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStaticActivationFiles } from '../activation-pack.js';

const execute = promisify(execFile);
const cliPath = path.resolve('dist/index.js');
let folder: string;
let server: Server;
let baseUrl: string;
let requests: { method?: string; url?: string; authenticated: boolean; retry?: string | string[]; body: unknown }[];
let redirect = false;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'molthub-manager-cli-'));
  requests = [];
  redirect = false;
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ method: req.method, url: req.url, authenticated: req.headers.authorization === 'Bearer private-test-key', retry: req.headers['x-idempotency-key'], body: text ? JSON.parse(text) : null });
    if (redirect) { res.writeHead(302, { location: '/unexpected' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url?.includes('/workflow') ? { version: 'test-contract' } : { success: true, data: { runId: 'receipt', requiresOwnerReview: true, nextCursor: 'next-page' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(folder, { recursive: true, force: true }); });
async function run(args: string[]) {
  const { stdout } = await execute(process.execPath, [cliPath, '--json', ...args], { cwd: folder, env: { ...process.env, MOLTHUB_API_KEY: 'private-test-key', MOLTHUB_BASE_URL: baseUrl }, timeout: 10000 });
  expect(stdout).not.toContain('private-test-key');
  return JSON.parse(stdout);
}

describe('project management CLI', () => {
  it('discovers the live contract without sending credentials', async () => {
    expect((await run(['agent', 'workflow'])).data.version).toBe('test-contract');
    expect(requests[0]).toMatchObject({ url: '/api/v1/agent/workflow', authenticated: false });
  });
  it('reads a scoped workspace page with its pagination cursor', async () => {
    await run(['project', 'workspace', '--id', 'project', '--section', 'tasks', '--cursor', 'cursor']);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/artifacts/project/workspace?section=tasks&cursor=cursor', authenticated: true });
  });
  it('sends an explicit retry key and preserves pending-review results', async () => {
    const body = { action: 'request_completion', taskId: 'task', evidence: 'Real proof for review.' };
    await writeFile(path.join(folder, 'request.json'), JSON.stringify(body));
    const result = await run(['project', 'manage', '--id', 'project', '--file', 'request.json', '--idempotency-key', 'request-1']);
    expect(requests[0]).toMatchObject({ method: 'POST', authenticated: true, retry: 'request-1', body });
    expect(result.data).toMatchObject({ runId: 'receipt', requiresOwnerReview: true });
  });
  it('refuses missing retry keys and credentials in request files before making a request', async () => {
    await writeFile(path.join(folder, 'request.json'), JSON.stringify({ action: 'add_note', title: 'Note', body: `mh_live_${'a'.repeat(48)}` }));
    await expect(run(['project', 'manage', '--id', 'project', '--file', 'request.json'])).rejects.toThrow();
    await expect(run(['project', 'manage', '--id', 'project', '--file', 'request.json', '--idempotency-key', 'one'])).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
  it('does not follow redirects with a workspace key', async () => {
    redirect = true;
    await expect(run(['project', 'workspace', '--id', 'project'])).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it('installs role-specific skill guidance without granting access', () => {
    const files = buildStaticActivationFiles(['hermes', 'openclaw'], { projectId: 'project', role: 'manager' });
    for (const file of files) {
      expect(file.content.startsWith('---\nname: molthub\n')).toBe(true);
      expect(file.content).toContain('Your role is project manager');
      expect(file.content).toContain('project manage --id project');
      expect(file.content).toContain('This file grants no permissions');
      expect(file.content).not.toContain('mh_live_');
    }
    expect(() => buildStaticActivationFiles(['hermes'], { role: 'manager' })).toThrow(/--project/);
  });
});
