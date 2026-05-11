import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import {
  LEDGER_PATH,
  PROMPT_INDEX_PATH,
  findProductionRecordSecrets,
  validateLedgerFile,
  validatePromptIndex,
} from './ledger.js';

const PRODUCTION_PACK_FILES = [
  '.molthub/production/production-index.yml',
  '.molthub/production/current-state.yml',
  '.molthub/production/warnings.yml',
  '.molthub/source-material/index.yml',
  '.molthub/plans/plan-index.yml',
  '.molthub/memory/accepted.yml',
  '.molthub/systems/implemented-systems.yml',
  '.molthub/missions/mission-index.yml',
  '.molthub/reviews/review-index.yml',
  '.molthub/agents/agent-context.yml',
] as const;

const PIPELINE_TEXT_FILES = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'SKILL.md',
  'docs/agent-recipes.md',
  'docs/json-contract.md',
  'docs/internal/product-memory-index.md',
  'docs/internal/current-release-state.md',
  'docs/internal/public-release-checklist.md',
  'docs/internal/production-map/open-loops.md',
  'docs/internal/production-map/future-roadmap.md',
  'docs/internal/prompt-intelligence-layer.md',
  'docs/internal/repo-production-memory-pack.md',
  'docs/internal/repo-local-production-ledger.md',
  'docs/internal/molthub-self-dogfood-operating-plan.md',
  'src/app/docs/agents/page.tsx',
  'src/app/docs/cli/page.tsx',
  'src/app/docs/roadmap/page.tsx',
  '.molthub/production/production-index.yml',
  '.molthub/production/current-state.yml',
  '.molthub/production/warnings.yml',
  LEDGER_PATH,
  PROMPT_INDEX_PATH,
  '.molthub/source-material/index.yml',
  '.molthub/plans/plan-index.yml',
  '.molthub/memory/accepted.yml',
  '.molthub/systems/implemented-systems.yml',
  '.molthub/missions/mission-index.yml',
  '.molthub/reviews/review-index.yml',
  '.molthub/agents/agent-context.yml',
] as const;

type Finding = {
  code: string;
  message: string;
  file?: string;
  line?: number;
};

function isNegatedBoundaryLine(line: string) {
  return /\b(do not|does not|cannot|must not|no\b|not |never|without|forbidden|disabled|fails closed|prohibited|avoid|not\.toContain|raw input|raw\/untrusted|separate from accepted)\b/i.test(line);
}

async function listTextFiles(root: string, entry: string): Promise<string[]> {
  const target = path.join(root, entry);
  if (!(await fs.pathExists(target))) return [];
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const files: string[] = [];
  for (const child of await fs.readdir(target)) {
    const childPath = path.join(target, child);
    const childStat = await fs.stat(childPath);
    if (childStat.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '.next'].includes(child)) continue;
      files.push(...await listTextFiles(root, path.relative(root, childPath)));
    } else if (/\.(md|mdx|txt|yml|yaml|json|tsx?|jsx?)$/i.test(child)) {
      files.push(childPath);
    }
  }
  return files;
}

async function parseYamlFile(filePath: string) {
  const content = await fs.readFile(filePath, 'utf8');
  return yaml.load(content);
}

