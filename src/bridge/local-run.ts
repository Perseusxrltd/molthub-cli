import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

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

function runGit(cwd: string, args: string[]) {
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
    }).replace(/\s+$/, '');
  } catch {
    return '';
  }
}

function parseChangedPaths(statusOutput: string) {
  const paths = new Set<string>();
  for (const line of statusOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const rawPath = line.length > 3 ? line.slice(3).trim() : line.trim().replace(/^[A-Z?! ]+/, '').trim();
    if (!rawPath) continue;
    const renameParts = rawPath.split(/\s+->\s+/);
    paths.add(renameParts[renameParts.length - 1]);
  }
  return Array.from(paths);
}

function normalizeRepoPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSensitivePath(value: string) {
  const normalized = normalizeRepoPath(value);
  return SENSITIVE_PATH_PATTERNS.some((entry) => entry.pattern.test(normalized));
}

function partitionChangedPaths(paths: string[]) {
  const safe: string[] = [];
  let omittedSensitivePathCount = 0;
  for (const entry of paths) {
    if (isSensitivePath(entry)) {
      omittedSensitivePathCount += 1;
    } else {
      safe.push(entry);
    }
  }
  return { safe, omittedSensitivePathCount };
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
    changedPaths: next.changedPaths && next.changedPaths.length > 0 ? next.changedPaths : existing.changedPaths,
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
  const markdown = await fs.readFile(evidencePath, 'utf8');
  const findings = findSecretLikeContent(path.basename(evidencePath), markdown);
  if (findings.length > 0) {
    const patterns = Array.from(new Set(findings.map((entry) => entry.pattern))).join(', ');
    throw new Error(`Evidence contains secret-like content (${patterns}). Redact it before submitting.`);
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
  };
}

export async function readLocalRun(runPath: string) {
  const paths = resolveRunPaths(runPath);
  if (!(await fs.pathExists(paths.runMetadataPath))) {
    throw new Error(`Missing run.json in ${paths.runDir}`);
  }
  const run = await fs.readJson(paths.runMetadataPath) as BridgeRunMetadata;
  const adapter = await fs.pathExists(paths.adapterPath)
    ? await fs.readJson(paths.adapterPath) as BridgeAdapterMetadata
    : null;
  const status = await fs.pathExists(paths.statusPath)
    ? await fs.readJson(paths.statusPath) as BridgeStatusMetadata
    : null;
  return { paths, run, adapter, status };
}

export async function updateRunStatus(runPath: string, status: BridgeRunStatus, blockedReason?: string | null) {
  const { paths, run } = await readLocalRun(runPath);
  const existingStatus = await fs.pathExists(paths.statusPath)
    ? await fs.readJson(paths.statusPath) as BridgeStatusMetadata
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
  const statusOutput = runGit(worktreePath, ['status', '--short']);
  const branch = runGit(worktreePath, ['branch', '--show-current']);
  const commit = runGit(worktreePath, ['rev-parse', '--verify', 'HEAD']);
  const allChangedPaths = parseChangedPaths(statusOutput);
  const { safe: changedPaths, omittedSensitivePathCount } = partitionChangedPaths(allChangedPaths);
  const diffStat = changedPaths.length > 0
    ? runGit(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--stat', '--', ...changedPaths])
    : '';
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
    'Git diff stat:',
    diffStat || 'No git diff stat available.',
  ].filter((line) => line !== null).join('\n');
  await fs.writeFile(paths.diffSummaryPath, `${diffSummary}\n`, 'utf8');

  let patchWritten = false;
  if (options.includePatch && changedPaths.length > 0) {
    const patch = runGit(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', '--', ...changedPaths]);
    await fs.writeFile(paths.diffPatchPath, `${redactSecretLikeContent(patch)}\n`, 'utf8');
    patchWritten = true;
  }

  const existingMarkdown = await fs.readFile(paths.evidencePath, 'utf8');
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
    const content = await fs.readFile(file, 'utf8');
    secretLikeFindings.push(...findSecretLikeContent(path.relative(paths.runDir, file), content));
  }

  const nextRun: BridgeRunMetadata = {
    ...run,
    status: 'evidence_ready',
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
  await updateRunStatus(paths.runDir, 'evidence_ready');

  return {
    runDir: paths.runDir,
    artifactId: run.artifactId,
    missionId: run.missionId,
    status: 'evidence_ready' as const,
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
