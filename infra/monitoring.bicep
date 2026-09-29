// Alerts, the availability test and the workbook, over the App Insights component and Log
// Analytics workspace that platform.bicep creates. Owner-only like the rest of platform.bicep: the
// CI role has no Microsoft.Insights write permission, so scripts/bootstrap.sh deploys this.
//
// What the queries read (docs/RUNBOOK.md, "Monitoring"):
//   AppRequests          one row per API request, written by the Functions host
//   AppTraces            the API's log lines; lines written by api/src/lib/telemetry.ts are JSON
//                        with an "event" field: "dependency" (RIPE Atlas and Table Storage calls),
//                        "transfer" (the outcome of an API transfer) and "error"
//   AppPageViews, AppBrowserTimings, AppExceptions, AppDependencies
//                        from the browser (web/src/lib/telemetry.ts), AppRoleName "web"
//   AppAvailabilityResults  from the availability test below
targetScope = 'resourceGroup'

param baseName string
param location string
param tags object = {}
param workspaceId string
param appInsightsId string

@description('Address that receives alert email')
param alertEmail string

@description('Page the availability test requests, e.g. https://atlasrelay.org/. Empty skips the test and its alert.')
param availabilityTestUrl string = ''

// ---------- where alerts go ----------

// The group Application Insights created on its own ("Application Insights Smart Detection")
// notifies holders of the Monitoring Contributor and Monitoring Reader roles, and nobody holds
// either on this subscription, so it reaches no one. This one sends email.
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${baseName}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'AtlasRelay'
    enabled: true
    emailReceivers: [
      {
        name: 'email'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

// ---------- log search alerts ----------

// The API served about 80 requests a week in September 2026, so a rate alone would fire on one
// failed request among three. Each threshold is a count with a floor, over a short window.
var apiServerErrors = '''
AppRequests
| summarize Requests = sum(ItemCount), Errors = sumif(ItemCount, toint(ResultCode) >= 500)
| where Errors >= 3 and Errors * 10 >= Requests
'''

// A transfer whose outcome the API could not learn ("uncertain": timeout, network failure or a
// 5xx from RIPE Atlas), or one RIPE Atlas accepted but the API could not record ("unrecorded").
// Either way a pledge is waiting on a person, so one is enough.
var transferNeedsAttention = '''
AppTraces
| where Message has '"event":"transfer"'
| extend e = parse_json(Message)
| where tostring(e.event) == "transfer" and tostring(e.outcome) in ("uncertain", "unrecorded")
| project TimeGenerated, Outcome = tostring(e.outcome), ProjectId = tostring(e.projectId), PledgeId = tostring(e.pledgeId)
'''

// Calls to RIPE Atlas that got no answer: a timeout, a network failure or a 5xx. A 4xx is RIPE
// answering (a key without permission, a refused transfer) and is not counted.
var ripeAtlasFailures = '''
AppTraces
| where Message has '"event":"dependency"' and Message has '"type":"RIPE Atlas"'
| extend e = parse_json(Message)
| where tobool(e.success) == false
| summarize Failures = count()
| where Failures >= 2
'''

// Error lines from the API, including the ones written on paths that still answered 2xx, such as
// a pledge slot that could not be released. The host's own "Executed ... (Failed" line for a
// request the browser abandoned is left out.
var apiErrors = '''
let traces = AppTraces
    | where SeverityLevel >= 3
    | where Message !startswith "Executed '"
    | summarize Count = count();
// Fuzzy, so the rule still evaluates the traces on a workspace where AppExceptions has never
// been created.
let exceptions = union isfuzzy=true
    (AppExceptions | where AppRoleName != "web" | summarize Count = sum(ItemCount)),
    (datatable(Count: long)[]);
union traces, exceptions
| summarize Errors = sum(Count)
| where Errors >= 3
'''

// Uncaught errors in the browser, from at least two page loads, so one broken tab or browser
// extension looping on an error does not page.
var browserExceptions = '''
AppExceptions
| where AppRoleName == "web"
| summarize Exceptions = sum(ItemCount), PageLoads = dcount(SessionId)
| where Exceptions >= 5 and PageLoads >= 2
'''

var rules = [
  {
    name: 'api-server-errors'
    displayName: 'Atlas Relay: API server errors'
    description: 'At least 3 API requests answered 5xx in 15 minutes, and at least 10% of requests. scripts/logs.sh api-errors shows which functions and codes.'
    severity: 2
    frequency: 'PT5M'
    window: 'PT15M'
    query: apiServerErrors
  }
  {
    name: 'transfer-needs-attention'
    displayName: 'Atlas Relay: API transfer outcome unknown or unrecorded'
    description: 'An API transfer ended with an unknown outcome or was accepted by RIPE Atlas but not recorded. scripts/logs.sh transfers lists them; docs/RUNBOOK.md says what to do.'
    severity: 1
    frequency: 'PT5M'
    window: 'PT15M'
    query: transferNeedsAttention
  }
  {
    name: 'ripe-atlas-failures'
    displayName: 'Atlas Relay: RIPE Atlas API not answering'
    description: 'At least 2 calls to the RIPE Atlas API timed out, failed to connect or returned 5xx in 30 minutes. scripts/logs.sh ripe-atlas shows the calls.'
    severity: 3
    frequency: 'PT10M'
    window: 'PT30M'
    query: ripeAtlasFailures
  }
  {
    name: 'api-errors'
    displayName: 'Atlas Relay: API error log lines'
    description: 'At least 3 error lines or exceptions from the API in 30 minutes. scripts/logs.sh api-errors shows them.'
    severity: 3
    frequency: 'PT10M'
    window: 'PT30M'
    query: apiErrors
  }
  {
    name: 'browser-exceptions'
    displayName: 'Atlas Relay: browser errors'
    description: 'At least 5 uncaught errors in the browser from at least 2 page loads in an hour. scripts/logs.sh browser-exceptions groups them by message.'
    severity: 3
    frequency: 'PT15M'
    window: 'PT1H'
    query: browserExceptions
  }
]

resource alert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = [
  for r in rules: {
    name: 'alert-${baseName}-${r.name}'
    location: location
    tags: tags
    kind: 'LogAlert'
    properties: {
      displayName: r.displayName
      description: r.description
      severity: r.severity
      enabled: true
      evaluationFrequency: r.frequency
      windowSize: r.window
      scopes: [workspaceId]
      // Tables such as AppPageViews exist only once the first row has arrived.
      skipQueryValidation: true
      // One notification when the condition starts, resolved when it clears.
      autoMitigate: true
      criteria: {
        allOf: [
          {
            query: r.query
            timeAggregation: 'Count'
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      actions: {
        actionGroups: [actionGroup.id]
      }
    }
  }
]

// ---------- availability ----------

// The portal lists a test under the component its hidden-link tag names.
var linkTag = { 'hidden-link:${appInsightsId}': 'Resource' }
// West US (San Jose), East US (Virginia), West Europe (Amsterdam).
var testLocations = ['us-ca-sjc-azr', 'us-va-ash-azr', 'emea-nl-ams-azr']
var testName = 'webtest-${baseName}-home'

// One page every 15 minutes from 3 locations. The home page is static, so this checks DNS, TLS,
// the certificate and that Static Web Apps is serving this site's files (the content match rejects
// the platform's placeholder page, which also answers 200). The API is covered by the alerts above.
resource webtest 'Microsoft.Insights/webtests@2022-06-15' = if (!empty(availabilityTestUrl)) {
  name: testName
  location: location
  tags: union(tags, linkTag)
  kind: 'standard'
  properties: {
    SyntheticMonitorId: testName
    Name: 'Atlas Relay home page'
    Description: 'GET ${availabilityTestUrl} expects 200, the app shell, and a certificate valid for 7 more days.'
    Enabled: true
    Frequency: 900
    Timeout: 30
    Kind: 'standard'
    // A location counts as failed only after the retry fails too.
    RetryEnabled: true
    Locations: [for l in testLocations: { Id: l }]
    Request: {
      RequestUrl: availabilityTestUrl
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
      ContentValidation: {
        ContentMatch: 'id="root"'
        IgnoreCase: false
        PassIfTextFound: true
      }
    }
  }
}

resource unavailable 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(availabilityTestUrl)) {
  name: 'alert-${baseName}-home-unavailable'
  location: 'global'
  tags: union(tags, linkTag)
  properties: {
    description: 'The home page (${availabilityTestUrl}) failed from at least 2 of 3 locations. Check the Availability page of appi-${baseName}, then scripts/logs.sh availability.'
    severity: 1
    enabled: true
    scopes: [webtest.id, appInsightsId]
    evaluationFrequency: 'PT1M'
    // At least one run per location in the window.
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: webtest.id
      componentId: appInsightsId
      failedLocationCount: 2
    }
    autoMitigate: true
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

// ---------- workbook ----------

// infra/workbooks/atlasrelay.json is the portal's own format (Advanced Editor, Gallery Template)
// with the workspace's resource id replaced by __WORKSPACE_ID__. To change it, edit the workbook
// in the portal, copy the JSON back into that file with the id turned back into the placeholder,
// and re-run scripts/bootstrap.sh.
resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  // A workbook's name is a GUID; a fixed seed keeps it stable so a redeploy updates it in place.
  name: guid(resourceGroup().id, 'atlasrelay-workbook')
  location: location
  tags: tags
  kind: 'shared'
  properties: {
    displayName: 'Atlas Relay'
    category: 'workbook'
    // Azure stores sourceId in lower case; matching it avoids a change on every deployment.
    sourceId: toLower(appInsightsId)
    version: 'Notebook/1.0'
    serializedData: replace(loadTextContent('workbooks/atlasrelay.json'), '__WORKSPACE_ID__', workspaceId)
  }
}

output actionGroupId string = actionGroup.id
