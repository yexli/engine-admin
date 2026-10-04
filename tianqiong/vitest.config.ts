import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /* world-engine 以 npm 包形态消费（见 vite.config） */
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
