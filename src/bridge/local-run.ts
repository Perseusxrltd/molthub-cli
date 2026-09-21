import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { assertPlainPath, readProofJson, readProofText, LocalBridgeError } from './safety.js';

import {
  buildCompletionEvidence,
  buildSourceEvidencePayload,
  parseEvidenceTemplate,
} from './evidence.js';
import type {
  BridgeAdapterMetadata,
  BridgeEvidenceFields,
  BridgeRunMetadata,
  BridgeRunStatus,
  BridgeStatusMetadata,
} from './types.js';

export const SECRET_PATTERNS = [
  { name: 'molthub_api_key', pattern: /mh_(?:live|test)_[A-Za-z0-9_\-]+/g },
  { name: 'bearer_token', pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._\-]+/gi },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9_\-]{16,}/g },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9\-]+/g },
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'database_url', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'generic_secret_assignment', pattern: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{20,}/gi },
];

const SENSITIVE_PATH_PATTERNS = [
  { name: 'env_file', pattern: /(^|[/\\])\.env($|[./\\])/i },
  { name: 'npmrc', pattern: /(^|[/\\])\.npmrc$/i },
  { name: 'private_key_file', pattern: /(^|[/\\])(id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(pem|key|p12|pfx))$/i },
  { name: 'local_run_folder', pattern: /^\.molthub\/runs($|\/)/i },
  { name: 'untracked_molthub_folder', pattern: /^\.molthub\/$/i },
];

export type LocalRunPaths = {
  runDir: string;
  runMetadataPath: string;
  adapterPath: string;
  statusPath: string;
  evidencePath: string;
  executorLogPath: string;
  commandsLogPath: string;
  diffSummaryPath: string;
  diffPatchPath: string;
  submissionReceiptPath: string;
  completionReceiptPath: string;
};

