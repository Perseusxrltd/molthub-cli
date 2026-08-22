import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { CLI_ABS_PATH, CLI_PATH, EXEC_TIMEOUT } from './cli-path.js';
import { assertEvidenceTextSafe } from '../bridge/local-run.js';

const VALID_API_KEY = `mh_live_${'ab'.repeat(24)}`;

function emptyAuthEnv(testDir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: testDir,
    USERPROFILE: testDir,
    MOLTHUB_API_KEY: '',
    ...extra,
  };
}

function parseFailure(command: string, cwd: string, extraEnv: Record<string, string> = {}) {
  try {
    execSync(`${CLI_PATH} ${command}`, {
      cwd,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
      env: emptyAuthEnv(cwd, extraEnv),
    });
    throw new Error('Should have failed');
  } catch (error: any) {
    if (error.message === 'Should have failed') throw error;
    return JSON.parse(`${error.stdout?.toString() || ''}`.trim());
  }
}

function waitForServerReady(server: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('EADDRINUSE') || text.includes('Error')) {
        clearTimeout(timer);
        reject(new Error(text));
      }
    });
  });
}

function startMockServer(testDir: string, script: string, port: number, requestLogPath: string) {
  return spawn(process.execPath, ['-e', script, String(port), requestLogPath], {
    cwd: testDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('CLI review-fix sprint', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), `tmp-review-${Math.random().toString(36).slice(2)}`);
    fs.ensureDirSync(testDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDir)) fs.removeSync(testDir);
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  it('apply agent writes config.pending and status polls id/token overrides', async () => {
    const port = 48000 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'apply-requests.jsonl');
    const server = startMockServer(testDir, `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];

      function reply(res, body, status = 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }

      http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          fs.appendFileSync(requestLogPath, JSON.stringify({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization || null,
          }) + '\\n');

          if (req.method === 'POST' && req.url === '/api/v1/agent/apply') {
            return reply(res, {
              application: { id: 'app-1', status: 'pending' },
              managementToken: 'mgmt-token-1',
            }, 201);
          }
          if (req.method === 'GET' && req.url === '/api/v1/agent/apply/app-1') {
            return reply(res, { application: { id: 'app-1', status: 'pending' } });
          }
          if (req.method === 'GET' && req.url === '/api/v1/agent/apply/app-2') {
            return reply(res, { application: { id: 'app-2', status: 'claimed' } });
          }
          reply(res, { error: { code: 'ERR_NOT_FOUND', message: 'Not found' } }, 404);
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, port, requestLogPath);

    try {
      await waitForServerReady(server);
      const env = emptyAuthEnv(testDir, {
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const createdRaw = execSync(`${CLI_PATH} --json apply agent --owner-email owner@example.com --name ReviewBot`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString();
      const created = JSON.parse(createdRaw.trim());
      const configPath = path.join(testDir, '.molthub-cli.json');
      const stored = fs.readJsonSync(configPath);

      expect(created.success).toBe(true);
      expect(created.data.application.id).toBe('app-1');
      expect(createdRaw).not.toContain('mgmt-token-1');
      expect(JSON.stringify(created)).not.toContain('managementToken');
      expect(stored.pending).toEqual({ id: 'app-1', token: 'mgmt-token-1' });

      const status = JSON.parse(execSync(`${CLI_PATH} --json apply status`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      expect(status.success).toBe(true);
      expect(status.data.id).toBe('app-1');

      const override = JSON.parse(execSync(`${CLI_PATH} --json apply status --id app-2 --token mgmt-token-2`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      expect(override.data.id).toBe('app-2');
      expect(fs.readJsonSync(configPath).pending).toEqual({ id: 'app-2', token: 'mgmt-token-2' });

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/agent/apply/app-1' && req.auth === 'Bearer mgmt-token-1')).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/agent/apply/app-2' && req.auth === 'Bearer mgmt-token-2')).toBe(true);
    } finally {
      server.kill();
    }
  }, 30000);

  it('apply status without pending id/token returns ERR_NO_PENDING', () => {
    const parsed = parseFailure('--json apply status', testDir);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('ERR_NO_PENDING');
  });

  it('doctor includes the report on failure as data and error.details', () => {
    const parsed = parseFailure('--json doctor', testDir);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('ERR_DOCTOR_ISSUES');
    expect(parsed.data.checks.auth).toBe('MISSING');
    expect(parsed.error.details.checks.auth).toBe('MISSING');
  });

  it('project discover forwards tag, missionOpen, and limit query params', async () => {
    const port = 48100 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'discover-requests.jsonl');
    const server = startMockServer(testDir, `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
      http.createServer((req, res) => {
        fs.appendFileSync(requestLogPath, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ artifacts: [{ id: 'proj-1', title: 'Help wanted' }] }));
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, port, requestLogPath);

    try {
      await waitForServerReady(server);
      const parsed = JSON.parse(execSync(`${CLI_PATH} --json project discover --tag TypeScript --mission-open --limit 7`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir, {
          MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        }),
      }).toString().trim());
      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(parsed.success).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/artifacts?tag=TypeScript&missionOpen=true&limit=7')).toBe(true);
    } finally {
      server.kill();
    }
  }, 30000);

  it('docs document the workbench API key URL, apply flow, and MoltHub Plus pricing', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    const skill = fs.readFileSync(path.join(process.cwd(), 'SKILL.md'), 'utf8');
    const recipes = fs.readFileSync(path.join(process.cwd(), 'docs', 'agent-recipes.md'), 'utf8');
    const contract = fs.readFileSync(path.join(process.cwd(), 'docs', 'json-contract.md'), 'utf8');
    const project = fs.readFileSync(path.join(process.cwd(), '.molthub', 'project.md'), 'utf8');

    for (const content of [readme, skill, recipes]) {
      expect(content).toContain('https://www.molthub.info/workbench/agents');
      expect(content).toContain('molthub apply agent');
      expect(content).toContain('molthub apply status');
    }
    expect(readme).toContain('MoltHub Plus is US$10 per project / month');
    expect(skill).toContain('MoltHub Plus is US$10 per project / month');
    expect(contract).toContain('MoltHub Plus (US$10 per project / month)');
    expect(project).not.toContain('Optional DeepSeek personalization is explicit, authenticated, server-side, budgeted, and cached');
    expect(project).toContain('disabled until signed packs exist');
  });

  it('auth login rejects invalid mh_live_ keys before storing or calling the API', () => {
    const parsed = parseFailure(`--json auth login not-a-key`, testDir);
    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('ERR_INVALID_API_KEY');
    expect(fs.existsSync(path.join(testDir, '.molthub-cli.json'))).toBe(false);
  });

  it('auth login does not store a well-formed key until /agent/me succeeds', async () => {
    const port = 48200 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'login-fail-requests.jsonl');
    const server = startMockServer(testDir, `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
      http.createServer((req, res) => {
        fs.appendFileSync(requestLogPath, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'ERR_NO_AUTH', message: 'Invalid key' } }));
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, port, requestLogPath);

    try {
      await waitForServerReady(server);
      const parsed = parseFailure(`--json auth login ${VALID_API_KEY}`, testDir, {
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_AUTH');
      expect(fs.existsSync(path.join(testDir, '.molthub-cli.json'))).toBe(false);
      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/agent/me')).toBe(true);
    } finally {
      server.kill();
    }
  }, 30000);

  it('auth login stores the key only after /agent/me succeeds', async () => {
    const port = 48300 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'login-ok-requests.jsonl');
    const server = startMockServer(testDir, `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
      http.createServer((req, res) => {
        fs.appendFileSync(requestLogPath, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null }) + '\\n');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agent: { id: 'agent-1', name: 'ReviewBot' } }));
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, port, requestLogPath);

    try {
      await waitForServerReady(server);
      const parsed = JSON.parse(execSync(`${CLI_PATH} --json auth login ${VALID_API_KEY}`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir, {
          MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        }),
      }).toString().trim());
      expect(parsed.success).toBe(true);
      expect(fs.readJsonSync(path.join(testDir, '.molthub-cli.json')).token).toBe(VALID_API_KEY);
    } finally {
      server.kill();
    }
  }, 30000);

  it('inline --evidence uses assertEvidenceTextSafe on complete and completion request', () => {
    expect(() => assertEvidenceTextSafe('Completed with mh_live_should_block')).toThrow(/secret-like/);

    const leaked = 'Completed via PR #12 with mh_live_should_block';
    const mission = parseFailure(`--json mission complete --id project-1 --mission-id mission-1 --evidence "${leaked}"`, testDir, {
      MOLTHUB_API_KEY: VALID_API_KEY,
    });
    const jobs = parseFailure(`--json jobs complete --id project-1 --job-id mission-1 --evidence "${leaked}"`, testDir, {
      MOLTHUB_API_KEY: VALID_API_KEY,
    });
    const completion = parseFailure(`--json mission completion request --id project-1 --mission-id mission-1 --evidence "${leaked}"`, testDir, {
      MOLTHUB_API_KEY: VALID_API_KEY,
    });

    expect(mission.error.code).toBe('ERR_SECRET_IN_EVIDENCE');
    expect(jobs.error.code).toBe('ERR_SECRET_IN_EVIDENCE');
    expect(completion.error.code).toBe('ERR_SECRET_IN_EVIDENCE');
  });

  it('local file errors classify as ERR_LOCAL_IO instead of ERR_NETWORK', async () => {
    const port = 48400 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'io-requests.jsonl');
    const server = startMockServer(testDir, `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
      http.createServer((req, res) => {
        fs.appendFileSync(requestLogPath, JSON.stringify({ method: req.method, url: req.url }) + '\\n');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ markdown: '# Packet\\n' }));
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, port, requestLogPath);

    try {
      await waitForServerReady(server);
      fs.ensureDirSync(path.join(testDir, 'packet.md'));
      const parsed = parseFailure('--json mission packet fetch --id project-1 --mission-id mission-1 --format markdown --out packet.md', testDir, {
        MOLTHUB_API_KEY: VALID_API_KEY,
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_LOCAL_IO');
      expect(parsed.error.code).not.toBe('ERR_NETWORK');
    } finally {
      server.kill();
    }
  }, 30000);

  it('pipeline check flags stale in X.Y.Z versions and retired 3.4.0/3.5.0', () => {
    fs.writeFileSync(
      path.join(testDir, 'README.md'),
      'molthub-cli 3.4.0 and molthub-cli 3.5.0 remain in 3.4.1 docs.\n',
    );

    const parsed = parseFailure('--json pipeline check', testDir);
    expect(parsed.success).toBe(false);
    expect(parsed.error.details.map((entry: any) => entry.message)).toEqual(
      expect.arrayContaining([
        'CLI-facing copy pins a stale in X.Y.Z version.',
        'CLI-facing copy still mentions retired 3.4.0.',
        'CLI-facing copy still mentions retired 3.5.0.',
      ]),
    );
  });

  it('prepare uses ensure-dist.mjs and tests invoke compiled dist/index.js', () => {
    const pkg = fs.readJsonSync(path.join(process.cwd(), 'package.json'));
    expect(pkg.scripts.prepare).toBe('node scripts/ensure-dist.mjs');
    expect(pkg.scripts.pretest).toBe('npm run build');
    expect(CLI_ABS_PATH).toBe(path.join(process.cwd(), 'dist', 'index.js'));
    expect(fs.existsSync(path.join(process.cwd(), 'scripts', 'ensure-dist.mjs'))).toBe(true);
    expect(fs.existsSync(CLI_ABS_PATH)).toBe(true);
  });
});
