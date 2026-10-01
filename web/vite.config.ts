import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderShell, SHELLS } from './src/lib/pages.ts';
import { parseSignIn, signInConfig } from './src/lib/signin.ts';

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

// Writes staticwebapp.config.json for the sign-in providers this build offers: the committed file
// for the built-in GitHub and Microsoft sign-in, or that file plus the site's own registrations
// when VITE_SIGNIN_PROVIDERS names them. A value it cannot use stops the build. See src/lib/signin.ts.
function signInProviders(): Plugin {
  let outDir = '';
  let root = '';
  return {
    name: 'atlasrelay-sign-in',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      parseSignIn(process.env.VITE_SIGNIN_PROVIDERS);
    },
    writeBundle() {
      const base = JSON.parse(readFileSync(join(root, 'public/staticwebapp.config.json'), 'utf8'));
      const config = signInConfig(base, parseSignIn(process.env.VITE_SIGNIN_PROVIDERS));
      writeFileSync(join(outDir, 'staticwebapp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [react(), pageShells(), signInProviders()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
