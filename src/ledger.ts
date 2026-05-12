import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';

import { secretLikeFindingsInText } from './bridge/local-run.js';

export const LEDGER_PATH = '.molthub/ledger/events.jsonl';
export const PROMPT_INDEX_PATH = '.molthub/prompts/prompt-index.yml';

export const REQUIRED_LEDGER_PROJECTION_FILES = [
  LEDGER_PATH,
  PROMPT_INDEX_PATH,
  '.molthub/source-material/index.yml',
  '.molthub/plans/plan-index.yml',
  '.molthub/memory/accepted.yml',
] as const;

export const LEDGER_EVENT_TYPES = [
  'project.created',
  'project.synced',
  'project.production_pack_initialized',
  'source_material.added',
  'plan.updated',
  'memory.suggestion_created',
  'memory.accepted',
  'mission.created',
  'mission.checked',
  'mission.brief_generated',
  'mission.claim_created',
  'mission.claim_accepted',
  'mission.run_prepared',
  'mission.run_status_updated',
  'mission.evidence_collected',
  'mission.evidence_submitted',
  'mission.completion_requested',
  'mission.completed',
  'review.created',
  'review.accepted',
  'review.rejected',
  'production_pack.exported',
  'prompt.generated',
  'prompt.used',
  'warning.created',
  'warning.closed',
  'system.updated',
] as const;

export const LEDGER_SOURCES = ['web', 'cli', 'local-agent', 'owner-ui', 'api'] as const;

const REQUIRED_EVENT_FIELDS = [
  'version',
  'eventId',
  'timestamp',
  'repo',
  'actor',
  'eventType',
  'source',
  'sourceVersion',
  'related',
  'inputs',
  'outputs',
  'proofRefs',
  'reviewBoundary',
  'privacyClassification',
  'redactionStatus',
] as const;

const REQUIRED_PROMPT_FIELDS = [
  'missionId',
  'generatedAt',
  'generator',
  'generatorVersion',
  'executorTarget',
  'reviewBoundary',
  'privacyClassification',
  'forbiddenActions',
  'proofRequirements',
] as const;

type Finding = {
  code: string;
  message: string;
  file?: string;
  line?: number;
};

type LedgerValidationOptions = {
  required?: boolean;
};

type LedgerAppendOptions = {
  eventType: string;
  actorLabel: string;
  actorType?: string;
  actorId?: string | null;
  projectId?: string | null;
  artifactId?: string | null;
  missionId?: string | null;
  runId?: string | null;
  reviewId?: string | null;
  memoryId?: string | null;
  source?: string;
  sourceVersion: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  proofRefs?: string[];
  reviewBoundary?: string;
  privacyClassification?: string;
};

const EXTRA_SECRET_PATTERNS = [
  { name: 'database_url', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'generic_secret_assignment', pattern: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{20,}/gi },
];

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function addFinding(findings: Finding[], code: string, message: string, file?: string, line?: number) {
  findings.push({ code, message, file, line });
}

function gitValue(root: string, args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function sanitizeRemoteUrl(value: string | null) {
  if (!value) return null;
  return value
    .replace(/(https?:\/\/)([^/@:]+):([^/@]+)@/i, '$1[redacted]@')
    .replace(/(https?:\/\/)([^/@]+)@/i, '$1[redacted]@');
}

function repoIdentity(root: string) {
  return {
    name: path.basename(root),
    remote: sanitizeRemoteUrl(gitValue(root, ['config', '--get', 'remote.origin.url'])),
    branch: gitValue(root, ['branch', '--show-current']),
    head: gitValue(root, ['rev-parse', '--short=12', 'HEAD']),
  };
}

function parseJsonOption(value: string | undefined, label: string) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must parse to a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(`${label} must be valid JSON: ${error?.message || 'parse failed'}`);
  }
}

export function parseLedgerJsonOption(value: string | undefined, label: string) {
  return parseJsonOption(value, label);
}

export function findProductionRecordSecrets(file: string, content: string) {
  const findings = [...secretLikeFindingsInText(file, content)];
  for (const entry of EXTRA_SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(content)) {
      findings.push({ file, pattern: entry.name });
    }
  }
  return findings;
}

