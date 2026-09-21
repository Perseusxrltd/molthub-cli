import fs from 'fs-extra';
import path from 'path';

export class LocalBridgeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LocalBridgeError';
  }
}

// Repo-controlled links must never redirect a proof read or write elsewhere.
export async function assertPlainPath(target: string) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new LocalBridgeError('ERR_UNSAFE_RUN_PATH', 'Local proof paths must not contain symbolic links or junctions.');
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function readProofText(file: string, maxBytes = 2 * 1024 * 1024) {
  await assertPlainPath(file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new LocalBridgeError('ERR_INVALID_LOCAL_FILE', `Proof file must be a regular file no larger than ${maxBytes} bytes: ${path.basename(file)}`);
  }
  return fs.readFile(file, 'utf8');
}

export async function readProofJson(file: string) {
  const text = await readProofText(file);
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalBridgeError('ERR_INVALID_LOCAL_FILE', `Invalid JSON in ${path.basename(file)}.`);
  }
}

export async function assertRunDestination(outputDir: string) {
  await assertPlainPath(outputDir);
  if (await fs.pathExists(outputDir)) {
    const stat = await fs.stat(outputDir);
    if (!stat.isDirectory() || (await fs.readdir(outputDir)).length > 0) {
      throw new LocalBridgeError('ERR_RUN_EXISTS', 'Run destination already contains files. Resume with mission run status, or choose a new --out folder; existing proof will not be overwritten.');
    }
  }
}
