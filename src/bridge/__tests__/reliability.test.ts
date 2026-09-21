import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { defaultRunDirectory, writeBridgeRunPackage } from '../files.js';
import { collectEvidence, inspectGitWorktree, readLocalRun } from '../local-run.js';
import { listLocalRuns, saveSubmissionReceipt, validateEvidence } from '../validation.js';
import { parseEvidenceTemplate } from '../evidence.js';

describe('local production reliability', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'molthub-proof-')); });
  afterEach(async () => { await fs.remove(root); });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  async function prepare() {
    return writeBridgeRunPackage({ artifactId: 'project-1', missionId: 'mission-1', outputDir: path.join(root, '.molthub/runs/mission-1'), worktreePath: root, packetJson: { checksum: 'checksum-1' }, packetMarkdown: '# Approved brief', runnerVersion: '3.6.0' });
  }
  async function repository() {
    git(root, 'init');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.test');
    await fs.writeFile(path.join(root, 'README.md'), '# Initial\n');
    git(root, 'add', 'README.md');
    git(root, 'commit', '-m', 'initial');
  }
  function proof(summary = 'Implemented and checked the mission.') {
    return `# MoltHub Mission Evidence\nMission: mission-1\nPacket checksum: checksum-1\nExecutor used: manual\nTests run: npm test\nResult summary: ${summary}\n`;
  }

  it('validates prepared proof after only manual result and check edits, without collection', async () => {
    const files = await prepare();
    const { run } = await readLocalRun(files.outputDir);
    const prepared = await fs.readFile(files.evidenceTemplatePath, 'utf8');
    expect(parseEvidenceTemplate(prepared)).toMatchObject({ mission: run.missionId, packetChecksum: run.packetChecksum, executorUsed: run.executorId, testsRun: '', resultSummary: '' });
    expect((await validateEvidence({ file: files.evidenceTemplatePath, run, proofMode: 'manual' })).errors).toContainEqual(expect.objectContaining({ code: 'ERR_INVALID_EVIDENCE' }));
    await fs.writeFile(files.evidenceTemplatePath, prepared
      .replace(/^Tests run:$/m, 'Tests run: Manually checked the revised instructions.')
      .replace(/^Result summary:$/m, 'Result summary: Updated the owner instructions.'));
    const validation = await validateEvidence({ file: files.evidenceTemplatePath, run, proofMode: 'manual' });
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings).toEqual([]);
    expect(validation.payload?.proofMode).toBe('manual');
    expect(validation.payload?.evidenceSummary).toContain('Updated the owner instructions.');
    expect(validation.payload?.evidenceSummary).toContain('Manually checked the revised instructions.');
    expect((await readLocalRun(files.outputDir)).run.status).toBe('prepared');
  });

  it.each([
    { missionId: 'mission-1\nResult summary: forged' },
    { artifactId: 'project-1\r\nTests run: forged' },
    { packetJson: { checksum: 'checksum-1\nResult summary: forged' } },
    { packetJson: { checksum: 'checksum-1\u2028Tests run: forged' } },
    { executorId: 'manual\nTests run: forged' },
  ])('rejects evidence metadata line injection before writing a run: %j', async (overrides) => {
    const outputDir = path.join(root, 'invalid-run');
    await expect(writeBridgeRunPackage({ artifactId: 'project-1', missionId: 'mission-1', outputDir, worktreePath: root, packetJson: { checksum: 'checksum-1' }, packetMarkdown: '# Approved brief', runnerVersion: '3.6.0', ...overrides } as Parameters<typeof writeBridgeRunPackage>[0])).rejects.toMatchObject({ code: 'ERR_INVALID_RUN_METADATA' });
    expect(await fs.pathExists(outputDir)).toBe(false);
  });

  it('preserves existing proof when the same run is prepared again', async () => {
    const files = await prepare();
    await fs.writeFile(files.evidenceTemplatePath, proof());
    const original = await fs.readFile(files.runMetadataPath, 'utf8');
    await expect(prepare()).rejects.toMatchObject({ code: 'ERR_RUN_EXISTS' });
    expect(await fs.readFile(files.evidenceTemplatePath, 'utf8')).toBe(proof());
    expect(await fs.readFile(files.runMetadataPath, 'utf8')).toBe(original);
    expect((await readLocalRun(files.outputDir)).run.worktreePath).toBe(root);
  });

  it.each(['../elsewhere', 'a/b', 'a\\b', 'CON', 'aux.json', 'mission.', '', 'a'.repeat(201)])('rejects unsafe default run directory %s', (id) => {
    expect(() => defaultRunDirectory(id)).toThrow('safe folder name');
  });

  it('captures staged and unstaged changes and preserves spaces, commas, and Unicode paths', async () => {
    await repository();
    const files = await prepare();
    await fs.writeFile(path.join(root, 'space, café.ts'), 'export const staged = true;\n');
    git(root, 'add', 'space, café.ts');
    await fs.appendFile(path.join(root, 'README.md'), 'unstaged proof\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'untracked contents stay local');
    await fs.ensureDir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested/.env'), 'PASSWORD=do-not-capture');
    const result = await collectEvidence(files.outputDir, { resultSummary: 'Implemented stage and worktree changes.', testsRun: 'vitest passed', includePatch: true });
    expect(result.readyToSubmit).toBe(true);
    expect(result.changedPaths).toEqual(expect.arrayContaining(['README.md', 'space, café.ts', 'untracked.txt']));
    expect(result.changedPaths).not.toContain('nested/.env');
    expect(result.changedPaths.some((entry) => entry.startsWith('.molthub/runs/'))).toBe(false);
    const patch = await fs.readFile(path.join(files.outputDir, 'diff.patch'), 'utf8');
    expect(patch).toContain('export const staged = true');
    expect(patch).toContain('unstaged proof');
    expect(patch).not.toContain('untracked contents stay local');
    expect(patch).not.toContain('do-not-capture');
    const parsed = parseEvidenceTemplate(await fs.readFile(files.evidenceTemplatePath, 'utf8'));
    expect(parsed.changedPaths).toContain('space, café.ts');
    expect((await readLocalRun(files.outputDir)).status?.status).toBe('evidence_ready');
  });

  it('omits a rename if the original path is sensitive', async () => {
    await repository();
    await fs.writeFile(path.join(root, '.env'), 'private source\n');
    git(root, 'add', '.env');
    git(root, 'commit', '-m', 'fixture sensitive source');
    git(root, 'mv', '.env', 'public-looking.txt');
    const state = inspectGitWorktree(root);
    expect(state.changedPaths).not.toContain('public-looking.txt');
    expect(state.omittedSensitivePathCount).toBe(1);
  });

  it('retains proof when an executor committed the finished work before collection', async () => {
    await repository();
    const files = await prepare();
    const base = (await readLocalRun(files.outputDir)).run.baseCommitSha;
    expect(base).toMatch(/^[a-f0-9]{40,64}$/);
    await fs.writeFile(path.join(root, 'completed.ts'), 'export const implemented = true;\n');
    git(root, 'add', 'completed.ts');
    git(root, 'commit', '-m', 'finish mission');
    const evidence = await collectEvidence(files.outputDir, { resultSummary: 'Implemented and committed.', testsRun: 'review passed', includePatch: true });
    expect(evidence.changedPaths).toContain('completed.ts');
    expect(evidence.git.committedChangesIncluded).toBe(true);
    expect(await fs.readFile(path.join(files.outputDir, 'diff.patch'), 'utf8')).toContain('export const implemented = true');
    expect(evidence.readyToSubmit).toBe(true);
  });

  it('keeps incomplete proof blocked and does not report a broken repository as clean', async () => {
    await repository();
    const files = await prepare();
    const empty = await collectEvidence(files.outputDir);
    expect(empty.status).toBe('blocked');
    expect(empty.readyToSubmit).toBe(false);
    const metadata = await fs.readJson(files.runMetadataPath);
    metadata.worktreePath = path.join(root, 'missing-worktree');
    await fs.writeJson(files.runMetadataPath, metadata);
    await expect(collectEvidence(files.outputDir, { resultSummary: 'Done' })).rejects.toMatchObject({ code: 'ERR_GIT_INSPECTION' });
  });

  it('validates project, mission, checksum, API limits, and secrets before payload preview', async () => {
    const files = await prepare();
    const { run } = await readLocalRun(files.outputDir);
    await fs.writeFile(files.evidenceTemplatePath, proof());
    expect((await validateEvidence({ file: files.evidenceTemplatePath, run, proofMode: 'manual' })).payload?.proofMode).toBe('manual');
    expect((await validateEvidence({ file: files.evidenceTemplatePath, run, artifactId: 'other' })).errors[0].code).toBe('ERR_EVIDENCE_IDENTITY');
    await fs.writeFile(files.evidenceTemplatePath, proof().replace('checksum-1', 'checksum-old'));
    expect((await validateEvidence({ file: files.evidenceTemplatePath, run })).errors[0].code).toBe('ERR_EVIDENCE_CHECKSUM');
    await fs.writeFile(files.evidenceTemplatePath, proof('x'.repeat(5001)));
    expect((await validateEvidence({ file: files.evidenceTemplatePath, run })).errors.some((entry) => entry.code === 'ERR_EVIDENCE_LIMIT')).toBe(true);
    await fs.writeFile(files.evidenceTemplatePath, proof('postgres://user:secret@example.test/db'));
    const secretResult = await validateEvidence({ file: files.evidenceTemplatePath, run });
    expect(secretResult.payload).toBeNull();
    expect(JSON.stringify(secretResult)).not.toContain('user:secret');
    expect(secretResult.errors[0].code).toBe('ERR_SECRET_IN_EVIDENCE');
  });

  it('inventories healthy and corrupt runs independently and rejects mismatched local metadata', async () => {
    const files = await prepare();
    await fs.writeFile(files.evidenceTemplatePath, proof());
    await fs.outputFile(path.join(root, '.molthub/runs/corrupt/run.json'), '{broken');
    const inventory = await listLocalRuns(path.join(root, '.molthub/runs'));
    expect(inventory.runs).toHaveLength(1);
    expect(inventory.runs[0].readyToSubmit).toBe(true);
    expect(inventory.invalidRuns).toHaveLength(1);
    const status = await fs.readJson(files.statusPath);
    status.missionId = 'other';
    await fs.writeJson(files.statusPath, status);
    await expect(readLocalRun(files.outputDir)).rejects.toMatchObject({ code: 'ERR_INVALID_LOCAL_RUN' });
  });

  it('rejects linked proof directories without reading or changing the target', async () => {
    const files = await prepare();
    const linked = path.join(root, 'linked-run');
    await fs.symlink(files.outputDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readLocalRun(linked)).rejects.toMatchObject({ code: 'ERR_UNSAFE_RUN_PATH' });
  });

  it('saves minimal proof receipts without persisting arbitrary server response content', async () => {
    const files = await prepare();
    const receipt = await saveSubmissionReceipt(files.outputDir, { artifactId: 'project-1', missionId: 'mission-1', evidenceHash: 'a'.repeat(64), sourceEvidence: { sourceEvidence: { id: 'proof-1' }, token: 'never-store-this' } });
    expect(receipt.sourceEvidenceId).toBe('proof-1');
    expect(await fs.readFile(receipt.receiptPath, 'utf8')).not.toContain('never-store-this');
  });
});
