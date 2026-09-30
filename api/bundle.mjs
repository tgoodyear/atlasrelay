// Bundles the API into one file for deployment.
//
// This is a quiet site, so nearly every real visit meets a cold host, and a cold host has to
// load the app before the first request can run. Shipping node_modules meant over three thousand
// small files to unpack and read; one bundled file is one read.
//
// @azure/functions-core is not a real package. The Functions worker provides it at runtime, and
// @azure/functions requires it to register handlers, so it has to stay external.
//
// The project page function (src/functions/projectPage.ts) starts from two pages the web build
// writes, so they are embedded here: web/dist/shell/project.html and web/dist/404.html. Build the
// web app first; the root `npm run build` and the deploy workflow both do. Embedding them ties the
// HTML the function returns to the script and style files of the same build, and costs the
// function no request at run time. With --dev or --watch, for local development against the Vite
// dev server, the source web/index.html stands in for both, because the dev server serves the app
// from source and has none of the built files.
import { existsSync, readFileSync } from 'node:fs';
import { context } from 'esbuild';

const dev = process.argv.includes('--dev') || process.argv.includes('--watch');

function pageTemplates() {
  const web = new URL('../web/', import.meta.url);
  if (dev) {
    const index = readFileSync(new URL('index.html', web), 'utf8');
    return { project: index, notFound: index };
  }
  const project = new URL('dist/shell/project.html', web);
  const notFound = new URL('dist/404.html', web);
  if (!existsSync(project) || !existsSync(notFound)) {
    throw new Error('web/dist has no shell/project.html or 404.html. Run `npm run build -w web` before building the API, or pass --dev.');
  }
  return { project: readFileSync(project, 'utf8'), notFound: readFileSync(notFound, 'utf8') };
}

const templates = pageTemplates();

// --watch rebuilds on every change, for `npm run watch`; otherwise build once and exit.
const ctx = await context({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@azure/functions-core'],
  outfile: 'dist/bundle.js',
  define: {
    __PROJECT_SHELL__: JSON.stringify(templates.project),
    __NOT_FOUND_PAGE__: JSON.stringify(templates.notFound),
  },
  sourcemap: true,
  legalComments: 'none',
  logLevel: process.argv.includes('--watch') ? 'info' : 'warning',
});

if (process.argv.includes('--watch')) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
