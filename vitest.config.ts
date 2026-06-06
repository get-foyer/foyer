import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      // Node environment: server + scripts logic
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['server/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      // jsdom environment: React components + App reducer
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
