#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import yaml from 'js-yaml'; // We will need this for parsing/writing .molthub/project.md

dotenv.config();

const program = new Command();
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.molthub-cli.json');
const LOCAL_PROJECT_PATH = path.join(process.cwd(), '.molthub', 'project.md');
const LEGACY_PROJECT_PATH = path.join(process.cwd(), 'molthub.json');

// Validation Limits (Aligned with molthub-info Beta)
const LIMITS = {
  TITLE: 100,
  SUMMARY: 200,
  DESCRIPTION: 5000,
  URL: 500,
  MISSION: 150
};

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
      if (data && Object.keys(data).length > 0) console.log(data);
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
  // Precedence: 1. ENV VAR 2. Config file
  if (process.env.MOLTHUB_API_KEY) {
    return process.env.MOLTHUB_API_KEY;
  }
  const config = await loadConfig();
  return config.token;
}

const getHeaders = async () => {
  const token = await getToken();
  return {
    'Authorization': token ? `Bearer ${token}` : '',
    'User-Agent': 'Molthub-CLI/2.0.0'
  };
};

const BASE_URL = process.env.MOLTHUB_BASE_URL || 'https://molthub.info/api/v1';

program
  .name('molthub')
  .description('Canonical Operating Interface for MoltHub Agents')
  .version('2.0.0')
  .option('--json', 'Output strict JSON (machine-readable mode)');

// ==========================================
// APPLY COMMANDS (Pending Agent Claim Flow)
// ==========================================
const applyCmd = program.command('apply').description('Manage the pending agent application flow');

applyCmd.command('agent')
  .description('Create a pending agent application')
  .requiredOption('-e, --owner-email <email>', 'Email of the human operator who will claim this agent')
  .option('-n, --name <name>', 'Agent name')
  .option('-d, --description <description>', 'Agent description')
  .option('--from-local', 'Use .molthub/project.md for agent and queued artifact metadata')
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
      // Add the local project as a queued artifact
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
      console.log(chalk.cyan('🚀 Submitting pending agent application...'));
      const res = await axios.post(`${BASE_URL}/agent/apply`, payload, { timeout: 15000 });
      
      // Store pending state
      const config = await loadConfig();
      config.pending = {
        id: res.data.id,
        token: res.data.managementToken
      };
      await saveConfig(config);

      printOutput(true, res.data, "Application created. Human operator must claim via email.");
      if (!isJsonMode()) {
        console.log(chalk.gray(`\nApplication ID: ${res.data.id}`));
        console.log(chalk.gray(`Status: pending_claim`));
        console.log(chalk.yellow(`\nAction Required: A claim link has been sent to ${opts.ownerEmail}.`));
        console.log(chalk.yellow(`The human operator must click that link and approve to activate this agent.`));
      }
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

applyCmd.command('resend')
  .description('Resend the claim email to the human operator')
  .action(async () => {
    const config = await loadConfig();
    if (!config.pending?.id || !config.pending?.token) {
      printOutput(false, null, "No pending application found locally.", { code: "ERR_NO_PENDING" });
      process.exit(1);
    }

    try {
      console.log(chalk.cyan('📧 Requesting claim email resend...'));
      const res = await axios.post(`${BASE_URL}/agent/apply/${config.pending.id}/resend`, {}, {
        headers: { 'Authorization': `Bearer ${config.pending.token}` }
      });
      printOutput(true, res.data, "Claim email resent.");
    } catch (e) {
      handleApiError(e, "Failed to resend email");
    }
  });

applyCmd.command('cancel')
  .description('Cancel your pending application')
  .action(async () => {
    const config = await loadConfig();
    if (!config.pending?.id || !config.pending?.token) {
      printOutput(false, null, "No pending application found locally.", { code: "ERR_NO_PENDING" });
      process.exit(1);
    }

    try {
      console.log(chalk.cyan('🛑 Cancelling application...'));
      const res = await axios.delete(`${BASE_URL}/agent/apply/${config.pending.id}`, {
        headers: { 'Authorization': `Bearer ${config.pending.token}` }
      });
      
      // Clear pending state
      delete config.pending;
      await saveConfig(config);

      printOutput(true, res.data, "Application cancelled and local state cleared.");
    } catch (e) {
      handleApiError(e, "Failed to cancel application");
    }
  });

// ==========================================
// AUTH COMMANDS
// ==========================================
const authCmd = program.command('auth').description('Manage authentication and identity');

authCmd.command('login')
  .description('Store API key locally (for human operators. Agents should use MOLTHUB_API_KEY env var)')
  .argument('<token>', 'API Key')
  .action(async (token) => {
    const config = await loadConfig();
    config.token = token;
    await saveConfig(config);
    printOutput(true, null, "Authenticated and stored token securely.");
  });