function validateForbiddenRepoNames(root: string, errors: Finding[]) {
  if (fs.existsSync(path.join(root, '.mothub'))) {
    addFinding(errors, 'ERR_FORBIDDEN_MOTHUB_DIR', 'Forbidden .mothub/ directory exists.');
  }
  if (fs.existsSync(path.join(root, 'molthub.yaml'))) {
    addFinding(errors, 'ERR_FORBIDDEN_MOLTHUB_YAML', 'Forbidden molthub.yaml file exists; .molthub/project.md is canonical.');
  }
}

function isPathInsideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function lstatIfExists(absolutePath: string) {
  try {
    return await fs.lstat(absolutePath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertLedgerAppendPathSafe(root: string, errors: Finding[]) {
  const resolvedRoot = path.resolve(root);
  const ledgerPath = path.resolve(resolvedRoot, LEDGER_PATH);

  if (!isPathInsideRoot(resolvedRoot, ledgerPath)) {
    addFinding(errors, 'ERR_LEDGER_PATH_UNSAFE', `Ledger path escapes repository root: ${LEDGER_PATH}`, LEDGER_PATH);
    return null;
  }

  const relativeParts = path.relative(resolvedRoot, ledgerPath).split(path.sep).filter(Boolean);
  let cursor = resolvedRoot;
  for (let index = 0; index < relativeParts.length; index += 1) {
    cursor = path.join(cursor, relativeParts[index]);
    const stat = await lstatIfExists(cursor);
    if (!stat) continue;

    const relative = path.relative(resolvedRoot, cursor).replace(/\\/g, '/');
    if (stat.isSymbolicLink()) {
      addFinding(errors, 'ERR_LEDGER_PATH_UNSAFE', `Ledger path contains a symlink: ${relative}`, relative);
      return null;
    }

    const isFinal = index === relativeParts.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      addFinding(errors, 'ERR_LEDGER_PATH_UNSAFE', `Ledger path component is not a directory: ${relative}`, relative);
      return null;
    }
    if (isFinal && !stat.isFile()) {
      addFinding(errors, 'ERR_LEDGER_PATH_UNSAFE', `Ledger path is not a regular file: ${relative}`, relative);
      return null;
    }
  }

  return ledgerPath;
}

function validateLedgerEventObject(event: unknown, errors: Finding[], file: string, line?: number) {
  const record = asObject(event);
  if (Object.keys(record).length === 0) {
    addFinding(errors, 'ERR_INVALID_LEDGER_EVENT', 'Ledger event must be a JSON object.', file, line);
    return;
  }

  for (const field of REQUIRED_EVENT_FIELDS) {
    if (!(field in record)) {
      addFinding(errors, 'ERR_LEDGER_EVENT_MISSING_FIELD', `Ledger event missing required field: ${field}.`, file, line);
    }
  }

  if (!nonEmptyString(record.version)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger event version must be a non-empty string.', file, line);
  if (!nonEmptyString(record.eventId)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger event eventId must be a non-empty string.', file, line);
  if (!nonEmptyString(record.timestamp) || Number.isNaN(Date.parse(String(record.timestamp)))) {
    addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger event timestamp must be an ISO-like date string.', file, line);
  }
  if (!LEDGER_EVENT_TYPES.includes(record.eventType as any)) {
    addFinding(errors, 'ERR_LEDGER_EVENT_TYPE', `Unsupported ledger eventType: ${String(record.eventType || '')}.`, file, line);
  }
  if (!LEDGER_SOURCES.includes(record.source as any)) {
    addFinding(errors, 'ERR_LEDGER_EVENT_SOURCE', `Unsupported ledger source: ${String(record.source || '')}.`, file, line);
  }
  if (!nonEmptyString(record.sourceVersion)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger event sourceVersion must be a non-empty string.', file, line);

  const actor = asObject(record.actor);
  if (!nonEmptyString(actor.type)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_ACTOR', 'Ledger actor.type is required.', file, line);
  if (!nonEmptyString(actor.label)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_ACTOR', 'Ledger actor.label is required.', file, line);

  if (Object.keys(asObject(record.repo)).length === 0) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger repo identity must be an object.', file, line);
  if (Object.keys(asObject(record.related)).length === 0 && record.related === null) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger related must be an object.', file, line);
  if (Object.keys(asObject(record.inputs)).length === 0 && record.inputs === null) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger inputs must be an object.', file, line);
  if (Object.keys(asObject(record.outputs)).length === 0 && record.outputs === null) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger outputs must be an object.', file, line);
  if (!Array.isArray(record.proofRefs)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger proofRefs must be an array.', file, line);
  if (!nonEmptyString(record.reviewBoundary)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger reviewBoundary must be a non-empty string.', file, line);
  if (!nonEmptyString(record.privacyClassification)) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger privacyClassification must be a non-empty string.', file, line);
  if (Object.keys(asObject(record.redactionStatus)).length === 0) addFinding(errors, 'ERR_LEDGER_EVENT_BAD_FIELD', 'Ledger redactionStatus must be an object.', file, line);

  const serialized = JSON.stringify(record);
  const secretFindings = findProductionRecordSecrets(file, serialized);
  for (const finding of secretFindings) {
    addFinding(errors, 'ERR_SECRET_IN_LEDGER_EVENT', `Ledger event contains secret-like content (${finding.pattern}).`, file, line);
  }
}

export async function appendLedgerEvent(root: string, options: LedgerAppendOptions) {
  const errors: Finding[] = [];
  validateForbiddenRepoNames(root, errors);
  if (errors.length > 0) {
    return { ok: false, written: null, event: null, errors };
  }

  const event = {
    version: 'ledger_event_v1',
    eventId: `evt_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    projectId: options.projectId ?? options.artifactId ?? null,
    artifactId: options.artifactId ?? options.projectId ?? null,
    repo: repoIdentity(root),
    actor: {
      type: options.actorType?.trim() || 'cli-user',
      id: options.actorId?.trim() || null,
      label: options.actorLabel.trim(),
    },
    eventType: options.eventType,
    source: options.source || 'cli',
    sourceVersion: options.sourceVersion,
    related: {
      missionIds: options.missionId ? [options.missionId] : [],
      runIds: options.runId ? [options.runId] : [],
      reviewIds: options.reviewId ? [options.reviewId] : [],
      memoryIds: options.memoryId ? [options.memoryId] : [],
    },
    inputs: options.inputs ?? {},
    outputs: options.outputs ?? {},
    proofRefs: options.proofRefs ?? [],
    reviewBoundary: options.reviewBoundary || 'owner_review_required',
    privacyClassification: options.privacyClassification || 'internal',
    redactionStatus: {
      status: 'checked',
      redacted: false,
      secretLikeFindings: [],
    },
    supersedes: [],
    relatedEvents: [],
  };
  const checksumPayload = JSON.stringify(event);
  const eventWithChecksum = {
    ...event,
    checksum: `sha256:${createHash('sha256').update(checksumPayload).digest('hex')}`,
  };

  validateLedgerEventObject(eventWithChecksum, errors, LEDGER_PATH);
  if (errors.length > 0) {
    return { ok: false, written: null, event: null, errors };
  }

  const ledgerPath = await assertLedgerAppendPathSafe(root, errors);
  if (!ledgerPath || errors.length > 0) {
    return { ok: false, written: null, event: null, errors };
  }

  await fs.ensureDir(path.dirname(ledgerPath));
  await assertLedgerAppendPathSafe(root, errors);
  if (errors.length > 0) {
    return { ok: false, written: null, event: null, errors };
  }

  await fs.appendFile(ledgerPath, `${JSON.stringify(eventWithChecksum)}\n`, 'utf8');
  return { ok: true, written: LEDGER_PATH, event: eventWithChecksum, errors: [] };
}

export async function validateLedgerFile(root: string, options: LedgerValidationOptions = {}) {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  validateForbiddenRepoNames(root, errors);
  const ledgerPath = path.join(root, LEDGER_PATH);
  const checkedFiles: string[] = [LEDGER_PATH];

  if (!(await fs.pathExists(ledgerPath))) {
    if (options.required) {
      addFinding(errors, 'ERR_MISSING_LEDGER_FILE', `Missing ledger file: ${LEDGER_PATH}`, LEDGER_PATH);
    }
    return { ok: errors.length === 0, checkedFiles, eventCount: 0, errors, warnings };
  }

  const content = await fs.readFile(ledgerPath, 'utf8');
  const lines = content.split(/\r?\n/);
  let eventCount = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    eventCount += 1;
    try {
      validateLedgerEventObject(JSON.parse(line), errors, LEDGER_PATH, index + 1);
    } catch (error: any) {
      addFinding(errors, 'ERR_LEDGER_JSONL_PARSE', error?.message || 'Invalid ledger JSONL line.', LEDGER_PATH, index + 1);
    }
  });

  return { ok: errors.length === 0, checkedFiles, eventCount, errors, warnings };
}

export async function validatePromptIndex(root: string, options: { required?: boolean } = {}) {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const checkedFiles: string[] = [PROMPT_INDEX_PATH];
  const promptPath = path.join(root, PROMPT_INDEX_PATH);

  if (!(await fs.pathExists(promptPath))) {
    if (options.required) {
      addFinding(errors, 'ERR_MISSING_PROMPT_INDEX', `Missing prompt index file: ${PROMPT_INDEX_PATH}`, PROMPT_INDEX_PATH);
    }
    return { ok: errors.length === 0, checkedFiles, promptCount: 0, errors, warnings };
  }

  const content = await fs.readFile(promptPath, 'utf8');
  for (const finding of findProductionRecordSecrets(PROMPT_INDEX_PATH, content)) {
    addFinding(errors, 'ERR_SECRET_IN_PROMPT_INDEX', `Prompt index contains secret-like content (${finding.pattern}).`, PROMPT_INDEX_PATH);
  }

  try {
    const parsed = yaml.load(content);
    const rootRecord = asObject(parsed);
    if (Object.keys(rootRecord).length === 0) {
      addFinding(errors, 'ERR_EMPTY_PROMPT_INDEX', `${PROMPT_INDEX_PATH} must contain a YAML object.`, PROMPT_INDEX_PATH);
      return { ok: false, checkedFiles, promptCount: 0, errors, warnings };
    }

    const prompts = rootRecord.prompts;
    if (prompts === undefined || (Array.isArray(prompts) && prompts.length === 0)) {
      return { ok: errors.length === 0, checkedFiles, promptCount: 0, errors, warnings };
    }
    if (!Array.isArray(prompts)) {
      addFinding(errors, 'ERR_PROMPT_INDEX_SHAPE', 'prompt-index.yml `prompts` must be an array when present.', PROMPT_INDEX_PATH);
      return { ok: false, checkedFiles, promptCount: 0, errors, warnings };
    }

    prompts.forEach((prompt, index) => {
      const record = asObject(prompt);
      if (Object.keys(record).length === 0) {
        addFinding(errors, 'ERR_PROMPT_RECORD_SHAPE', 'Prompt record must be a YAML object.', PROMPT_INDEX_PATH, index + 1);
        return;
      }
      for (const field of REQUIRED_PROMPT_FIELDS) {
        if (!(field in record)) {
          addFinding(errors, 'ERR_PROMPT_RECORD_MISSING_FIELD', `Prompt record missing required field: ${field}.`, PROMPT_INDEX_PATH, index + 1);
        }
      }
      if (!Array.isArray(record.forbiddenActions)) {
        addFinding(errors, 'ERR_PROMPT_RECORD_BAD_FIELD', 'Prompt record forbiddenActions must be an array.', PROMPT_INDEX_PATH, index + 1);
      }
      if (!Array.isArray(record.proofRequirements)) {
        addFinding(errors, 'ERR_PROMPT_RECORD_BAD_FIELD', 'Prompt record proofRequirements must be an array.', PROMPT_INDEX_PATH, index + 1);
      }
    });

    return { ok: errors.length === 0, checkedFiles, promptCount: prompts.length, errors, warnings };
  } catch (error: any) {
    addFinding(errors, 'ERR_INVALID_PROMPT_INDEX_YAML', error?.message || 'Invalid prompt-index YAML.', PROMPT_INDEX_PATH);
    return { ok: false, checkedFiles, promptCount: 0, errors, warnings };
  }
}

export async function projectLedgerStatus(root: string) {
  const ledger = await validateLedgerFile(root);
  const promptIndex = await validatePromptIndex(root);
  const projections = await Promise.all(REQUIRED_LEDGER_PROJECTION_FILES.map(async (rel) => ({
    path: rel,
    exists: await fs.pathExists(path.join(root, rel)),
  })));
  return {
    ok: ledger.ok && promptIndex.ok,
    ledgerPath: LEDGER_PATH,
    eventCount: ledger.eventCount,
    promptIndexPath: PROMPT_INDEX_PATH,
    promptCount: promptIndex.promptCount,
    projections,
    errors: [...ledger.errors, ...promptIndex.errors],
    warnings: [...ledger.warnings, ...promptIndex.warnings],
  };
}
