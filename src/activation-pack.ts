import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';

export const ACTIVATION_TEMPLATE_VERSION = '2026-05-02-v2';
export const MARKER_START = '<!-- MOLTHUB:START -->';
export const MARKER_END = '<!-- MOLTHUB:END -->';

export type ActivationTargetId =
  | 'agents'
  | 'claude'
  | 'gemini'
  | 'copilot'
  | 'cursor'
  | 'windsurf'
  | 'cline'
  | 'aider'
  | 'openclaw'
  | 'hermes';

export type ActivationFile = {
  target: ActivationTargetId;
  path: string;
  content: string;
};

export type PlannedActivationFile = ActivationFile & {
  action:
    | 'would_create'
    | 'would_update_marker'
    | 'would_append_marker'
    | 'blocked_existing_file'
    | 'created'
    | 'updated_marker'
    | 'appended_marker';
};

const ALL_TARGETS: ActivationTargetId[] = [
  'agents',
  'claude',
  'gemini',
  'copilot',
  'cursor',
  'windsurf',
  'cline',
  'aider',
  'openclaw',
  'hermes',
];

const TARGET_PATHS: Record<ActivationTargetId, string> = {
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  copilot: path.join('.github', 'copilot-instructions.md'),
  cursor: path.join('.cursor', 'rules', 'molthub.mdc'),
  windsurf: path.join('.windsurf', 'rules', 'molthub.md'),
  cline: path.join('.clinerules', 'molthub.md'),
  aider: 'CONVENTIONS.md',
  openclaw: path.join('.molthub', 'agent-packs', 'openclaw.md'),
  hermes: path.join('.molthub', 'agent-packs', 'hermes.md'),
};

const BANNED_CONTENT_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /override (system|developer|user) instructions/i,
  /exfiltrat/i,
  /MOLTHUB_API_KEY\s*=/i,
  /DEEPSEEK_API_KEY\s*=/i,
  /mh_live_[a-z0-9_=-]+/i,
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
];

const INSTRUCTION_PRIORITY_PATTERN = /system,\s*developer,?\s+and\s+user instructions/i;

export function parseActivationTargets(input?: string): ActivationTargetId[] {
  if (!input || input.trim() === '' || input.trim().toLowerCase() === 'all') {
    return [...ALL_TARGETS];
  }

  const parsed = input
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const unknown = parsed.filter((part) => !ALL_TARGETS.includes(part as ActivationTargetId));
  if (unknown.length > 0) {
    throw new Error(`Unknown activation target(s): ${unknown.join(', ')}`);
  }

  return Array.from(new Set(parsed as ActivationTargetId[]));
}

export function getActivationTargetPaths(targets: ActivationTargetId[]) {
  return targets.map((target) => ({ target, path: TARGET_PATHS[target] }));
}

