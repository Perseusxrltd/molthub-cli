import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_ABS_PATH } from './cli-path.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'molthub-onboarding-')); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_ABS_PATH, ...args], {
    cwd: directory,
    env: { ...process.env, HOME: directory, USERPROFILE: directory, MOLTHUB_API_KEY: '', ...env },
    encoding: 'utf8', timeout: 10000,
  });
}

describe('CLI onboarding', () => {
  it.each([
    ['nonsense', '--json'],
    ['project', 'inspect', '--json'],
    ['local', 'init', '--name', '--json'],
    ['--json', 'doctor', '--nonsense'],
    ['project', '--json'],
    ['--json'],
  ])('returns JSON for syntax errors: %s', (...args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('ERR_USAGE');
    expect(body.suggestedNextCommands).toContain('molthub commands --json');
  });
  it('returns JSON even when base URL validation fails before parsing', () => {
    const result = run(['doctor', '--json'], { MOLTHUB_BASE_URL: 'https://untrusted.example' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('ERR_UNTRUSTED_BASE_URL');
  });
  it('offers actionable offline recovery without a key or a manifest', () => {
    const result = run(['doctor', '--json']);
    const body = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(body.data.checks.auth).toBe('MISSING');
    expect(body.data.checks.auth_verified).toBe(false);
    expect(body.data.nextSteps.map((step: { command: string }) => step.command)).toEqual([
      'molthub auth whoami --json', 'molthub local init --json',
    ]);
  });
  it('does not mistake an invalid key for healthy configuration or disclose it', () => {
    const result = run(['doctor', '--json'], { MOLTHUB_API_KEY: 'not-a-valid-secret' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).data.checks.auth).toBe('INVALID');
    expect(result.stdout).not.toContain('not-a-valid-secret');
  });
  it('never claims a configured key was verified and does not require local metadata', () => {
    const token = `mh_live_${'ab'.repeat(24)}`;
    const result = run(['doctor', '--json'], { MOLTHUB_API_KEY: token, MOLTHUB_BASE_URL: 'http://127.0.0.1:1/api/v1' });
    const body = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(body.data.checks).toMatchObject({ auth: 'OK', auth_verified: false, local_manifest: 'MISSING' });
    expect(result.stdout).not.toContain(token);
  });
  it('recommends validating an existing manifest', () => {
    mkdirSync(path.join(directory, '.molthub'));
    writeFileSync(path.join(directory, '.molthub/project.md'), '---\ntitle: Example\ncategory: Tool\n---\n');
    const body = JSON.parse(run(['doctor', '--json']).stdout);
    expect(body.data.nextSteps.at(-1).command).toBe('molthub local validate --json');
  });
  it('keeps explicit help successful and shows a short first-use path', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Start here:');
    expect(result.stdout).toContain('no key needed');
  });
});
