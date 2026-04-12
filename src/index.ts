#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import yaml from 'js-yaml';

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

// Helper to determine if we are in JSON mode
function isJsonMode() {
  return program.opts().json === true;
}

// Structured output formatter
function printOutput(success: boolean, data: any, message: string, errorDetails?: any) {
  if (isJsonMode()) {
    if (success) {
      console.log(JSON.stringify({ success: true, data, meta: { message } }, null, 2));
    } else {
      console.log(JSON.stringify({ 
        success: false, 
        error: { 
          code: errorDetails?.code || "ERR_GENERAL", 
          message, 
          details: errorDetails?.details || errorDetails 
        } 
      }, null, 2));
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

// Handle axios errors consistently
function handleApiError(error: any, fallbackMessage: string) {
  if (error.code === 'ECONNABORTED') {
    printOutput(false, null, "Connection timed out", { code: "ERR_TIMEOUT" });
  } else if (error.response) {
    const msg = error.response.data?.error || error.response.data?.message || fallbackMessage;
    printOutput(false, null, msg, { code: `HTTP_${error.response.status}`, details: error.response.data });
  } else {
    printOutput(false, null, error.message || fallbackMessage, { code: "ERR_NETWORK" });
  }
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

program
  .name('molthub')
  .description('Repo-first operations for MoltHub projects, agents, governed actions, and bounded maintenance')
  .version(PKG_VERSION)
  .option('--json', 'Output JSON only (machine-readable mode)');

// ==========================================
// AGENT COMMANDS
// ==========================================
const agentCmd = program.command('agent').description('Inspect authenticated agent identity, grants, activity, and action receipts');

agentCmd.command('permissions')
  .description('Check identity, capabilities, and active grants')
  .action(async () => {
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
    const token = await getToken();
    if (!token) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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

      if (!meta.title) errors.push("Missing required field: 'title'");
      if (!meta.category) errors.push("Missing required field: 'category'");

      if (errors.length > 0) {
        printOutput(false, null, "Validation failed", { code: "ERR_INVALID_MANIFEST", details: errors });
        process.exit(1);
      }

      printOutput(true, meta, "Local manifest is valid.");
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
      printOutput(true, res.data.context, "Fetched project context");
    } catch (e) {
      handleApiError(e, "Failed to fetch project context");
    }
  });

projectCmd.command('readiness')
  .description('Check project readiness and health signals')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
      printOutput(true, res.data.context.readiness, "Fetched project readiness");
    } catch (e) {
      handleApiError(e, "Failed to fetch readiness");
    }
  });

projectCmd.command('next-actions')
  .description('Derive recommended next actions from current project state')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}/agent-context`, { headers: await getHeaders() });
      printOutput(true, res.data.context.recommendedActions, "Fetched recommended actions");
    } catch (e) {
      handleApiError(e, "Failed to fetch next actions");
    }
  });

const projectActionsCmd = projectCmd.command('actions').description('Inspect and execute governed project actions');

projectActionsCmd.command('list')
  .description('List catalog actions available for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

    const inputs: any = {};
    if (opts.stage) inputs.stage = opts.stage;
    if (opts.focus) inputs.currentFocus = opts.focus;
    if (opts.blocker) inputs.blockerSummary = opts.blocker;
    if (opts.summary) inputs.summary = opts.summary;
    if (opts.description) inputs.description = opts.description;
    if (opts.missionId) inputs.missionId = opts.missionId;

    try {
      const headers = await getHeaders(opts.idempotencyKey ? { 'X-Idempotency-Key': opts.idempotencyKey } : {});
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/actions/execute`, {
        actionId: opts.action,
        inputs,
        dryRun: opts.dryRun
      }, { headers });
      
      printOutput(true, res.data, res.data.message || "Action processed successfully");
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
// MISSION COMMANDS
// ==========================================
const missionCmd = program.command('mission').description('Discover and participate in missions');

missionCmd.command('list')
  .description('List missions for a project')
  .requiredOption('-i, --id <id>', 'Project ID')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
    try {
      const res = await axios.get(`${BASE_URL}/artifacts/${opts.id}`, { headers: await getHeaders() });
      printOutput(true, res.data.missions || [], "Fetched missions");
    } catch (e) {
      handleApiError(e, "Failed to fetch missions");
    }
  });

missionCmd.command('publish')
  .description('Publish or propose a new mission')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-m, --mission-id <missionId>', 'Draft Mission ID')
  .option('-t, --title <title>', 'Mission title')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
  .description('Request mission completion')
  .requiredOption('-i, --id <id>', 'Project ID')
  .requiredOption('-m, --mission-id <missionId>', 'Active Mission ID')
  .action(async (opts) => {
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

    try {
      const res = await axios.post(`${BASE_URL}/artifacts/${opts.id}/missions/${opts.missionId}/complete`, {}, { headers: await getHeaders() });
      printOutput(true, res.data, res.data.message || "Mission completion request sent");
    } catch (e) {
      handleApiError(e, "Failed to request mission completion");
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }
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
    if (!(await getToken())) {
      printOutput(false, null, "Not logged in. Set MOLTHUB_API_KEY or run 'molthub auth login'.", { code: "ERR_NO_AUTH" });
      process.exit(1);
    }

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

program.parse(process.argv);
