import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, renameSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  plugins: [
    viteSingleFile(),
    {
      // Rename the single-file output to invoice-generator-v<version>.html
      // so each release has a self-describing filename.
      name: 'rename-single-file-output',
      closeBundle() {
        renameSync('dist/index.html', `dist/invoice-generator-v${pkg.version}.html`);
      },
    },
  ],
  build: {
    // Alles inline in eine HTML — Limit hoch, kein Code-Splitting
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