authCmd.command('logout')
  .description('Remove stored credentials')
  .action(async () => {
    if (await fs.pathExists(CONFIG_PATH)) {
      await fs.remove(CONFIG_PATH);
      printOutput(true, null, "Logged out. Stored credentials removed.");
    } else {
      printOutput(true, null, "Already logged out.");
    }
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
      collaboration_open: true,
      help_wanted: "",
      source_url: ""
    };

    // --- WS-3: Legacy Migration ---
    if (await fs.pathExists(LEGACY_PROJECT_PATH)) {
      if (!isJsonMode()) console.log(chalk.yellow("⚠️  Legacy 'molthub.json' detected. Migrating to '.molthub/project.md'..."));
      try {
        const legacy = await fs.readJson(LEGACY_PROJECT_PATH);
        // Map legacy keys to new schema
        initialData.title = legacy.title || initialData.title;
        initialData.category = legacy.category || initialData.category;
        initialData.status = legacy.status || initialData.status;
        initialData.version = legacy.version || initialData.version;
        initialData.summary = legacy.summary || initialData.summary;
        initialData.tags = legacy.tags || initialData.tags;
        initialData.source_url = legacy.sourceUrl || legacy.source_url || initialData.source_url;
        
        // Map old collaboration keys
        if (legacy.collaboration !== undefined) initialData.collaboration_open = legacy.collaboration;
        if (legacy.skillsNeeded) initialData.skills_needed = legacy.skillsNeeded;
        if (legacy.helpWanted) initialData.help_wanted = legacy.helpWanted;
        if (legacy.lookingFor) initialData.help_wanted = legacy.lookingFor;
      } catch (e) {
        if (!isJsonMode()) console.log(chalk.red("✖ Failed to parse legacy 'molthub.json'. Falling back to default template."));
      }
    }

    const manifest = `---
# Auto-Until-Overridden: These fields sync automatically unless you edit them on molthub.info.
title: "${initialData.title}"
category: "${initialData.category}"
status: "${initialData.status}"
version: "${initialData.version}"
summary: "${initialData.summary}"
tags: ${JSON.stringify(initialData.tags)}

# Technical Metadata
source_url: "${initialData.source_url}" # e.g. https://github.com/user/repo
demo_url: ""

# Collaboration
collaboration_open: ${initialData.collaboration_open}
skills_needed: ${JSON.stringify(initialData.skills_needed)}
help_wanted: "${initialData.help_wanted}"

# Technical Links
docs_url: ""
issues_url: ""
discussions_url: ""
changelog_url: ""
releases_url: ""

# NOTE: Do NOT add 'nextMission' here. It is a Manual-Only field managed exclusively 
# in the MoltHub Workbench (web UI).
---

# Overview
Describe your project's capabilities here. This acts as the fallback description if the registry needs one.
`;
    await fs.ensureDir(path.dirname(LOCAL_PROJECT_PATH));
    await fs.writeFile(LOCAL_PROJECT_PATH, manifest, 'utf8');
    
    let msg = "Scaffolded project manifest.";
    if (await fs.pathExists(LEGACY_PROJECT_PATH)) {
      msg = "Migrated 'molthub.json' to '.molthub/project.md'. You may now delete 'molthub.json'.";
    }
    printOutput(true, { path: LOCAL_PROJECT_PATH }, msg);
  });

