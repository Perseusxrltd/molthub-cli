import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { planActivationFileWrites, type ActivationFile } from '../activation-pack.js';

const tempRoots: string[] = [];

async function makeTempRepo() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'molthub-activation-'));
  tempRoots.push(repo);
  return repo;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fs.remove(root);
  }
});

describe('activation file planning safety', () => {
  it('rejects activation paths that escape the repository root', async () => {
    const repo = await makeTempRepo();
    const files: ActivationFile[] = [{
      target: 'agents',
      path: path.join('..', 'AGENTS.md'),
      content: '<!-- MOLTHUB:START -->\ncontent\n<!-- MOLTHUB:END -->\n',
    }];

    await expect(planActivationFileWrites(repo, files, { write: true, force: false }))
      .rejects.toThrow(/escapes repository root/);
  });

  it('rejects symlinked activation targets before writing', async () => {
    const repo = await makeTempRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'molthub-outside-'));
    tempRoots.push(outside);
    try {
      await fs.ensureSymlink(outside, path.join(repo, '.cursor'), 'dir');
    } catch (error: any) {
      if (error?.code === 'EPERM') return;
      throw error;
    }

    const files: ActivationFile[] = [{
      target: 'cursor',
      path: path.join('.cursor', 'rules', 'molthub.mdc'),
      content: '<!-- MOLTHUB:START -->\ncontent\n<!-- MOLTHUB:END -->\n',
    }];

    await expect(planActivationFileWrites(repo, files, { write: true, force: true }))
      .rejects.toThrow(/symlink/);
  });
});
