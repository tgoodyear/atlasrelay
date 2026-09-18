using './app.bicep'

// A second, isolated instance of the app resources in the same resource group, for integration
// testing a PR stack before it reaches main. Every name derives from baseName, so nothing here
// touches production. App Insights is off: app.bicep expects an existing component, and dev does
// not need telemetry.
param baseName = 'internetresearch-dev'
param location = 'westus2'
param swaLocation = 'westus2'
param swaSku = 'Free'
param stagingEnvironmentPolicy = 'Disabled'
param enableApplicationInsights = false
param storageKeyIndex = 0
param additionalAppSettings = {}
param tags = {
  project: 'atlas-credit-exchange'
  repo: 'tgoodyear/internetresearch'
  environment: 'dev'
}
