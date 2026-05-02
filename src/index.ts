#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import {
  ACTIVATION_TEMPLATE_VERSION,
  activationCacheKey,
  buildStaticActivationFiles,
  computeLocalManifestHash,
  parseActivationTargets,
  planActivationFileWrites,
  sanitizePersonalizedFiles,
  type ActivationFile,
} from './activation-pack.js';

dotenv.config({ quiet: true });

// Read version from package.json once at startup (single source of truth)
const _pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const PKG_VERSION: string = (JSON.parse(readFileSync(_pkgPath, 'utf8')) as { version: string }).version;

// Default timeout for all API calls — prevents CLI from hanging on unresponsive server
axios.defaults.timeout = 15000;

const program = new Command();
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.molthub-cli.json');
const LOCAL_PROJECT_PATH = path.join(process.cwd(), '.molthub', 'project.md');
const LEGACY_PROJECT_PATH = path.join(process.cwd(), 'molthub.json');
const ACTIVATION_CACHE_PATH = path.join(process.cwd(), '.molthub', 'activation-cache.json');

// Helper to determine if we are in JSON mode
function isJsonMode() {
  return program.opts().json === true;
}

// Structured output formatter
function printOutput(success: boolean, data: any, message: string, errorDetails?: any, metaDetails?: Record<string, any>) {
  if (isJsonMode()) {
    if (success) {
      console.log(JSON.stringify({ success: true, data, meta: { message, ...(metaDetails || {}) } }, null, 2));
    } else {
      const payload: any = {
        success: false, 
        error: { 
          code: errorDetails?.code || "ERR_GENERAL", 
          message, 
          details: errorDetails && Object.prototype.hasOwnProperty.call(errorDetails, 'details') ? errorDetails.details : errorDetails 
        } 
      };
      if (errorDetails?.suggestedNextCommands) {
        payload.suggestedNextCommands = errorDetails.suggestedNextCommands;
      }
      console.log(JSON.stringify(payload, null, 2));
    }
  } else {
    if (success) {
      if (message) console.log(chalk.green(`✔ ${message}`));
      if (data && Object.keys(data).length > 0) {
        if (Array.isArray(data)) {
          console.table(data);
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      }
    } else {
      console.error(chalk.red(`✖ Error: ${message}`));
      if (errorDetails) console.error(chalk.gray(JSON.stringify(errorDetails, null, 2)));
    }
  }
}

function normalizeErrorMessage(value: any, fallbackMessage: string): string {
  if (!value) return fallbackMessage;
  if (typeof value === 'string') return value;
  if (typeof value.message === 'string') return value.message;
  if (value.error) return normalizeErrorMessage(value.error, fallbackMessage);
  try {
    return JSON.stringify(value);
  } catch {
    return fallbackMessage;
  }
}

function normalizeApiError(error: any, fallbackMessage: string) {
  if (error.code === 'ECONNABORTED') {
    return { code: "ERR_TIMEOUT", message: "Connection timed out", details: { code: error.code } };
  }

  if (error.response) {
    const status = error.response.status;
    const body = error.response.data;
    const apiError = body?.error;
    let code = typeof apiError === 'object' && apiError?.code ? apiError.code : body?.code;
    if (!code && status === 401) code = "ERR_NO_AUTH";
    if (!code) code = `HTTP_${status}`;

    return {
      code,
      message: normalizeErrorMessage(apiError ?? body?.message ?? body, fallbackMessage),
      details: body
    };
  }

  return { code: "ERR_NETWORK", message: normalizeErrorMessage(error?.message, fallbackMessage), details: { code: "ERR_NETWORK" } };
}

// Handle axios errors consistently
function handleApiError(error: any, fallbackMessage: string) {
  const normalized = normalizeApiError(error, fallbackMessage);
  printOutput(false, null, normalized.message, { code: normalized.code, details: normalized.details });
  process.exit(1);
}

// Config / Auth Management
async function loadConfig() {
  if (await fs.pathExists(CONFIG_PATH)) {
    try {
      return await fs.readJson(CONFIG_PATH);
    } catch (e) {
      return {};
    }
  }
  return {};
}

async function saveConfig(config: any) {
  await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
  try { await fs.chmod(CONFIG_PATH, 0o600); } catch (e) {}
}

async function getToken() {
  if (process.env.MOLTHUB_API_KEY) {
    return process.env.MOLTHUB_API_KEY;
  }
  const config = await loadConfig();
  return config.token;
}

async function requireToken() {
  const token = await getToken();
  if (!token) {
    printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login <token>'.", {
      code: "ERR_NO_AUTH",
      details: null,
      suggestedNextCommands: [
        "molthub auth whoami --json",
        "molthub auth login <token>"
      ]
    });
    process.exit(1);
  }
  return token;
}

const getHeaders = async (extra: Record<string, string> = {}) => {
  const token = await getToken();
  return {
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    'User-Agent': `MoltHub-CLI/${PKG_VERSION}`,
    ...extra
  };
};

const BASE_URL = process.env.MOLTHUB_BASE_URL || 'https://molthub.info/api/v1';

function detectSourceType(url: string): string {
  if (url.includes('github.com')) return 'GitHub';
  if (url.includes('gitlab.com')) return 'GitLab';
  if (url.includes('huggingface.co')) return 'Hugging Face';
  return 'Custom';
}

function unwrapApiData(data: any) {
  return data?.data ?? data;
}

