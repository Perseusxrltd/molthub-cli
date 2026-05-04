import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

const CLI_ABS_PATH = path.join(process.cwd(), 'src', 'index.ts');
// --import is the modern (non-deprecated) API; ts-node/esm --loader generates warnings on Node 22+
const CLI_PATH = `node --import "data:text/javascript,import{register}from'node:module';import{pathToFileURL}from'node:url';register('ts-node/esm',pathToFileURL('./'));" "${CLI_ABS_PATH}"`;
const EXEC_TIMEOUT = 15000;

function emptyAuthEnv(testDir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HOME: testDir,
    USERPROFILE: testDir,
    MOLTHUB_API_KEY: '',
    ...extra,
  };
}

function expectNoAuth(command: string, cwd: string) {
  try {
    execSync(`${CLI_PATH} ${command}`, {
      cwd,
      stdio: 'pipe',
      timeout: EXEC_TIMEOUT,
      env: emptyAuthEnv(cwd),
    });
    throw new Error('Should have failed');
  } catch (e: any) {
    const output = `${e.stdout?.toString() || ''}`.trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('ERR_NO_AUTH');
    expect(typeof parsed.error.message).toBe('string');
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

describe('MoltHub CLI Beta Alignment', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), `tmp-test-${Math.random().toString(36).slice(2)}`);
    fs.ensureDirSync(testDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDir)) fs.removeSync(testDir);
    } catch (e) {
      // Ignore cleanup errors in tests
    }
  });

  it('local init creates canonical .molthub/project.md', () => {
    execSync(`${CLI_PATH} local init --name "Test Project"`, { cwd: testDir, timeout: EXEC_TIMEOUT });
    const manifestPath = path.join(testDir, '.molthub', 'project.md');
    expect(fs.existsSync(manifestPath)).toBe(true);
    
    const content = fs.readFileSync(manifestPath, 'utf8');
    expect(content).toContain('title: "Test Project"');
    expect(content).toContain('collaboration: true');
    expect(content).not.toContain('- [ ] List core features here');
  });

  it('local init migrates legacy molthub.json', () => {
    const legacyData = {
      title: "Legacy Title",
      summary: "Legacy Summary",
      collaboration: false,
      skillsNeeded: ["legacy-skill"]
    };
    fs.writeJsonSync(path.join(testDir, 'molthub.json'), legacyData);

    execSync(`${CLI_PATH} local init`, { cwd: testDir, timeout: EXEC_TIMEOUT });
    
    const manifestPath = path.join(testDir, '.molthub', 'project.md');
    const content = fs.readFileSync(manifestPath, 'utf8');
    
    expect(content).toContain('title: "Legacy Title"');
    expect(content).toContain('summary: "Legacy Summary"');
    expect(content).toContain('collaboration: false');
    expect(content).toContain('"legacy-skill"');
  });

  it('local validate warns on missing source_url and PM keys', () => {
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
tasks: ["task1"]
---
# Body`;
    fs.writeFileSync(path.join(testDir, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} --json local validate`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString().trim();
    const parsed = JSON.parse(output);
    
    expect(parsed.success).toBe(true);
    expect(parsed.data._warnings).toContain("Missing recommended field: 'source_url'");
    expect(parsed.data._warnings.some((w: string) => w.includes("'tasks'"))).toBe(true);
    });

  it('agent bootstrap emits JSON operating context with suffix flag placement', () => {
    const output = execSync(`${CLI_PATH} agent bootstrap --json`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.version).toBe('3.3.3');
    expect(parsed.data.safeDecisionLoop).toContain('molthub agent bootstrap --json');
    expect(parsed.data.repoOnboardingLoop).toContain('molthub local init --name "<project-name>" --category "<category>"');
    expect(parsed.data.repoOnboardingLoop).toContain('molthub local validate --json');
    expect(parsed.data.repoStewardship).toContain('Keep README.md, AGENTS.md, and .molthub/project.md aligned');
    expect(parsed.data.safeDecisionLoop).toContain('molthub project operator dashboard --id <project-id> --json');
    expect(parsed.data.safeDecisionLoop).toContain('molthub project operator runs --id <project-id> --json');
    expect(parsed.data.safeDecisionLoop).toContain('molthub jobs discover --json');
    expect(parsed.data.commandManifest.some((cmd: any) => cmd.name === 'comm')).toBe(true);
  });

  it('agent bootstrap also supports leading global JSON flag placement', () => {
    const output = execSync(`${CLI_PATH} --json agent bootstrap`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.auth.envVar).toBe('MOLTHUB_API_KEY');
  });

  it('agent install-instructions previews activation files without writing', () => {
    const output = execSync(`${CLI_PATH} --json agent install-instructions --targets agents,claude`, {
      cwd: testDir,
      timeout: EXEC_TIMEOUT,
      env: emptyAuthEnv(testDir),
    }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.mode).toBe('preview');
    expect(parsed.data.personalized).toBe(false);
    expect(parsed.data.files.map((file: any) => file.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(fs.existsSync(path.join(testDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(testDir, 'CLAUDE.md'))).toBe(false);
  });

  it('agent install-instructions writes static activation files without auth or network', () => {
    const output = execSync(`${CLI_PATH} --json agent install-instructions --write --targets agents`, {
      cwd: testDir,
      timeout: EXEC_TIMEOUT,
      env: emptyAuthEnv(testDir),
    }).toString().trim();
    const parsed = JSON.parse(output);
    const agentsPath = path.join(testDir, 'AGENTS.md');
    const content = fs.readFileSync(agentsPath, 'utf8');

    expect(parsed.success).toBe(true);
    expect(parsed.data.mode).toBe('write');
    expect(parsed.data.files[0].action).toBe('created');
    expect(content).toContain('<!-- MOLTHUB:START -->');
    expect(content).toContain('molthub agent bootstrap --json');
    expect(content).toContain('## Repo Onboarding And Stewardship');
    expect(content).toContain('If `.molthub/project.md` is missing');
    expect(content).toContain('molthub local init --name "<project-name>" --category "<category>"');
    expect(content).toContain('molthub local validate --json');
    expect(content).toContain('source_url');
    expect(content).toContain('docs_url');
    expect(content).toContain('molthub project create --json');
    expect(content).toContain('molthub project update --id <project-id>');
    expect(content).toContain('molthub project operator dashboard --id <project-id> --json');
    expect(content).toContain('molthub project operator feedback --id <project-id>');
    expect(content).toContain('molthub project billing checkout --id <project-id> --json');
    expect(content).toContain('Keep README.md, AGENTS.md, and `.molthub/project.md` aligned');
    expect(content).toContain('Do not log, print, commit, or transmit API keys');
    expect(content).toContain('Do not assume a CLI scheduler');
  });

  it('agent install-instructions refuses to modify unmarked files without force', () => {
    const agentsPath = path.join(testDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# Existing Rules\n\nDo not replace this.\n');

    try {
      execSync(`${CLI_PATH} --json agent install-instructions --write --targets agents`, {
        cwd: testDir,
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir),
      });
      throw new Error('Should have failed');
    } catch (e: any) {
      const parsed = JSON.parse(`${e.stdout?.toString() || ''}`.trim());
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_INSTRUCTION_FILE_EXISTS');
      expect(fs.readFileSync(agentsPath, 'utf8')).toBe('# Existing Rules\n\nDo not replace this.\n');
    }
  });

  it('agent install-instructions requires auth before personalized generation', () => {
    expectNoAuth('agent install-instructions --personalize --targets agents --json', testDir);
  });

  it('agent install-instructions personalizes once and reuses the fingerprint cache', async () => {
    const port = 41000 + Math.floor(Math.random() * 2000);
    const countPath = path.join(testDir, 'activation-count.txt');
    const bodyPath = path.join(testDir, 'activation-body.json');
    fs.writeFileSync(countPath, '0');

    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const countPath = process.argv[2];
      const bodyPath = process.argv[3];
      http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          fs.writeFileSync(bodyPath, body);
          const count = Number(fs.readFileSync(countPath, 'utf8') || '0') + 1;
          fs.writeFileSync(countPath, String(count));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              personalized: true,
              fallbackReason: null,
              files: [{
                target: 'agents',
                path: 'AGENTS.md',
                content: '<!-- MOLTHUB:START -->\\n# Personalized MoltHub\\nFollow system, developer, and user instructions first.\\nRun \`molthub agent bootstrap --json\`.\\n<!-- MOLTHUB:END -->\\n'
              }]
            }
          }));
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), countPath, bodyPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const env = emptyAuthEnv(testDir, {
        MOLTHUB_API_KEY: 'mh_live_test_token',
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const firstOutput = execSync(`${CLI_PATH} --json agent install-instructions --personalize --targets agents`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const first = JSON.parse(firstOutput);

      const secondOutput = execSync(`${CLI_PATH} --json agent install-instructions --personalize --targets agents`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim();
      const second = JSON.parse(secondOutput);
      const sentBody = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));

      expect(first.data.personalized).toBe(true);
      expect(first.data.cacheHit).toBe(false);
      expect(second.data.personalized).toBe(true);
      expect(second.data.cacheHit).toBe(true);
      expect(fs.readFileSync(countPath, 'utf8')).toBe('1');
      expect(sentBody).toMatchObject({
        templateVersion: '2026-05-02-v2',
        cliVersion: '3.3.3',
        targets: ['agents'],
        manifestHash: 'missing',
      });
      expect(JSON.stringify(sentBody)).not.toContain('mh_live_test_token');
    } finally {
      server.kill();
    }
  }, 30000);

  it('agent install-instructions preserves server fallback status and caches it', async () => {
    const port = 43000 + Math.floor(Math.random() * 2000);
    const countPath = path.join(testDir, 'activation-fallback-count.txt');
    fs.writeFileSync(countPath, '0');

    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const fs = require('fs');
      const port = Number(process.argv[1]);
      const countPath = process.argv[2];
      http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          const count = Number(fs.readFileSync(countPath, 'utf8') || '0') + 1;
          fs.writeFileSync(countPath, String(count));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              personalized: false,
              fallbackReason: 'monthly_budget_exhausted',
              files: [{
                target: 'agents',
                path: 'AGENTS.md',
                content: '<!-- MOLTHUB:START -->\\n# Static fallback\\nFollow system, developer, and user instructions first.\\nRun \`molthub agent bootstrap --json\`.\\n<!-- MOLTHUB:END -->\\n'
              }]
            }
          }));
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), countPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const env = emptyAuthEnv(testDir, {
        MOLTHUB_API_KEY: 'mh_live_test_token',
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const first = JSON.parse(execSync(`${CLI_PATH} --json agent install-instructions --personalize --targets agents`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const second = JSON.parse(execSync(`${CLI_PATH} --json agent install-instructions --personalize --targets agents`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir),
      }).toString().trim());

      expect(first.data.personalized).toBe(false);
      expect(first.data.personalizationWarning).toContain('monthly_budget_exhausted');
      expect(second.data.personalized).toBe(false);
      expect(second.data.cacheHit).toBe(true);
      expect(second.data.personalizationWarning).toContain('Cached server fallback');
      expect(fs.readFileSync(countPath, 'utf8')).toBe('1');
    } finally {
      server.kill();
    }
  }, 30000);

  it('agent install-instructions rejects unsafe personalized server files locally', async () => {
    const port = 45000 + Math.floor(Math.random() * 2000);

    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const port = Number(process.argv[1]);
      http.createServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: {
              personalized: true,
              fallbackReason: null,
              files: [{
                target: 'agents',
                path: 'AGENTS.md',
                content: '<!-- MOLTHUB:START -->\\n# Unsafe Pack\\nRun \`molthub agent bootstrap --json\`.\\n<!-- MOLTHUB:END -->\\n'
              }]
            }
          }));
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const parsed = JSON.parse(execSync(`${CLI_PATH} --json agent install-instructions --personalize --targets agents`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir, {
          MOLTHUB_API_KEY: 'mh_live_test_token',
          MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        }),
      }).toString().trim());

      expect(parsed.success).toBe(true);
      expect(parsed.data.personalized).toBe(false);
      expect(parsed.data.personalizationWarning).toContain('invalid pack');
      expect(parsed.data.files[0].content).toContain('system, developer, and user instructions');
    } finally {
      server.kill();
    }
  }, 30000);

  it('AGENTS.md exists and contains essential automation rules', () => {
    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    expect(fs.existsSync(agentsPath)).toBe(true);
    const content = fs.readFileSync(agentsPath, 'utf8');
    expect(content).toContain('--json');
    expect(content).toContain('MOLTHUB_API_KEY');
    expect(content).toContain('idempotency');
  });

  it('release docs are updated to 3.3.3', () => {
    const skillPath = path.join(process.cwd(), 'SKILL.md');
    const readmePath = path.join(process.cwd(), 'README.md');
    const projectPath = path.join(process.cwd(), '.molthub', 'project.md');

    expect(fs.readFileSync(skillPath, 'utf8')).toContain('3.3.3');
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('MoltHub CLI (v3.3.3)');
    expect(fs.readFileSync(projectPath, 'utf8')).toContain('version: "3.3.3"');
  });

  it('README exposes a parseable Active Project command reference table', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

    expect(readme).toContain('| Command | Purpose |');
    expect(readme).toContain('| `molthub project operator dashboard --id <project-id> --json` |');
    expect(readme).toContain('| `molthub project billing checkout --id <project-id> --json` |');
    expect(readme).toContain('| `molthub project billing portal --id <project-id> --json` |');
  });

  it('JSON contract documents activation installer output and errors', () => {
    const content = fs.readFileSync(path.join(process.cwd(), 'docs', 'json-contract.md'), 'utf8');

    expect(content).toContain('agent install-instructions');
    expect(content).toContain('ERR_INVALID_TARGETS');
    expect(content).toContain('ERR_INSTRUCTION_FILE_EXISTS');
    expect(content).toContain('personalizationWarning');
    expect(content).toContain('Repo onboarding');
  });

  it('local validate returns error for missing project.md', () => {
    try {
      execSync(`${CLI_PATH} --json local validate`, { cwd: testDir, stdio: 'pipe', timeout: EXEC_TIMEOUT });
      throw new Error("Should have failed");
    } catch (e: any) {
      const output = e.stdout.toString().trim();
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_MANIFEST');
    }
  });

  it('json mode emits parseable JSON only for local validate', () => {
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
summary: "A valid summary"
---
# Body`;
    fs.writeFileSync(path.join(testDir, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} --json local validate`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('Test');
  });

  it('project help lists implemented project commands', () => {
    const output = execSync(`${CLI_PATH} project --help`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString();

    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('production');
    expect(output).toContain('maintenance');
    expect(output).toContain('playbook');
    expect(output).toContain('operator');
    expect(output).toContain('billing');
    expect(output).not.toContain('delete');
    expect(output).not.toContain('MoltHub registry');
    expect(output).not.toContain('scheduler');
  });

  it('top-level help uses project-facing wording instead of artifact-facing marketing copy', () => {
    const output = execSync(`${CLI_PATH} --help`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString();

    expect(output).toContain('MoltHub projects');
    expect(output).not.toContain('MoltHub artifacts, agents');
  });

  it('project help keeps user-facing descriptions project-oriented', () => {
    const output = execSync(`${CLI_PATH} project --help`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString();

    expect(output).toContain('Fetch project-scoped operating context for an agent');
    expect(output).toContain('Inspect and execute governed project actions');
    expect(output).toContain('Read and update project maintenance playbooks');
    expect(output).not.toContain('artifact-scoped operating context');
  });

  it('commands manifest recursively lists nested command groups', () => {
    const output = execSync(`${CLI_PATH} commands --json`, { cwd: testDir, timeout: EXEC_TIMEOUT }).toString().trim();
    const parsed = JSON.parse(output);

    const project = parsed.data.manifest.find((cmd: any) => cmd.name === 'project');
    const actions = project.subcommands.find((cmd: any) => cmd.name === 'actions');
    const execute = actions.subcommands.find((cmd: any) => cmd.name === 'execute');
    const operator = project.subcommands.find((cmd: any) => cmd.name === 'operator');
    const billing = project.subcommands.find((cmd: any) => cmd.name === 'billing');
    const comm = parsed.data.manifest.find((cmd: any) => cmd.name === 'comm');
    const mission = parsed.data.manifest.find((cmd: any) => cmd.name === 'mission');
    const missionDiscover = mission.subcommands.find((cmd: any) => cmd.name === 'discover');
    const jobs = parsed.data.manifest.find((cmd: any) => cmd.name === 'jobs');
    const jobsDiscover = jobs.subcommands.find((cmd: any) => cmd.name === 'discover');
    const reply = comm.subcommands.find((cmd: any) => cmd.name === 'reply');

    expect(execute.options.some((opt: any) => opt.flags.includes('--idempotency-key'))).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'dashboard')).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'status')).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'runs')).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'report')).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'feedback')).toBe(true);
    expect(operator.subcommands.some((cmd: any) => cmd.name === 'scheduler')).toBe(false);
    expect(billing.subcommands.some((cmd: any) => cmd.name === 'checkout')).toBe(true);
    expect(billing.subcommands.some((cmd: any) => cmd.name === 'portal')).toBe(true);
    expect(missionDiscover.options.some((opt: any) => opt.flags.includes('--agentic'))).toBe(true);
    expect(missionDiscover.options.some((opt: any) => opt.flags.includes('--job-board'))).toBe(true);
    expect(jobs.subcommands.some((cmd: any) => cmd.name === 'claim')).toBe(true);
    expect(jobs.subcommands.some((cmd: any) => cmd.name === 'complete')).toBe(true);
    expect(jobsDiscover.options.some((opt: any) => opt.flags.includes('--freshness-days'))).toBe(true);
    expect(reply.options.some((opt: any) => opt.flags.includes('--thread'))).toBe(true);
  });

  it('comm commands are registered and fail locally with ERR_NO_AUTH when no token is configured', () => {
    expectNoAuth('comm inbox --json', testDir);
    expectNoAuth('comm send --project project-1 --kind status_update --content "Starting work" --json', testDir);
    expectNoAuth('comm reply --thread thread-1 --content "Acknowledged" --json', testDir);
    expectNoAuth('comm ack --message message-1 --json', testDir);
  }, 30000);

  it('agent, mission, research, room, and handoff commands guard auth before network calls', () => {
    [
      'agent permissions --json',
      'mission discover --json',
      'mission claim --id project-1 --mission-id mission-1 --json',
      'jobs discover --json',
      'jobs claim --id project-1 --job-id mission-1 --json',
      'jobs complete --id project-1 --job-id mission-1 --evidence "Done" --json',
      'research import --title "Paper" --json',
      'project research scan --id project-1 --json',
      'problem create --title "Problem" --summary "Summary" --json',
      'agent room list --json',
      'agent handoff create --to agent-2 --json',
      'project operator dashboard --id project-1 --json',
      'project operator status --id project-1 --json',
      'project operator runs --id project-1 --json',
      'project operator report --id project-1 --run run-1 --json',
      'project operator feedback --id project-1 --decision rejected --target-type draft --target-id draft-1 --feedback "No" --json',
      'project billing checkout --id project-1 --json',
      'project billing portal --id project-1 --json',
    ].forEach((cmd) => expectNoAuth(cmd, testDir));
  }, 30000);

  it('Active Project, billing, and agentic mission commands call the current API endpoints', async () => {
    const port = 47000 + Math.floor(Math.random() * 2000);
    const requestLogPath = path.join(testDir, 'active-project-requests.jsonl');

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
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          fs.appendFileSync(requestLogPath, JSON.stringify({
            method: req.method,
            url: req.url,
            auth: req.headers.authorization || null,
            body: body ? JSON.parse(body) : null
          }) + '\\n');

          if (req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/active-project-dashboard') {
            return reply(res, {
              success: true,
              data: {
                entitlement: { status: 'active' },
                projectHealth: { status: 'on_track' },
                operationsAllowance: { status: 'healthy' },
                alerts: [{ id: 'alert-1', title: 'Stale mission' }]
              }
            });
          }
          if (req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator') {
            return reply(res, {
              success: true,
              data: {
                entitlement: { status: 'active' },
                latestReport: { id: 'run-1', report: { summary: 'Weekly proof' } },
                operationsAllowance: { status: 'healthy' },
                pendingSuggestions: [{ title: 'Draft invitation' }]
              }
            });
          }
          if (req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator-runs') {
            return reply(res, {
              success: true,
              data: {
                runs: [
                  { id: 'run-1', status: 'completed', report: { summary: 'Weekly proof' } }
                ]
              }
            });
          }
          if (req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator-runs/run-1') {
            return reply(res, {
              success: true,
              data: { id: 'run-1', status: 'completed', report: { summary: 'Weekly proof' } }
            });
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/operator-feedback') {
            return reply(res, {
              success: true,
              data: {
                decision: { id: 'decision-1', decision: 'needs_changes' },
                jobBoardMission: null
              }
            });
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/billing/checkout') {
            return reply(res, {
              success: true,
              data: {
                entitlementId: 'ent-1',
                checkoutSessionId: 'cs_test',
                url: 'https://checkout.stripe.test/session'
              }
            });
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/billing/portal') {
            return reply(res, {
              success: true,
              data: {
                id: 'bps_test',
                url: 'https://billing.stripe.test/session'
              }
            });
          }
          if (req.method === 'GET' && req.url === '/api/v1/missions/discover?tag=planning&agentic=true&jobBoard=true&domain=robotics&freshnessDays=14&limit=5') {
            return reply(res, {
              success: true,
              data: {
                missions: [
                  { id: 'mission-1', title: 'Operator mission', agenticJobBoardEligible: true }
                ]
              }
            });
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/missions/mission-1/claim') {
            return reply(res, {
              success: true,
              data: { claim: { id: 'claim-1', status: 'pending' } }
            }, 201);
          }
          if (req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/missions/mission-1/complete') {
            return reply(res, {
              success: true,
              data: { claim: { id: 'claim-1', status: 'completed' } }
            });
          }

          reply(res, { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Not found' } }, 404);
        });
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port), requestLogPath], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      const env = emptyAuthEnv(testDir, {
        MOLTHUB_API_KEY: 'mh_live_test_token',
        MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
      });

      const dashboard = JSON.parse(execSync(`${CLI_PATH} --json project operator dashboard --id project-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const status = JSON.parse(execSync(`${CLI_PATH} --json project operator status --id project-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const runs = JSON.parse(execSync(`${CLI_PATH} --json project operator runs --id project-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const report = JSON.parse(execSync(`${CLI_PATH} --json project operator report --id project-1 --run run-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const feedback = JSON.parse(execSync(`${CLI_PATH} --json project operator feedback --id project-1 --decision needs_changes --target-type draft --target-id draft-1 --feedback "Too broad" --reason-tags scope,clarity --next-action "Narrow it"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const checkout = JSON.parse(execSync(`${CLI_PATH} --json project billing checkout --id project-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const portal = JSON.parse(execSync(`${CLI_PATH} --json project billing portal --id project-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const missions = JSON.parse(execSync(`${CLI_PATH} --json mission discover --tag planning --agentic --job-board --domain robotics --freshness-days 14 --limit 5`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const jobs = JSON.parse(execSync(`${CLI_PATH} --json jobs discover --tag planning --domain robotics --freshness-days 14 --limit 5`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const jobClaim = JSON.parse(execSync(`${CLI_PATH} --json jobs claim --id project-1 --job-id mission-1`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());
      const jobComplete = JSON.parse(execSync(`${CLI_PATH} --json jobs complete --id project-1 --job-id mission-1 --evidence "Merged PR #12"`, {
        cwd: testDir,
        timeout: EXEC_TIMEOUT,
        env,
      }).toString().trim());

      const requests = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
      const feedbackRequest = requests.find((req) => req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/operator-feedback');

      expect(dashboard.data.projectHealth.status).toBe('on_track');
      expect(status.data.entitlement.status).toBe('active');
      expect(runs.data.runs[0].id).toBe('run-1');
      expect(report.data.id).toBe('run-1');
      expect(feedback.data.decision.id).toBe('decision-1');
      expect(checkout.data.checkoutSessionId).toBe('cs_test');
      expect(portal.data.id).toBe('bps_test');
      expect(missions.data[0].agenticJobBoardEligible).toBe(true);
      expect(jobs.data[0].agenticJobBoardEligible).toBe(true);
      expect(jobClaim.data.claim.id).toBe('claim-1');
      expect(jobComplete.data.claim.status).toBe('completed');
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/active-project-dashboard')).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator')).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator-runs')).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/artifacts/project-1/operator-runs/run-1')).toBe(true);
      expect(requests.some((req) => req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/billing/checkout')).toBe(true);
      expect(requests.some((req) => req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/billing/portal')).toBe(true);
      expect(requests.some((req) => req.method === 'GET' && req.url === '/api/v1/missions/discover?tag=planning&agentic=true&jobBoard=true&domain=robotics&freshnessDays=14&limit=5')).toBe(true);
      expect(requests.some((req) => req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/missions/mission-1/claim')).toBe(true);
      expect(requests.some((req) => req.method === 'POST' && req.url === '/api/v1/artifacts/project-1/missions/mission-1/complete')).toBe(true);
      expect(requests.every((req) => req.auth === 'Bearer mh_live_test_token')).toBe(true);
      expect(feedbackRequest.body).toMatchObject({
        decision: 'needs_changes',
        targetType: 'draft',
        targetId: 'draft-1',
        feedback: 'Too broad',
        reasonTags: ['scope', 'clarity'],
        nextAction: 'Narrow it',
        source: 'cli',
      });
    } finally {
      server.kill();
    }
  }, 30000);

  it('project operator report returns ERR_NOT_FOUND when the run is absent', async () => {
    const port = 49000 + Math.floor(Math.random() * 2000);

    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const port = Number(process.argv[1]);
      http.createServer((req, res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: { code: 'ERR_NOT_FOUND', message: 'Operator run not found' }
        }));
      }).listen(port, '127.0.0.1', () => console.log('READY'));
    `, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      try {
        execSync(`${CLI_PATH} --json project operator report --id project-1 --run missing-run`, {
          cwd: testDir,
          stdio: 'pipe',
          timeout: EXEC_TIMEOUT,
          env: emptyAuthEnv(testDir, {
            MOLTHUB_API_KEY: 'mh_live_test_token',
            MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
          }),
        });
        throw new Error('Should have failed');
      } catch (e: any) {
        if (!e.stdout) throw e;
        const output = `${e.stdout.toString() || ''}`.trim();
        const parsed = JSON.parse(output);

        expect(parsed.success).toBe(false);
        expect(parsed.error.code).toBe('ERR_NOT_FOUND');
      }
    } finally {
      server.kill();
    }
  }, 30000);

  it('normalizes object-shaped API errors into string messages', async () => {
    const port = 39000 + Math.floor(Math.random() * 2000);
    const server = spawn(process.execPath, ['-e', `
      const http = require('http');
      http.createServer((req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'ERR_NO_AUTH', message: 'Invalid API Key' } }));
      }).listen(${port}, '127.0.0.1', () => console.log('READY'));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await waitForServerReady(server);
      execSync(`${CLI_PATH} --json auth whoami`, {
        cwd: testDir,
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT,
        env: emptyAuthEnv(testDir, {
          MOLTHUB_API_KEY: 'fake-token',
          MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        }),
      });
      throw new Error('Should have failed');
    } catch (e: any) {
      const output = `${e.stdout?.toString() || ''}`.trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_AUTH');
      expect(parsed.error.message).toBe('Invalid API Key');
      expect(typeof parsed.error.message).toBe('string');
    } finally {
      server.kill();
    }
  });

  it('project list requires auth before it attempts an owned-artifact lookup', () => {
    // Note: 'list' is now a top-level project command: molthub project list
    try {
      execSync(`${CLI_PATH} --json project list`, {
        cwd: testDir,
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT,
        env: {
          ...process.env,
          HOME: testDir,
          USERPROFILE: testDir,
          MOLTHUB_API_KEY: '',
        },
      });
      throw new Error('Should have failed');
    } catch (e: any) {
      const output = `${e.stdout?.toString() || ''}`.trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_AUTH');
    }
  });

  it('project playbook get requires auth before calling the API', () => {
    try {
      execSync(`${CLI_PATH} --json project playbook get --id artifact-1`, {
        cwd: testDir,
        stdio: 'pipe',
        timeout: EXEC_TIMEOUT,
        env: {
          ...process.env,
          HOME: testDir,
          USERPROFILE: testDir,
          MOLTHUB_API_KEY: '',
        },
      });
      throw new Error('Should have failed');
    } catch (e: any) {
      const output = `${e.stdout?.toString() || ''}`.trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_AUTH');
    }
  });
});
