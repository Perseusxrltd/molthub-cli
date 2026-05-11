import fs from 'fs-extra';
import path from 'path';

import { EVIDENCE_TEMPLATE } from './evidence.js';
import type {
  BridgeAdapterMetadata,
  BridgeExecutorId,
  BridgeRunMetadata,
  BridgeRunPackageFiles,
  BridgeRunPackageInput,
  BridgeRunStatus,
  BridgeStatusMetadata,
} from './types.js';

export function defaultRunDirectory(missionId: string) {
  return path.join('.molthub', 'runs', missionId);
}

function packetRecord(packetJson: unknown): Record<string, unknown> {
  if (packetJson && typeof packetJson === 'object' && !Array.isArray(packetJson)) {
    return packetJson as Record<string, unknown>;
  }
  return {};
}

function packetMeta(packetJson: unknown) {
  const root = packetRecord(packetJson);
  const nestedPacket = packetRecord(root.packet);
  const meta = packetRecord(root.meta);
  return {
    checksum: cleanString(root.packetHash) ?? cleanString(root.checksum) ?? cleanString(meta.packetHash) ?? cleanString(nestedPacket.checksum) ?? cleanString(nestedPacket.packetHash),
    version: cleanString(root.packetVersion) ?? cleanString(root.version) ?? cleanString(meta.packetVersion) ?? cleanString(nestedPacket.version) ?? cleanString(nestedPacket.packetVersion),
    source: cleanString(root.packetSource) ?? cleanString(meta.packetSource) ?? cleanString(nestedPacket.source) ?? cleanString(nestedPacket.packetSource),
  };
}

function cleanString(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return value;
  return null;
}

function normalizeExecutorId(value: BridgeExecutorId | undefined): BridgeExecutorId {
  return value ?? 'manual';
}

export function buildAdapterMetadata(input: {
  executorId?: BridgeExecutorId;
  orchestratorId?: string | null;
  planMode?: 'on' | 'off' | null;
}): BridgeAdapterMetadata {
  const executorId = normalizeExecutorId(input.executorId);
  const orchestratorId = input.orchestratorId?.trim() || null;
  const planMode = executorId === 'codex-cli' ? input.planMode ?? 'on' : input.planMode ?? null;
  const commonUnsupported = [
    'No automatic cloud execution by MoltHub.',
    'No hidden dispatch.',
    'No repository mutation beyond the owner-controlled local process.',
    'No direct Project Memory mutation.',
    'No secret capture or printing.',
  ];

  const templates: Record<BridgeExecutorId, Pick<BridgeAdapterMetadata, 'commandTemplate' | 'requiredInputs' | 'expectedOutputs' | 'proofCapture' | 'safeStop' | 'unsupported' | 'executionDefault'>> = {
    manual: {
      commandTemplate: null,
      requiredInputs: ['packet.md', 'packet.json', 'evidence.md'],
      expectedOutputs: ['owner-filled evidence.md'],
      proofCapture: ['evidence.md', 'changed files entered by owner', 'test summary entered by owner'],
      safeStop: 'Mark status.json as blocked, failed, cancelled, or evidence_ready manually.',
      unsupported: ['Automated executor logs are not created by the manual adapter.', ...commonUnsupported],
      executionDefault: 'manual',
    },
    'codex-cli': {
      commandTemplate: 'codex < packet.md',
      requiredInputs: ['packet.md', 'packet.json', 'adapter.json', 'Plan mode must be explicit in the prompt'],
      expectedOutputs: ['executor.log transcript', 'commands.log', 'diff-summary.txt or diff.patch', 'evidence.md'],
      proofCapture: ['Codex transcript', 'git status/diff summary', 'test output summary', 'final report'],
      safeStop: 'Interrupt or terminate the local Codex process, then set status.json to failed or blocked.',
      unsupported: ['The adapter template does not launch Codex in Wave 1.', ...commonUnsupported],
      executionDefault: 'template_only',
    },
    hermes: {
      commandTemplate: 'hermes --packet packet.md --worktree <worktree>',
      requiredInputs: ['packet.md', 'packet.json', 'adapter.json', 'configured Hermes command'],
      expectedOutputs: ['executor.log', 'commands.log', 'diff-summary.txt or diff.patch', 'evidence.md'],
      proofCapture: ['Hermes logs', 'changed files', 'test output summary'],
      safeStop: 'Terminate the local Hermes process group and set status.json to failed or blocked.',
      unsupported: ['Hermes command shape is setup-gated and not executed by the CLI in Wave 1.', ...commonUnsupported],
      executionDefault: 'template_only',
    },
    openclaw: {
      commandTemplate: 'openclaw --packet packet.md --repo <worktree>',
      requiredInputs: ['packet.md', 'packet.json', 'adapter.json', 'configured OpenClaw command'],
      expectedOutputs: ['executor.log', 'commands.log', 'diff-summary.txt or diff.patch', 'evidence.md'],
      proofCapture: ['OpenClaw logs', 'changed files', 'test output summary'],
      safeStop: 'Terminate the local OpenClaw process group and set status.json to failed or blocked.',
      unsupported: ['OpenClaw command shape is setup-gated and not executed by the CLI in Wave 1.', ...commonUnsupported],
      executionDefault: 'template_only',
    },
    'claude-code': {
      commandTemplate: 'claude < packet.md',
      requiredInputs: ['packet.md', 'packet.json', 'adapter.json', 'allowed local paths'],
      expectedOutputs: ['executor.log transcript', 'commands.log', 'diff-summary.txt or diff.patch', 'evidence.md'],
      proofCapture: ['Claude transcript', 'changed files', 'test output summary'],
      safeStop: 'Interrupt or terminate the local Claude process, then set status.json to failed or blocked.',
      unsupported: ['No auto-PR or owner-review bypass.', ...commonUnsupported],
      executionDefault: 'template_only',
    },
    'gemini-cli': {
      commandTemplate: 'gemini < packet.md',
      requiredInputs: ['packet.md', 'packet.json', 'adapter.json', 'worktree path'],
      expectedOutputs: ['executor.log transcript', 'commands.log', 'diff-summary.txt or diff.patch', 'evidence.md'],
      proofCapture: ['Gemini transcript', 'changed files', 'test output summary'],
      safeStop: 'Interrupt or terminate the local Gemini process, then set status.json to failed or blocked.',
      unsupported: ['No durable memory assumption or Project Memory write.', ...commonUnsupported],
      executionDefault: 'template_only',
    },
  };

  const template = templates[executorId];
  return {
    version: 'executor_adapter_contract_v1',
    executorId,
    orchestratorId,
    planMode,
    commandTemplate: template.commandTemplate,
    requiredInputs: template.requiredInputs,
    expectedOutputs: template.expectedOutputs,
    proofCapture: template.proofCapture,
    safeStop: template.safeStop,
    unsupported: template.unsupported,
    executionDefault: template.executionDefault,
    noCloudExecution: true,
    noDirectProjectMemoryMutation: true,
  };
}

