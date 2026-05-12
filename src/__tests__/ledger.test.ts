import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

const CLI_ABS_PATH = path.join(process.cwd(), 'src', 'index.ts');
const CLI_PATH = `node --import "data:text/javascript,import{register}from'node:module';import{pathToFileURL}from'node:url';register('ts-node/esm',pathToFileURL('./'));" "${CLI_ABS_PATH}"`;
const EXEC_TIMEOUT = 15000;

function parseCommand(command: string, cwd: string) {
  return JSON.parse(execSync(`${CLI_PATH} --json ${command}`, {
    cwd,
    timeout: EXEC_TIMEOUT,
  }).toString().trim());
}

function parseFailure(command: string, cwd: string) {
  try {
    execSync(`${CLI_PATH} --json ${command}`, {
      cwd,
      timeout: EXEC_TIMEOUT,
      stdio: 'pipe',
    });
    throw new Error('Should have failed');
  } catch (error: any) {
    return JSON.parse(error.stdout.toString().trim());
  }
}

function validEvent(overrides: Record<string, unknown> = {}) {
  return {
    version: 'ledger_event_v1',
    eventId: 'evt_test',
    timestamp: '2026-05-11T00:00:00.000Z',
    projectId: 'project-1',
    artifactId: 'project-1',
    repo: { name: 'fixture', remote: null, branch: null, head: null },
    actor: { type: 'cli-user', id: null, label: 'Tester' },
    eventType: 'project.production_pack_initialized',
    source: 'cli',
    sourceVersion: 'test',
    related: { missionIds: [], runIds: [], reviewIds: [], memoryIds: [] },
    inputs: {},
    outputs: {},
    proofRefs: [],
    reviewBoundary: 'owner_review_required',
    privacyClassification: 'internal',
    redactionStatus: { status: 'checked', redacted: false, secretLikeFindings: [] },
    ...overrides,
  };
}

function writeLedger(root: string, lines: string[]) {
  const ledgerDir = path.join(root, '.molthub', 'ledger');
  fs.ensureDirSync(ledgerDir);
  fs.writeFileSync(path.join(ledgerDir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

describe('Repo-local production ledger CLI', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), `tmp-ledger-${Math.random().toString(36).slice(2)}`);
    fs.ensureDirSync(testDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDir)) fs.removeSync(testDir);
    } catch {
      // Ignore cleanup failures on Windows test runners.
    }
  });

  it('ledger append writes a valid JSONL event and ledger validate passes it', () => {
    const append = parseCommand('ledger append --type project.production_pack_initialized --actor-label "Owner" --project-id project-1 --mission-id mission-1 --proof docs/internal/repo-local-production-ledger.md', testDir);
    expect(append.success).toBe(true);
    expect(append.data.written).toBe('.molthub/ledger/events.jsonl');
    expect(append.data.event.eventType).toBe('project.production_pack_initialized');
    expect(append.data.event.related.missionIds).toEqual(['mission-1']);

    const ledgerPath = path.join(testDir, '.molthub', 'ledger', 'events.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).checksum).toMatch(/^sha256:/);

    const validate = parseCommand('ledger validate', testDir);
    expect(validate.success).toBe(true);
    expect(validate.data.eventCount).toBe(1);
  });

  it('ledger project reports projection coverage without writing files', () => {
    writeLedger(testDir, [JSON.stringify(validEvent())]);
    const project = parseCommand('ledger project', testDir);

    expect(project.success).toBe(true);
    expect(project.data.eventCount).toBe(1);
    expect(project.data.projections.some((entry: any) => entry.path === '.molthub/prompts/prompt-index.yml')).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.molthub', 'prompts', 'prompt-index.yml'))).toBe(false);
  });

  it('ledger validate rejects malformed JSONL', () => {
    writeLedger(testDir, ['{bad json']);
    const failed = parseFailure('ledger validate', testDir);

    expect(failed.success).toBe(false);
    expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_LEDGER_JSONL_PARSE');
  });

  it('ledger validate rejects missing required fields', () => {
    writeLedger(testDir, [JSON.stringify({ version: 'ledger_event_v1' })]);
    const failed = parseFailure('ledger validate', testDir);

    expect(failed.success).toBe(false);
    expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_LEDGER_EVENT_MISSING_FIELD');
  });

  it('ledger validate rejects unsupported event types', () => {
    writeLedger(testDir, [JSON.stringify(validEvent({ eventType: 'mission.auto_dispatched' }))]);
    const failed = parseFailure('ledger validate', testDir);

    expect(failed.success).toBe(false);
    expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_LEDGER_EVENT_TYPE');
  });

  it('ledger validate rejects obvious secret-like values', () => {
    writeLedger(testDir, [JSON.stringify(validEvent({ inputs: { leaked: 'mh_live_should_not_be_committed' } }))]);
    const failed = parseFailure('ledger validate', testDir);

    expect(failed.success).toBe(false);
    expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_SECRET_IN_LEDGER_EVENT');
    expect(JSON.stringify(failed)).not.toContain('mh_live_should_not_be_committed');
  });

  it('ledger validate rejects forbidden metadata names', () => {
    writeLedger(testDir, [JSON.stringify(validEvent())]);
    fs.writeFileSync(path.join(testDir, 'molthub.yaml'), 'forbidden: true\n');
    fs.ensureDirSync(path.join(testDir, '.mothub'));

    const failed = parseFailure('ledger validate', testDir);

    expect(failed.success).toBe(false);
    expect(failed.error.details.map((entry: any) => entry.code)).toEqual(
      expect.arrayContaining(['ERR_FORBIDDEN_MOLTHUB_YAML', 'ERR_FORBIDDEN_MOTHUB_DIR']),
    );
  });

  it('ledger append refuses to follow a ledger file symlink outside the repo', () => {
    const outsidePath = path.join(testDir, '..', `${path.basename(testDir)}-outside-ledger.jsonl`);
    fs.ensureDirSync(path.join(testDir, '.molthub', 'ledger'));
    fs.writeFileSync(outsidePath, 'outside\n');

    try {
      fs.symlinkSync(outsidePath, path.join(testDir, '.molthub', 'ledger', 'events.jsonl'), 'file');
    } catch (error: any) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        fs.removeSync(outsidePath);
        return;
      }
      throw error;
    }

    try {
      const failed = parseFailure('ledger append --type project.production_pack_initialized --actor-label "Owner"', testDir);

      expect(failed.success).toBe(false);
      expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_LEDGER_PATH_UNSAFE');
      expect(fs.readFileSync(outsidePath, 'utf8')).toBe('outside\n');
    } finally {
      fs.removeSync(outsidePath);
    }
  });

  it('ledger append refuses to follow an intermediate ledger directory symlink outside the repo', () => {
    const outsideDir = path.join(testDir, '..', `${path.basename(testDir)}-outside-ledger-dir`);
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    fs.ensureDirSync(outsideDir);

    try {
      fs.symlinkSync(outsideDir, path.join(testDir, '.molthub', 'ledger'), 'junction');
    } catch (error: any) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        fs.removeSync(outsideDir);
        return;
      }
      throw error;
    }

    try {
      const failed = parseFailure('ledger append --type project.production_pack_initialized --actor-label "Owner"', testDir);

      expect(failed.success).toBe(false);
      expect(failed.error.details.map((entry: any) => entry.code)).toContain('ERR_LEDGER_PATH_UNSAFE');
      expect(fs.existsSync(path.join(outsideDir, 'events.jsonl'))).toBe(false);
    } finally {
      fs.removeSync(outsideDir);
    }
  });
});
