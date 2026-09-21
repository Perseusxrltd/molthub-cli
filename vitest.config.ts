import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Integration cases launch the packaged CLI and disposable git repositories.
    // Windows process creation can exceed five seconds on a busy development host.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
