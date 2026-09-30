// <env>.<domain> for an environment other than prod: a CNAME in the zone that prod's stack owns,
// pointing at this environment's static web app. It is declared by this environment's stack, so
// it follows the site when the environment is rebuilt and goes when it is torn down. The binding
// on the site is made by scripts/bind-custom-domain.sh <env> once the record resolves.
targetScope = 'resourceGroup'

@description('The zone, e.g. atlasrelay.org, in this resource group')
param zoneName string

@description('Record name, e.g. dev')
param recordName string

@description('Default hostname of the environment\'s static web app')
param target string

param ttl int = 3600

resource zone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: zoneName
}

resource cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: recordName
  properties: {
    TTL: ttl
    CNAMERecord: {
      cname: target
    }
  }
}

output fqdn string = '${recordName}.${zoneName}'
