export type PacketFormat = 'json' | 'markdown';

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
  artifactId: string;
  missionId: string;
  preparedAt: string;
  status: 'prepared';
  noExecution: true;
  packetChecksum: string | null;
  packetVersion: string | number | null;
  packetSource: string | null;
};

export type BridgeRunPackageInput = {
  artifactId: string;
  missionId: string;
  outputDir: string;
  packetJson: unknown;
  packetMarkdown: string;
};

export type BridgeRunPackageFiles = {
  outputDir: string;
  packetMarkdownPath: string;
  packetJsonPath: string;
  evidenceTemplatePath: string;
  runMetadataPath: string;
};

export type BridgeHttpClient = {
  get(url: string, options: { headers: Record<string, string> }): Promise<{ data: unknown; headers?: Record<string, unknown> }>;
  put(url: string, body: unknown, options: { headers: Record<string, string> }): Promise<{ data: unknown }>;
  post(url: string, body: unknown, options: { headers: Record<string, string> }): Promise<{ data: unknown }>;
};
