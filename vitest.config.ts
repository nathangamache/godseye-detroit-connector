import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // No live HTTP: anything but loopback is refused (test/setup-offline.ts).
    setupFiles: ['test/setup-offline.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 4,
  },
});
