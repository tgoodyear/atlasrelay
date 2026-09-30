import { test } from '@playwright/test';

// PLACEHOLDER, NOT ENABLED: a pledge that moves one real credit through the RIPE Atlas API.
//
// How it would work, once it is wanted:
// - The donor's RIPE Atlas account gets an API key with only the "transfer credits" permission,
//   created on atlas.ripe.net, and scripts/set-test-users.sh stores it in the same vault as
//   e2e-donor-ripe-transfer-key. The job would read it like the passwords (a new
//   E2E_DONOR_RIPE_KEY_SECRET variable in infra/testharness.bicep and a field in run.mjs), and
//   run.mjs would add it to the values it redacts.
// - The researcher's profile would carry the RIPE NCC Access email of a second real RIPE Atlas
//   account instead of the reserved address the manual flow uses.
// - The test would pledge 1 credit with "Transfer now with an API key", expect "Transferred via
//   API", and check the researcher's RIPE Atlas balance went up by one.
// - The key is typed into the pledge dialog, so this test must run with tracing and screenshots
//   off for that step, the same way global-setup.ts keeps the passwords out of every trace.
test.skip('API pledge transfers one credit on RIPE Atlas (placeholder, not enabled)', async () => {});