export async function validateProductionPack(root = process.cwd()) {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const checkedFiles: string[] = [];

  if (await fs.pathExists(path.join(root, '.mothub'))) {
    errors.push({ code: 'ERR_FORBIDDEN_MOTHUB_DIR', message: 'Forbidden .mothub/ directory exists.' });
  }
  if (await fs.pathExists(path.join(root, 'molthub.yaml'))) {
    errors.push({ code: 'ERR_FORBIDDEN_MOLTHUB_YAML', message: 'Forbidden molthub.yaml file exists; .molthub/project.md is canonical.' });
  }
  if (!(await fs.pathExists(path.join(root, '.molthub', 'project.md')))) {
    errors.push({ code: 'ERR_MISSING_PROJECT_MD', message: 'Missing canonical .molthub/project.md.' });
  }

  for (const rel of PRODUCTION_PACK_FILES) {
    const filePath = path.join(root, rel);
    checkedFiles.push(rel);
    if (!(await fs.pathExists(filePath))) {
      errors.push({ code: 'ERR_MISSING_PRODUCTION_PACK_FILE', message: `Missing production pack file: ${rel}`, file: rel });
      continue;
    }
    try {
      const parsed = await parseYamlFile(filePath);
      if (!parsed || typeof parsed !== 'object') {
        errors.push({ code: 'ERR_EMPTY_PRODUCTION_PACK_FILE', message: `${rel} must contain a YAML object.`, file: rel });
      }
    } catch (error: any) {
      errors.push({ code: 'ERR_INVALID_YAML', message: error?.message || 'Invalid YAML.', file: rel });
    }
  }

  const ledgerValidation = await validateLedgerFile(root, { required: true });
  checkedFiles.push(...ledgerValidation.checkedFiles.filter((entry) => !checkedFiles.includes(entry)));
  errors.push(...ledgerValidation.errors);
  warnings.push(...ledgerValidation.warnings);

  const promptValidation = await validatePromptIndex(root, { required: true });
  checkedFiles.push(...promptValidation.checkedFiles.filter((entry) => !checkedFiles.includes(entry)));
  errors.push(...promptValidation.errors);
  warnings.push(...promptValidation.warnings);

  return {
    ok: errors.length === 0,
    checkedFiles,
    errors,
    warnings,
  };
}

function addLineFinding(
  findings: Finding[],
  code: string,
  message: string,
  file: string,
  line: number,
) {
  findings.push({ code, message, file, line });
}