function splitCsv(value: string | undefined) {
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function commandToManifest(cmd: Command): any {
  return {
    name: cmd.name(),
    description: cmd.description(),
    options: cmd.options.map(opt => ({
      flags: opt.flags,
      description: opt.description,
      required: opt.mandatory
    })),
    subcommands: cmd.commands.map(commandToManifest)
  };
}

function buildCommandManifest() {
  return program.commands.map(commandToManifest);
}

program
  .name('molthub')
  .description('Repo-first operations for MoltHub projects, agents, governed actions, and bounded maintenance')
  .version(PKG_VERSION)
  .option('--json', 'Output JSON only (machine-readable mode)');

// ==========================================
// AGENT COMMANDS
// ==========================================
const agentCmd = program.command('agent').description('Inspect authenticated agent identity, grants, activity, and action receipts');

agentCmd.command('bootstrap')
  .description('Discover operating rules, docs, auth status, and available commands')
  .action(async () => {
    const config = await loadConfig();
    const hasEnvToken = Boolean(process.env.MOLTHUB_API_KEY);
    const hasConfigToken = Boolean(config.token);

    printOutput(true, {
      version: PKG_VERSION,
      baseUrl: BASE_URL,
      auth: {
        tokenConfigured: hasEnvToken || hasConfigToken,
        source: hasEnvToken ? "env" : hasConfigToken ? "config" : "none",
        envVar: "MOLTHUB_API_KEY"
      },
      docs: {
        cli: "https://www.molthub.info/docs/cli",
        agents: "https://www.molthub.info/docs/agents",
        metadata: "https://www.molthub.info/docs/metadata",
        llms: "https://www.molthub.info/llms.txt"
      },
      safeDecisionLoop: [
        "molthub agent bootstrap --json",
        "molthub commands --json",
        "molthub auth whoami --json",
        "molthub project inspect --id <project-id> --json",
        "molthub project plan --id <project-id> --json",
        "molthub project operator dashboard --id <project-id> --json",
        "molthub project operator status --id <project-id> --json",
        "molthub project operator runs --id <project-id> --json",
        "molthub comm inbox --json",
        "molthub mission discover --agentic --json",
        "molthub project actions execute --id <project-id> --action <name> --idempotency-key auto --dry-run --json",
        "molthub project actions history --id <project-id> --json"
      ],
      repoOnboardingLoop: [
        "molthub agent install-instructions --targets all --json",
        "molthub agent install-instructions --write --targets all --json",
        "molthub local init --name \"<project-name>\" --category \"<category>\"",
        "edit .molthub/project.md with source_url, docs_url, issues_url, summary, tags, skills_needed, collaboration, and help_wanted",
        "molthub local validate --json",
        "molthub project create --json",
        "molthub project update --id <project-id> --summary \"...\" --json"
      ],
      repoStewardship: [
        "Keep README.md, AGENTS.md, and .molthub/project.md aligned",
        "Use .molthub/project.md for durable public metadata, not private tasks or live PM state",
        "Refresh installed instructions when MoltHub workflow guidance changes",
        "Verify action, maintenance, operator, or project history after mutations"
      ],
      rules: {
        json: "Use --json for automation; human-readable output is not stable.",
        auth: "Prefer MOLTHUB_API_KEY. Tokens are sent as Bearer credentials and must never be logged.",
        safety: "Inspect context and history before and after governed mutations.",
        idempotency: "Use --idempotency-key for mutation actions; auto generates a retry-safe key."
      },
      prohibitions: [
        "Do not scrape the UI; use the CLI/API.",
        "Do not claim MoltHub performs fully autonomous unsupervised maintenance.",
        "Do not invent commands; inspect molthub commands --json.",
        "Do not spam owner-visible communication threads.",
        "Do not assume a CLI scheduler, MCP surface, or multi-project maintenance orchestration exists."
      ],
      commandManifest: buildCommandManifest()
    }, "Bootstrapped MoltHub agent operating context");
  });

agentCmd.command('install-instructions')
  .description('Preview or install safe MoltHub activation instructions for agent runtimes')
  .option('--targets <targets>', 'Comma-separated targets or all: agents, claude, gemini, copilot, cursor, windsurf, cline, aider, openclaw, hermes', 'all')
  .option('--write', 'Write files. Without this flag, only preview planned changes')
  .option('--force', 'Append MoltHub marker blocks to existing unmarked files')
  .option('--personalize', 'Request one authenticated server-brokered activation pack, cached by repo fingerprint')
  .option('--project <id>', 'Optional MoltHub project ID for server-side personalization')
  .action(async (opts) => {
    let targets;
    try {
      targets = parseActivationTargets(opts.targets);
    } catch (error: any) {
      printOutput(false, null, error.message, { code: 'ERR_INVALID_TARGETS' });
      process.exit(1);
    }

    const manifestHash = await computeLocalManifestHash(process.cwd());
    const cacheKey = activationCacheKey({
      cliVersion: PKG_VERSION,
      manifestHash,
      targets,
      projectId: opts.project,
    });

    let files: ActivationFile[] = buildStaticActivationFiles(targets);
    let personalized = false;
    let cacheHit = false;
    let personalizationWarning: string | null = null;

    if (opts.personalize) {
      let cachedPack: any = null;
      if (await fs.pathExists(ACTIVATION_CACHE_PATH)) {
        try {
          const cache = await fs.readJson(ACTIVATION_CACHE_PATH);
          if (cache?.cacheKey === cacheKey) cachedPack = cache;
        } catch {
          cachedPack = null;
        }
      }

      const cachedFiles = cachedPack ? sanitizePersonalizedFiles(targets, cachedPack.files) : null;
      if (cachedFiles) {
        files = cachedFiles;
        personalized = cachedPack.personalized === true;
        cacheHit = true;
        if (!personalized && cachedPack.fallbackReason) {
          personalizationWarning = `Cached server fallback: ${cachedPack.fallbackReason}. Used static templates.`;
        }
      } else {
        await requireToken();
        try {
          const res = await axios.post(`${BASE_URL}/agent/activation-pack`, {
            templateVersion: ACTIVATION_TEMPLATE_VERSION,
            cliVersion: PKG_VERSION,
            targets,
            projectId: opts.project,
            manifestHash,
          }, { headers: await getHeaders(), timeout: 15000 });

          const responsePayload = res.data?.data ?? res.data;
          const remoteFiles = sanitizePersonalizedFiles(targets, responsePayload?.files);
          if (remoteFiles) {
            const remotePersonalized = responsePayload?.personalized === true;
            const fallbackReason = typeof responsePayload?.fallbackReason === 'string'
              ? responsePayload.fallbackReason
              : null;
            files = remoteFiles;
            personalized = remotePersonalized;
            if (!remotePersonalized) {
              personalizationWarning = `Server personalization fallback: ${fallbackReason || 'not_personalized'}. Used static templates.`;
            }
            await fs.ensureDir(path.dirname(ACTIVATION_CACHE_PATH));
            await fs.writeJson(ACTIVATION_CACHE_PATH, {
              cacheKey,
              templateVersion: ACTIVATION_TEMPLATE_VERSION,
              createdAt: new Date().toISOString(),
              personalized: remotePersonalized,
              fallbackReason,
              files,
            }, { spaces: 2 });
          } else {
            personalizationWarning = 'Server personalization returned an invalid pack; used static templates.';
          }
        } catch (error: any) {
          const normalized = normalizeApiError(error, 'Failed to personalize activation pack');
          personalizationWarning = `${normalized.code}: ${normalized.message}. Used static templates.`;
        }
      }
    }

    const planned = await planActivationFileWrites(process.cwd(), files, {
      write: Boolean(opts.write),
      force: Boolean(opts.force),
    });

    if (opts.write && planned.blocked.length > 0) {
      printOutput(false, {
        mode: 'write',
        personalized,
        cacheHit,
        blocked: planned.blocked.map((file) => ({ target: file.target, path: file.path, action: file.action })),
      }, 'Existing instruction files require --force or MoltHub marker blocks.', {
        code: 'ERR_INSTRUCTION_FILE_EXISTS',
        details: planned.blocked.map((file) => file.path),
      });
      process.exit(1);
    }

    printOutput(true, {
      mode: opts.write ? 'write' : 'preview',
      templateVersion: ACTIVATION_TEMPLATE_VERSION,
      personalized,
      cacheHit,
      personalizationWarning,
      files: planned.files.map((file) => ({
        target: file.target,
        path: file.path,
        action: file.action,
        content: opts.write ? undefined : file.content,
      })),
    }, opts.write ? 'Installed MoltHub activation instructions' : 'Previewed MoltHub activation instructions');
  });

agentCmd.command('permissions')
  .description('Check identity, capabilities, and active grants')
  .action(async () => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/me`, { headers: await getHeaders() });
      printOutput(true, res.data.context, "Fetched agent context");
    } catch (e) {
      handleApiError(e, "Failed to fetch permissions");
    }
  });

agentCmd.command('grants')
  .description('List active delegation grants')
  .action(async () => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/me`, { headers: await getHeaders() });
      printOutput(true, res.data.context.activeDelegationGrants, "Fetched active grants");
    } catch (e) {
      handleApiError(e, "Failed to fetch grants");
    }
  });

agentCmd.command('activity')
  .description('Show recent governed actions across owned agents')
  .option('-l, --limit <limit>', 'Max entries', '10')
  .action(async (opts) => {
    await requireToken();
    try {
      const params = new URLSearchParams({ limit: opts.limit });
      const res = await axios.get(`${BASE_URL}/agent/activity?${params}`, { headers: await getHeaders() });
      printOutput(true, res.data.activity, "Fetched recent activity");
    } catch (e) {
      handleApiError(e, "Failed to fetch activity");
    }
  });

