import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Browser build.
 *
 * Output goes to `apps/world-web/public` so the Fastify server hosts the compiled client from
 * the same origin — no CORS in production, and the container carries one artefact.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../world-web/public',
    emptyOutDir: true,
    // Babylon is large; splitting it keeps the app shell interactive while the engine loads.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('@babylonjs') ? 'babylon' : undefined),
      },
    },
    chunkSizeWarningLimit: 2_400,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
});
