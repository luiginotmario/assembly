import { defineConfig } from 'vite';

// `pnpm dev` runs this alongside the server; open the address it prints, on the computer
// or on a phone on the same wifi
const API = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 5180),
    proxy: {
      '/api': { target: API },
      '/files': { target: API },
      '/mcp': { target: API },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
