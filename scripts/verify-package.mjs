import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const temporary = mkdtempSync(path.join(tmpdir(), 'molthub-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 180000,
  env: { ...process.env, MOLTHUB_API_KEY: '', MOLTHUB_BASE_URL: '', NO_COLOR: '1' },
});

try {
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--silent', '--pack-destination', temporary]));
  assert.equal(packed.version, pkg.version);
  const paths = packed.files.map(file => file.path);
  for (const required of ['package.json', 'dist/index.js', 'scripts/ensure-dist.mjs', 'README.md', 'SKILL.md', 'AGENTS.md', 'LICENSE']) {
    assert(paths.includes(required), `Missing package file: ${required}`);
  }
  for (const name of paths) {
    assert(/^(dist\/.*\.js|scripts\/ensure-dist\.mjs|package\.json|README\.md|SKILL\.md|AGENTS\.md|LICENSE)$/.test(name), `Unexpected package file: ${name}`);
    assert(!/(?:__tests__|\.test\.|\.env|\.npmrc)/.test(name), `Private or test file in package: ${name}`);
  }
  const tarball = path.join(temporary, packed.filename);
  const prefix = path.join(temporary, 'installed');
  const project = path.join(temporary, 'project');
  mkdirSync(project);
  run(npm, ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', tarball]);
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', pkg.name);
  const cli = path.join(installed, 'dist', 'index.js');
  const command = (args) => run(process.execPath, [cli, ...args], project).trim();
  const json = (args) => {
    const result = JSON.parse(command([...args, '--json']));
    assert.equal(result.success, true, `Command failed: ${args.join(' ')}`);
    return result.data;
  };
  assert.equal(command(['--version']), pkg.version);
  const bin = path.join(prefix, process.platform === 'win32' ? 'molthub.cmd' : 'bin/molthub');
  assert(existsSync(bin), 'Global command shim is missing');
  if (process.platform !== 'win32') assert.equal(run(bin, ['--version'], project).trim(), pkg.version);
  // The published package must not need TypeScript or a source checkout.
  assert(!existsSync(path.join(installed, 'src')));
  assert(!existsSync(path.join(installed, 'node_modules', 'typescript')));
  run(npm, ['run', 'prepare', '--silent'], installed);
  assert.equal(json(['agent', 'bootstrap']).version, pkg.version);
  const manifest = json(['commands']).manifest;
  const projectCommands = manifest.find(entry => entry.name === 'project').subcommands;
  for (const name of ['workspace', 'manage']) assert(projectCommands.some(entry => entry.name === name));
  assert(manifest.find(entry => entry.name === 'agent').subcommands.some(entry => entry.name === 'workflow'));
  const diagnostics = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
    cwd: project, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, MOLTHUB_API_KEY: '', MOLTHUB_BASE_URL: '' },
  });
  assert([0, 1].includes(diagnostics.status), 'Diagnostics failed to run');
  const doctor = JSON.parse(diagnostics.stdout);
  assert.equal(doctor.data.checks.auth_verified, false);
  assert(doctor.data.nextSteps.length > 0);
  if (diagnostics.status === 1) assert.equal(doctor.error.code, 'ERR_DOCTOR_ISSUES');
  json(['local', 'init', '--name', 'Package verification']);
  json(['local', 'validate']);
  const guide = command(['agent', 'install-instructions', '--project', 'release-verification', '--role', 'manager', '--targets', 'hermes,openclaw', '--json']);
  assert(guide.includes('project manager'));
  assert(guide.includes('name: molthub'));
  if (process.env.MOLTHUB_VERIFY_LIVE === '1') {
    const workflow = json(['agent', 'workflow']);
    assert.equal(workflow.baseUrl, 'https://www.molthub.info');
    assert.equal(workflow.proof.method, 'PUT');
    assert(workflow.roles.manager && workflow.roles.builder);
  }
  if (process.env.MOLTHUB_PACKAGE_OUTPUT_DIR) {
    const output = path.resolve(process.env.MOLTHUB_PACKAGE_OUTPUT_DIR);
    mkdirSync(output, { recursive: true });
    copyFileSync(tarball, path.join(output, packed.filename));
  }
  console.log(JSON.stringify({ success: true, version: pkg.version, filename: packed.filename, integrity: packed.integrity, files: paths.length, cleanGlobalInstall: true, managerCommands: true, offlineOnboarding: true, liveWorkflow: process.env.MOLTHUB_VERIFY_LIVE === '1' }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