export async function checkPipelineConformance(root = process.cwd()) {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const checkedFiles: string[] = [];
  const packagePath = path.join(root, 'package.json');
  let packageVersion: string | null = null;

  if (await fs.pathExists(path.join(root, '.mothub'))) {
    errors.push({ code: 'ERR_FORBIDDEN_MOTHUB_DIR', message: 'Forbidden .mothub/ directory exists.' });
  }
  if (await fs.pathExists(path.join(root, 'molthub.yaml'))) {
    errors.push({ code: 'ERR_FORBIDDEN_MOLTHUB_YAML', message: 'Forbidden molthub.yaml file exists; .molthub/project.md is canonical.' });
  }

  if (await fs.pathExists(packagePath)) {
    try {
      const pkg = await fs.readJson(packagePath);
      if (pkg?.name === 'molthub-cli' && typeof pkg.version === 'string') {
        packageVersion = pkg.version;
      }
    } catch {
      warnings.push({ code: 'WARN_PACKAGE_PARSE', message: 'Could not parse package.json for CLI version checks.', file: 'package.json' });
    }
  }

  const files = (await Promise.all(PIPELINE_TEXT_FILES.map((entry) => listTextFiles(root, entry)))).flat();
  for (const filePath of files) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    checkedFiles.push(rel);
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    if (packageVersion && /README\.md$/.test(rel)) {
      const readmeVersion = content.match(/MoltHub CLI \(v([0-9]+\.[0-9]+\.[0-9]+)\)/)?.[1];
      if (readmeVersion && readmeVersion !== packageVersion) {
        errors.push({
          code: 'ERR_STALE_CLI_VERSION',
          message: `README CLI version ${readmeVersion} does not match package version ${packageVersion}.`,
          file: rel,
        });
      }
    }
    if (packageVersion && /SKILL\.md$/.test(rel)) {
      const skillVersion = content.match(/\*\*Version:\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
      if (skillVersion && skillVersion !== packageVersion) {
        errors.push({
          code: 'ERR_STALE_CLI_VERSION',
          message: `SKILL CLI version ${skillVersion} does not match package version ${packageVersion}.`,
          file: rel,
        });
      }
    }

    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      const lineNo = index + 1;
      if (/^\.molthub\/(?:ledger|prompts)\//.test(rel)) {
        for (const finding of findProductionRecordSecrets(rel, line)) {
          addLineFinding(errors, 'ERR_SECRET_IN_PRODUCTION_RECORD', `Production record contains secret-like content (${finding.pattern}).`, rel, lineNo);
        }
      }
      if (/\b3\.4\.0\b/.test(line) && /molthub-cli|Local Bridge|CLI/i.test(line)) {
        addLineFinding(errors, 'ERR_STALE_CLI_VERSION', 'CLI-facing copy still mentions 3.4.0.', rel, lineNo);
      }
      if (/\b(public beta is ready|ready for public beta|public beta ready)\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_PUBLIC_BETA_OVERCLAIM', 'Copy claims public beta readiness.', rel, lineNo);
      }
      if (/\b(hidden autonomous dispatch|automatic dispatch|auto-dispatch)\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_AUTOMATIC_DISPATCH_CLAIM', 'Copy implies automatic dispatch.', rel, lineNo);
      }
      if (/\b(MoltHub cloud runs code|MoltHub runs code|cloud runs code)\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_CLOUD_EXECUTION_CLAIM', 'Copy implies MoltHub cloud code execution.', rel, lineNo);
      }
      if (/\bLocal Bridge\b.*\b(executes|runs|invokes|launches)\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_LOCAL_BRIDGE_EXECUTION_CLAIM', 'Copy describes Local Bridge as executing tools.', rel, lineNo);
      }
      if (/\b(raw\s+)?Source Material\b.*\b(truth|accepted truth|canonical)\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_SOURCE_MATERIAL_TRUTH_CLAIM', 'Copy treats raw Source Material as truth.', rel, lineNo);
      }
      if (/\bagents?\b.*\b(directly\s+)?(mutate|write|update|change)\b.*\bProject Memory\b/i.test(line) && !isNegatedBoundaryLine(line)) {
        addLineFinding(errors, 'ERR_PROJECT_MEMORY_DIRECT_MUTATION_CLAIM', 'Copy implies agents can directly mutate Project Memory.', rel, lineNo);
      }
      if (/\bmolthub\.yaml\b/i.test(line) && !isNegatedBoundaryLine(line) && !/legacy|migrat/i.test(line)) {
        addLineFinding(warnings, 'WARN_MOLTHUB_YAML_MENTION', 'Copy mentions molthub.yaml outside an explicit deprecation or migration context.', rel, lineNo);
      }
      if (/\.mothub\b/i.test(line) && !isNegatedBoundaryLine(line) && !/parallel metadata|historical/i.test(line)) {
        addLineFinding(warnings, 'WARN_MOTHUB_MENTION', 'Copy mentions .mothub outside a forbidden-path context.', rel, lineNo);
      }
    });
  }

  return {
    ok: errors.length === 0,
    packageVersion,
    checkedFiles,
    errors,
    warnings,
  };
}

export async function exportProductionPack(root = process.cwd(), reviewed = false, out?: string) {
  if (!reviewed) {
    throw new Error('Refusing to export production pack without --reviewed. Owner review must happen before pack export.');
  }
  const validation = await validateProductionPack(root);
  if (!validation.ok) {
    return { written: null, validation };
  }
  const outputPath = path.resolve(root, out ?? '.molthub/production/export-report.json');
  const payload = {
    version: 'production_pack_export_v1',
    exportedAt: new Date().toISOString(),
    source: 'local production export',
    reviewed: true,
    files: validation.checkedFiles,
    validator: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    boundaries: [
      '.molthub/project.md remains canonical public repo metadata.',
      'This export does not replace owner-reviewed Project Memory.',
      'This export does not run code or dispatch agents.',
    ],
  };
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, payload, { spaces: 2 });
  return { written: outputPath, validation };
}
