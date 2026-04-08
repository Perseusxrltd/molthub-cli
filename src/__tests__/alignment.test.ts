import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

const CLI_ABS_PATH = path.join(process.cwd(), 'src', 'index.ts');
const CLI_PATH = `node --loader ts-node/esm "${CLI_ABS_PATH}"`;

describe('MoltHub CLI Beta Alignment', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), `tmp-test-${Math.random().toString(36).slice(2)}`);
    fs.ensureDirSync(testDir);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testDir)) fs.removeSync(testDir);
    } catch (e) {
      // Ignore cleanup errors in tests
    }
  });

  it('local init creates canonical .molthub/project.md', () => {
    execSync(`${CLI_PATH} local init --name "Test Project"`, { cwd: testDir });
    const manifestPath = path.join(testDir, '.molthub', 'project.md');
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
    fs.writeJsonSync(path.join(testDir, 'molthub.json'), legacyData);

    execSync(`${CLI_PATH} local init`, { cwd: testDir });
    
    const manifestPath = path.join(testDir, '.molthub', 'project.md');
    const content = fs.readFileSync(manifestPath, 'utf8');
    
    expect(content).toContain('title: "Legacy Title"');
    expect(content).toContain('summary: "Legacy Summary"');
    expect(content).toContain('collaboration_open: false');
    expect(content).toContain('"legacy-skill"');
  });

  it('local validate warns on nextMission', () => {
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
nextMission: "Testing"
---
# Body`;
    fs.writeFileSync(path.join(testDir, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} local validate`, { cwd: testDir }).toString();
    expect(output).toContain('nextMission');
    expect(output).toContain('Manual-Only field');
  });

  it('local validate warns on PM keys', () => {
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
tasks: ["task1"]
---
# Body`;
    fs.writeFileSync(path.join(testDir, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} local validate`, { cwd: testDir }).toString();
    expect(output).toContain("'tasks' detected");
  });

  it('local validate rejects legacy-only JSON beta usage', () => {
    fs.writeJsonSync(path.join(testDir, 'molthub.json'), { title: "Test" });
    
    try {
      execSync(`${CLI_PATH} local validate`, { cwd: testDir, stdio: 'pipe' });
      throw new Error("Should have failed");
    } catch (e: any) {
      expect(e.stdout.toString() + e.stderr.toString()).toContain('Legacy \'molthub.json\' detected');
    }
  });

  it('json mode emits parseable JSON only for local validate', () => {
    fs.ensureDirSync(path.join(testDir, '.molthub'));
    const manifest = `---
title: "Test"
category: "Agent"
source_url: "https://github.com/test"
summary: "A valid summary"
---
# Body`;
    fs.writeFileSync(path.join(testDir, '.molthub', 'project.md'), manifest);

    const output = execSync(`${CLI_PATH} --json local validate`, { cwd: testDir }).toString().trim();
    const parsed = JSON.parse(output);

    expect(parsed.success).toBe(true);
    expect(parsed.data.title).toBe('Test');
  });

  it('project help lists only implemented project commands', () => {
    const output = execSync(`${CLI_PATH} project --help`, { cwd: testDir }).toString();

    expect(output).toContain('create');
    expect(output).toContain('list');
    expect(output).not.toContain('delete');
  });

  it('project list requires auth before it attempts an owned-artifact lookup', () => {
    try {
      execSync(`${CLI_PATH} --json project list`, {
        cwd: testDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: testDir,
          USERPROFILE: testDir,
          MOLTHUB_API_KEY: '',
        },
      });
      throw new Error('Should have failed');
    } catch (e: any) {
      const output = `${e.stdout?.toString() || ''}`.trim();
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('ERR_NO_AUTH');
    }
  });
});