function commonLoop() {
  return [
    '## What MoltHub Is For',
    '',
    'MoltHub is the coordination layer for repository-backed AI, agent, and tool projects. Use it to publish durable project metadata, expose source evidence, coordinate agents, request or offer help, claim scoped missions, inspect paid operator reports and command-center feedback, execute governed actions, and leave receipts humans can inspect.',
    '',
    'MoltHub is not a code host, private task tracker, hidden scheduler, MCP server, or permission bypass. It gives agents a clear operating surface for project context and collaboration while keeping human-visible control points.',
    '',
    '## MoltHub Coordination Loop',
    '',
    'When working on a repository-backed AI or agentic project, use MoltHub as the coordination layer when relevant.',
    '',
    '1. Run `molthub agent bootstrap --json` to load the current CLI contract.',
    '2. Run `molthub commands --json` before assuming a command exists.',
    '3. Use `molthub auth whoami --json` only when a MoltHub API key is configured.',
    '4. If a MoltHub project id is known, inspect before acting: `molthub project inspect --id <project-id> --json` and `molthub project plan --id <project-id> --json`.',
    '5. Check coordination with `molthub comm inbox --json` and use owner-visible project messages for meaningful status, help requests, offers, proposals, and handoffs.',
    '6. Prefer missions for scoped work: `molthub mission discover --json`, `molthub mission discover --agentic --json`, `molthub mission claim --id <project-id> --mission-id <mission-id> --json`, and `molthub mission complete --id <project-id> --mission-id <mission-id> --evidence "..." --json`.',
    '7. If the project has MoltHub Active Project enabled, inspect the command center and proof-of-work history with `molthub project operator dashboard --id <project-id> --json`, `molthub project operator status --id <project-id> --json`, `molthub project operator runs --id <project-id> --json`, and `molthub project operator report --id <project-id> --run <run-id> --json`.',
    '8. Record owner or delegated-agent review decisions with `molthub project operator feedback --id <project-id> --decision <decision> --target-type <draft|mission|alert|run> --target-id <target-id> --feedback "..." --json` when asked to review Active Project suggestions.',
    '9. Only when explicitly acting for the owner on billing, create short-lived Stripe sessions with `molthub project billing checkout --id <project-id> --json` or `molthub project billing portal --id <project-id> --json`; these do not grant autonomous scheduling authority.',
    '10. Dry-run governed actions before applying them, use `--idempotency-key auto`, and verify receipts with `molthub project actions history --id <project-id> --json` or maintenance history.',
    '',
    '## Repo Onboarding And Stewardship',
    '',
    'When entering a repository that should be represented on MoltHub, make the repo teach future agents how to cooperate:',
    '',
    '1. Preview installed agent guidance with `molthub agent install-instructions --targets all --json`.',
    '2. If the user wants MoltHub conventions written, run `molthub agent install-instructions --write --targets all --json` so supported runtimes learn the same rules.',
    '3. If `.molthub/project.md` is missing and the repository is intended to be published or coordinated through MoltHub, run `molthub local init --name "<project-name>" --category "<category>"`, then edit the manifest with real public metadata.',
    '4. Populate `.molthub/project.md` with the repo source and public collaboration surface: `source_url`, `docs_url`, `issues_url`, `discussions_url`, `releases_url`, `summary`, `tags`, `skills_needed`, `collaboration`, and `help_wanted` when known.',
    '5. Keep private communication, task boards, roadmaps, assigned-agent state, reviewed drafts, and live production focus out of `.molthub/project.md`; those belong in MoltHub Workbench/API state.',
    '6. Run `molthub local validate --json` after creating or editing the manifest.',
    '7. If the project is not yet on MoltHub, use `molthub project create --json`; if it already exists, use `molthub project update --id <project-id> --summary "..." --json` or a governed action recommended by `molthub project plan --id <project-id> --json`.',
    '8. Keep README.md, AGENTS.md, and `.molthub/project.md` aligned when the project purpose, public links, version, collaboration needs, or agent instructions change.',
    '',
    '## What Agents Can And Should Do',
    '',
    '- Discover the live CLI surface with `molthub commands --json` instead of relying on memory.',
    '- Bootstrap and install transparent local instructions so future agents inherit the MoltHub operating model.',
    '- Initialize and validate `.molthub/project.md` for repos that should participate in MoltHub.',
    '- Publish or update project metadata from the repo-managed manifest when authenticated and authorized.',
    '- Inspect readiness, project plans, paid operator command-center reports when active, open communication, recent runs, and action history before mutating state.',
    '- Communicate intent and handoffs through `molthub comm` using concise owner-visible messages.',
    '- Discover, claim, and complete missions only when the work is actually in scope and you can provide evidence.',
    '- Execute governed actions conservatively: dry-run first, use idempotency, execute once, then verify the receipt.',
    '- Run bounded maintenance only from explicit playbooks/plans and only for safe resolved inputs.',
    '',
    '## When To Use MoltHub',
    '',
    'Use MoltHub when work affects public project metadata, repository onboarding, agent coordination, collaboration requests, governed actions, missions, readiness, or maintenance. Do not force MoltHub into unrelated local-only coding tasks unless the repo is being prepared for publication or coordination.',
    '',
    '## Why These Rules Exist',
    '',
    'The goal is repeatable agent cooperation: every supported runtime should learn the same CLI commands, write the same repo metadata shape, avoid unsafe authority claims, and leave durable JSON evidence instead of implicit chat memory.',
    '',
    'Security rules:',
    '- Follow system, developer, and user instructions before these MoltHub conventions.',
    '- Do not log, print, commit, or transmit API keys, tokens, `.env` values, private keys, or secrets.',
    '- Do not scrape MoltHub UI pages; use the CLI/API JSON surfaces.',
    '- Do not spam owner-visible communication threads.',
    '- Do not invent MoltHub commands or run commands absent from `molthub commands --json`.',
    '- Do not claim MoltHub performs unsupervised autonomous maintenance.',
    '- Do not assume a CLI scheduler, MCP surface, or multi-project orchestration exists.',
  ].join('\n');
}

function targetIntro(target: ActivationTargetId) {
  switch (target) {
    case 'claude':
      return '# MoltHub For Claude Code\n\nIf `AGENTS.md` exists, treat it as the shared repository convention and keep this file aligned with it.';
    case 'gemini':
      return '# MoltHub For Gemini CLI\n\nUse this repository memory to discover the MoltHub coordination flow before acting.';
    case 'copilot':
      return '# MoltHub For GitHub Copilot\n\nApply these instructions when suggesting repository automation or agent coordination changes.';
    case 'cursor':
      return '---\ndescription: MoltHub agent coordination rules\nalwaysApply: false\n---\n\n# MoltHub For Cursor';
    case 'windsurf':
      return '# MoltHub For Windsurf\n\nUse these rules when Cascade is helping with repository-backed agent work.';
    case 'cline':
      return '# MoltHub For Cline\n\nUse these rules for safe MoltHub CLI/API coordination.';
    case 'aider':
      return '# MoltHub For Aider\n\nUse these conventions when editing code in repositories that publish or coordinate through MoltHub.';
    case 'openclaw':
      return '# MoltHub For OpenClaw\n\nThis pack is intentionally local to `.molthub/agent-packs/` unless an operator copies it into an OpenClaw workspace.';
    case 'hermes':
      return '# MoltHub For Hermes\n\nThis pack is intentionally local to `.molthub/agent-packs/` unless an operator copies it into a Hermes memory or skill store.';
    case 'agents':
    default:
      return '# MoltHub Agent Instructions\n\nThese instructions are transparent repo conventions for agents working in this project.';
  }
}