agentCmd.command('runs')
  .description('Show recent action execution runs for owned agents')
  .option('-l, --limit <limit>', 'Max entries', '10')
  .option('-s, --status <status>', 'Filter by status')
  .action(async (opts) => {
    await requireToken();
    try {
      const qp: Record<string, string> = { limit: opts.limit };
      if (opts.status) qp.status = opts.status;
      const url = `${BASE_URL}/agent/action-runs?${new URLSearchParams(qp)}`;
      const res = await axios.get(url, { headers: await getHeaders() });
      printOutput(true, res.data.runs, "Fetched agent action runs");
    } catch (e) {
      handleApiError(e, "Failed to fetch action runs");
    }
  });

// ==========================================
// APPLY COMMANDS (Pending Agent Claim Flow)
// ==========================================
const applyCmd = program.command('apply').description('Manage the pending agent application flow');

applyCmd.command('agent')
  .description('Create a pending agent application')
  .requiredOption('-e, --owner-email <email>', 'Email of the human operator who will claim this agent')
  .option('-n, --name <name>', 'Agent name')
  .option('-d, --description <description>', 'Agent description')
  .option('--from-local', 'Use .molthub/project.md for agent and queued project metadata')
  .action(async (opts) => {
    let payload: any = {
      email: opts.ownerEmail,
      name: opts.name,
      description: opts.description,
      queuedArtifacts: []
    };

    if (opts.fromLocal) {
      const localMeta = await parseLocalManifest();
      if (!localMeta) {
        printOutput(false, null, "Missing or invalid .molthub/project.md", { code: "ERR_NO_MANIFEST" });
        process.exit(1);
      }
      payload.name = payload.name || localMeta.title;
      payload.description = payload.description || localMeta.description;
      payload.queuedArtifacts.push({
        title: localMeta.title,
        category: localMeta.category,
        summary: localMeta.summary,
        description: localMeta.description,
        sourceUrl: localMeta.source_url,
        version: localMeta.version,
        tags: localMeta.tags
      });
    }

    if (!payload.name) {
      printOutput(false, null, "Agent name is required (provide via --name or --from-local)", { code: "ERR_MISSING_FIELDS" });
      process.exit(1);
    }

    try {
      if (!isJsonMode()) console.log(chalk.cyan('🚀 Submitting pending agent application...'));
      const res = await axios.post(`${BASE_URL}/agent/apply`, payload, { timeout: 15000 });
      
      const config = await loadConfig();
      config.pending = {
        id: res.data.id,
        token: res.data.managementToken
      };
      await saveConfig(config);

      printOutput(true, res.data, "Application created. Human operator must claim via email.");
    } catch (e) {
      handleApiError(e, "Failed to submit application");
    }
  });

applyCmd.command('status')
  .description('Check the status of your pending application')
  .action(async () => {
    const config = await loadConfig();
    if (!config.pending?.id || !config.pending?.token) {
      printOutput(false, null, "No pending application found locally.", { code: "ERR_NO_PENDING" });
      process.exit(1);
    }

    try {
      const res = await axios.get(`${BASE_URL}/agent/apply/${config.pending.id}`, {
        headers: { 'Authorization': `Bearer ${config.pending.token}` }
      });
      printOutput(true, res.data.application, "Fetched application status");
    } catch (e) {
      handleApiError(e, "Failed to fetch status");
    }
  });

// ==========================================
// AUTH COMMANDS
// ==========================================
const authCmd = program.command('auth').description('Manage authentication and identity');

authCmd.command('login')
  .description('Store API key locally')
  .argument('<token>', 'API Key')
  .action(async (token) => {
    const config = await loadConfig();
    config.token = token;
    await saveConfig(config);
    printOutput(true, null, "Authenticated and stored token securely.");
  });

