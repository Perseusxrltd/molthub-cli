import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { EVIDENCE_TEMPLATE } from '../evidence.js';
import { defaultRunDirectory, writeBridgeRunPackage } from '../files.js';

describe('local bridge run package files', () => {
  it('uses the canonical local run directory', () => {
    expect(defaultRunDirectory('mission-1')).toBe(path.join('.molthub', 'runs', 'mission-1'));
  });

  it('writes packet markdown, packet JSON, evidence template, and run metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'molthub-bridge-'));
    const outputDir = path.join(root, '.molthub', 'runs', 'mission-1');

    const written = await writeBridgeRunPackage({
      artifactId: 'artifact-1',
      missionId: 'mission-1',
      outputDir,
      packetJson: {
        id: 'packet-1',
        version: 2,
        checksum: 'checksum-123',
        mission: { title: 'Bridge Mission' },
      },
      packetMarkdown: '# Bridge Mission\n\nRun this manually.',
    });

    expect(await fs.pathExists(written.packetMarkdownPath)).toBe(true);
    expect(await fs.pathExists(written.packetJsonPath)).toBe(true);
    expect(await fs.pathExists(written.evidenceTemplatePath)).toBe(true);
    expect(await fs.pathExists(written.runMetadataPath)).toBe(true);
    expect(await fs.readFile(written.packetMarkdownPath, 'utf8')).toContain('Run this manually.');
    expect(await fs.readFile(written.evidenceTemplatePath, 'utf8')).toBe(EVIDENCE_TEMPLATE);

    const metadata = await fs.readJson(written.runMetadataPath);
    expect(metadata).toMatchObject({
      version: 'local_executor_bridge_v0',
      artifactId: 'artifact-1',
      missionId: 'mission-1',
      status: 'prepared',
      noExecution: true,
      packetChecksum: 'checksum-123',
      packetVersion: 2,
    });
  });
});
