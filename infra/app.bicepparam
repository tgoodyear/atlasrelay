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
param tags = {
  project: 'atlas-credit-exchange'
  repo: 'tgoodyear/internetresearch'
}
