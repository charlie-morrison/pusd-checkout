import { defineConfig } from 'vite';

// The site is served from https://charliemorrison.dev/pusd-checkout/ (GitHub Pages project site
// under the account's custom domain), so every asset path needs the /pusd-checkout/ base.
export default defineConfig({
  root: 'app',
  base: '/pusd-checkout/',
  build: { outDir: '../dist', emptyOutDir: true, target: 'esnext' },
});