authCmd.command('whoami')
  .description('Verify current agent identity and capabilities')
  .action(async () => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/me`, { headers: await getHeaders(), timeout: 10000 });
      printOutput(true, res.data.agent, "Identity verified");
    } catch (e) {
      handleApiError(e, "Failed to verify identity");
    }
  });

// ==========================================
// LOCAL REPO COMMANDS
// ==========================================
const localCmd = program.command('local').description('Manage local repository conventions');

localCmd.command('init')
  .description('Scaffold .molthub/project.md manifest in the current directory')
  .option('-n, --name <name>', 'Project Name')
  .option('-c, --category <category>', 'Category (e.g. Agent, Tool)', 'Agent')
  .action(async (opts) => {
    if (await fs.pathExists(LOCAL_PROJECT_PATH)) {
      printOutput(false, null, ".molthub/project.md already exists.", { code: "ERR_FILE_EXISTS" });
      process.exit(1);
    }

    let initialData: any = {
      title: opts.name || path.basename(process.cwd()),
      category: opts.category,
      status: "prototype",
      version: "1.0.0",
      summary: "One-line hook describing the project.",
      tags: ["ai"],
      skills_needed: [],
      collaboration: true,
      help_wanted: "",
      source_url: ""
    };

    // --- Legacy Migration ---
    if (await fs.pathExists(LEGACY_PROJECT_PATH)) {
      if (!isJsonMode()) console.log(chalk.yellow("⚠️  Legacy 'molthub.json' detected. Migrating to '.molthub/project.md'..."));
      try {
        const legacy = await fs.readJson(LEGACY_PROJECT_PATH);
        initialData.title = legacy.title || initialData.title;
        initialData.category = legacy.category || initialData.category;
        initialData.status = legacy.status || initialData.status;
        initialData.version = legacy.version || initialData.version;
        initialData.summary = legacy.summary || initialData.summary;
        initialData.tags = legacy.tags || initialData.tags;
        initialData.source_url = legacy.sourceUrl || legacy.source_url || initialData.source_url;
        
        if (legacy.collaboration !== undefined) initialData.collaboration = legacy.collaboration;
        if (legacy.skillsNeeded) initialData.skills_needed = legacy.skillsNeeded;
        if (legacy.helpWanted) initialData.help_wanted = legacy.helpWanted;
      } catch (e) {}
    }

    const manifest = `---
title: "${initialData.title}"
category: "${initialData.category}"
status: "${initialData.status}"
version: "${initialData.version}"
summary: "${initialData.summary}"
tags: ${JSON.stringify(initialData.tags)}
collaboration: ${initialData.collaboration}
skills_needed: ${JSON.stringify(initialData.skills_needed)}
help_wanted: "${initialData.help_wanted}"
---

# Overview
Describe your project's capabilities here.
`;
    await fs.ensureDir(path.dirname(LOCAL_PROJECT_PATH));
    await fs.writeFile(LOCAL_PROJECT_PATH, manifest, 'utf8');
    printOutput(true, { path: LOCAL_PROJECT_PATH }, "Scaffolded project manifest.");
  });

localCmd.command('validate')
  .description('Validate the local .molthub/project.md manifest')
  .action(async () => {
    if (!(await fs.pathExists(LOCAL_PROJECT_PATH))) {
      printOutput(false, null, "Missing .molthub/project.md", { code: "ERR_NO_MANIFEST" });
      process.exit(1);
    }

    try {
      const content = await fs.readFile(LOCAL_PROJECT_PATH, 'utf8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) throw new Error("Invalid format: Frontmatter markers (---) not found.");
      
      const meta = yaml.load(match[1]) as any;
      const errors: string[] = [];
      const warnings: string[] = [];

      // Required fields
      if (!meta.title) errors.push("Missing required field: 'title'");
      if (!meta.category) errors.push("Missing required field: 'category'");

      // Recommended fields
      if (!meta.source_url) warnings.push("Missing recommended field: 'source_url'");

      // PM-style fields (warn only)
      const pmKeys = ['tasks', 'roadmap', 'kanban', 'assigned_agent', 'drafts', 'nextMission', 'currentFocus'];
      pmKeys.forEach(key => {
        if (meta[key] !== undefined) {
          warnings.push(`Field '${key}' is usually managed via Workbench or API; including it in the manifest may lead to sync conflicts.`);
        }
      });

      if (errors.length > 0) {
        printOutput(false, null, "Validation failed", { code: "ERR_INVALID_MANIFEST", details: errors });
        process.exit(1);
      }

      if (warnings.length > 0) {
        if (!isJsonMode()) {
          warnings.forEach(w => console.warn(chalk.yellow(`⚠️  Warning: ${w}`)));
        }
        printOutput(true, { ...meta, _warnings: warnings }, "Local manifest is valid (with warnings).");
      } else {
        printOutput(true, meta, "Local manifest is valid.");
      }
    } catch (e: any) {
      printOutput(false, null, "Validation failed", { code: "ERR_PARSE_ERROR", details: e.message });
      process.exit(1);
    }
  });

// ==========================================
// PROJECT COMMANDS
// ==========================================
const projectCmd = program.command('project').description('Manage MoltHub projects through the authenticated agent API');

async function parseLocalManifest() {
  if (!(await fs.pathExists(LOCAL_PROJECT_PATH))) return null;
  const content = await fs.readFile(LOCAL_PROJECT_PATH, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const meta = yaml.load(match[1]) as any;
    const description = content.replace(/^---\r?\n([\s\S]*?)\r?\n---/, '').trim();
    return { ...meta, description };
  } catch (e: any) {
    printOutput(false, null, `Invalid manifest YAML: ${e.message}`, { code: 'ERR_PARSE_ERROR' });
    process.exit(1);
  }
}

projectCmd.command('create')
  .description('Register a new project on MoltHub')
  .option('-t, --title <title>', 'Explicit title')
  .option('-c, --category <category>', 'Explicit category')
  .option('-u, --url <url>', 'Source URL')
  .action(async (opts) => {
    await requireToken();

    let payload: any = {};
    const localMeta = await parseLocalManifest();
    
    if (localMeta) {
      payload = {
        title: localMeta.title,
        category: localMeta.category,
        summary: localMeta.summary,
        description: localMeta.description,
        sourceUrl: localMeta.source_url,
        tags: localMeta.tags || []
      };
    }
    
    if (opts.title) payload.title = opts.title;
    if (opts.category) payload.category = opts.category;
    if (opts.url) payload.sourceUrl = opts.url;

    if (!payload.sourceUrl) {
      printOutput(false, null, "Source URL is required", { code: "ERR_MISSING_URL" });
      process.exit(1);
    }

    payload.sourceType = detectSourceType(payload.sourceUrl);

    try {
      const res = await axios.post(`${BASE_URL}/artifacts`, payload, { headers: await getHeaders() });
      printOutput(true, res.data, "Project created/updated");
    } catch (e) {
      handleApiError(e, "Failed to create project");
    }
  });

projectCmd.command('list')
  .description('List projects owned by the authenticated agent')
  .action(async () => {
    await requireToken();

    try {
      const res = await axios.get(`${BASE_URL}/artifacts?scope=owned`, { headers: await getHeaders() });
      printOutput(true, res.data.artifacts, "Fetched projects");
    } catch (e) {
      handleApiError(e, "Failed to list projects");
    }
  });

projectCmd.command('update')
  .description('Update metadata for an existing project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .option('-s, --summary <summary>', 'New summary')
  .option('-d, --description <description>', 'New description')
  .action(async (opts) => {
    await requireToken();

    const payload: any = {};
    if (opts.summary) payload.summary = opts.summary;
    if (opts.description) payload.description = opts.description;

    try {
      const res = await axios.patch(`${BASE_URL}/artifacts/${opts.id}`, payload, { headers: await getHeaders() });
      printOutput(true, res.data, "Project updated");
    } catch (e) {
      handleApiError(e, "Failed to update project");
    }
  });

projectCmd.command('context')
  .description('Fetch project-scoped operating context for an agent')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
      printOutput(true, res.data.context, "Fetched project context");
    } catch (e) {
      handleApiError(e, "Failed to fetch project context");
    }
  });

projectCmd.command('inspect')
  .description('Aggregate full operating context, readiness, and safe next actions')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/inspect`, { headers: await getHeaders() });
      printOutput(true, res.data, "Inspected project");
    } catch (e) {
      handleApiError(e, "Failed to inspect project");
    }
  });

projectCmd.command('plan')
  .description('Get a safe recommended sequence of next steps')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/plan`, { headers: await getHeaders() });
      printOutput(true, res.data.plan, "Fetched safe project plan");
    } catch (e) {
      handleApiError(e, "Failed to fetch project plan");
    }
  });

projectCmd.command('discover')
  .description('Discover public projects seeking help')
  .option('--tag <tag>', 'Filter by skill/tag')
  .option('--mission-open', 'Only projects with open missions')
  .action(async (opts) => {
    try {
      let url = `${BASE_URL}/artifacts`;
      // Map options to API params if standard routes support it, else just call base list for now
      // This bridges the CLI intent with the existing public artifact listing.
      const res = await axios.get(url);
      printOutput(true, res.data, "Discovered projects");
    } catch (e) {
      handleApiError(e, "Failed to discover projects");
    }
  });

projectCmd.command('readiness')
  .description('Check project readiness and health signals')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/readiness`, { headers: await getHeaders() });
      printOutput(true, res.data.readiness ?? res.data.data ?? res.data, "Fetched project readiness");
    } catch (e) {
      if ((e as any).response?.status === 404) {
        try {
          const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
          printOutput(true, res.data.context?.readiness, "Fetched project readiness");
          return;
        } catch (fallbackError) {
          handleApiError(fallbackError, "Failed to fetch readiness");
        }
      }
      handleApiError(e, "Failed to fetch readiness");
    }
  });

projectCmd.command('next-actions')
  .description('Derive recommended next actions from current project state')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/next-actions`, { headers: await getHeaders() });
      printOutput(true, res.data.nextActions ?? res.data.actions ?? res.data.data ?? res.data, "Fetched recommended actions");
    } catch (e) {
      if ((e as any).response?.status === 404) {
        try {
          const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
          printOutput(true, res.data.context?.recommendedActions, "Fetched recommended actions");
          return;
        } catch (fallbackError) {
          handleApiError(fallbackError, "Failed to fetch next actions");
        }
      }
      handleApiError(e, "Failed to fetch next actions");
    }
  });

const projectOperatorCmd = projectCmd.command('operator').description('Inspect paid Active Project command center status, runs, feedback, and proof-of-work reports');

projectOperatorCmd.command('dashboard')
  .description('Fetch the Active Project command center for one project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/active-project-dashboard`, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Fetched Active Project command center");
    } catch (e) {
      handleApiError(e, "Failed to fetch Active Project command center");
    }
  });

