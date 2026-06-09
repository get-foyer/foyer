import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/hook': { target: 'http://localhost:4317', changeOrigin: true },
      '/events': { target: 'http://localhost:4317', changeOrigin: true },
      '/research': { target: 'http://localhost:4317', changeOrigin: true },
      '/activity': { target: 'http://localhost:4317', changeOrigin: true },
      '/prefetch': { target: 'http://localhost:4317', changeOrigin: true },
      '/close': { target: 'http://localhost:4317', changeOrigin: true },
      '/pin': { target: 'http://localhost:4317', changeOrigin: true },
      '/api': { target: 'http://localhost:4317', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist/public',
    sourcemap: false,
  },
});
