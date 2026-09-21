import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { buildCompletionEvidence, buildSourceEvidencePayload, parseEvidenceTemplate } from './evidence.js';
import { readLocalRun, secretLikeFindingsInText } from './local-run.js';
import { assertPlainPath, readProofText, LocalBridgeError } from './safety.js';
import type { BridgeRunMetadata, SourceEvidencePayload } from './types.js';

export type ProofMode = 'repo' | 'manual' | 'no_repo';
type Finding = { code: string; message: string };

export function normalizeProofMode(value?: string): ProofMode {
  if (!value || value === 'repo') return 'repo';
  if (value === 'manual' || value === 'no_repo') return value;
  throw new LocalBridgeError('ERR_INVALID_PROOF_MODE', 'Proof mode must be repo, manual, or no_repo.');
}

export async function validateEvidence(input: { file: string; run?: BridgeRunMetadata; missionId?: string; artifactId?: string; proofMode?: string }) {
  const mode = normalizeProofMode(input.proofMode);
  const markdown = await readProofText(input.file);
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const secretFindings = secretLikeFindingsInText('evidence.md', markdown);
  // Never include the supplied content in diagnostics or preview when secrets are present.
  if (secretFindings.length) {
    return { ok: false, proofMode: mode, errors: [{ code: 'ERR_SECRET_IN_EVIDENCE', message: 'Evidence contains secret-like content. Redact it before submitting.' }], warnings, payload: null, completionEvidence: null, evidenceHash: null };
  }
  const fields = parseEvidenceTemplate(markdown);
  const labels = markdown.match(/^(Mission|Packet checksum|Executor used|Branch|Commit|PR URL|Changed paths|Tests run|Result summary|Issues \/ blockers|Memory update notes):/gm) ?? [];
  if (new Set(labels).size !== labels.length) errors.push({ code: 'ERR_DUPLICATE_EVIDENCE_FIELD', message: 'Evidence contains duplicate field labels; keep one value for each field.' });
  const expectedMission = input.missionId ?? input.run?.missionId;
  if (fields.mission && expectedMission && fields.mission !== expectedMission) errors.push({ code: 'ERR_EVIDENCE_IDENTITY', message: 'Evidence Mission must match the target mission ID.' });
  if (input.run && ((input.artifactId && input.artifactId !== input.run.artifactId) || (input.missionId && input.missionId !== input.run.missionId))) errors.push({ code: 'ERR_EVIDENCE_IDENTITY', message: 'Explicit project or mission ID does not match run.json. Use the intended run folder.' });
  if (input.run?.packetChecksum && fields.packetChecksum !== input.run.packetChecksum) errors.push({ code: 'ERR_EVIDENCE_CHECKSUM', message: 'Evidence packet checksum does not match the prepared run. Restore the original checksum or prepare a fresh run.' });
  if (!fields.resultSummary) errors.push({ code: 'ERR_INVALID_EVIDENCE', message: 'Result summary is required before submitting source evidence.' });
  if (!fields.mission) warnings.push({ code: 'WARN_MISSING_MISSION', message: 'Add the mission ID to the evidence template for durable traceability.' });
  if (!fields.testsRun) warnings.push({ code: 'WARN_MISSING_TESTS', message: 'Record tests already run, or explain why tests were not applicable.' });
  if (mode === 'repo' && !fields.branch && !fields.commit && !fields.prUrl) warnings.push({ code: 'WARN_MISSING_REPO_PROOF', message: 'No branch, commit, or PR proof was supplied. Use manual or no_repo for work without repository proof.' });
  if (fields.branch.length > 160) errors.push({ code: 'ERR_EVIDENCE_LIMIT', message: 'Branch must be at most 160 characters.' });
  if (fields.changedPaths.length > 50 || fields.changedPaths.some((entry) => entry.length > 240)) errors.push({ code: 'ERR_EVIDENCE_LIMIT', message: 'Changed paths allow at most 50 entries of 240 characters each.' });
  if (fields.changedPaths.some((entry) => /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:/.test(entry))) errors.push({ code: 'ERR_UNSAFE_EVIDENCE_PATH', message: 'Changed paths must be relative repository paths without parent traversal.' });
  for (const [label, value] of [['PR URL', fields.prUrl], ['Commit', fields.commit]]) {
    if (/^https?:/i.test(value)) {
      try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.length > 500) throw new Error();
      } catch {
        errors.push({ code: 'ERR_INVALID_EVIDENCE_URL', message: `${label} must be an HTTP(S) URL without embedded credentials and at most 500 characters.` });
      }
    }
  }
  let payload: SourceEvidencePayload | null = null;
  if (fields.resultSummary) {
    payload = buildSourceEvidencePayload(fields);
    if (input.proofMode) payload.proofMode = mode;
    if (payload.evidenceSummary.length > 5000) errors.push({ code: 'ERR_EVIDENCE_LIMIT', message: 'Combined executor, test, result, blocker, and learning summary must be at most 5000 characters.' });
    if (fields.prUrl && !payload.pullRequestUrl) warnings.push({ code: 'WARN_UNSUPPORTED_PR', message: 'PR URL is not a supported GitHub pull request or GitLab merge request and will not be submitted.' });
    if (fields.commit && !payload.headCommitSha && !payload.commitUrl) warnings.push({ code: 'WARN_INVALID_COMMIT', message: 'Commit is not a valid SHA or URL and will not be submitted.' });
  }
  return { ok: errors.length === 0, proofMode: mode, errors, warnings, payload: errors.length ? null : payload, completionEvidence: errors.length ? null : buildCompletionEvidence(fields), evidenceHash: createHash('sha256').update(markdown).digest('hex') };
}

