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
// dev.atlasrelay.org, bound here so it comes back with the environment instead of being something
// to remember after every rebuild. The matching CNAME is declared in infra/dns.bicep from
// devStaticWebAppDefaultHostname in infra/main.bicepparam, which is a different deployment at a
// different scope, so a dev site recreated with a new defaultHostname needs the two passes
// docs/RUNBOOK.md describes: the binding validates against public DNS and will fail the
// deployment while that record still points at the old site. Clear this and that hostname
// together if dev is ever torn down for good.
param customDomain = 'dev.atlasrelay.org'
param tags = {
  project: 'atlasrelay'
  repo: 'tgoodyear/atlasrelay'
  environment: 'dev'
}