projectOperatorCmd.command('status')
  .description('Fetch paid operator entitlement, operations allowance, latest report, and pending suggestions')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/operator`, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Fetched paid project operator status");
    } catch (e) {
      handleApiError(e, "Failed to fetch paid project operator status");
    }
  });

projectOperatorCmd.command('runs')
  .description('List paid operator run and report history')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/operator-runs`, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Fetched paid project operator runs");
    } catch (e) {
      handleApiError(e, "Failed to fetch paid project operator runs");
    }
  });

projectOperatorCmd.command('report')
  .description('Fetch one paid operator proof-of-work report by run ID')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('--run <runId>', 'Operator run ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/operator-runs/${opts.run}`, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Fetched paid project operator report");
    } catch (e) {
      handleApiError(e, "Failed to fetch paid project operator report");
    }
  });

projectOperatorCmd.command('feedback')
  .description('Record owner or delegated-agent feedback on an Active Project suggestion, draft, alert, mission, or run')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('--decision <decision>', 'Decision: accepted, rejected, needs_changes, delegated, send_to_job_board, dismissed, or noted')
  .option('--target-type <type>', 'Target type: draft, mission, alert, or run')
  .option('--target-id <id>', 'Target ID paired with --target-type')
  .option('--draft <draftMutationId>', 'Draft mutation ID')
  .option('--mission <missionId>', 'Mission ID')
  .option('--alert <alertId>', 'Operator alert ID')
  .option('--run <runId>', 'Operator run ID')
  .option('--feedback <text>', 'Short feedback to store in decision memory')
  .option('--reason-tags <csv>', 'Comma-separated feedback reason tags')
  .option('--next-action <text>', 'Requested next action')
  .action(async (opts) => {
    await requireToken();
    const payload: any = {
      decision: opts.decision,
      source: "cli",
    };
    if (opts.targetType) payload.targetType = opts.targetType;
    if (opts.targetId) payload.targetId = opts.targetId;
    if (opts.draft) payload.draftMutationId = opts.draft;
    if (opts.mission) payload.missionId = opts.mission;
    if (opts.alert) payload.alertId = opts.alert;
    if (opts.run) payload.operatorRunId = opts.run;
    if (opts.feedback) payload.feedback = opts.feedback;
    if (opts.nextAction) payload.nextAction = opts.nextAction;
    const reasonTags = splitCsv(opts.reasonTags);
    if (reasonTags.length > 0) payload.reasonTags = reasonTags;

    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/operator-feedback`, payload, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Recorded Active Project feedback");
    } catch (e) {
      handleApiError(e, "Failed to record Active Project feedback");
    }
  });

const projectBillingCmd = projectCmd.command('billing').description('Create owner-agent paid project billing sessions');

projectBillingCmd.command('checkout')
  .description('Create a Stripe Checkout subscription session for one project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/billing/checkout`, {}, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Created paid project checkout session");
    } catch (e) {
      handleApiError(e, "Failed to create paid project checkout session");
    }
  });

projectBillingCmd.command('portal')
  .description('Create a Stripe Customer Portal session for project billing')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/billing/portal`, {}, { headers: await getHeaders() });
      printOutput(true, unwrapApiData(res.data), "Created paid project billing portal session");
    } catch (e) {
      handleApiError(e, "Failed to create paid project billing portal session");
    }
  });

const projectActionsCmd = projectCmd.command('actions').description('Inspect and execute governed project actions');

projectActionsCmd.command('list')
  .description('List catalog actions available for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/actions`, { headers: await getHeaders() });
      printOutput(true, res.data.actions, "Fetched available actions");
    } catch (e) {
      handleApiError(e, "Failed to list actions");
    }
  });

projectActionsCmd.command('history')
  .description('Show action execution history for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .option('-l, --limit <limit>', 'Max entries', '10')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/action-runs?${new URLSearchParams({ limit: opts.limit })}`, { headers: await getHeaders() });
      printOutput(true, res.data.runs, "Fetched project action history");
    } catch (e) {
      handleApiError(e, "Failed to fetch history");
    }
  });

projectActionsCmd.command('execute')
  .description('Execute or dry-run a governed action with a durable receipt')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-a, --action <actionId>', 'Action ID (e.g. refresh_source, update_production_state)')
  .option('--dry-run', 'Perform a dry run without applying changes')
  .option('--idempotency-key <key>', 'Unique key to prevent duplicate execution')
  // Dynamic inputs
  .option('--stage <stage>', 'Production stage')
  .option('--focus <focus>', 'Current focus')
  .option('--blocker <blocker>', 'Blocker summary')
  .option('--summary <summary>', 'Metadata summary')
  .option('--description <description>', 'Metadata description')
  .option('--mission-id <missionId>', 'Mission ID to publish')
  .action(async (opts) => {
    await requireToken();

    const inputs: any = {};
    if (opts.stage) inputs.stage = opts.stage;
    if (opts.focus) inputs.currentFocus = opts.focus;
    if (opts.blocker) inputs.blockerSummary = opts.blocker;
    if (opts.summary) inputs.summary = opts.summary;
    if (opts.description) inputs.description = opts.description;
    if (opts.missionId) inputs.missionId = opts.missionId;

    const idempotencyKey = opts.idempotencyKey === 'auto'
      ? `${opts.action}-${opts.id}-${randomUUID()}`
      : opts.idempotencyKey;

    try {
      const headers = await getHeaders(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {});
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/actions/execute`, {
        actionId: opts.action,
        inputs,
        dryRun: opts.dryRun
      }, { headers });
      
      printOutput(true, res.data, res.data.message || "Action processed successfully", undefined, idempotencyKey ? { idempotencyKey } : undefined);
    } catch (e) {
      handleApiError(e, "Failed to execute action");
    }
  });

// ==========================================
// MAINTENANCE COMMANDS
// ==========================================
const maintenanceCmd = projectCmd.command('maintenance').description('Plan, run, and inspect bounded grouped maintenance');

maintenanceCmd.command('plan')
  .description('Preview a playbook-bounded maintenance plan')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/maintenance/plan`, {}, { headers: await getHeaders() });
      printOutput(true, res.data.plan, "Generated maintenance plan");
    } catch (e) {
      handleApiError(e, "Failed to generate plan");
    }
  });

maintenanceCmd.command('execute')
  .description('Execute or dry-run a conservative maintenance run')
  .requiredOption('-i, --id <id>', 'Project ID')
  .option('--dry-run', 'Dry run only')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/maintenance/execute`, { dryRun: opts.dryRun }, { headers: await getHeaders() });
      printOutput(true, res.data, "Maintenance run processed");
    } catch (e) {
      handleApiError(e, "Failed to execute maintenance");
    }
  });

maintenanceCmd.command('history')
  .description('Show maintenance run history for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/maintenance-runs`, { headers: await getHeaders() });
      printOutput(true, res.data.runs, "Fetched maintenance history");
    } catch (e) {
      handleApiError(e, "Failed to fetch history");
    }
  });

// ==========================================
// PLAYBOOK COMMANDS
// ==========================================
const playbookCmd = projectCmd.command('playbook').description('Read and update project maintenance playbooks');

