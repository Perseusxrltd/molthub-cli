import path from 'path';

export const CLI_ABS_PATH = path.join(process.cwd(), 'dist', 'index.js');
export const CLI_PATH = `node "${CLI_ABS_PATH}"`;
export const EXEC_TIMEOUT = 15000;
