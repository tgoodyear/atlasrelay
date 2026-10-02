// Creates the site's GitHub App for sign-in with GitHub's app manifest flow
// (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
// for scripts/register-signin.sh. Nothing here prints or stores a secret:
//
//   1. Serves one page on 127.0.0.1 that posts the manifest to GitHub, and opens it.
//   2. The owner checks the name and clicks "Create GitHub App" on github.com.
//   3. GitHub sends the browser back here with a one-time code, which is exchanged for the app's
//      client id and client secret.
//   4. The secret goes to `az keyvault secret set` on its standard input, the client id to stdout.
//
// The app asks for no permissions and has no webhook: it only signs people in. GitHub also
// returns a private key for the app; it is not kept, since nothing here acts as the app.
//
//   node scripts/lib/github-app.mjs --name NAME --homepage URL --callback URL [--callback URL ...] \
//     --vault VAULT --secret-name NAME --subscription ID
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string' },
    homepage: { type: 'string' },
    callback: { type: 'string', multiple: true },
    vault: { type: 'string' },
    'secret-name': { type: 'string' },
    subscription: { type: 'string' },
    org: { type: 'string' },
  },
});
for (const k of ['name', 'homepage', 'callback', 'vault', 'secret-name', 'subscription']) {
  if (!args[k]) {
    console.error(`github-app: --${k} is required`);
    process.exit(2);
  }
}

const state = randomBytes(16).toString('hex');
const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function putSecret(secret) {
  return new Promise((resolve, reject) => {
    const az = spawn(
      'az',
      ['keyvault', 'secret', 'set', '--vault-name', args.vault, '--name', args['secret-name'], '--file', '/dev/stdin', '--encoding', 'utf-8', '--subscription', args.subscription, '-o', 'none', '--only-show-errors'],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    az.on('error', reject);
    az.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`az keyvault secret set exited ${code}`))));
    az.stdin.end(secret);
  });
}

async function putSecretWithRetry(secret) {
  // A role assigned by the deployment a moment ago can take a few minutes to apply.
  for (let attempt = 1; ; attempt++) {
    try {
      return await putSecret(secret);
    } catch (err) {
      if (attempt >= 10) throw err;
      console.error(`github-app: could not write the secret yet (${err.message}); retrying in 30 s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/') {
    const { port } = server.address();
    const manifest = {
      name: args.name,
      url: args.homepage,
      callback_urls: args.callback,
      redirect_url: `http://127.0.0.1:${port}/done`,
      public: true,
      default_permissions: {},
      hook_attributes: { url: args.homepage, active: false },
      request_oauth_on_install: false,
      setup_on_update: false,
    };
    const target = args.org
      ? `https://github.com/organizations/${encodeURIComponent(args.org)}/settings/apps/new?state=${state}`
      : `https://github.com/settings/apps/new?state=${state}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>Atlas Relay: create the GitHub App</title>
<p>Sending the app's settings to GitHub. Check the name there, then choose <strong>Create GitHub App</strong>.</p>
<form id="f" method="post" action="${escape(target)}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>
<script>document.getElementById('f').submit()</script>`);
    return;
  }
  if (url.pathname === '/done') {
    const code = url.searchParams.get('code') ?? '';
    if (url.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('This is not the answer to the request this script sent. Run it again.');
      return;
    }
    try {
      const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
      if (r.status !== 201) throw new Error(`GitHub answered ${r.status} to the code exchange`);
      const app = await r.json();
      if (!app.client_id || !app.client_secret) throw new Error('GitHub returned no client id or secret');
      await putSecretWithRetry(app.client_secret);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`Created ${app.slug}. Its secret is in the vault; you can close this tab.`);
      // stdout carries the client id and the app's page, nothing else.
      process.stdout.write(`${app.client_id}\n${app.html_url ?? ''}\n`);
      server.close();
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Could not finish: ${err.message}`);
      console.error(`github-app: ${err.message}`);
      process.exitCode = 1;
      server.close();
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const page = `http://127.0.0.1:${port}/`;
  console.error(`github-app: opening ${page} (open it yourself if no browser appears)`);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [page], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
});
setTimeout(() => {
  console.error('github-app: no answer from GitHub within 15 minutes');
  process.exit(1);
}, 15 * 60_000).unref();
