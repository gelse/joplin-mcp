import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/container/**/*.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './reports/junit.xml',
    },
    // Container tests must run serially — shared Joplin instance
    sequence: {
      concurrent: false,
    },
    // Longer timeouts for container communication
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
