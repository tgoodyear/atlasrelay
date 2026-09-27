// Bundles the API into one file for deployment.
//
// Static Web Apps' managed Functions load the app from a network file share on every cold start,
// and this is a quiet site, so nearly every real visit meets a cold host. Shipping node_modules
// meant reading over three thousand small files before the first request could run; one bundled
// file is one read.
//
// @azure/functions-core is not a real package. The Functions worker provides it at runtime, and
// @azure/functions requires it to register handlers, so it has to stay external.
import { context } from 'esbuild';

// --watch rebuilds on every change, for `npm run watch`; otherwise build once and exit.
const ctx = await context({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['@azure/functions-core'],
  outfile: 'dist/bundle.js',
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
