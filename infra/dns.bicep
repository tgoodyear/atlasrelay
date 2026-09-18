// Public DNS zone for the project's domain.
// Owner-only: the CI role grants no Microsoft.Network permissions, so CI cannot change DNS.
//
// Ordering note. Static Web Apps validates a custom domain only after the zone is delegated at
// the registrar, which happens between two deployments and cannot be expressed as a dependency.
// So this template creates the zone and the records, and the bindings that consume them are made
// separately: production by scripts/bind-custom-domain.sh, dev by the customDomain parameter of
// app.bicep (see docs/RUNBOOK.md). Once the apex validation token is issued, record it in
// apexTxtValues so Bicep stays the only writer of this zone.
//
// Apex routing. DNS forbids a CNAME at the zone apex, and an Azure DNS alias record cannot
// target a static site (alias targets are limited to public IPs, Traffic Manager, CDN and Front
// Door). The apex therefore uses a plain A record pointing at the site's stable inbound address,
// taken from the resource rather than hardcoded so that redeploying corrects it if it changes.
targetScope = 'resourceGroup'

@description('Public DNS zone name, e.g. atlasrelay.org')
param zoneName string

@description('Default hostname of the static web app, used for the www CNAME')
param staticWebAppDefaultHostname string

@description('Default hostname of the dev static web app. Empty leaves dev.atlasrelay.org uncreated.')
param devStaticWebAppDefaultHostname string = ''

@description('''Address the static web app serves on, for the apex A record. Empty skips the
record, which is correct on a first deployment before the platform has assigned one.''')
param staticWebAppInboundIp string = ''

@description('TTL in seconds for the records below')
param ttl int = 3600

@description('''Extra TXT values published at the apex, joined with the SPF record.
Put the Static Web Apps domain-validation token here once Azure issues it, so a later
deployment does not remove it.''')
param apexTxtValues array = []

@description('Publish records stating the domain sends and receives no mail (RFC 7505 null MX, SPF -all, DMARC reject).')
param rejectMail bool = true

@description('Tags applied to the zone')
param tags object = {}

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
  tags: tags
  properties: {
    zoneType: 'Public'
  }
}

// www -> the static web app. Static Web Apps also uses this record to validate the subdomain
// (cname-delegation). Until the custom domain is bound, requests to www return a 404 from the
// platform, which is expected.
resource wwwCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: 'www'
  properties: {
    TTL: ttl
    CNAMERecord: {
      cname: staticWebAppDefaultHostname
    }
  }
}

// dev -> the dev static web app, for integration testing a PR stack before it reaches main.
// Same cname-delegation validation as www. Created only when a dev instance exists. The binding
// on the other end is declared on the dev site itself (customDomain in infra/dev.bicepparam),
// because that is the deployment which rebuilds dev; this record and that binding have to be
// changed together when the dev site is recreated.
resource devCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (!empty(devStaticWebAppDefaultHostname)) {
  parent: zone
  name: 'dev'
  properties: {
    TTL: ttl
    CNAMERecord: {
      cname: devStaticWebAppDefaultHostname
    }
  }
}

// Apex A record: routes atlasrelay.org itself to the site. Without it the apex resolves to
// nothing even after the custom domain validates.
resource apexA 'Microsoft.Network/dnsZones/A@2018-05-01' = if (!empty(staticWebAppInboundIp)) {
  parent: zone
  name: '@'
  properties: {
    TTL: ttl
    ARecords: [
      {
        ipv4Address: staticWebAppInboundIp
      }
    ]
  }
}

// The apex TXT set carries the SPF policy and, later, the domain-validation token.
resource apexTxt 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (rejectMail || !empty(apexTxtValues)) {
  parent: zone
  name: '@'
  properties: {
    TTL: ttl
    TXTRecords: concat(
      rejectMail ? [{ value: ['v=spf1 -all'] }] : [],
      map(apexTxtValues, v => { value: [v] })
    )
  }
}

// RFC 7505: an explicit "this domain accepts no mail" record.
resource nullMx 'Microsoft.Network/dnsZones/MX@2018-05-01' = if (rejectMail) {
  parent: zone
  name: '@'
  properties: {
    TTL: ttl
    MXRecords: [
      {
        preference: 0
        exchange: '.'
      }
    ]
  }
}

resource dmarc 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (rejectMail) {
  parent: zone
  name: '_dmarc'
  properties: {
    TTL: ttl
    TXTRecords: [
      {
        value: ['v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s']
      }
    ]
  }
}

output zoneName string = zone.name
output nameServers array = zone.properties.nameServers
output zoneId string = zone.id
output apexARecordIp string = staticWebAppInboundIp