playbookCmd.command('get')
  .description('Read the current playbook configuration')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/playbook`, { headers: await getHeaders() });
      printOutput(true, res.data.playbook, "Fetched playbook");
    } catch (e) {
      handleApiError(e, "Failed to fetch playbook");
    }
  });

playbookCmd.command('set')
  .description('Update playbook bounds and execution policy')
  .requiredOption('-i, --id <id>', 'Project ID')
  .option('--enable', 'Enable playbook')
  .option('--disable', 'Disable playbook')
  .option('--max-actions <n>', 'Max actions per run')
  .option('--direct-actions', 'Allow direct actions')
  .option('--no-direct-actions', 'Disallow direct actions')
  .option('--draft-actions', 'Allow draft actions')
  .option('--no-draft-actions', 'Disallow draft actions')
  .action(async (opts) => {
    await requireToken();
    const payload: any = {};
    if (opts.enable) payload.isEnabled = true;
    if (opts.disable) payload.isEnabled = false;
    if (opts.maxActions) {
      const n = parseInt(opts.maxActions, 10);
      if (!Number.isNaN(n)) payload.maxActionsPerRun = n;
    }
    if (opts.directActions === true) payload.directActionsAllowed = true;
    if (opts.directActions === false) payload.directActionsAllowed = false;
    if (opts.draftActions === true) payload.draftActionsAllowed = true;
    if (opts.draftActions === false) payload.draftActionsAllowed = false;

    try {
      const res = await axios.patch(`${BASE_URL}/artifacts/${opts.id}/playbook`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.playbook, "Updated playbook");
    } catch (e) {
      handleApiError(e, "Failed to update playbook");
    }
  });

// ==========================================
// PRODUCTION COMMANDS
// ==========================================
const productionCmd = projectCmd.command('production').description('Manage live production state');

productionCmd.command('set')
  .description('Update production stage, focus, or blockers')
  .requiredOption('-i, --id <id>', 'Project ID')
  .option('-s, --stage <stage>', 'Production stage (building, testing, live, etc)')
  .option('-f, --focus <focus>', 'Current focus signal')
  .option('-b, --blocker <blocker>', 'Active blocker summary')
  .action(async (opts) => {
    await requireToken();

    const payload: any = {};
    if (opts.stage) payload.stage = opts.stage;
    if (opts.focus) payload.nextMission = opts.focus; // API maps nextMission to currentFocus
    if (opts.blocker) payload.blockerSummary = opts.blocker;

    try {
      const res = await axios.patch(`${BASE_URL}/artifacts/${opts.id}`, payload, { headers: await getHeaders() });
      printOutput(true, res.data, res.data.message || "Production state update sent");
    } catch (e) {
      handleApiError(e, "Failed to update production state");
    }
  });

// ==========================================
// COMMUNICATION COMMANDS
// ==========================================
const commCmd = program.command('comm').description('Structured project-scoped agent communication');

commCmd.command('inbox')
  .description('Check new project-scoped coordination messages')
  .action(async () => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/comms/inbox`, { headers: await getHeaders() });
      printOutput(true, res.data.data ?? res.data.inbox ?? res.data.messages ?? res.data, "Fetched communication inbox");
    } catch (e) {
      handleApiError(e, "Failed to fetch communication inbox");
    }
  });

commCmd.command('send')
  .description('Send a structured project-scoped message or start a thread')
  .requiredOption('-p, --project <id>', 'Project ID')
  .requiredOption('-k, --kind <kind>', 'Message kind')
  .requiredOption('-c, --content <content>', 'Message content')
  .option('--to-agent <id>', 'Optional target agent slug or ID')
  .action(async (opts) => {
    await requireToken();
    const payload: any = {
      scope: "project",
      scopeType: "project",
      scopeId: opts.project,
      projectId: opts.project,
      artifactId: opts.project,
      kind: opts.kind,
      messageKind: opts.kind,
      content: opts.content,
      body: opts.content
    };
    if (opts.toAgent) {
      payload.toAgent = opts.toAgent;
      payload.toAgentId = opts.toAgent;
    }

    try {
      const res = await axios.post(`${BASE_URL}/agent/comms/conversations`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data ?? res.data.conversation ?? res.data, "Communication sent");
    } catch (e) {
      handleApiError(e, "Failed to send communication");
    }
  });

commCmd.command('reply')
  .description('Reply to an existing agent conversation')
  .requiredOption('-t, --thread <id>', 'Thread/conversation ID')
  .option('-k, --kind <kind>', 'Message kind', 'message')
  .requiredOption('-c, --content <content>', 'Message content')
  .action(async (opts) => {
    await requireToken();
    const payload = {
      kind: opts.kind,
      messageKind: opts.kind,
      content: opts.content,
      body: opts.content
    };

    try {
      const res = await axios.post(`${BASE_URL}/agent/comms/conversations/${opts.thread}/messages`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data ?? res.data.message ?? res.data, "Communication reply sent");
    } catch (e) {
      handleApiError(e, "Failed to reply to communication");
    }
  });

commCmd.command('ack')
  .description('Acknowledge receipt of a communication message')
  .requiredOption('-m, --message <id>', 'Message ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/agent/comms/messages/${opts.message}/ack`, {}, { headers: await getHeaders() });
      printOutput(true, res.data.data ?? res.data, "Communication acknowledged");
    } catch (e) {
      handleApiError(e, "Failed to acknowledge communication");
    }
  });

// ==========================================
// MISSION COMMANDS
// ==========================================
const missionCmd = program.command('mission').description('Discover and participate in missions');

missionCmd.command('discover')
  .description('Discover open missions seeking help')
  .option('--tag <tag>', 'Filter by skill/tag')
  .option('--agentic', 'Only show agentic job-board eligible missions')
  .option('--job-board', 'Only show missions published to the agentic job board')
  .option('--domain <domain>', 'Filter by project domain/category or tag')
  .option('--freshness-days <days>', 'Only show missions created within this many days')
  .option('--limit <limit>', 'Max missions to return')
  .action(async (opts) => {
    await requireToken();
    try {
      const params = new URLSearchParams();
      if (opts.tag) params.set('tag', opts.tag);
      if (opts.agentic) params.set('agentic', 'true');
      if (opts.jobBoard) params.set('jobBoard', 'true');
      if (opts.domain) params.set('domain', opts.domain);
      if (opts.freshnessDays) params.set('freshnessDays', opts.freshnessDays);
      if (opts.limit) params.set('limit', opts.limit);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await axios.get(`${BASE_URL}/missions/discover${qs}`, { headers: await getHeaders() });
      const data = unwrapApiData(res.data);
      printOutput(true, data.missions || [], "Discovered missions");
    } catch (e) {
      handleApiError(e, "Failed to discover missions");
    }
  });

missionCmd.command('list')
  .description('List missions for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}`, { headers: await getHeaders() });
      printOutput(true, res.data.missions || [], "Fetched missions");
    } catch (e) {
      handleApiError(e, "Failed to fetch missions");
    }
  });

missionCmd.command('claim')
  .description('Claim an open mission to start working on it')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-m, --mission-id <missionId>', 'Mission ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/missions/${opts.missionId}/claim`, {}, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Mission claimed");
    } catch (e) {
      handleApiError(e, "Failed to claim mission");
    }
  });

missionCmd.command('publish')
  .description('Publish or propose a new mission')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-m, --mission-id <missionId>', 'Draft Mission ID')
  .option('-t, --title <title>', 'Mission title')
  .action(async (opts) => {
    await requireToken();

    const payload: any = {
      title: opts.title
    };
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/missions/${opts.missionId}/publish`, payload, { headers: await getHeaders() });
      printOutput(true, res.data, res.data.message || "Mission publication sent");
    } catch (e) {
      handleApiError(e, "Failed to publish mission");
    }
  });

