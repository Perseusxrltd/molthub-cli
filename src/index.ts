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
    const manifest = `---
name: "${opts.name || path.basename(process.cwd())}"
version: "1.0.0"
category: "${opts.category}"
sourceUrl: "" # Fill this before creating
---

# Overview
A brief description of this project.

# Capabilities
- [ ] List core features here
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
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) throw new Error("Invalid frontmatter");
      const meta = yaml.load(match[1]) as any;
      if (!meta.name || !meta.category || !meta.sourceUrl) {
        throw new Error("Missing required frontmatter fields: name, category, sourceUrl");
      }
      printOutput(true, meta, "Local manifest is valid.");
    } catch (e: any) {
      printOutput(false, null, "Validation failed", { code: "ERR_INVALID_MANIFEST", details: e.message });
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
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const meta = yaml.load(match[1]) as any;
  const description = content.replace(/^---\n[\s\S]*?\n---/, '').trim();
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
        title: localMeta.name,
        category: localMeta.category,
        summary: localMeta.summary || "Imported from local manifest",
        description: localMeta.description,
        sourceUrl: localMeta.sourceUrl,
        sourceType: "GitHub" // Defaults
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
