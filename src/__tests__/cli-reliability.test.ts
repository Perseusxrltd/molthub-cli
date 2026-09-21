import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { writeBridgeRunPackage } from '../bridge/files.js';

const CLI = path.resolve('dist/index.js');

describe('CLI proof workflow contract', () => {
  let root: string;
  let server: ChildProcess | undefined;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'molthub-cli-contract-')); });
  afterEach(async () => { server?.kill(); server = undefined; await fs.remove(root); });
  function command(args: string[], extra: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: root, USERPROFILE: root, MOLTHUB_API_KEY: '', MOLTHUB_BASE_URL: 'http://127.0.0.1:1/api/v1', ...extra } });
    return { status: result.status, stderr: result.stderr, body: JSON.parse(result.stdout) };
  }
  async function run() {
    const files = await writeBridgeRunPackage({ artifactId: 'project-1', missionId: 'mission-1', outputDir: path.join(root, '.molthub/runs/mission-1'), worktreePath: root, packetJson: { checksum: 'checksum-1' }, packetMarkdown: '# Brief', runnerVersion: '3.6.0' });
    await fs.writeFile(files.evidenceTemplatePath, '# MoltHub Mission Evidence\nMission: mission-1\nPacket checksum: checksum-1\nTests run: manual review\nResult summary: Reviewed the production brief.\n');
    return files;
  }

  it('returns offline diagnostics and preserves legacy doctor check fields without requiring auth', () => {
    const result = command(['doctor']);
    expect(result.status).toBe(0);
    expect(result.body.data.offline).toBe(true);
    expect(result.body.data.checks).toEqual({ auth: 'MISSING', local_manifest: 'MISSING' });
    expect(result.body.data.status).toBe('ready_with_notes');
  });

  it('exposes all new commands in the recursive manifest', () => {
    const result = command(['commands']);
    const manifest = JSON.stringify(result.body.data.manifest);
    expect(manifest).toContain('Inspect local setup');
    expect(manifest).toContain('Check proof identity');
    expect(manifest).toContain('--proof-mode');
    expect(manifest).toContain('List local runs');
  });

  it('returns one JSON usage error for unknown commands and missing options without echoing sensitive arguments', () => {
    for (const args of [['does-not-exist', 'sk-secret-value-to-avoid-echoing'], ['mission', 'run', 'prepare']]) {
      const result = command(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.body.error.code).toBe('ERR_USAGE');
      expect(JSON.stringify(result.body)).not.toContain('sk-secret');
    }
  });

  it('keeps early invalid-base-url errors machine readable', () => {
    const result = command(['commands'], { MOLTHUB_BASE_URL: 'https://untrusted.example/api/v1' });
    expect(result.status).toBe(1);
    expect(result.body.success).toBe(false);
  });

  it('validates and previews manual evidence without a network call or key, including paths with spaces', async () => {
    const files = await run();
    const validation = command(['mission', 'evidence', 'validate', '--run', files.outputDir, '--proof-mode', 'manual']);
    expect(validation.status).toBe(0);
    expect(validation.body.data.payload.proofMode).toBe('manual');
    const preview = command(['mission', 'evidence', 'submit', '--run', files.outputDir, '--proof-mode', 'manual', '--dry-run']);
    expect(preview.status).toBe(0);
    expect(preview.body.data.dryRun).toBe(true);
    expect(await fs.pathExists(path.join(files.outputDir, 'submission.json'))).toBe(false);
    const completion = command(['mission', 'completion', 'request', '--run', files.outputDir, '--dry-run']);
    expect(completion.status).toBe(0);
    expect(completion.body.data.dryRun).toBe(true);
  });

  it('reports invalid proof with nonzero exit and blocks target-identity overrides', async () => {
    const files = await run();
    const mismatch = command(['mission', 'evidence', 'submit', '--run', files.outputDir, '--id', 'other-project', '--dry-run']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.body.error.code).toBe('ERR_EVIDENCE_IDENTITY');
    await fs.writeFile(files.evidenceTemplatePath, 'Result summary:\n');
    const invalid = command(['mission', 'evidence', 'validate', '--run', files.outputDir]);
    expect(invalid.status).toBe(1);
    expect(invalid.body.data.ok).toBe(false);
  });

  it('does not permit local status commands to invent server submission or completion', async () => {
    const files = await run();
    const result = command(['mission', 'run', 'status', '--run', files.outputDir, '--set', 'completed']);
    expect(result.body.error.code).toBe('ERR_RECEIPT_REQUIRED');
    expect((await fs.readJson(files.runMetadataPath)).status).toBe('prepared');
  });

  it('rejects empty and oversized completion previews before any network request', () => {
    for (const evidence of ['', '   ', 'x'.repeat(5001)]) {
      const result = command(['mission', 'completion', 'request', '--id', 'project-1', '--mission-id', 'mission-1', '--evidence', evidence, '--dry-run']);
      expect(result.status).toBe(1);
      expect(['ERR_MISSING_COMPLETION_EVIDENCE', 'ERR_EVIDENCE_LIMIT']).toContain(result.body.error.code);
    }
  });

  it('preserves the successful proof receipt when a subsequent completion request fails', async () => {
    const files = await run();
    server = spawn(process.execPath, ['-e', `
      const http = require('http');
      const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          res.setHeader('content-type', 'application/json');
          if (req.method === 'PUT') { res.end(JSON.stringify({ success: true, sourceEvidence: { id: 'proof-saved-1' } })); return; }
          res.statusCode = 403;
          res.end(JSON.stringify({ error: { code: 'ERR_FORBIDDEN', message: 'Completion scope is required' } }));
        });
      });
      server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture server did not start')), 5000);
      server!.stdout!.once('data', (chunk) => { clearTimeout(timer); resolve(chunk.toString()); });
      server!.once('error', reject);
    });
    const result = command(['mission', 'evidence', 'submit', '--run', files.outputDir, '--complete'], { MOLTHUB_API_KEY: 'fixture-token', MOLTHUB_BASE_URL: `http://127.0.0.1:${port}/api/v1` });
    expect(result.status).toBe(1);
    expect(result.body.error.code).toBe('ERR_PARTIAL_SUBMISSION');
    expect(result.body.error.details.sourceEvidenceSaved).toBe(true);
    const receipt = await fs.readJson(path.join(files.outputDir, 'submission.json'));
    expect(receipt.sourceEvidenceId).toBe('proof-saved-1');
    expect(receipt.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.readJson(files.runMetadataPath)).status).toBe('submitted');
  });
});