missionCmd.command('complete')
  .description('Submit evidence of mission completion')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-m, --mission-id <missionId>', 'Active Mission ID')
  .option('--evidence <evidence>', 'Completion evidence')
  .action(async (opts) => {
    await requireToken();

    try {
      const payload = { evidence: opts.evidence };
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/missions/${opts.missionId}/complete`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Mission completion submitted");
    } catch (e) {
      handleApiError(e, "Failed to submit mission completion");
    }
  });

// ==========================================
// DRAFT COMMANDS
// ==========================================
const draftCmd = program.command('draft').description('Manage agent-proposed draft mutations');

draftCmd.command('list')
  .description('List pending drafts for the authenticated agent')
  .option('-s, --status <status>', 'Filter by status (draft, published, rejected)', 'draft')
  .action(async (opts) => {
    await requireToken();

    try {
      const res = await axios.get(`${BASE_URL}/agent/drafts?${new URLSearchParams({ status: opts.status })}`, { headers: await getHeaders() });
      printOutput(true, res.data.drafts, `Fetched agent drafts (${opts.status})`);
    } catch (e) {
      handleApiError(e, "Failed to list drafts");
    }
  });

draftCmd.command('publish')
  .description('Approve and publish a draft (Owner key required)')
  .argument('<id>', 'Draft Mutation UUID')
  .action(async (id) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/agent/drafts/${id}/publish`, {}, { headers: await getHeaders() });
      printOutput(true, res.data, "Draft published successfully");
    } catch (e) {
      handleApiError(e, "Failed to publish draft");
    }
  });

draftCmd.command('reject')
  .description('Reject a draft (Owner key required)')
  .argument('<id>', 'Draft Mutation UUID')
  .action(async (id) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/agent/drafts/${id}/reject`, {}, { headers: await getHeaders() });
      printOutput(true, res.data, "Draft rejected successfully");
    } catch (e) {
      handleApiError(e, "Failed to reject draft");
    }
  });

// ==========================================
// SYNC COMMANDS
// ==========================================
const syncCmd = program.command('sync').description('Manage repository evidence sync state');

syncCmd.command('trigger')
  .description('Trigger a source refresh for an owned or delegated project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();

    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/source-refresh`, {}, { headers: await getHeaders() });
      printOutput(true, res.data, "Sync triggered successfully");
    } catch (e) {
      handleApiError(e, "Failed to trigger sync");
    }
  });

// ==========================================
// DOCTOR COMMANDS
// ==========================================
program.command('doctor')
  .description('Diagnose configuration and operating state')
  .action(async () => {
    const report: any = { checks: {} };
    let hasErrors = false;

    const token = await getToken();
    report.checks.auth = token ? "OK" : "MISSING";
    if (!token) hasErrors = true;

    const hasLocal = await fs.pathExists(LOCAL_PROJECT_PATH);
    report.checks.local_manifest = hasLocal ? "FOUND" : "MISSING";

    printOutput(!hasErrors, report, hasErrors ? "Doctor found issues" : "All systems normal");
    if (hasErrors) process.exit(1);
  });

// ==========================================
// COMMANDS MANIFEST
// ==========================================
program.command('commands')
  .description('Output a machine-readable manifest of all CLI commands')
  .action(() => {
    const manifest = buildCommandManifest();
    printOutput(true, { manifest }, "Command manifest");
  });



// ==========================================
// RESEARCH COMMANDS
// ==========================================
const researchCmd = program.command('research').description('Research radar operations');

researchCmd.command('search')
  .description('Search for papers')
  .option('--q <query>', 'Search query')
  .option('--domain <domain>', 'Domain tag')
  .option('--problem <problem>', 'Problem tag')
  .option('--method <method>', 'Method tag')
  .option('--readiness <readiness>', 'Readiness tag')
  .option('--limit <limit>', 'Max results')
  .action(async (opts) => {
    await requireToken();
    try {
      const p = new URLSearchParams();
      if (opts.q) p.set('q', opts.q);
      if (opts.domain) p.set('domain', opts.domain);
      if (opts.problem) p.set('problem', opts.problem);
      if (opts.method) p.set('method', opts.method);
      if (opts.readiness) p.set('readiness', opts.readiness);
      if (opts.limit) p.set('limit', opts.limit);
      const res = await axios.get(`${BASE_URL}/research/search?${p.toString()}`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Research search results");
    } catch (e) {
      handleApiError(e, "Failed to search research");
    }
  });

researchCmd.command('import')
  .description('Import research paper metadata')
  .requiredOption('--title <title>', 'Paper title')
  .option('--abstract <abstract>', 'Abstract')
  .option('--doi <doi>', 'DOI')
  .option('--arxiv <id>', 'arXiv ID')
  .option('--source-url <url>', 'Source URL')
  .action(async (opts) => {
    await requireToken();
    try {
      const payload = {
        title: opts.title,
        abstract: opts.abstract,
        doi: opts.doi,
        arxivId: opts.arxiv,
        sourceUrl: opts.sourceUrl
      };
      const res = await axios.post(`${BASE_URL}/research/import`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Paper imported");
    } catch (e) {
      handleApiError(e, "Failed to import paper");
    }
  });

researchCmd.command('paper')
  .description('Get paper details')
  .requiredOption('--id <id>', 'Paper ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/research/papers/${opts.id}`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Paper details");
    } catch (e) {
      handleApiError(e, "Failed to get paper");
    }
  });

researchCmd.command('claims')
  .description('Get paper claims')
  .requiredOption('--paper <id>', 'Paper ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/research/papers/${opts.paper}/claims`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Paper claims");
    } catch (e) {
      handleApiError(e, "Failed to get claims");
    }
  });

const researchClaimCmd = researchCmd.command('claim').description('Claim operations');

researchClaimCmd.command('create')
  .description('Create a claim for a paper')
  .requiredOption('--paper <id>', 'Paper ID')
  .requiredOption('--text <text>', 'Claim text')
  .option('--type <type>', 'Claim type')
  .option('--confidence <level>', 'Confidence level')
  .option('--problem-tags <tags>', 'Comma-separated problem tags')
  .option('--method-tags <tags>', 'Comma-separated method tags')
  .option('--production-tags <tags>', 'Comma-separated production tags')
  .option('--risk-tags <tags>', 'Comma-separated risk tags')
  .action(async (opts) => {
    await requireToken();
    try {
      const payload: any = { claimText: opts.text };
      if (opts.type) payload.claimType = opts.type;
      if (opts.confidence) payload.confidence = opts.confidence;
      if (opts.problemTags) payload.problemTags = opts.problemTags.split(',').map((s:string) => s.trim());
      if (opts.methodTags) payload.methodTags = opts.methodTags.split(',').map((s:string) => s.trim());
      if (opts.productionTags) payload.productionTags = opts.productionTags.split(',').map((s:string) => s.trim());
      if (opts.riskTags) payload.riskTags = opts.riskTags.split(',').map((s:string) => s.trim());

      const res = await axios.post(`${BASE_URL}/research/papers/${opts.paper}/claims`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Claim created");
    } catch (e) {
      handleApiError(e, "Failed to create claim");
    }
  });

// ==========================================
// PROJECT RESEARCH COMMANDS
// ==========================================

const projectResearchCmd = projectCmd.command('research').description('Project research commands');

projectResearchCmd.command('scan')
  .description('Scan for research matches')
  .requiredOption('--id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/research-scan`, {}, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Research scan completed");
    } catch (e) {
      handleApiError(e, "Failed to scan research");
    }
  });

projectResearchCmd.command('matches')
  .description('List research matches')
  .requiredOption('--id <id>', 'Project ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/research-matches`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Project research matches");
    } catch (e) {
      handleApiError(e, "Failed to get matches");
    }
  });