export async function listLocalRuns(root: string, filters: { projectId?: string; status?: string } = {}) {
  const directory = path.resolve(root);
  await assertPlainPath(directory);
  const runs: Array<Record<string, unknown>> = [];
  const invalidRuns: Array<{ directory: string; code: string; message: string }> = [];
  if (!(await fs.pathExists(directory))) return { directory, runs, invalidRuns, total: 0 };
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const runDir = path.join(directory, entry.name);
    try {
      const local = await readLocalRun(runDir);
      if (filters.projectId && local.run.artifactId !== filters.projectId) continue;
      if (filters.status && local.run.status !== filters.status) continue;
      const proof = await fs.pathExists(local.paths.evidencePath)
        ? await validateEvidence({ file: local.paths.evidencePath, run: local.run })
        : null;
      const afterSubmission = ['submitted', 'completion_requested', 'completed', 'cancelled'].includes(local.run.status);
      runs.push({ runDir, artifactId: local.run.artifactId, missionId: local.run.missionId, status: local.run.status, executor: local.run.executorId, preparedAt: local.run.preparedAt, readyToSubmit: !afterSubmission && (proof?.ok ?? false), proofErrors: proof?.errors ?? [{ code: 'ERR_MISSING_EVIDENCE', message: 'Missing evidence.md.' }], nextAction: afterSubmission ? 'inspect_server_history' : proof?.ok ? 'submit_evidence' : 'collect_evidence' });
    } catch (error: any) {
      invalidRuns.push({ directory: runDir, code: error.code ?? 'ERR_INVALID_LOCAL_RUN', message: error instanceof LocalBridgeError ? error.message : 'Could not read this run. Check its files and permissions.' });
    }
  }
  return { directory, runs, invalidRuns, total: runs.length };
}

export async function saveSubmissionReceipt(runDir: string, input: { artifactId: string; missionId: string; evidenceHash: string | null; sourceEvidence: unknown }) {
  const receiptPath = path.join(runDir, 'submission.json');
  await assertPlainPath(receiptPath);
  const record = input.sourceEvidence as any;
  const rawId = record?.id ?? record?.sourceEvidence?.id ?? record?.evidence?.id ?? null;
  const sourceEvidenceId = typeof rawId === 'string' && !secretLikeFindingsInText('id', rawId).length ? rawId : null;
  if (!sourceEvidenceId) throw new LocalBridgeError('ERR_INVALID_API_RECEIPT', 'A saved proof ID is required for a local submission receipt.');
  const receipt = { version: 'local_evidence_submission_v1', artifactId: input.artifactId, missionId: input.missionId, submittedAt: new Date().toISOString(), evidenceHash: input.evidenceHash, sourceEvidenceId, sourceEvidenceSaved: true, reviewBoundary: 'source_evidence_not_accepted_memory' };
  await fs.writeJson(receiptPath, receipt, { spaces: 2 });
  return { receiptPath, ...receipt };
}

export async function saveCompletionReceipt(runDir: string, input: { artifactId: string; missionId: string; state: 'completed' | 'completion_requested'; response: unknown }) {
  const receiptPath = path.join(runDir, 'completion.json');
  await assertPlainPath(receiptPath);
  const body = input.response as any;
  const draftId = body?.data?.completionDraft?.id ?? null;
  const receipt = { version: 'local_completion_receipt_v1', artifactId: input.artifactId, missionId: input.missionId, receivedAt: new Date().toISOString(), status: input.state, completionDraftId: typeof draftId === 'string' && !secretLikeFindingsInText('id', draftId).length ? draftId : null, reviewBoundary: 'memory_acceptance_requires_owner_review' };
  await fs.writeJson(receiptPath, receipt, { spaces: 2 });
  return { receiptPath, ...receipt };
}
