import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Renderer lives in /src and is built to /dist. base './' keeps asset paths
// relative so the production build loads correctly over file://.
export default defineConfig({
  root: resolve(__dirname, 'src'),
  // Static assets (Earth textures from `npm run fetch-textures`) live in the
  // repo-root /public and are copied verbatim into /dist at build time.
  publicDir: resolve(__dirname, 'public'),
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
  },
});
