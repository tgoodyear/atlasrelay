import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderShell, SHELLS } from './src/lib/pages.ts';
import { parseSignIn, signInConfig, type SignIn } from './src/lib/signin.ts';
import { parseSiteEnv, siteEnvConfig, siteEnvHtml, TEST_ROBOTS_TXT, type SiteEnv } from './src/lib/siteEnv.ts';

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
// The value comes from Vite's resolved environment, the same one that gives the app its buttons
// (src/lib/offered.ts), so a value set in a .env file reaches both or neither.
// A test site's build (VITE_SITE_ENV, src/lib/siteEnv.ts) adds its noindex header and sitemap 404.
function signInProviders(): Plugin {
  let outDir = '';
  let root = '';
  let signIn: SignIn;
  let siteEnv: SiteEnv;
  return {
    name: 'atlasrelay-sign-in',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
      signIn = parseSignIn(config.env.VITE_SIGNIN_PROVIDERS);
      siteEnv = parseSiteEnv(config.env.VITE_SITE_ENV);
    },
    writeBundle() {
      const base = JSON.parse(readFileSync(join(root, 'public/staticwebapp.config.json'), 'utf8'));
      const config = siteEnvConfig(signInConfig(base, signIn), siteEnv);
      writeFileSync(join(outDir, 'staticwebapp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
    },
  };
}

// A test site's build (VITE_SITE_ENV set to an environment other than prod, see src/lib/siteEnv.ts):
// adds the robots meta tag and the test site banner to index.html, which every page shell and the
// API's project pages are made from, replaces robots.txt with one that names no sitemap, and
// leaves out the IndexNow key file. A prod build (the default) is left exactly as it was.
function siteEnvironment(): Plugin {
  let outDir = '';
  let siteEnv: SiteEnv;
  return {
    name: 'atlasrelay-site-env',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      siteEnv = parseSiteEnv(config.env.VITE_SITE_ENV);
    },
    transformIndexHtml(html) {
      return siteEnvHtml(html, siteEnv);
    },
    writeBundle() {
      if (siteEnv.prod) return;
      writeFileSync(join(outDir, 'robots.txt'), TEST_ROBOTS_TXT);
      for (const f of readdirSync(outDir)) if (/^[0-9a-f]{32}\.txt$/.test(f)) rmSync(join(outDir, f));
    },
  };
}

export default defineConfig({
  plugins: [react(), siteEnvironment(), pageShells(), signInProviders()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