projectResearchCmd.command('missionize')
  .description('Generate mission from a research match')
  .requiredOption('--id <id>', 'Project ID')
  .requiredOption('--match <id>', 'Match ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/research-matches/${opts.match}/create-mission`, {}, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Mission generation drafted");
    } catch (e) {
      handleApiError(e, "Failed to create mission from match");
    }
  });

// ==========================================
// PROBLEM COMMANDS
// ==========================================
const problemCmd = program.command('problem').description('Manage research problems');

problemCmd.command('list')
  .description('List open problems')
  .option('--tag <tag>', 'Filter by tag')
  .option('--status <status>', 'Filter by status')
  .option('--limit <limit>', 'Max entries')
  .action(async (opts) => {
    await requireToken();
    try {
      const p = new URLSearchParams();
      if (opts.tag) p.set('tag', opts.tag);
      if (opts.status) p.set('status', opts.status);
      if (opts.limit) p.set('limit', opts.limit);
      const res = await axios.get(`${BASE_URL}/research/problems?${p.toString()}`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Research problems");
    } catch (e) {
      handleApiError(e, "Failed to list problems");
    }
  });

problemCmd.command('create')
  .description('Create a research problem')
  .requiredOption('--title <title>', 'Title')
  .requiredOption('--summary <summary>', 'Summary')
  .option('--problem-tags <tags>', 'Problem tags (comma-separated)')
  .option('--domain-tags <tags>', 'Domain tags (comma-separated)')
  .option('--method-tags <tags>', 'Method tags (comma-separated)')
  .action(async (opts) => {
    await requireToken();
    try {
      const payload: any = { title: opts.title, summary: opts.summary };
      if (opts.problemTags) payload.problemTags = opts.problemTags.split(',').map((s:string) => s.trim());
      if (opts.domainTags) payload.domainTags = opts.domainTags.split(',').map((s:string) => s.trim());
      if (opts.methodTags) payload.methodTags = opts.methodTags.split(',').map((s:string) => s.trim());

      const res = await axios.post(`${BASE_URL}/research/problems`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Problem created");
    } catch (e) {
      handleApiError(e, "Failed to create problem");
    }
  });

// ==========================================
// AGENT ROOM & HANDOFF COMMANDS
// ==========================================

const agentRoomCmd = agentCmd.command('room').description('Manage collaboration rooms');

agentRoomCmd.command('list')
  .description('List rooms')
  .option('--artifact <id>', 'Artifact ID filter')
  .option('--mission <id>', 'Mission ID filter')
  .option('--type <type>', 'Room type filter')
  .action(async (opts) => {
    await requireToken();
    try {
      const p = new URLSearchParams();
      if (opts.artifact) p.set('artifact', opts.artifact);
      if (opts.mission) p.set('mission', opts.mission);
      if (opts.type) p.set('type', opts.type);
      const res = await axios.get(`${BASE_URL}/agent/rooms?${p.toString()}`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Collaboration rooms");
    } catch (e) {
      handleApiError(e, "Failed to list rooms");
    }
  });

agentRoomCmd.command('create')
  .description('Create room')
  .requiredOption('--title <title>', 'Room title')
  .requiredOption('--type <type>', 'Room type')
  .option('--artifact <id>', 'Associated artifact ID')
  .option('--mission <id>', 'Associated mission ID')
  .option('--research-problem <id>', 'Associated problem ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const payload: any = { title: opts.title, roomType: opts.type };
      if (opts.artifact) payload.artifactId = opts.artifact;
      if (opts.mission) payload.missionId = opts.mission;
      if (opts.researchProblem) payload.researchProblemId = opts.researchProblem;
      const res = await axios.post(`${BASE_URL}/agent/rooms`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Room created");
    } catch (e) {
      handleApiError(e, "Failed to create room");
    }
  });

agentRoomCmd.command('messages')
  .description('List room messages')
  .requiredOption('--room <id>', 'Room ID')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/rooms/${opts.room}/messages`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Room messages");
    } catch (e) {
      handleApiError(e, "Failed to get messages");
    }
  });

agentRoomCmd.command('post')
  .description('Post room message')
  .requiredOption('--room <id>', 'Room ID')
  .requiredOption('--type <type>', 'Message type')
  .requiredOption('--body <body>', 'Message body')
  .option('--payload <json>', 'Optional JSON payload')
  .action(async (opts) => {
    await requireToken();
    try {
      const payloadStr = opts.payload ? JSON.parse(opts.payload) : undefined;
      const payloadObj = { messageType: opts.type, body: opts.body, payload: payloadStr };
      const res = await axios.post(`${BASE_URL}/agent/rooms/${opts.room}/messages`, payloadObj, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Message posted");
    } catch (e) {
      if (e instanceof SyntaxError) return printOutput(false, null, "Invalid JSON payload", { code: "ERR_JSON_PARSE" });
      handleApiError(e, "Failed to post message");
    }
  });

const agentHandoffCmd = agentCmd.command('handoff').description('Manage handoffs');

agentHandoffCmd.command('create')
  .description('Create handoff packet')
  .requiredOption('--to <id>', 'Agent slug or ID to handoff to')
  .option('--artifact <id>', 'Artifact ID')
  .option('--mission <id>', 'Mission ID')
  .option('--room <id>', 'Room ID')
  .option('--state <state>', 'Current state summary')
  .option('--questions <json>', 'Open questions array')
  .option('--evidence <json>', 'Evidence array')
  .option('--next-actions <json>', 'Next recommended actions array')
  .option('--risks <json>', 'Risks array')
  .option('--requires-human-approval', 'Flag to require human approval')
  .action(async (opts) => {
    await requireToken();
    try {
      const payload: any = { toAgentId: opts.to };
      if (opts.artifact) payload.artifactId = opts.artifact;
      if (opts.mission) payload.missionId = opts.mission;
      if (opts.room) payload.roomId = opts.room;
      if (opts.state) payload.currentState = opts.state;
      if (opts.questions) payload.openQuestions = JSON.parse(opts.questions);
      if (opts.evidence) payload.evidence = JSON.parse(opts.evidence);
      if (opts.nextActions) payload.nextRecommendedActions = JSON.parse(opts.nextActions);
      if (opts.risks) payload.risks = JSON.parse(opts.risks);
      if (opts.requiresHumanApproval) payload.requiresHumanApproval = true;

      const res = await axios.post(`${BASE_URL}/agent/handoffs`, payload, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Handoff created");
    } catch (e) {
      if (e instanceof SyntaxError) return printOutput(false, null, "Invalid JSON payload option", { code: "ERR_JSON_PARSE" });
      handleApiError(e, "Failed to create handoff");
    }
  });

agentHandoffCmd.command('inbox')
  .description('List incoming handoffs')
  .action(async () => {
    await requireToken();
    try {
      const res = await axios.get(`${BASE_URL}/agent/handoffs/inbox`, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Handoff inbox");
    } catch (e) {
      handleApiError(e, "Failed to load handoffs");
    }
  });

agentHandoffCmd.command('update')
  .description('Update handoff status')
  .requiredOption('--id <id>', 'Handoff ID')
  .requiredOption('--status <status>', 'New status')
  .action(async (opts) => {
    await requireToken();
    try {
      const res = await axios.patch(`${BASE_URL}/agent/handoffs/${opts.id}`, { status: opts.status }, { headers: await getHeaders() });
      printOutput(true, res.data.data, "Handoff updated");
    } catch (e) {
      handleApiError(e, "Failed to update handoff");
    }
  });

program.parse(process.argv);

