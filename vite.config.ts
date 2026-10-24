import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist/umpire-1b', emptyOutDir: true, chunkSizeWarningLimit: 800 },
});
