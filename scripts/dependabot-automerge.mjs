#!/usr/bin/env node
// Decides whether a Dependabot pull request may be merged without a person. The Dependabot
// auto-merge workflow (.github/workflows/dependabot-automerge.yml) runs it when Deploy has passed on
// the pull request, with BRANCH and SHA naming the commit that passed, and merges the number it
// writes to GITHUB_OUTPUT as pr=<number>. Writing nothing leaves the pull request for a person.
//
// It may merge only npm updates that move every dependency by a patch or minor version, none of
// them @playwright/test. On 0.x a minor bump counts as major. @playwright/test has to move in four
// places at once (e2e-real/test/versions.test.mjs checks them), and the check that catches a
// mismatch, Full-flow test image, is not a required one.
//
// The update is read from the metadata Dependabot writes at the end of its commit message, which
// is what dependabot/fetch-metadata reads too; that action needs a pull_request event, and this
// runs on workflow_run. Nothing from the pull request is checked out or run.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PATCH = 'version-update:semver-patch';
const MINOR = 'version-update:semver-minor';
const MAJOR = 'version-update:semver-major';
const LEFT_TO_PEOPLE = new Set(['@playwright/test']);

const log = (msg) => console.log(`[dependabot-automerge] ${msg}`);

/**
 * The dependencies in the block Dependabot puts at the end of its commit message, between
 * "updated-dependencies:" and "...": name, new version and update type, each '' when missing.
 */
export function parseUpdates(message) {
  const block = /^updated-dependencies:\n([\s\S]*?)^\.\.\.$/m.exec(message);
  if (!block) return [];
  const updates = [];
  for (const line of block[1].split('\n')) {
    const name = /^- dependency-name: "?([^"]*)"?$/.exec(line);
    if (name) {
      updates.push({ name: name[1], version: '', type: '' });
      continue;
    }
    const field = /^ {2}(dependency-version|update-type): (\S+)$/.exec(line);
    if (field && updates.length) updates.at(-1)[field[1] === 'update-type' ? 'type' : 'version'] = field[2];
  }
  return updates;
}

/** The update type of a move between two x.y.z versions, or '' when either is not one. */
export function typeOfBump(from, to) {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(from);
  const b = /^(\d+)\.(\d+)\.(\d+)$/.exec(to);
  if (!a || !b) return '';
  if (a[1] !== b[1]) return MAJOR;
  if (a[2] !== b[2]) return MINOR;
  return PATCH;
}

/**
 * Whether the update in a Dependabot commit message may merge without a person: { ok, reason }.
 */
export function judge(message) {
  const updates = parseUpdates(message);
  if (!updates.length) return { ok: false, reason: 'no dependency metadata in the commit message' };

  // Dependabot's security updates of indirect dependencies give no update-type; for a single
  // dependency, work it out from the "Bump <name> from <old> to <new>" subject.
  if (updates.length === 1 && !updates[0].type) {
    const bump = / from (\S+) to (\S+)$/.exec(message.split('\n')[0]);
    if (bump) updates[0].type = typeOfBump(bump[1], bump[2]);
  }

  for (const { name, version, type } of updates) {
    // The 0.x rule needs the new version's major number; without one, leave it.
    if (!/^\d+\./.test(version)) return { ok: false, reason: `${name} has no readable new version (${version || 'none'})` };
    const effective = type === MINOR && version.startsWith('0.') ? MAJOR : type;
    if (effective !== PATCH && effective !== MINOR) {
      const why = type === MINOR ? 'a minor bump on 0.x' : type || 'no update type';
      return { ok: false, reason: `${name} is not a patch or minor update (${why})` };
    }
    if (LEFT_TO_PEOPLE.has(name)) return { ok: false, reason: `it updates ${name}` };
  }
  return { ok: true, reason: updates.map((u) => `${u.name} ${u.version} (${u.type.replace('version-update:semver-', '')})`).join(', ') };
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

/** The open pull request from Dependabot on BRANCH whose only commit is SHA, written by Dependabot. */
function findPullRequest(branch, sha) {
  const prs = JSON.parse(gh('pr', 'list', '--head', branch, '--base', 'main', '--state', 'open', '--json', 'number,author,headRefOid,commits'));
  const pr = prs.find((p) => ['app/dependabot', 'dependabot[bot]'].includes(p.author.login) && p.headRefOid === sha && p.commits.length === 1);
  if (!pr) return undefined;
  const commit = JSON.parse(gh('api', `repos/${process.env.GH_REPO}/commits/${sha}`));
  if (commit.author?.login !== 'dependabot[bot]') return undefined;
  return { number: pr.number, message: commit.commit.message };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { BRANCH, SHA, GITHUB_OUTPUT } = process.env;
  if (!BRANCH || !SHA || !GITHUB_OUTPUT || !process.env.GH_REPO) throw new Error('BRANCH, SHA, GH_REPO and GITHUB_OUTPUT must be set');
  const pr = findPullRequest(BRANCH, SHA);
  if (!pr) {
    log(`no open pull request from Dependabot with Dependabot's one commit at ${SHA} on ${BRANCH}; leaving it`);
  } else {
    const { ok, reason } = judge(pr.message);
    if (ok) {
      log(`#${pr.number} may merge: ${reason}`);
      appendFileSync(GITHUB_OUTPUT, `pr=${pr.number}\n`);
    } else {
      log(`leaving #${pr.number}: ${reason}`);
    }
  }
}
