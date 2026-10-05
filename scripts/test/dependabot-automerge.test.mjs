import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, parseUpdates, typeOfBump } from '../dependabot-automerge.mjs';

// Commit messages as Dependabot writes them. SECURITY is #59's, a security update of an indirect
// dependency, which carries no update-type.
const SECURITY = `Bump @grpc/grpc-js from 1.14.4 to 1.14.5

Bumps [@grpc/grpc-js](https://github.com/grpc/grpc-node) from 1.14.4 to 1.14.5.
- [Release notes](https://github.com/grpc/grpc-node/releases)

---
updated-dependencies:
- dependency-name: "@grpc/grpc-js"
  dependency-version: 1.14.5
  dependency-type: indirect
...

Signed-off-by: dependabot[bot] <support@github.com>`;

const group = (...deps) => `Bump the all group with ${deps.length} updates

---
updated-dependencies:
${deps.map(([name, version, type]) => `- dependency-name: ${name}
  dependency-version: ${version}
  dependency-type: direct:development
  update-type: version-update:semver-${type}
  dependency-group: all`).join('\n')}
...

Signed-off-by: dependabot[bot] <support@github.com>`;

test('reads every dependency in the metadata, quoted names included', () => {
  assert.deepEqual(parseUpdates(SECURITY), [{ name: '@grpc/grpc-js', version: '1.14.5', type: '' }]);
  assert.deepEqual(parseUpdates(group(['vite', '7.1.2', 'patch'], ['"@types/react"', '19.2.0', 'minor'])), [
    { name: 'vite', version: '7.1.2', type: 'version-update:semver-patch' },
    { name: '@types/react', version: '19.2.0', type: 'version-update:semver-minor' },
  ]);
  assert.deepEqual(parseUpdates('Bump something\n\nNo metadata here.'), []);
});

test('types a bump from its versions', () => {
  assert.equal(typeOfBump('1.14.4', '1.14.5'), 'version-update:semver-patch');
  assert.equal(typeOfBump('1.14.4', '1.15.0'), 'version-update:semver-minor');
  assert.equal(typeOfBump('1.14.4', '2.0.0'), 'version-update:semver-major');
  assert.equal(typeOfBump('1.14.4', '1.15.0-rc.1'), '');
});

test('merges patch and minor updates, grouped or alone', () => {
  assert.equal(judge(group(['vite', '7.1.2', 'patch'], ['@types/react', '19.2.0', 'minor'])).ok, true);
  assert.equal(judge(SECURITY).ok, true);
});

test('leaves majors, 0.x minors, Playwright and unreadable updates to a person', () => {
  const left = (message) => assert.equal(judge(message).ok, false, message.split('\n')[0]);
  left(group(['vite', '8.0.0', 'major']));
  left(group(['vite', '7.1.2', 'patch'], ['esbuild', '0.29.0', 'minor']));
  left(group(['vite', '7.1.2', 'patch'], ['"@playwright/test"', '1.63.1', 'patch']));
  left(SECURITY.replaceAll('1.14.5', '2.0.0'));
  left(SECURITY.replaceAll('1.14.4', '0.14.4').replaceAll('1.14.5', '0.15.0'));
  left(SECURITY.replace('Bump @grpc/grpc-js from 1.14.4 to 1.14.5', 'Bump @grpc/grpc-js'));
  left('Bump vite from 7.1.0 to 7.1.2');
  assert.equal(judge(SECURITY.replaceAll('1.14.4', '0.14.4').replaceAll('1.14.5', '0.14.5')).ok, true);
});
