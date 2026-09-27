using './app.bicep'

// Deployed by the Infrastructure workflow on every merge to main.
// Values marked (shared) must match infra/main.bicepparam; scripts/check-params.sh enforces it.
param baseName = 'internetresearch'                 // (shared)
param location = 'westus2'
param swaLocation = 'westus2'                        // (shared)
param swaSku = 'Free'                                // (shared)
param stagingEnvironmentPolicy = 'Disabled'          // (shared)
param enableApplicationInsights = true               // (shared)
param storageKeyIndex = 0                            // (shared)
param additionalAppSettings = {}                     // (shared)
// Production hostnames are bound once by hand with scripts/bind-custom-domain.sh, never from CI.
// Empty on purpose, and a reviewer should treat any non-empty value here as a change to the live
// domain rather than a parameter tweak: this file is deployed by the Infrastructure workflow on
// every merge that touches infra/**, and a customDomains PUT carrying the wrong validationMethod
// returns 200, changes nothing, and is only recoverable by deleting and recreating the binding on
// a site that holds a CanNotDelete lock, with a certificate re-issue behind it (docs/RUNBOOK.md,
// "A hostname stuck at Validating"). www and the apex are how the transfer flow is reached.
// Two things enforce this rather than trusting the comment: scripts/check-params.sh fails the
// build when it is set, and the CI role in infra/main.bicep denies customDomains/write outright.
param customDomain = ''
param tags = {
  project: 'atlasrelay'
  repo: 'tgoodyear/atlasrelay'
}
