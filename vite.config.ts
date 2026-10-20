import { defineConfig } from 'vite';

// `pnpm dev` runs this alongside the server; open the address it prints, on the computer
// or on a phone on the same wifi
export default defineConfig({
  root: 'web',
  server: {
    host: true,
    port: 5180,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787' },
      '/files': { target: 'http://127.0.0.1:8787' },
      '/mcp': { target: 'http://127.0.0.1:8787' },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
