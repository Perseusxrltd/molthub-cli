import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

const CLI_ABS_PATH = path.join(process.cwd(), 'src', 'index.ts');
const CLI_PATH = `node --import "data:text/javascript,import{register}from'node:module';import{pathToFileURL}from'node:url';register('ts-node/esm',pathToFileURL('./'));" "${CLI_ABS_PATH}"`;
const EXEC_TIMEOUT = 15000;

function testEnv(testDir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: testDir,
    USERPROFILE: testDir,
    MOLTHUB_API_KEY: '',
    ...extra,
  };
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

describe('Local Executor Bridge CLI commands', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), `tmp-bridge-${Math.random().toString(36).slice(2)}`);
    fs.ensureDirSync(testDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDir)) fs.removeSync(testDir);
    } catch {
      // Ignore cleanup failures on Windows test runners.
    }
  });

  it('bridge setup reports local requirements without token leakage', () => {
    const output = execSync(`${CLI_PATH} --json bridge setup`, {
      cwd: testDir,
      timeout: EXEC_TIMEOUT,
      env: testEnv(testDir),
    }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.auth.configured).toBe(false);
    expect(parsed.data.requiredCapabilities).toEqual([
      'read_mission_packet',
      'submit_mission_source_evidence',
      'complete_mission (optional, only for --complete)',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('mh_live');
    expect(JSON.stringify(parsed)).not.toContain('Authorization');
  });

  it('fetches a packet and prepares a local run folder without executing tools', async () => {
    const port = 50000 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'requests.jsonl');
    const outDir = path.join(testDir, '.molthub', 'runs', 'mission-1');
    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
      function reply(res, body, status = 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }
      http.createServer((req, res) => {
        fs.appendFileSync(requestLogPath, JSON.stringify({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization || null
        }) + '\\n');
        if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-1/packet?format=json') {
          return reply(res, { packet: { id: 'packet-1', version: 2, checksum: 'checksum-123', mission: { title: 'Bridge Mission' } } });
        }
        if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-1/packet?format=markdown') {
          return reply(res, { markdown: '# Bridge Mission\\n\\nRun this outside MoltHub.' });
        }
        reply(res, { error: { code: 'ERR_NOT_FOUND', message: 'Not found' } }, 404);
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), requestLogPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const env = testEnv(testDir, {
        MOLTHUB_API_KEY: 'bridge-test-token',
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const fetchOutput = execSync(`${CLI_PATH} --json mission packet fetch --id artifact-1 --mission-id mission-1 --format markdown --out packet.md`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const prepareOutput = execSync(`${CLI_PATH} --json mission run prepare --id artifact-1 --mission-id mission-1 --out "${outDir}"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const fetchParsed = JSON.parse(fetchOutput);
      const prepareParsed = JSON.parse(prepareOutput);

      expect(fetchParsed.success).toBe(true);
      expect(fs.readFileSync(path.join(testDir, 'packet.md'), 'utf8')).toContain('Run this outside MoltHub.');
      expect(prepareParsed.success).toBe(true);
      expect(fs.readFileSync(path.join(outDir, 'packet.md'), 'utf8')).toContain('Run this outside MoltHub.');
      expect(await fs.pathExists(path.join(outDir, 'packet.json'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'evidence.md'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'run.json'))).toBe(true);
      expect(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8')).toContain('"noExecution": true');
      expect(prepareParsed.data.warnings.join(' ')).toContain('does not run Codex, Claude, Gemini, shell commands, branches, PRs, or deployments');

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests.every((req) => req.auth === 'Bearer bridge-test-token')).toBe(true);
      expect(requests.some((req) => req.url.endsWith('/packet?format=json'))).toBe(true);
      expect(requests.some((req) => req.url.endsWith('/packet?format=markdown'))).toBe(true);
    } finally {
      server.kill();
    }
  }, 30000);

  it('submits source evidence and completes only when --complete is explicit', async () => {
    const port = 52000 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'evidence-requests.jsonl');
    const evidencePath = path.join(testDir, 'evidence.md');
    fs.writeFileSync(evidencePath, `# MoltHub Mission Evidence

Mission: Bridge Mission
Packet checksum: checksum-123
Executor used: Codex CLI manually
Branch: local-bridge-v0
Commit: abcdef1234567890
PR URL:
Changed paths: src/index.ts
Tests run: npm test
Result summary: Submitted evidence through the local bridge.
Issues / blockers: None.
Memory update notes: Keep manual bridge boundary.
`);
    const server = spawn(process.execPath, ['-e', `
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
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          fs.appendFileSync(requestLogPath, JSON.stringify({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization || null,
            body: body ? JSON.parse(body) : null
          }) + '\\n');
          if (req.method === 'PUT' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-1/source-evidence') {
            return reply(res, { sourceEvidence: { id: 'evidence-1' } });
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-1/complete') {
            return reply(res, { data: { mission: { status: 'completed' } } });
          }
          reply(res, { error: { code: 'ERR_NOT_FOUND', message: 'Not found' } }, 404);
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), requestLogPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const env = testEnv(testDir, {
        MOLTHUB_API_KEY: 'bridge-test-token',
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const submitOutput = execSync(`${CLI_PATH} --json mission evidence submit --id artifact-1 --mission-id mission-1 --file "${evidencePath}"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const completeOutput = execSync(`${CLI_PATH} --json mission evidence submit --id artifact-1 --mission-id mission-1 --file "${evidencePath}" --complete`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const submitParsed = JSON.parse(submitOutput);
      const completeParsed = JSON.parse(completeOutput);

      expect(submitParsed.data.completed).toBe(false);
      expect(completeParsed.data.completed).toBe(true);

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests.filter((req) => req.method === 'PUT' && req.url.endsWith('/source-evidence'))).toHaveLength(2);
      expect(requests.filter((req) => req.method === 'POST' && req.url.endsWith('/complete'))).toHaveLength(1);
      expect(requests[0].body).toMatchObject({
        branchName: 'local-bridge-v0',
        workBranch: 'local-bridge-v0',
        headCommitSha: 'abcdef1234567890',
        changedPaths: ['src/index.ts'],
      });
      expect(JSON.stringify(requests)).not.toContain('Authorization:');
    } finally {
      server.kill();
    }
  }, 30000);
});
