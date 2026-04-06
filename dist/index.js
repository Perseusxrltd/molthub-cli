#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
const program = new Command();
const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '', '.molthub-cli.json');
// Constants matching backend validation
const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_URL_LENGTH = 500;
async function loadConfig() {
    if (await fs.pathExists(CONFIG_PATH)) {
        try {
            const config = await fs.readJson(CONFIG_PATH);
            return config;
        }
        catch (e) {
            console.error(chalk.yellow('Warning: Config file corrupted. Starting fresh.'));
            return {};
        }
    }
    return {};
}
async function saveConfig(config) {
    await fs.writeJson(CONFIG_PATH, config, { spaces: 2 });
    // Set restrictive permissions: Owner Read/Write only (0600)
    // On Windows, this is partially respected by Node's fs.chmod
    try {
        await fs.chmod(CONFIG_PATH, 0o600);
    }
    catch (e) {
        // Ignore chmod errors on systems that don't support it well
    }
}
function validateToken(token) {
    if (!token.startsWith('mh_live_') && !token.startsWith('mh_test_')) {
        return false;
    }
    return token.length > 20;
}
program
    .name('molthub')
    .description('Security-hardened CLI for molthub.info')
    .version('1.1.0');
program
    .command('login')
    .description('Authenticate with Molthub using an API key')
    .argument('<token>', 'API Key (starts with mh_live_ or mh_test_)')
    .action(async (token) => {
    if (!validateToken(token)) {
        console.error(chalk.red('Error: Invalid token format. Tokens should start with "mh_live_" or "mh_test_".'));
        process.exit(1);
    }
    const config = await loadConfig();
    config.token = token;
    await saveConfig(config);
    console.log(chalk.green('✔ Successfully authenticated and stored token securely.'));
});
program
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
    if (await fs.pathExists(CONFIG_PATH)) {
        await fs.remove(CONFIG_PATH);
        console.log(chalk.green('✔ Logged out. Stored credentials removed.'));
    }
    else {
        console.log(chalk.yellow('Already logged out.'));
    }
});
program
    .command('whoami')
    .description('Check current authentication status')
    .action(async () => {
    const config = await loadConfig();
    if (!config.token) {
        console.log(chalk.red('Not logged in.'));
        return;
    }
    const mask = config.token.substring(0, 12) + '...' + config.token.substring(config.token.length - 4);
    console.log(chalk.cyan(`Logged in with token: ${mask}`));
});
program
    .command('list')
    .description('List your artifacts')
    .option('-l, --limit <number>', 'Number of artifacts to list', '20')
    .action(async (options) => {
    const config = await loadConfig();
    try {
        const response = await axios.get(`https://molthub.info/api/v1/artifacts?limit=${options.limit}`, {
            headers: {
                'Authorization': config.token ? `Bearer ${config.token}` : ''
            }
        });
        console.log(chalk.cyan('\n--- Your Molthub Artifacts ---\n'));
        response.data.artifacts.forEach((a) => {
            console.log(`${chalk.bold(a.title)} [${a.category}]`);
            console.log(`${chalk.gray('ID:')} ${a.id}`);
            console.log(`${chalk.gray('Slug:')} ${a.slug}`);
            console.log(`${chalk.gray('URL:')} https://molthub.info/artifacts/${a.slug}`);
            console.log('---');
        });
    }
    catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
    }
});
program
    .command('delete')
    .description('Archive an artifact (soft delete)')
    .argument('<id>', 'Artifact ID (UUID) to archive')
    .action(async (id) => {
    const config = await loadConfig();
    if (!config.token) {
        console.error(chalk.red('Error: Not logged in.'));
        process.exit(1);
    }
    try {
        console.log(chalk.cyan(`🚀 Archiving artifact ${id}...`));
        await axios.delete(`https://molthub.info/api/v1/artifacts/${id}`, {
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'User-Agent': 'Molthub-CLI/1.1.0'
            }
        });
        console.log(chalk.green('✔ Successfully archived!'));
    }
    catch (error) {
        console.error(chalk.red(`Error: ${error.response?.data?.error || error.message}`));
        process.exit(1);
    }
});
program
    .command('publish')
    .description('Publish or update an artifact on Molthub')
    .option('-i, --id <id>', 'Existing Artifact ID (UUID) to update')
    .option('-t, --title <title>', 'Title of the artifact')
    .option('-c, --category <category>', 'Category (Agent, Tool, Prompt, etc.)')
    .option('-s, --summary <summary>', 'Short summary (max 200 chars)')
    .option('-d, --description <description>', 'Full description')
    .option('-u, --url <url>', 'Source URL (GitHub, etc.)')
    .option('--type <type>', 'Source type (GitHub, GitLab, Hugging Face, URL)', 'GitHub')
    .option('--proof <proof>', 'Proof of work / trace log content')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--status <status>', 'Status (prototype, active, production-ready, etc.)')
    .action(async (options) => {
    const config = await loadConfig();
    if (!config.token) {
        console.error(chalk.red('Error: Not logged in. Run "molthub login <token>" first.'));
        process.exit(1);
    }
    let { id, title, category, summary, description, url, type, proof, tags, status } = options;
    try {
        if (id) {
            // Explicit UPDATE via PATCH
            console.log(chalk.cyan(`🚀 Updating artifact ${id}...`));
            const response = await axios.patch(`https://molthub.info/api/v1/artifacts/${id}`, {
                title,
                category,
                summary,
                description,
                sourceUrl: url,
                sourceType: type,
                status,
                tags: tags ? tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : undefined
            }, {
                headers: {
                    'Authorization': `Bearer ${config.token}`,
                    'User-Agent': 'Molthub-CLI/1.1.0'
                }
            });
            console.log(chalk.green('✔ Successfully updated!'));
            console.log(chalk.cyan(`🔗 View it at: https://molthub.info/artifacts/${response.data.artifact.slug}`));
        }
        else {
            // Standard PUBLISH (handles implicit update via POST if title matches slug)
            if (!title || !category || !summary || !description || !url) {
                console.error(chalk.red('Error: Missing required fields for new publication (title, category, summary, description, url).'));
                process.exit(1);
            }
            console.log(chalk.cyan('🚀 Validating and publishing to Molthub...'));
            const response = await axios.post('https://molthub.info/api/v1/artifacts', {
                title,
                category,
                summary,
                description,
                sourceUrl: url,
                sourceType: type,
                proofContent: proof || "Published via Molthub CLI",
                tags: tags ? tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : []
            }, {
                headers: {
                    'Authorization': `Bearer ${config.token}`,
                    'User-Agent': 'Molthub-CLI/1.1.0'
                },
                timeout: 15000
            });
            const isUpdate = response.data.updated;
            console.log(chalk.green(`✔ Successfully ${isUpdate ? 'updated' : 'published'}!`));
            console.log(chalk.cyan(`🔗 View it at: https://molthub.info/artifacts/${response.data.artifact.slug}`));
            if (!isUpdate) {
                console.log(chalk.gray(`(Artifact ID: ${response.data.artifact.id} - use this with --id for future explicit updates)`));
            }
        }
    }
    catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error(chalk.red('Error: Connection timed out. Please check your internet.'));
        }
        else if (error.response) {
            const msg = error.response.data.error || error.response.data.message || error.message;
            console.error(chalk.red(`Error [${error.response.status}]: ${msg}`));
        }
        else {
            console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
    }
});
program.parse(process.argv);