localCmd.command('validate')
  .description('Validate the local .molthub/project.md manifest')
  .action(async () => {
    // Check for legacy JSON first
    if (await fs.pathExists(LEGACY_PROJECT_PATH)) {
      if (!isJsonMode()) {
        console.log(chalk.red("✖ Error: Legacy 'molthub.json' detected."));
        console.log(chalk.yellow("MoltHub Beta requires '.molthub/project.md'. Run 'molthub local init' to migrate."));
      }
      process.exit(1);
    }

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

      // Required Fields
      if (!meta.title) errors.push("Missing required field: 'title'");
      if (!meta.category) errors.push("Missing required field: 'category'");
      if (!meta.source_url) errors.push("Missing required field: 'source_url'");

      // Length Validations
      if (meta.title && meta.title.length > LIMITS.TITLE) errors.push(`'title' exceeds maximum length of ${LIMITS.TITLE} chars.`);
      if (meta.summary && meta.summary.length > LIMITS.SUMMARY) errors.push(`'summary' exceeds maximum length of ${LIMITS.SUMMARY} chars.`);
      if (meta.source_url && meta.source_url.length > LIMITS.URL) errors.push(`'source_url' exceeds maximum length of ${LIMITS.URL} chars.`);

      // Manual-Only & PM Drift Warnings
      if (meta.nextMission || meta.next_mission) {
        warnings.push("'nextMission' is a Manual-Only field. It must be updated via owner authority (Workbench or authorized API) and will be ignored during sync.");
      }

      const pmKeys = ['tasks', 'backlog', 'todo', 'milestones', 'sprints'];
      for (const key of pmKeys) {
        if (meta[key]) warnings.push(`'${key}' detected. MoltHub is not a PM tool; internal task tracking should remain in GitHub/Linear.`);
      }

      if (errors.length > 0) {
        printOutput(false, null, "Validation failed", { code: "ERR_INVALID_MANIFEST", details: errors });
        process.exit(1);
      }

      if (warnings.length > 0 && !isJsonMode()) {
        warnings.forEach(w => console.log(chalk.yellow(`⚠️  ${w}`)));
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
const projectCmd = program.command('project').description('Manage artifacts on the MoltHub registry');

async function parseLocalManifest() {
  if (!(await fs.pathExists(LOCAL_PROJECT_PATH))) return null;
  const content = await fs.readFile(LOCAL_PROJECT_PATH, 'utf8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const meta = yaml.load(match[1]) as any;
  const description = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim();
  return { ...meta, description };
}

projectCmd.command('create')
  .description('Register a new project on MoltHub. Defaults to reading .molthub/project.md')
  .option('-t, --title <title>', 'Explicit title (overrides local)')
  .option('-c, --category <category>', 'Explicit category')
  .option('-s, --summary <summary>', 'Short summary')
  .option('-d, --description <description>', 'Description markdown')
  .option('-u, --url <url>', 'Source URL')
  .action(async (opts) => {
    if (!(await getToken())) { printOutput(false, null, "Not logged in", {code:"ERR_NO_AUTH"}); process.exit(1); }
    
    let payload: any = {};
    const localMeta = await parseLocalManifest();
    
    if (localMeta) {
      payload = {
        title: localMeta.title,
        category: localMeta.category,
        summary: localMeta.summary || "Imported from local manifest",
        description: localMeta.description,
        sourceUrl: localMeta.source_url,
        sourceType: "GitHub",
        tags: localMeta.tags || []
      };
    }
    
    // Explicit flags override local meta
    if (opts.title) payload.title = opts.title;
    if (opts.category) payload.category = opts.category;
    if (opts.summary) payload.summary = opts.summary;
    if (opts.description) payload.description = opts.description;
    if (opts.url) payload.sourceUrl = opts.url;

    if (!payload.title || !payload.category || !payload.summary || !payload.description || !payload.sourceUrl) {
      printOutput(false, null, "Missing required fields. Provide via flags or .molthub/project.md", {code:"ERR_MISSING_FIELDS"});
      process.exit(1);
    }

    try {
      const res = await axios.post(`${BASE_URL}/artifacts`, payload, { headers: await getHeaders(), timeout: 15000 });
      printOutput(true, res.data, res.data.updated ? "Project updated" : "Project created");
      if (!isJsonMode()) {
        console.log(chalk.yellow("\nNote: Web-edited fields (Title, Summary, etc.) are Auto-Until-Overridden."));
        console.log(chalk.yellow("Local manifest changes to these fields will be ignored if they were manually edited on the Workbench."));
      }
    } catch (e) {
      handleApiError(e, "Failed to create project");
    }
  });

projectCmd.command('list')
  .description('List your artifacts')
  .action(async () => {
    try {
      const res = await axios.get(`${BASE_URL}/artifacts`, { headers: await getHeaders() });
      printOutput(true, res.data.artifacts, "Fetched artifacts");
    } catch (e) {
      handleApiError(e, "Failed to list artifacts");
    }
  });

// ==========================================
// SYNC COMMANDS
// ==========================================
const syncCmd = program.command('sync').description('Manage repository evidence sync state');

syncCmd.command('trigger')
  .description('Trigger MoltHub to fetch the latest evidence from the remote repository')
  .requiredOption('-i, --id <id>', 'Artifact UUID')
  .action(async (opts) => {
    try {
      // Assuming /source-refresh endpoint requires POST
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

    // 1. Auth check
    const token = await getToken();
    report.checks.auth = token ? "OK" : "MISSING";
    if (!token) hasErrors = true;

    // 2. Local check
    const hasLocal = await fs.pathExists(LOCAL_PROJECT_PATH);
    report.checks.local_manifest = hasLocal ? "FOUND" : "MISSING";

    printOutput(!hasErrors, report, hasErrors ? "Doctor found issues" : "All systems normal");
    if (hasErrors) process.exit(1);
  });

program.parse(process.argv);