function buildStatusMetadata(input: {
  artifactId: string;
  missionId: string;
  createdAt: string;
  status?: BridgeRunStatus;
}): BridgeStatusMetadata {
  return {
    version: 'local_run_status_v1',
    projectId: input.artifactId,
    artifactId: input.artifactId,
    missionId: input.missionId,
    status: input.status ?? 'prepared',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastHeartbeatAt: null,
    blockedReason: null,
    noCloudExecution: true,
    noSecretsLogged: true,
  };
}

export async function writeBridgeRunPackage(input: BridgeRunPackageInput): Promise<BridgeRunPackageFiles> {
  const outputDir = path.resolve(input.outputDir);
  await fs.ensureDir(outputDir);

  const packetMarkdownPath = path.join(outputDir, 'packet.md');
  const packetJsonPath = path.join(outputDir, 'packet.json');
  const evidenceTemplatePath = path.join(outputDir, 'evidence.md');
  const runMetadataPath = path.join(outputDir, 'run.json');
  const adapterPath = path.join(outputDir, 'adapter.json');
  const statusPath = path.join(outputDir, 'status.json');
  const executorLogPath = path.join(outputDir, 'executor.log');
  const commandsLogPath = path.join(outputDir, 'commands.log');
  const diffSummaryPath = path.join(outputDir, 'diff-summary.txt');
  const meta = packetMeta(input.packetJson);
  const preparedAt = new Date().toISOString();
  const adapter = buildAdapterMetadata({
    executorId: input.executorId,
    orchestratorId: input.orchestratorId,
    planMode: input.planMode,
  });
  const status = buildStatusMetadata({
    artifactId: input.artifactId,
    missionId: input.missionId,
    createdAt: preparedAt,
  });
  const metadata: BridgeRunMetadata = {
    version: 'local_executor_bridge_v0',
    runnerVersion: input.runnerVersion,
    projectId: input.artifactId,
    artifactId: input.artifactId,
    missionId: input.missionId,
    createdAt: preparedAt,
    preparedAt,
    status: 'prepared',
    noExecution: true,
    noCloudExecution: true,
    packetChecksum: meta.checksum === null ? null : String(meta.checksum),
    packetVersion: meta.version,
    packetSource: meta.source === null ? null : String(meta.source),
    worktreePath: input.worktreePath?.trim() || null,
    executorId: adapter.executorId,
    orchestratorId: adapter.orchestratorId,
    adapterPath: path.relative(outputDir, adapterPath),
    statusPath: path.relative(outputDir, statusPath),
    redactionSummary: {
      checkedFiles: [],
      secretLikeFindings: [],
      redactedOutputs: [],
      omittedSensitivePathCount: 0,
    },
  };

  await fs.writeFile(packetMarkdownPath, input.packetMarkdown, 'utf8');
  await fs.writeJson(packetJsonPath, input.packetJson, { spaces: 2 });
  await fs.writeFile(evidenceTemplatePath, EVIDENCE_TEMPLATE, 'utf8');
  await fs.writeJson(runMetadataPath, metadata, { spaces: 2 });
  await fs.writeJson(adapterPath, adapter, { spaces: 2 });
  await fs.writeJson(statusPath, status, { spaces: 2 });
  await fs.writeFile(executorLogPath, 'No executor has been launched by MoltHub CLI.\n', 'utf8');
  await fs.writeFile(commandsLogPath, 'No commands have been launched by MoltHub CLI.\n', 'utf8');
  await fs.writeFile(diffSummaryPath, 'No diff collected yet. Run molthub mission evidence collect --run <path> after local work.\n', 'utf8');

  return {
    outputDir,
    packetMarkdownPath,
    packetJsonPath,
    evidenceTemplatePath,
    runMetadataPath,
    adapterPath,
    statusPath,
    executorLogPath,
    commandsLogPath,
    diffSummaryPath,
  };
}
