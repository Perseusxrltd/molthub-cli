import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import net from 'net';
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

function getFreeLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate loopback port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
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
      'read_private_project_context (project agent runner key only, for inspect/plan/readiness/action-list)',
      'complete_mission (optional, only for --complete)',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('mh_live');
    expect(JSON.stringify(parsed)).not.toContain('Authorization');
  });

  it('fetches a packet and prepares a local run folder without executing tools', async () => {
    const port = await getFreeLoopbackPort();
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
      expect(await fs.pathExists(path.join(outDir, 'adapter.json'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'status.json'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'executor.log'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'commands.log'))).toBe(true);
      expect(await fs.pathExists(path.join(outDir, 'diff-summary.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8')).toContain('"noExecution": true');
      expect(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8')).toContain('"noCloudExecution": true');
      expect(fs.readFileSync(path.join(outDir, 'adapter.json'), 'utf8')).toContain('"executorId": "manual"');
      expect(fs.readFileSync(path.join(outDir, 'status.json'), 'utf8')).toContain('"status": "prepared"');
      expect(prepareParsed.data.warnings.join(' ')).toContain('does not run Codex, Claude, Gemini, OpenClaw, Hermes, arbitrary shell commands, branches, PRs, or deployments');

      const statusOutput = execSync(`${CLI_PATH} --json mission run status --run "${outDir}"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const statusParsed = JSON.parse(statusOutput);
      expect(statusParsed.success).toBe(true);
      expect(statusParsed.data.status.status).toBe('prepared');

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests.every((req) => req.auth === 'Bearer bridge-test-token')).toBe(true);
      expect(requests.some((req) => req.url.endsWith('/packet?format=json'))).toBe(true);
      expect(requests.some((req) => req.url.endsWith('/packet?format=markdown'))).toBe(true);
    } finally {
      server.kill();
    }
  }, 30000);

  it('collects local run evidence and submits from --run path', async () => {
    const port = await getFreeLoopbackPort();
    const requestLogPath = path.join(testDir, 'collect-requests.jsonl');
    const outDir = path.join(testDir, '.molthub', 'runs', 'mission-collect');
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Fixture\n');
    execSync('git init', { cwd: testDir, timeout: EXEC_TIMEOUT });
    execSync('git config user.email owner@example.com', { cwd: testDir, timeout: EXEC_TIMEOUT });
    execSync('git config user.name Owner', { cwd: testDir, timeout: EXEC_TIMEOUT });
    execSync('git add README.md', { cwd: testDir, timeout: EXEC_TIMEOUT });
    execSync('git commit -m initial', { cwd: testDir, timeout: EXEC_TIMEOUT });

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
          if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-collect/packet?format=json') {
            return reply(res, { packet: { id: 'packet-collect', version: 2, checksum: 'checksum-collect', mission: { title: 'Collect Mission' } } });
          }
          if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-collect/packet?format=markdown') {
            return reply(res, { markdown: '# Collect Mission\\n\\nRun this outside MoltHub.' });
          }
          if (req.method === 'PUT' && req.url === '/api/v1/artifacts/artifact-1/missions/mission-collect/source-evidence') {
            return reply(res, { sourceEvidence: { id: 'evidence-collect' } });
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

      execSync(`${CLI_PATH} --json mission run prepare --id artifact-1 --mission-id mission-collect --out "${outDir}" --executor codex-cli`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      });
      fs.appendFileSync(path.join(testDir, 'README.md'), 'Changed locally.\n');
      fs.writeFileSync(path.join(testDir, '.env'), 'MOLTHUB_API_KEY=mh_live_should_not_leak\n');
      const collectOutput = execSync(`${CLI_PATH} --json mission evidence collect --run "${outDir}" --result-summary "Collected local proof with mh_live_should_not_leak." --tests-run "npm test"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const submitOutput = execSync(`${CLI_PATH} --json mission evidence submit --run "${outDir}"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const collectParsed = JSON.parse(collectOutput);
      const submitParsed = JSON.parse(submitOutput);

      expect(collectParsed.success).toBe(true);
      expect(collectParsed.data.changedPaths).toContain('README.md');
      expect(collectParsed.data.changedPaths).not.toContain('.env');
      expect(collectParsed.data.redaction.omittedSensitivePathCount).toBeGreaterThanOrEqual(1);
      expect(collectParsed.data.redaction.redactedOutputs).toContain('evidence.md');
      const evidence = fs.readFileSync(path.join(outDir, 'evidence.md'), 'utf8');
      expect(evidence).toContain('Result summary: Collected local proof with [REDACTED:molthub_api_key].');
      expect(evidence).not.toContain('mh_live_should_not_leak');
      expect(evidence).not.toContain('.env');
      expect(fs.readFileSync(path.join(outDir, 'diff-summary.txt'), 'utf8')).not.toContain('.env');
      expect(fs.readFileSync(path.join(outDir, 'status.json'), 'utf8')).toContain('"status": "submitted"');
      expect(fs.readFileSync(path.join(outDir, 'adapter.json'), 'utf8')).toContain('"executorId": "codex-cli"');
      expect(fs.readFileSync(path.join(outDir, 'adapter.json'), 'utf8')).toContain('"planMode": "on"');
      expect(submitParsed.success).toBe(true);
      expect(submitParsed.data.artifactId).toBe('artifact-1');
      expect(submitParsed.data.missionId).toBe('mission-collect');

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      const evidenceRequest = requests.find((req) => req.method === 'PUT' && req.url.endsWith('/source-evidence'));
      expect(evidenceRequest.body).toMatchObject({
        changedPaths: expect.arrayContaining(['README.md']),
        evidenceSummary: expect.stringContaining('Collected local proof with [REDACTED:molthub_api_key].'),
      });
      expect(collectOutput).not.toContain('bridge-test-token');
      expect(submitOutput).not.toContain('bridge-test-token');
      expect(collectOutput).not.toContain('mh_live_should_not_leak');
      expect(submitOutput).not.toContain('mh_live_should_not_leak');
    } finally {
      server.kill();
    }
  }, 30000);

  it('blocks evidence submit when evidence still contains secret-like content', async () => {
    const outDir = path.join(testDir, '.molthub', 'runs', 'mission-secret');
    await fs.ensureDir(outDir);
    await fs.writeJson(path.join(outDir, 'run.json'), {
      version: 'local_executor_bridge_v0',
      runnerVersion: 'test',
      projectId: 'artifact-1',
      artifactId: 'artifact-1',
      missionId: 'mission-secret',
      createdAt: new Date().toISOString(),
      preparedAt: new Date().toISOString(),
      status: 'prepared',
      noExecution: true,
      noCloudExecution: true,
      packetChecksum: null,
      packetVersion: null,
      packetSource: null,
      worktreePath: null,
      executorId: 'manual',
      orchestratorId: null,
      adapterPath: 'adapter.json',
      statusPath: 'status.json',
      redactionSummary: {
        checkedFiles: [],
        secretLikeFindings: [],
        redactedOutputs: [],
        omittedSensitivePathCount: 0,
      },
    }, { spaces: 2 });
    await fs.writeFile(path.join(outDir, 'evidence.md'), `# MoltHub Mission Evidence

Mission: Secret Mission
Packet checksum:
Executor used: manual
Branch:
Commit:
PR URL: No PR created
Changed paths:
Tests run: none
Result summary: leaked mh_live_should_block
Issues / blockers:
Memory update notes:
`, 'utf8');

    let parsed: any = null;
    try {
      execSync(`${CLI_PATH} --json mission evidence submit --run "${outDir}"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env: testEnv(testDir, { MOLTHUB_API_KEY: 'bridge-test-token' }),
      });
    } catch (error: any) {
      parsed = JSON.parse(error.stdout.toString().trim());
    }

    expect(parsed?.success).toBe(false);
    expect(parsed?.error.code).toBe('ERR_SECRET_IN_EVIDENCE');
    expect(JSON.stringify(parsed)).not.toContain('mh_live_should_block');
  });

  it('lists missions through the dedicated mission-list route', async () => {
    const port = await getFreeLoopbackPort();
    const requestLogPath = path.join(testDir, 'mission-list-requests.jsonl');
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
        if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions') {
          return reply(res, {
            success: true,
            data: {
              missions: [
                { id: 'mission-1', title: 'Bridge Mission', status: 'published' }
              ]
            }
          });
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

      const output = execSync(`${CLI_PATH} --json mission list --id artifact-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual([
        expect.objectContaining({ id: 'mission-1', title: 'Bridge Mission' }),
      ]);
      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests).toEqual([
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/artifacts/artifact-1/missions',
          auth: 'Bearer bridge-test-token',
        }),
      ]);
    } finally {
      server.kill();
    }
  }, 30000);

  it('falls back to the compatibility artifact route if mission-list deployment returns 405', async () => {
    const port = await getFreeLoopbackPort();
    const requestLogPath = path.join(testDir, 'mission-list-fallback-requests.jsonl');
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
        if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1/missions') {
          return reply(res, { error: { code: 'HTTP_405', message: 'Method not allowed' } }, 405);
        }
        if (req.method === 'GET' && req.url === '/api/v1/artifacts/artifact-1') {
          return reply(res, {
            success: true,
            data: {
              missions: [
                { id: 'mission-1', title: 'Bridge Mission', status: 'published' }
              ]
            }
          });
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

      const output = execSync(`${CLI_PATH} --json mission list --id artifact-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual([
        expect.objectContaining({ id: 'mission-1', title: 'Bridge Mission' }),
      ]);
      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests).toEqual([
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/artifacts/artifact-1/missions',
          auth: 'Bearer bridge-test-token',
        }),
        expect.objectContaining({
          method: 'GET',
          url: '/api/v1/artifacts/artifact-1',
          auth: 'Bearer bridge-test-token',
        }),
      ]);
    } finally {
      server.kill();
    }
  }, 30000);

  it('submits source evidence and completes only when --complete is explicit', async () => {
    const port = await getFreeLoopbackPort();
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

  it('completion request fails closed when the key lacks completion scope', async () => {
    const port = await getFreeLoopbackPort();
    const requestLogPath = path.join(testDir, 'completion-denied-requests.jsonl');
    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const requestLogPath = process.argv[2];
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
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'ERR_FORBIDDEN', message: 'Missing complete_mission capability' } }));
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), requestLogPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      let parsed: any = null;
      try {
        execSync(`${CLI_PATH} --json mission completion request --id artifact-1 --mission-id mission-1 --evidence "Done"`, {
          cwd: testDir,
          timeout: EXEC_TIMEOUT,
          env: testEnv(testDir, {
            MOLTHUB_API_KEY: 'bridge-test-token',
            MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          }),
        });
      } catch (error: any) {
        parsed = JSON.parse(error.stdout.toString().trim());
      }

      expect(parsed?.success).toBe(false);
      expect(parsed?.error.code).toBe('ERR_FORBIDDEN');
      expect(parsed?.error.message).toContain('Missing complete_mission capability');
      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(requests).toEqual([
        expect.objectContaining({
          method: 'POST',
          url: '/api/v1/artifacts/artifact-1/missions/mission-1/complete',
        }),
      ]);
    } finally {
      server.kill();
    }
  }, 30000);
});
