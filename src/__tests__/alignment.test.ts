import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'path';

const CLI_ABS_PATH = path.join(process.cwd(), 'src', 'index.ts');
const CLI_PATH = `node --loader ts-node/esm "${CLI_ABS_PATH}"`;
const TEST_DIR = path.join(process.cwd(), 'tmp-test-cli');

describe('MoltHub CLI Beta Alignment', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.removeSync(TEST_DIR);
    fs.ensureDirSync(TEST_DIR);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.removeSync(TEST_DIR);
  });

  it('local init creates canonical .molthub/project.md', () => {
    execSync(`${CLI_PATH} local init --name "Test Project"`, { cwd: TEST_DIR });
    const manifestPath = path.join(TEST_DIR, '.molthub', 'project.md');
    expect(fs.existsSync(manifestPath)).toBe(true);
    
    const content = fs.readFileSync(manifestPath, 'utf8');
    expect(content).toContain('title: "Test Project"');
    expect(content).toContain('collaboration_open: true');
    expect(content).not.toContain('- [ ] List core features here');
    expect(content).toContain('NOTE: Do NOT add \'nextMission\' here');
  });

  it('local init migrates legacy molthub.json', () => {
    const legacyData = {
      title: "Legacy Title",
      summary: "Legacy Summary",
      collaboration: false,
      skillsNeeded: ["legacy-skill"]
    };
    fs.writeJsonSync(path.join(TEST_DIR, 'molthub.json'), legacyData);

    execSync(`${CLI_PATH} local init`, { cwd: TEST_DIR });
    
    const manifestPath = path.join(TEST_DIR, '.molthub', 'project.md');
    const content = fs.readFileSync(manifestPath, 'utf8');
    
    expect(content).toContain('title: "Legacy Title"');
    expect(content).toContain('summary: "Legacy Summary"');
    expect(content).toContain('collaboration_open: false');
    expect(content).toContain('"legacy-skill"');
  });

  it('local validate warns on nextMission', () => {
    fs.ensureDirSync(path.join(TEST_DIR, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
nextMission: "Testing"
---
# Body`;
    fs.writeFileSync(path.join(TEST_DIR, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} local validate`, { cwd: TEST_DIR }).toString();
    expect(output).toContain('nextMission');
    expect(output).toContain('Manual-Only field');
  });

  it('local validate warns on PM keys', () => {
    fs.ensureDirSync(path.join(TEST_DIR, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
tasks: ["task1"]
---
# Body`;
    fs.writeFileSync(path.join(TEST_DIR, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} local validate`, { cwd: TEST_DIR }).toString();
    expect(output).toContain("'tasks' detected");
  });

  it('local validate rejects legacy-only JSON beta usage', () => {
    fs.writeJsonSync(path.join(TEST_DIR, 'molthub.json'), { title: "Test" });
    
    try {
      execSync(`${CLI_PATH} local validate`, { cwd: TEST_DIR, stdio: 'pipe' });
      throw new Error("Should have failed");
    } catch (e: any) {
      expect(e.stdout.toString() + e.stderr.toString()).toContain('Legacy \'molthub.json\' detected');
    }
  });
});
