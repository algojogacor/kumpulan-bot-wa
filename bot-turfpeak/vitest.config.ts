import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'vendor'],
    environment: 'node',
  },
});
