import fs from 'fs-extra';
import path from 'path';

import { EVIDENCE_TEMPLATE } from './evidence.js';
import type { BridgeRunMetadata, BridgeRunPackageFiles, BridgeRunPackageInput } from './types.js';

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

export async function writeBridgeRunPackage(input: BridgeRunPackageInput): Promise<BridgeRunPackageFiles> {
  const outputDir = path.resolve(input.outputDir);
  await fs.ensureDir(outputDir);

  const packetMarkdownPath = path.join(outputDir, 'packet.md');
  const packetJsonPath = path.join(outputDir, 'packet.json');
  const evidenceTemplatePath = path.join(outputDir, 'evidence.md');
  const runMetadataPath = path.join(outputDir, 'run.json');
  const meta = packetMeta(input.packetJson);
  const metadata: BridgeRunMetadata = {
    version: 'local_executor_bridge_v0',
    artifactId: input.artifactId,
    missionId: input.missionId,
    preparedAt: new Date().toISOString(),
    status: 'prepared',
    noExecution: true,
    packetChecksum: meta.checksum === null ? null : String(meta.checksum),
    packetVersion: meta.version,
    packetSource: meta.source === null ? null : String(meta.source),
  };

  await fs.writeFile(packetMarkdownPath, input.packetMarkdown, 'utf8');
  await fs.writeJson(packetJsonPath, input.packetJson, { spaces: 2 });
  await fs.writeFile(evidenceTemplatePath, EVIDENCE_TEMPLATE, 'utf8');
  await fs.writeJson(runMetadataPath, metadata, { spaces: 2 });

  return {
    outputDir,
    packetMarkdownPath,
    packetJsonPath,
    evidenceTemplatePath,
    runMetadataPath,
  };
}
