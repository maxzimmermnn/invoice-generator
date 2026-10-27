import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, renameSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// `vite build --mode app` feeds the Tauri desktop shell (src-tauri/): it
// needs a plain dist-app/index.html, so the release rename is skipped there.
export default defineConfig(({ mode }) => ({
  plugins: [
    viteSingleFile(),
    mode !== 'app' && {
      // Rename the single-file output to invoice-generator-v<version>.html
      // so each release has a self-describing filename.
      name: 'rename-single-file-output',
      closeBundle() {
        renameSync('dist/index.html', `dist/invoice-generator-v${pkg.version}.html`);
      },
    },
  ],
  build: {
    outDir: mode === 'app' ? 'dist-app' : 'dist',
    // Alles inline in eine HTML — Limit hoch, kein Code-Splitting
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
}));