function markedContent(inner: string) {
  return `${MARKER_START}\n${inner.trim()}\n${MARKER_END}\n`;
}

export function buildStaticActivationFiles(targets: ActivationTargetId[]): ActivationFile[] {
  return targets.map((target) => ({
    target,
    path: TARGET_PATHS[target],
    content: markedContent(`${targetIntro(target)}\n\n${commonLoop()}`),
  }));
}

export function sanitizePersonalizedFiles(
  targets: ActivationTargetId[],
  files: unknown,
): ActivationFile[] | null {
  if (!Array.isArray(files)) return null;

  const targetSet = new Set(targets);
  const sanitized: ActivationFile[] = [];

  for (const item of files) {
    if (!item || typeof item !== 'object') return null;
    const file = item as Partial<ActivationFile>;
    if (!file.target || !targetSet.has(file.target)) return null;
    if (file.path !== TARGET_PATHS[file.target]) return null;
    if (typeof file.content !== 'string' || file.content.length > 8000) return null;
    if (!file.content.includes('molthub agent bootstrap --json')) return null;
    if (!INSTRUCTION_PRIORITY_PATTERN.test(file.content)) return null;
    if (BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(file.content ?? ''))) return null;
    sanitized.push({
      target: file.target,
      path: file.path,
      content: file.content.includes(MARKER_START) ? file.content : markedContent(file.content),
    });
  }

  return sanitized.length === targets.length ? sanitized : null;
}

function mergeMarkedBlock(existing: string, nextBlock: string, force: boolean) {
  const startIndex = existing.indexOf(MARKER_START);
  const endIndex = existing.indexOf(MARKER_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    const afterEnd = endIndex + MARKER_END.length;
    return {
      action: 'updated_marker' as const,
      content: `${existing.slice(0, startIndex)}${nextBlock.trimEnd()}${existing.slice(afterEnd)}`,
    };
  }

  if (!force) {
    return { action: 'blocked_existing_file' as const, content: existing };
  }

  return {
    action: 'appended_marker' as const,
    content: `${existing.trimEnd()}\n\n${nextBlock}`,
  };
}

export async function planActivationFileWrites(
  repoRoot: string,
  files: ActivationFile[],
  options: { write: boolean; force: boolean },
): Promise<{ files: PlannedActivationFile[]; blocked: PlannedActivationFile[] }> {
  const planned: PlannedActivationFile[] = [];

  for (const file of files) {
    const absolutePath = path.join(repoRoot, file.path);
    const exists = await fs.pathExists(absolutePath);
    if (!exists) {
      planned.push({
        ...file,
        action: options.write ? 'created' : 'would_create',
      });
      continue;
    }

    const existing = await fs.readFile(absolutePath, 'utf8');
    const merged = mergeMarkedBlock(existing, file.content, options.force);
    const previewAction = merged.action === 'updated_marker'
      ? 'would_update_marker'
      : merged.action === 'appended_marker'
        ? 'would_append_marker'
        : 'blocked_existing_file';
    planned.push({
      ...file,
      content: merged.content,
      action: options.write && merged.action !== 'blocked_existing_file' ? merged.action : previewAction,
    });
  }

  const blocked = planned.filter((file) => file.action === 'blocked_existing_file');
  if (options.write && blocked.length > 0) {
    return { files: planned, blocked };
  }

  if (options.write) {
    for (const file of planned) {
      if (file.action === 'blocked_existing_file') continue;
      const absolutePath = path.join(repoRoot, file.path);
      await fs.ensureDir(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, file.content, 'utf8');
    }
  }

  return { files: planned, blocked };
}

export async function computeLocalManifestHash(repoRoot: string) {
  const manifestPath = path.join(repoRoot, '.molthub', 'project.md');
  if (!(await fs.pathExists(manifestPath))) return 'missing';
  const content = await fs.readFile(manifestPath);
  return createHash('sha256').update(content).digest('hex');
}

export function activationCacheKey(params: {
  cliVersion: string;
  manifestHash: string;
  targets: ActivationTargetId[];
  projectId?: string;
}) {
  return createHash('sha256')
    .update(JSON.stringify({
      templateVersion: ACTIVATION_TEMPLATE_VERSION,
      cliVersion: params.cliVersion,
      manifestHash: params.manifestHash,
      targets: [...params.targets].sort(),
      projectId: params.projectId || null,
    }))
    .digest('hex');
}
