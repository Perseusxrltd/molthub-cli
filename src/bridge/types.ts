export type PacketFormat = 'json' | 'markdown';

export type BridgeExecutorId =
  | 'manual'
  | 'codex-cli'
  | 'hermes'
  | 'openclaw'
  | 'claude-code'
  | 'gemini-cli';

export type BridgeRunStatus =
  | 'prepared'
  | 'running'
  | 'blocked'
  | 'evidence_ready'
  | 'submitted'
  | 'completion_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BridgeEvidenceFields = {
  mission: string;
  packetChecksum: string;
  executorUsed: string;
  branch: string;
  commit: string;
  prUrl: string;
  changedPaths: string[];
  testsRun: string;
  resultSummary: string;
  issuesBlockers: string;
  memoryUpdateNotes: string;
};

export type SourceEvidencePayload = {
  branchName?: string;
  workBranch?: string;
  headCommitSha?: string;
  headCommitUrl?: string;
  pullRequestUrl?: string;
  changedPaths?: string[];
  evidenceSummary: string;
};

export type BridgeRunMetadata = {
  version: 'local_executor_bridge_v0';
  runnerVersion: string;
  projectId: string;
  artifactId: string;
  missionId: string;
  createdAt: string;
  preparedAt: string;
  status: BridgeRunStatus;
  noExecution: true;
  noCloudExecution: true;
  packetChecksum: string | null;
  packetVersion: string | number | null;
  packetSource: string | null;
  worktreePath: string | null;
  executorId: BridgeExecutorId;
  orchestratorId: string | null;
  adapterPath: string;
  statusPath: string;
  redactionSummary: {
    checkedFiles: string[];
    secretLikeFindings: Array<{ file: string; pattern: string }>;
    redactedOutputs: string[];
    omittedSensitivePathCount: number;
  };
};

export type BridgeAdapterMetadata = {
  version: 'executor_adapter_contract_v1';
  executorId: BridgeExecutorId;
  orchestratorId: string | null;
  planMode: 'on' | 'off' | null;
  commandTemplate: string | null;
  requiredInputs: string[];
  expectedOutputs: string[];
  proofCapture: string[];
  safeStop: string;
  unsupported: string[];
  executionDefault: 'manual' | 'template_only';
  noCloudExecution: true;
  noDirectProjectMemoryMutation: true;
};

export type BridgeStatusMetadata = {
  version: 'local_run_status_v1';
  projectId: string;
  artifactId: string;
  missionId: string;
  status: BridgeRunStatus;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  blockedReason: string | null;
  noCloudExecution: true;
  noSecretsLogged: true;
};

export type BridgeRunPackageInput = {
  artifactId: string;
  missionId: string;
  outputDir: string;
  packetJson: unknown;
  packetMarkdown: string;
  runnerVersion: string;
  executorId?: BridgeExecutorId;
  orchestratorId?: string | null;
  worktreePath?: string | null;
  planMode?: 'on' | 'off' | null;
};

export type BridgeRunPackageFiles = {
  outputDir: string;
  packetMarkdownPath: string;
  packetJsonPath: string;
  evidenceTemplatePath: string;
  runMetadataPath: string;
  adapterPath: string;
  statusPath: string;
  executorLogPath: string;
  commandsLogPath: string;
  diffSummaryPath: string;
};

export type BridgeHttpClient = {
  get(url: string, options: { headers: Record<string, string> }): Promise<{ data: unknown; headers?: Record<string, unknown> }>;
  put(url: string, body: unknown, options: { headers: Record<string, string> }): Promise<{ data: unknown }>;
  post(url: string, body: unknown, options: { headers: Record<string, string> }): Promise<{ data: unknown }>;
};
