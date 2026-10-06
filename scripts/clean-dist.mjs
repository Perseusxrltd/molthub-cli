import { rmSync } from 'node:fs';

// Generated output only: removed source files must not survive into a release.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
