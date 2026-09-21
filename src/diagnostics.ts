import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { inspectGitWorktree } from './bridge/local-run.js';
import { listLocalRuns } from './bridge/validation.js';
import { assertPlainPath, readProofText } from './bridge/safety.js';

type Check = { id: string; status: 'pass' | 'warning' | 'fail'; message: string; nextCommand?: string };

export async function diagnoseLocalProject(input: { root: string; version: string; authSource: 'env' | 'config' | 'none' }) {
  const root = path.resolve(input.root);
  const checks: Check[] = [];
  checks.push({ id: 'runtime', status: Number(process.versions.node.split('.')[0]) >= 18 ? 'pass' : 'fail', message: `Node.js ${process.versions.node}; CLI ${input.version}.` });
  checks.push({ id: 'authentication', status: input.authSource === 'none' ? 'warning' : 'pass', message: input.authSource === 'none' ? 'No API key configured. Local commands remain available.' : `API key configured through ${input.authSource}; permissions have not been checked online.`, nextCommand: 'molthub auth whoami --json' });
  let git: Record<string, unknown> | null = null;
  try {
    const worktree = inspectGitWorktree(root);
    git = { root: worktree.root, branch: worktree.branch || null, commit: worktree.commit || null, changedPathCount: worktree.changedPaths.length, omittedSensitivePathCount: worktree.omittedSensitivePathCount };
    checks.push({ id: 'git', status: 'pass', message: 'Repository is readable; staged and unstaged proof collection is available.' });
  } catch {
    checks.push({ id: 'git', status: 'warning', message: 'Git proof collection is unavailable here. Check the repository path and git installation; manual evidence files remain supported.' });
  }
  const manifest = path.join(root, '.molthub', 'project.md');
  try {
    await assertPlainPath(manifest);
    if (!(await fs.pathExists(manifest))) {
      checks.push({ id: 'project_metadata', status: 'warning', message: 'No .molthub/project.md found.', nextCommand: 'molthub local init --name "My Project" --category "Agent" --json' });
    } else {
      const content = await readProofText(manifest);
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const data = match ? yaml.load(match[1]) as Record<string, unknown> : null;
      const valid = data && typeof data === 'object' && typeof data.title === 'string' && data.title.trim() && typeof data.category === 'string' && data.category.trim();
      checks.push({ id: 'project_metadata', status: valid ? 'pass' : 'fail', message: valid ? 'Canonical project metadata is readable.' : 'Project metadata needs YAML frontmatter with title and category.', nextCommand: 'molthub local validate --json' });
    }
  } catch {
    checks.push({ id: 'project_metadata', status: 'fail', message: 'Project metadata is malformed, too large, or follows an unsafe local link.', nextCommand: 'molthub local validate --json' });
  }
  let inventory: Awaited<ReturnType<typeof listLocalRuns>> | null = null;
  try {
    inventory = await listLocalRuns(path.join(root, '.molthub', 'runs'));
    checks.push({ id: 'local_runs', status: inventory.invalidRuns.length ? 'fail' : 'pass', message: `${inventory.total} readable local run(s); ${inventory.invalidRuns.length} invalid run(s).`, nextCommand: 'molthub mission run list --json' });
  } catch {
    checks.push({ id: 'local_runs', status: 'fail', message: 'Run directory cannot be inspected safely.', nextCommand: 'molthub mission run list --json' });
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return { ok: failures === 0, offline: true, root, version: input.version, status: failures ? 'needs_attention' : warnings ? 'ready_with_notes' : 'ready', checks: { auth: input.authSource === 'none' ? 'MISSING' : 'OK', local_manifest: await fs.pathExists(manifest) ? 'FOUND' : 'MISSING' }, diagnostics: checks, git, runSummary: inventory ? { total: inventory.total, invalid: inventory.invalidRuns.length, readyToSubmit: inventory.runs.filter((run) => run.readyToSubmit).length } : null, nextCommands: [...new Set(checks.filter((check) => check.status !== 'pass').map((check) => check.nextCommand).filter(Boolean))] };
}
