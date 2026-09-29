import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderShell, SHELLS } from './src/lib/pages.ts';

// Writes one HTML file per kind of page next to index.html, each with its own title, description
// and canonical URL. staticwebapp.config.json routes every path to one of them and answers
// anything else with 404.html and a real 404 status. See src/lib/pages.ts.
function pageShells(): Plugin {
  let outDir = '';
  return {
    name: 'atlasrelay-page-shells',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    writeBundle() {
      const index = readFileSync(join(outDir, 'index.html'), 'utf8');
      for (const shell of SHELLS) {
        const file = join(outDir, shell.file);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderShell(index, shell));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), pageShells()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
