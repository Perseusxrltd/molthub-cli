import type { BridgeEvidenceFields, SourceEvidencePayload } from './types.js';

export const EVIDENCE_TEMPLATE = `# MoltHub Mission Evidence

Mission:
Packet checksum:
Executor used:
Branch:
Commit:
PR URL:
Changed paths:
Tests run:
Result summary:
Issues / blockers:
Memory update notes:
`;

const FIELD_LABELS = [
  'Mission',
  'Packet checksum',
  'Executor used',
  'Branch',
  'Commit',
  'PR URL',
  'Changed paths',
  'Tests run',
  'Result summary',
  'Issues / blockers',
  'Memory update notes',
] as const;

const FIELD_TO_KEY: Record<(typeof FIELD_LABELS)[number], keyof Omit<BridgeEvidenceFields, 'changedPaths'> | 'changedPathsRaw'> = {
  Mission: 'mission',
  'Packet checksum': 'packetChecksum',
  'Executor used': 'executorUsed',
  Branch: 'branch',
  Commit: 'commit',
  'PR URL': 'prUrl',
  'Changed paths': 'changedPathsRaw',
  'Tests run': 'testsRun',
  'Result summary': 'resultSummary',
  'Issues / blockers': 'issuesBlockers',
  'Memory update notes': 'memoryUpdateNotes',
};

function stripListMarker(value: string) {
  return value.replace(/^\s*[-*]\s+/, '').trim();
}

function splitChangedPaths(value: string) {
  return value
    .split(/[\r\n,]+/)
    .map(stripListMarker)
    .filter(Boolean);
}

function clean(value: string | undefined) {
  return (value ?? '').trim();
}

function parseFieldLine(line: string) {
  for (const label of FIELD_LABELS) {
    const prefix = `${label}:`;
    if (line.startsWith(prefix)) {
      return {
        label,
        value: line.slice(prefix.length).trim(),
      };
    }
  }
  return null;
}

export function parseEvidenceTemplate(markdown: string): BridgeEvidenceFields {
  const fields: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim() === '# MoltHub Mission Evidence') continue;

    const field = parseFieldLine(line);
    if (field) {
      const key = FIELD_TO_KEY[field.label];
      currentKey = key;
      fields[key] = field.value ? [field.value] : [];
      continue;
    }

    if (currentKey) {
      fields[currentKey] = [...(fields[currentKey] ?? []), line.trim()];
    }
  }

  const value = (key: string) => clean((fields[key] ?? []).join('\n'));
  return {
    mission: value('mission'),
    packetChecksum: value('packetChecksum'),
    executorUsed: value('executorUsed'),
    branch: value('branch'),
    commit: value('commit'),
    prUrl: value('prUrl'),
    changedPaths: splitChangedPaths(value('changedPathsRaw')),
    testsRun: value('testsRun'),
    resultSummary: value('resultSummary'),
    issuesBlockers: value('issuesBlockers'),
    memoryUpdateNotes: value('memoryUpdateNotes'),
  };
}

function isUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function cleanUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isGitHubPullRequestUrl(value: string) {
  const parsed = cleanUrl(value);
  if (!parsed) return false;
  const url = new URL(parsed);
  if (url.hostname.toLowerCase() !== 'github.com') return false;
  const parts = url.pathname.split('/').filter(Boolean);
  const pullIndex = parts.indexOf('pull');
  return pullIndex >= 2 && /^\d+$/.test(parts[pullIndex + 1] ?? '');
}

function isGitLabMergeRequestUrl(value: string) {
  const parsed = cleanUrl(value);
  if (!parsed) return false;
  const url = new URL(parsed);
  if (url.hostname.toLowerCase() !== 'gitlab.com') return false;
  const parts = url.pathname.split('/').filter(Boolean);
  const dashIndex = parts.indexOf('-');
  const mergeRequestIndex = parts.indexOf('merge_requests');
  return dashIndex >= 2 && mergeRequestIndex > dashIndex && /^\d+$/.test(parts[mergeRequestIndex + 1] ?? '');
}

function normalizePullRequestUrl(value: string) {
  const cleaned = cleanUrl(value);
  if (!cleaned) return null;
  return isGitHubPullRequestUrl(cleaned) || isGitLabMergeRequestUrl(cleaned)
    ? cleaned
    : null;
}

function isLikelyCommitSha(value: string) {
  return /^[a-f0-9]{7,64}$/i.test(value);
}

function buildEvidenceSummary(fields: BridgeEvidenceFields) {
  const lines = [
    fields.executorUsed ? `Executor used: ${fields.executorUsed}` : null,
    fields.testsRun ? `Tests run: ${fields.testsRun}` : null,
    fields.resultSummary ? `Result summary: ${fields.resultSummary}` : null,
    fields.issuesBlockers ? `Issues / blockers: ${fields.issuesBlockers}` : null,
    fields.memoryUpdateNotes ? `Memory update notes: ${fields.memoryUpdateNotes}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

export function buildSourceEvidencePayload(fields: BridgeEvidenceFields): SourceEvidencePayload {
  if (!fields.resultSummary) {
    throw new Error('Result summary is required before submitting source evidence.');
  }

  const payload: SourceEvidencePayload = {
    evidenceSummary: buildEvidenceSummary(fields),
  };

  if (fields.branch) {
    payload.branchName = fields.branch;
    payload.workBranch = fields.branch;
  }

  if (fields.commit) {
    if (isUrl(fields.commit)) {
      payload.headCommitUrl = fields.commit;
    } else if (isLikelyCommitSha(fields.commit)) {
      payload.headCommitSha = fields.commit;
    }
  }

  const pullRequestUrl = fields.prUrl ? normalizePullRequestUrl(fields.prUrl) : null;
  if (pullRequestUrl) payload.pullRequestUrl = pullRequestUrl;
  if (fields.changedPaths.length > 0) payload.changedPaths = fields.changedPaths;

  return payload;
}

export function buildCompletionEvidence(fields: BridgeEvidenceFields) {
  return [
    fields.mission ? `Mission: ${fields.mission}` : null,
    fields.executorUsed ? `Executor used: ${fields.executorUsed}` : null,
    fields.branch ? `Branch: ${fields.branch}` : null,
    fields.commit ? `Commit: ${fields.commit}` : null,
    fields.prUrl ? `PR URL: ${fields.prUrl}` : null,
    fields.changedPaths.length > 0 ? `Changed paths: ${fields.changedPaths.join(', ')}` : null,
    fields.testsRun ? `Tests run: ${fields.testsRun}` : null,
    fields.resultSummary ? `Result summary: ${fields.resultSummary}` : null,
    fields.issuesBlockers ? `Issues / blockers: ${fields.issuesBlockers}` : null,
    fields.memoryUpdateNotes ? `Memory update notes: ${fields.memoryUpdateNotes}` : null,
  ].filter(Boolean).join('\n');
}