export type EvidenceCollectOptions = {
  testsRun?: string;
  resultSummary?: string;
  issuesBlockers?: string;
  memoryUpdateNotes?: string;
  executorUsed?: string;
  includePatch?: boolean;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function safeGitArgs(args: string[]) {
  return [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    ...args,
  ];
}

function runGit(cwd: string, args: string[], optional = false) {
  try {
    return execFileSync('git', safeGitArgs(args), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 8,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_EXTERNAL_DIFF: '',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  } catch {
    if (optional) return '';
    throw new LocalBridgeError('ERR_GIT_INSPECTION', 'Could not inspect the recorded worktree with git. Check that the folder exists, git is installed, and this repository is accessible. No clean-worktree claim was recorded.');
  }
}

export function readGitHead(cwd: string) {
  return runGit(cwd, ['rev-parse', '--verify', 'HEAD'], true).trim();
}

export function inspectGitWorktree(cwd: string, baseCommitSha?: string | null) {
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
  const status = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const records = status.split('\0');
  const changedPaths = new Set<string>();
  let omittedSensitivePathCount = 0;
  let untrackedCount = 0;
  const addPaths = (names: string[]) => {
    if (names.some((name) => !name || isSensitivePath(name) || /[\r\n\x00-\x1f]/.test(name))) {
      omittedSensitivePathCount += 1;
      return false;
    }
    for (const name of names) changedPaths.add(name);
    return true;
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const flags = record.slice(0, 2);
    const names = [record.slice(3)];
    if (/[RC]/.test(flags)) names.push(records[++index]);
    if (addPaths(names) && flags === '??') untrackedCount += 1;
  }
  const validBase = baseCommitSha && /^[a-f0-9]{7,64}$/i.test(baseCommitSha)
    && runGit(root, ['rev-parse', '--verify', `${baseCommitSha}^{commit}`], true).trim() ? baseCommitSha : null;
  const commit = readGitHead(root);
  if (validBase && commit) {
    const committed = runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', validBase, commit, '--']).split('\0');
    for (let index = 0; index < committed.length; index += 1) {
      const status = committed[index];
      if (!status) continue;
      const names = [committed[++index]];
      if (/^[RC]/.test(status)) names.push(committed[++index]);
      addPaths(names);
    }
  }
  return {
    root,
    branch: runGit(root, ['branch', '--show-current'], true).trim(),
    commit,
    baseCommitSha: validBase,
    committedChangesIncluded: Boolean(validBase && commit),
    changedPaths: [...changedPaths],
    omittedSensitivePathCount,
    untrackedCount,
  };
}

function normalizeRepoPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSensitivePath(value: string) {
  const normalized = normalizeRepoPath(value);
  return SENSITIVE_PATH_PATTERNS.some((entry) => entry.pattern.test(normalized));
}

function renderEvidence(fields: BridgeEvidenceFields) {
  const changedPaths = fields.changedPaths.length > 0
    ? `\n${fields.changedPaths.map((entry) => `- ${entry}`).join('\n')}`
    : '';

  return `# MoltHub Mission Evidence

Mission: ${fields.mission}
Packet checksum: ${fields.packetChecksum}
Executor used: ${fields.executorUsed}
Branch: ${fields.branch}
Commit: ${fields.commit}
PR URL: ${fields.prUrl}
Changed paths:${changedPaths}
Tests run: ${fields.testsRun}
Result summary: ${fields.resultSummary}
Issues / blockers: ${fields.issuesBlockers}
Memory update notes: ${fields.memoryUpdateNotes}
`;
}

function mergeEvidenceFields(existing: BridgeEvidenceFields, next: Partial<BridgeEvidenceFields>): BridgeEvidenceFields {
  return {
    mission: next.mission || existing.mission,
    packetChecksum: next.packetChecksum || existing.packetChecksum,
    executorUsed: next.executorUsed || existing.executorUsed,
    branch: next.branch || existing.branch,
    commit: next.commit || existing.commit,
    prUrl: next.prUrl || existing.prUrl,
    changedPaths: next.changedPaths ?? existing.changedPaths,
    testsRun: next.testsRun || existing.testsRun,
    resultSummary: next.resultSummary || existing.resultSummary,
    issuesBlockers: next.issuesBlockers || existing.issuesBlockers,
    memoryUpdateNotes: next.memoryUpdateNotes || existing.memoryUpdateNotes,
  };
}

function redactEvidenceFields(fields: BridgeEvidenceFields) {
  return {
    mission: redactSecretLikeContent(fields.mission),
    packetChecksum: redactSecretLikeContent(fields.packetChecksum),
    executorUsed: redactSecretLikeContent(fields.executorUsed),
    branch: redactSecretLikeContent(fields.branch),
    commit: redactSecretLikeContent(fields.commit),
    prUrl: redactSecretLikeContent(fields.prUrl),
    changedPaths: fields.changedPaths.map((entry) => redactSecretLikeContent(entry)),
    testsRun: redactSecretLikeContent(fields.testsRun),
    resultSummary: redactSecretLikeContent(fields.resultSummary),
    issuesBlockers: redactSecretLikeContent(fields.issuesBlockers),
    memoryUpdateNotes: redactSecretLikeContent(fields.memoryUpdateNotes),
  };
}

function findSecretLikeContent(file: string, content: string) {
  const findings: Array<{ file: string; pattern: string }> = [];
  for (const entry of SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(content)) {
      findings.push({ file, pattern: entry.name });
    }
  }
  return findings;
}

function redactSecretLikeContent(content: string) {
  let redacted = content;
  for (const entry of SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    redacted = redacted.replace(entry.pattern, `[REDACTED:${entry.name}]`);
  }
  return redacted;
}

export function secretLikeFindingsInText(file: string, content: string) {
  return findSecretLikeContent(file, content);
}

export async function assertEvidenceSafeForSubmit(evidencePath: string) {
  const markdown = await readProofText(evidencePath);
  const findings = findSecretLikeContent(path.basename(evidencePath), markdown);
  if (findings.length > 0) {
    const patterns = Array.from(new Set(findings.map((entry) => entry.pattern))).join(', ');
    throw new LocalBridgeError('ERR_SECRET_IN_EVIDENCE', `Evidence contains secret-like content (${patterns}). Redact it before submitting.`);
  }
}

export function resolveRunPaths(runPath: string): LocalRunPaths {
  const runDir = path.resolve(process.cwd(), runPath);
  return {
    runDir,
    runMetadataPath: path.join(runDir, 'run.json'),
    adapterPath: path.join(runDir, 'adapter.json'),
    statusPath: path.join(runDir, 'status.json'),
    evidencePath: path.join(runDir, 'evidence.md'),
    executorLogPath: path.join(runDir, 'executor.log'),
    commandsLogPath: path.join(runDir, 'commands.log'),
    diffSummaryPath: path.join(runDir, 'diff-summary.txt'),
    diffPatchPath: path.join(runDir, 'diff.patch'),
    submissionReceiptPath: path.join(runDir, 'submission.json'),
    completionReceiptPath: path.join(runDir, 'completion.json'),
  };
}

export async function readLocalRun(runPath: string) {
  const paths = resolveRunPaths(runPath);
  for (const file of Object.values(paths)) await assertPlainPath(file);
  if (!(await fs.pathExists(paths.runMetadataPath))) {
    throw new Error(`Missing run.json in ${paths.runDir}`);
  }
  const run = await readProofJson(paths.runMetadataPath) as BridgeRunMetadata;
  if (!run || run.version !== 'local_executor_bridge_v0' || !cleanString(run.artifactId) || !cleanString(run.missionId)
    || (run.projectId && run.projectId !== run.artifactId) || !LOCAL_RUN_STATUSES.includes(run.status)) {
    throw new LocalBridgeError('ERR_INVALID_LOCAL_RUN', 'run.json must contain a supported version, matching project identity, mission ID, and valid local status.');
  }
  if (findSecretLikeContent('run.json', JSON.stringify(run)).length) {
    throw new LocalBridgeError('ERR_SECRET_IN_EVIDENCE', 'Run metadata contains secret-like content. Redact it before using the run.');
  }
  const adapter = await fs.pathExists(paths.adapterPath)
    ? await readProofJson(paths.adapterPath) as BridgeAdapterMetadata
    : null;
  const status = await fs.pathExists(paths.statusPath)
    ? await readProofJson(paths.statusPath) as BridgeStatusMetadata
    : null;
  if (status && (status.artifactId !== run.artifactId || status.missionId !== run.missionId || !LOCAL_RUN_STATUSES.includes(status.status))) {
    throw new LocalBridgeError('ERR_INVALID_LOCAL_RUN', 'status.json does not match the local run identity or contains an invalid status.');
  }
  if (findSecretLikeContent('adapter.json', JSON.stringify(adapter)).length || findSecretLikeContent('status.json', JSON.stringify(status)).length) {
    throw new LocalBridgeError('ERR_SECRET_IN_EVIDENCE', 'Run metadata contains secret-like content. Redact it before using the run.');
  }
  const receipts: Record<string, unknown> = {};
  for (const [key, file] of [['submission', paths.submissionReceiptPath], ['completion', paths.completionReceiptPath]]) {
    if (!(await fs.pathExists(file))) continue;
    const value = await readProofJson(file);
    if (secretLikeFindingsInText(path.basename(file), JSON.stringify(value)).length) throw new LocalBridgeError('ERR_SECRET_IN_EVIDENCE', 'Local receipt contains secret-like content. Redact it before reading the run.');
    receipts[key] = value;
  }
  return { paths, run, adapter, status, receipts };
}

export const LOCAL_RUN_STATUSES: BridgeRunStatus[] = ['prepared', 'running', 'blocked', 'evidence_ready', 'submitted', 'completion_requested', 'completed', 'failed', 'cancelled'];

export async function updateRunStatus(runPath: string, status: BridgeRunStatus, blockedReason?: string | null) {
  if (blockedReason && findSecretLikeContent('blockedReason', blockedReason).length) {
    throw new LocalBridgeError('ERR_SECRET_IN_EVIDENCE', 'Blocked reason contains secret-like content. Redact it before saving.');
  }
  const { paths, run } = await readLocalRun(runPath);
  const existingStatus = await fs.pathExists(paths.statusPath)
    ? await readProofJson(paths.statusPath) as BridgeStatusMetadata
    : {
        version: 'local_run_status_v1',
        projectId: run.projectId ?? run.artifactId,
        artifactId: run.artifactId,
        missionId: run.missionId,
        status: run.status,
        createdAt: run.createdAt ?? run.preparedAt,
        updatedAt: run.preparedAt,
        lastHeartbeatAt: null,
        blockedReason: null,
        noCloudExecution: true,
        noSecretsLogged: true,
      } satisfies BridgeStatusMetadata;

  const now = new Date().toISOString();
  const nextStatus: BridgeStatusMetadata = {
    ...existingStatus,
    status,
    updatedAt: now,
    lastHeartbeatAt: now,
    blockedReason: status === 'blocked' ? blockedReason ?? existingStatus.blockedReason : blockedReason ?? null,
  };
  const nextRun: BridgeRunMetadata = { ...run, status };
  await fs.writeJson(paths.statusPath, nextStatus, { spaces: 2 });
  await fs.writeJson(paths.runMetadataPath, nextRun, { spaces: 2 });
  return nextStatus;
}

export async function collectEvidence(runPath: string, options: EvidenceCollectOptions = {}) {
  const { paths, run, adapter } = await readLocalRun(runPath);
  if (!(await fs.pathExists(paths.evidencePath))) {
    throw new Error(`Missing evidence.md in ${paths.runDir}`);
  }

  const worktreePath = cleanString(run.worktreePath) || process.cwd();
  const git = inspectGitWorktree(worktreePath, run.baseCommitSha);
  const { branch, commit, changedPaths, omittedSensitivePathCount } = git;
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv'];
  // Literal pathspecs prevent a filename such as :(glob)** from expanding scope.
  const pathspecs = changedPaths.map((file) => `:(literal)${file}`);
  const stagedStat = changedPaths.length ? runGit(git.root, [...diffArgs, '--cached', '--stat', '--', ...pathspecs]).trim() : '';
  const unstagedStat = changedPaths.length ? runGit(git.root, [...diffArgs, '--stat', '--', ...pathspecs]).trim() : '';
  const committedStat = changedPaths.length && git.committedChangesIncluded ? runGit(git.root, [...diffArgs, '--stat', git.baseCommitSha!, git.commit, '--', ...pathspecs]).trim() : '';
  const diffSummary = [
    `Collected at: ${new Date().toISOString()}`,
    `Worktree: ${worktreePath}`,
    branch ? `Branch: ${branch}` : 'Branch: unavailable',
    commit ? `Commit: ${commit}` : 'Commit: unavailable',
    '',
    'Changed files:',
    changedPaths.length > 0 ? changedPaths.map((entry) => `- ${entry}`).join('\n') : '- none detected',
    omittedSensitivePathCount > 0 ? `- [${omittedSensitivePathCount} sensitive path omitted]` : null,
    '',
    'Committed changes since preparation:',
    git.committedChangesIncluded ? committedStat || 'No committed changes since preparation.' : 'Unavailable: no resolvable preparation commit was recorded. Only current uncommitted changes were inspected.',
    'Staged diff stat:',
    stagedStat || 'No staged diff.',
    'Unstaged diff stat:',
    unstagedStat || 'No unstaged diff.',
    `Untracked files: ${git.untrackedCount} (paths only; contents are not captured).`,
  ].filter((line) => line !== null).join('\n');
  await fs.writeFile(paths.diffSummaryPath, `${redactSecretLikeContent(diffSummary)}\n`, 'utf8');

  let patchWritten = false;
  if (options.includePatch) {
    const stagedPatch = changedPaths.length ? runGit(git.root, [...diffArgs, '--cached', '--', ...pathspecs]) : '';
    const unstagedPatch = changedPaths.length ? runGit(git.root, [...diffArgs, '--', ...pathspecs]) : '';
    const committedPatch = changedPaths.length && git.committedChangesIncluded ? runGit(git.root, [...diffArgs, git.baseCommitSha!, git.commit, '--', ...pathspecs]) : '';
    const patch = `# Committed changes since preparation\n${committedPatch}\n# Staged changes\n${stagedPatch}\n# Unstaged changes\n${unstagedPatch}`;
    await fs.writeFile(paths.diffPatchPath, `${redactSecretLikeContent(patch)}\n`, 'utf8');
    patchWritten = true;
  }

  const existingMarkdown = await readProofText(paths.evidencePath);
  const existingFields = parseEvidenceTemplate(existingMarkdown);
  const nextFields = redactEvidenceFields(mergeEvidenceFields(existingFields, {
    mission: run.missionId,
    packetChecksum: cleanString(run.packetChecksum),
    executorUsed: options.executorUsed ?? adapter?.executorId ?? run.executorId ?? '',
    branch,
    commit,
    changedPaths,
    testsRun: options.testsRun,
    resultSummary: options.resultSummary,
    issuesBlockers: options.issuesBlockers,
    memoryUpdateNotes: options.memoryUpdateNotes,
  }));
  await fs.writeFile(paths.evidencePath, renderEvidence(nextFields), 'utf8');

  const checkedFiles = [
    paths.evidencePath,
    paths.executorLogPath,
    paths.commandsLogPath,
    paths.diffSummaryPath,
    ...(patchWritten ? [paths.diffPatchPath] : []),
  ];
  const secretLikeFindings: Array<{ file: string; pattern: string }> = [];
  for (const file of checkedFiles) {
    if (!(await fs.pathExists(file))) continue;
    const content = await readProofText(file, 16 * 1024 * 1024);
    secretLikeFindings.push(...findSecretLikeContent(path.relative(paths.runDir, file), content));
  }

  const { validateEvidence } = await import('./validation.js');
  const validation = await validateEvidence({ file: paths.evidencePath, run });
  const evidenceReady = validation.ok && secretLikeFindings.length === 0;
  const nextStatus = evidenceReady ? 'evidence_ready' : 'blocked';
  const nextRun: BridgeRunMetadata = {
    ...run,
    status: nextStatus,
    redactionSummary: {
      checkedFiles: checkedFiles.map((file) => path.relative(paths.runDir, file)),
      secretLikeFindings,
      redactedOutputs: [
        ...(patchWritten ? ['diff.patch'] : []),
        ...(JSON.stringify(nextFields).includes('[REDACTED:') ? ['evidence.md'] : []),
      ],
      omittedSensitivePathCount,
    },
  };
  await fs.writeJson(paths.runMetadataPath, nextRun, { spaces: 2 });
  await updateRunStatus(paths.runDir, nextStatus, evidenceReady ? null : 'Proof needs a result summary and local secret review before submission.');

  return {
    runDir: paths.runDir,
    artifactId: run.artifactId,
    missionId: run.missionId,
    status: nextStatus,
    readyToSubmit: evidenceReady,
    validation: { errors: validation.errors, warnings: validation.warnings },
    git: { inspected: true, baseCommitSha: git.baseCommitSha, committedChangesIncluded: git.committedChangesIncluded, untrackedCount: git.untrackedCount, patchIncludes: [...(git.committedChangesIncluded ? ['committed_since_preparation'] : []), 'staged', 'unstaged'], untrackedContentsIncluded: false },
    files: {
      evidence: paths.evidencePath,
      diffSummary: paths.diffSummaryPath,
      diffPatch: patchWritten ? paths.diffPatchPath : null,
    },
    changedPaths,
    testsRun: nextFields.testsRun,
    sourceEvidencePreview: nextFields.resultSummary
      ? buildSourceEvidencePayload(nextFields)
      : null,
    completionEvidencePreview: buildCompletionEvidence(nextFields),
    redaction: nextRun.redactionSummary,
    warnings: [
      ...(!git.committedChangesIncluded ? ['No resolvable preparation commit is available; only uncommitted changes were inspected. Record committed proof manually if needed.'] : []),
      ...(!nextFields.resultSummary.trim() ? ['Add a result summary before submitting evidence.'] : []),
      ...(git.untrackedCount > 0 ? ['Untracked files are listed by path only. Their contents are not included in the patch.'] : []),
      ...(secretLikeFindings.length > 0
        ? ['Secret-like content was detected in local run files. Review and redact before submitting evidence.']
        : []),
      ...(omittedSensitivePathCount > 0
        ? [`${omittedSensitivePathCount} sensitive changed path was omitted from evidence.`]
        : []),
    ],
  };
}

export function coerceRunSubmitDefaults(run: BridgeRunMetadata) {
  const raw = asObject(run);
  return {
    artifactId: cleanString(raw.artifactId) || cleanString(raw.projectId),
    missionId: cleanString(raw.missionId),
  };
}
