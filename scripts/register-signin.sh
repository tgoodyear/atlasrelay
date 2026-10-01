#!/usr/bin/env bash
# Register the site's own sign-in apps for an environment and put their secrets in its sign-in
# vault (docs/RUNBOOK.md, "Sign-in registrations").
#
#   scripts/register-signin.sh dev                       # every provider, then provision
#   scripts/register-signin.sh prod aad                   # one (aad, github, google, orcid)
#   scripts/register-signin.sh prod --rotate github       # a new secret for an existing app
#
# Microsoft: creates or updates the Entra app registration with Microsoft Graph (name, accounts,
#   redirect URI, publisher domain, links, logo, sign-in permissions) and adds a client secret,
#   keeping the previous one so the site keeps working until it reads the new one.
# GitHub: creates a GitHub App from a manifest; you click "Create GitHub App" on github.com.
# Google, ORCID: prints what to register, then asks for the client id and, without echoing it,
#   the client secret.
#
# Secrets go from the provider straight into the vault, on standard input: never printed, never on
# a command line, never in a file. The client ids go to the settings file. Then the stack is
# deployed, the providers the site's build should offer are recorded as SIGNIN_PROVIDERS (and in
# the repository variable the matching workflow builds with), and each provider's sign-in redirect
# is checked on the live site.
#
# Needs az 2.61+ signed in to the environment's tenant as an Owner who may create app registrations,
# jq, node with the web workspace installed (for the logo), and gh for the GitHub variable.
set -euo pipefail
usage() { sed -n '2,8s/^# \{0,1\}//p' "$0" >&2; exit 2; }
[ $# -ge 1 ] || usage
ENV_NAME=$1; shift
ROTATE=false
PROVIDERS=()
for a in "$@"; do
  case $a in
    --rotate) ROTATE=true ;;
    aad|github|google|orcid) PROVIDERS+=("$a") ;;
    *) usage ;;
  esac
done
[ ${#PROVIDERS[@]} -gt 0 ] || PROVIDERS=(aad github google orcid)
die() { echo "error: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."
. scripts/lib/env.sh
need_stack_az
[ -s "$ENV_FILE" ] || die "no settings for $ENV_NAME; run scripts/bootstrap.sh $ENV_NAME first"
az_sub
az account show "${AZ_SUB[@]}" -o none 2> /dev/null ||
  die "run: az login --tenant <tenant> (the environment is in subscription $(aget AZURE_SUBSCRIPTION_ID))"
REPO=$(aget ATLASRELAY_GITHUB_REPO); REPO=${REPO:-tgoodyear/atlasrelay}
GRAPH=https://graph.microsoft.com/v1.0

# The hostname people sign in on, and the one every redirect URI names. Prod: the domain, which the
# site redirects every other hostname to once it is the default domain (docs/RUNBOOK.md,
# "Canonical host"). Any other environment: the site's own hostname, which the full-flow tests use.
if [ "$ENV_NAME" = prod ]; then
  HOST=$(aget ATLASRELAY_DNS_ZONE)
  NAME="Atlas Relay"
else
  HOST=$(aget SWA_HOSTNAME)
  NAME="Atlas Relay ($ENV_NAME)"
fi
[ -n "$HOST" ] || die "no hostname for $ENV_NAME (ATLASRELAY_DNS_ZONE or SWA_HOSTNAME); provision it first"
callback() { echo "https://$HOST/.auth/login/$1/callback"; }

# The vault comes with the stack. An environment provisioned before it existed gets it now.
VAULT=$(aget SIGNIN_KEY_VAULT_NAME)
if [ -z "$VAULT" ]; then
  echo "== deploying the stack, for the sign-in vault"
  provision
  VAULT=$(aget SIGNIN_KEY_VAULT_NAME)
  [ -n "$VAULT" ] || die "the deployment did not report a sign-in vault"
fi

# Writes the value on this function's standard input to the vault as the given secret. Retries
# for a few minutes, since the operator's role on a new vault takes a moment to apply. The value
# is held in a shell variable, never in a file or on a command line (printf is a builtin).
put_secret() {
  local name=$1 value attempt
  IFS= read -r -d '' value || true
  value=${value%$'\n'}
  [ -n "$value" ] || die "no value for $name"
  for attempt in $(seq 1 10); do
    if printf '%s' "$value" | az keyvault secret set --vault-name "$VAULT" --name "$name" --file /dev/stdin \
      --encoding utf-8 "${AZ_SUB[@]}" -o none --only-show-errors; then
      unset value
      echo "  stored $name in $VAULT"
      return 0
    fi
    [ "$attempt" = 10 ] && break
    echo "  could not write to $VAULT yet; retrying in 30s"
    sleep 30
  done
  unset value
  die "could not write $name to $VAULT"
}

# ---------- Microsoft ----------

# Microsoft Graph's delegated sign-in permissions: openid, profile, email.
GRAPH_APP=00000003-0000-0000-c000-000000000000
register_aad() {
  local app_id object_id body logo token secret keep
  echo "== Microsoft: $NAME"
  app_id=$(aget ATLASRELAY_MICROSOFT_CLIENT_ID)
  object_id=""
  if [ -n "$app_id" ]; then
    object_id=$(az rest --method get --url "$GRAPH/applications(appId='$app_id')" --query id -o tsv 2> /dev/null || true)
    [ -n "$object_id" ] || die "the settings name Entra app $app_id, which this tenant does not have. Sign in to the right tenant, or clear ATLASRELAY_MICROSOFT_CLIENT_ID to create a new app"
  else
    object_id=$(az rest --method post --url "$GRAPH/applications" --headers Content-Type=application/json \
      --body "$(jq -n --arg n "$NAME" '{displayName: $n, signInAudience: "AzureADandPersonalMicrosoftAccount", api: {requestedAccessTokenVersion: 2}}')" \
      --query id -o tsv)
    app_id=$(az rest --method get --url "$GRAPH/applications/$object_id" --query appId -o tsv)
    aset ATLASRELAY_MICROSOFT_CLIENT_ID "$app_id"
    echo "  created app $app_id"
  fi
  body=$(jq -n --arg n "$NAME" --arg cb "$(callback aad)" --arg g "$GRAPH_APP" '{
    displayName: $n,
    signInAudience: "AzureADandPersonalMicrosoftAccount",
    api: {requestedAccessTokenVersion: 2},
    web: {
      redirectUris: [$cb],
      homePageUrl: "https://atlasrelay.org",
      implicitGrantSettings: {enableIdTokenIssuance: false, enableAccessTokenIssuance: false}
    },
    info: {
      marketingUrl: "https://atlasrelay.org/how-it-works",
      privacyStatementUrl: "https://atlasrelay.org/privacy",
      supportUrl: "https://github.com/tgoodyear/atlasrelay/issues"
    },
    requiredResourceAccess: [{
      resourceAppId: $g,
      resourceAccess: [
        {id: "37f7f235-527c-4136-accd-4a02d197296e", type: "Scope"},
        {id: "14dad69e-099b-42c9-810b-d002981feec1", type: "Scope"},
        {id: "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0", type: "Scope"}
      ]
    }]
  }')
  az rest --method patch --url "$GRAPH/applications/$object_id" --headers Content-Type=application/json --body "$body" -o none
  echo "  name, accounts, redirect URI $(callback aad), links and sign-in permissions set"
  # The publisher domain shown on the consent screen. Microsoft Graph treats it as read-only
  # ("Property 'publisherDomain' is read-only and cannot be set", 2026-10), so it is set once in
  # the admin center, and checked here.
  if [ "$(az rest --method get --url "$GRAPH/applications/$object_id" --query publisherDomain -o tsv)" = atlasrelay.org ]; then
    echo "  publisher domain atlasrelay.org"
  else
    PENDING+=("Entra admin center, app \"$NAME\" ($app_id), Branding & properties: set Publisher domain to atlasrelay.org: https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Branding/appId/$app_id")
  fi
  # The logo: the site's icon at the size Entra asks for. Graph takes the image as the request
  # body; the token goes to curl on standard input, not on its command line.
  logo=$(mktemp -t atlasrelay-logo).png
  node scripts/lib/render-logo.mjs "$logo" 215 > /dev/null
  token=$(az account get-access-token --resource-type ms-graph --query accessToken -o tsv)
  if printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X PUT "$GRAPH/applications/$object_id/logo" \
    -H @- -H 'Content-Type: image/png' --data-binary "@$logo" -o /dev/null; then
    echo "  logo uploaded"
  else
    echo "  warning: the logo upload failed" >&2
  fi
  unset token
  rm -f "$logo"
  # The app's service principal in its own tenant, so the tenant's own accounts can sign in.
  if ! az rest --method get --url "$GRAPH/servicePrincipals(appId='$app_id')" -o none 2> /dev/null; then
    az rest --method post --url "$GRAPH/servicePrincipals" --headers Content-Type=application/json \
      --body "$(jq -n --arg a "$app_id" '{appId: $a}')" -o none
    echo "  service principal created"
  fi
  # A new secret every run. It goes straight to the vault; the previous one stays valid, so the
  # site keeps signing people in until it reads the new one, and anything older is removed.
  secret=$(az rest --method post --url "$GRAPH/applications/$object_id/addPassword" --headers Content-Type=application/json \
    --body "$(jq -n --arg d "Static Web Apps sign-in $(date -u +%Y-%m-%d)" --arg e "$(date -u -v+24m +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || date -u -d '+24 months' +%Y-%m-%dT%H:%M:%SZ)" \
      '{passwordCredential: {displayName: $d, endDateTime: $e}}')" --query secretText -o tsv)
  printf '%s' "$secret" | put_secret "$(signin_secret_name aad)"
  unset secret
  keep=2
  az rest --method get --url "$GRAPH/applications/$object_id" --query 'passwordCredentials' -o json |
    jq -r --argjson keep "$keep" 'sort_by(.startDateTime) | reverse | .[$keep:] | .[].keyId' |
    while read -r key; do
      az rest --method post --url "$GRAPH/applications/$object_id/removePassword" --headers Content-Type=application/json \
        --body "$(jq -n --arg k "$key" '{keyId: $k}')" -o none
      echo "  removed an older secret"
    done
}

# ---------- GitHub ----------

register_github() {
  local id out page
  echo "== GitHub: $NAME"
  id=$(aget ATLASRELAY_GITHUB_CLIENT_ID)
  if [ -n "$id" ] && [ "$ROTATE" != true ]; then
    echo "  already registered ($id); use --rotate for a new secret"
    return 0
  fi
  if [ -n "$id" ]; then
    echo "  On the app's page on github.com (Settings, Developer settings, GitHub Apps), choose"
    echo "  'Generate a new client secret', and paste it here. Delete the old one there afterwards."
    read_secret_into_vault "GitHub client secret" "$(signin_secret_name github)"
    return 0
  fi
  echo "  A browser opens on github.com. Check the name (GitHub app names are unique across GitHub;"
  echo "  change it there if '$NAME' is taken), then choose 'Create GitHub App'."
  out=$(node scripts/lib/github-app.mjs --name "$NAME" --homepage https://atlasrelay.org \
    --callback "$(callback github)" --vault "$VAULT" --secret-name "$(signin_secret_name github)" \
    --subscription "$(aget AZURE_SUBSCRIPTION_ID)")
  id=$(sed -n 1p <<< "$out"); page=$(sed -n 2p <<< "$out")
  [[ $id =~ ^Iv[0-9A-Za-z.]+$ ]] || die "the GitHub App was not created"
  aset ATLASRELAY_GITHUB_CLIENT_ID "$id"
  echo "  created $page (client id $id); its secret is in $VAULT"
}

# ---------- Google and ORCID ----------

# Reads a secret at a prompt that does not echo it, and stores it.
read_secret_into_vault() {
  local label=$1 name=$2 value
  [ -t 0 ] || die "run this in a terminal: it asks for the $label"
  IFS= read -rsp "  $label (not shown): " value; echo
  [ -n "$value" ] || die "no $label given"
  printf '%s' "$value" | put_secret "$name"
  unset value
}

read_client_id() {
  local label=$1 key=$2 pattern=$3 value current
  current=$(aget "$key")
  IFS= read -rp "  $label${current:+ [$current]}: " value
  value=${value:-$current}
  [[ $value =~ $pattern ]] || die "that does not look like a $label"
  aset "$key" "$value"
}

register_google() {
  echo "== Google: $NAME"
  if [ -n "$(aget ATLASRELAY_GOOGLE_CLIENT_ID)" ] && [ "$ROTATE" != true ]; then
    echo "  already registered; use --rotate for a new secret"
    return 0
  fi
  cat << EOF
  In the Google Cloud console (https://console.cloud.google.com), in a project for the site, open
  Google Auth Platform:
    Branding: app name "$NAME", a support email, home page https://atlasrelay.org,
              privacy policy https://atlasrelay.org/privacy, authorized domain atlasrelay.org
              (and azurestaticapps.net for a site on its own hostname)
    Audience: External, then Publish app
    Clients:  Create client, type Web application, name "$NAME",
              authorized redirect URI $(callback google)
  Then copy the client id and the client secret.
EOF
  read_client_id "Google client id" ATLASRELAY_GOOGLE_CLIENT_ID '^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$'
  read_secret_into_vault "Google client secret" "$(signin_secret_name google)"
}

register_orcid() {
  echo "== ORCID: $NAME"
  if [ -n "$(aget ATLASRELAY_ORCID_CLIENT_ID)" ] && [ "$ROTATE" != true ]; then
    echo "  already registered; use --rotate for a new secret"
    return 0
  fi
  cat << EOF
  Sign in to https://orcid.org (the account's email must be verified), open Developer tools and
  register for the public API:
    Name: $NAME    Website: https://atlasrelay.org
    Description: Sign-in for Atlas Relay, which connects researchers who need RIPE Atlas
                 credits with people who can donate them.
    Redirect URI: $(callback orcid)
  Use a different ORCID account for dev and prod: each account has one public API client.
  Then copy the client id (APP-...) and the client secret.
EOF
  read_client_id "ORCID client id" ATLASRELAY_ORCID_CLIENT_ID '^APP-[0-9A-Z]{16}$'
  read_secret_into_vault "ORCID client secret" "$(signin_secret_name orcid)"
}

# Steps only a person can do, listed at the end.
PENDING=()
show_pending() {
  [ ${#PENDING[@]} -gt 0 ] || return 0
  echo "== still to do by hand"
  printf '  - %s\n' "${PENDING[@]}"
}
trap show_pending EXIT

for p in "${PROVIDERS[@]}"; do
  "register_$p"
done

# ---------- deploy and check ----------

if [ -z "$(aget ATLASRELAY_GITHUB_CLIENT_ID)" ] || [ -z "$(aget ATLASRELAY_MICROSOFT_CLIENT_ID)" ]; then
  echo "GitHub and Microsoft both need a registration before the site can use any of its own; run"
  echo "scripts/register-signin.sh $ENV_NAME for the missing one. Nothing is deployed until then."
  exit 0
fi
echo "== deploying the stack with the registrations"
provision
signin=$(aget SIGNIN_PROVIDERS)
echo "sign-in providers for $ENV_NAME builds: ${signin:-built-in GitHub and Microsoft}"
var=SIGNIN_PROVIDERS; [ "$ENV_NAME" = prod ] || var=DEV_SIGNIN_PROVIDERS
if [ "$ENV_NAME" = prod ] || [ "$ENV_NAME" = dev ]; then
  if command -v gh > /dev/null && gh auth status > /dev/null 2>&1; then
    gh variable set "$var" --repo "$REPO" --body "$signin"
    echo "repository variable $var set; the next build for $ENV_NAME offers these providers"
  else
    echo "set the repository variable: gh variable set $var --repo $REPO --body \"$signin\""
  fi
fi

# What the live site does with each provider's sign-in. Before a build that names the providers is
# deployed, the site still has the built-in GitHub and Microsoft sign-in and Google and ORCID
# answer 404.
echo "== sign-in redirects on https://$HOST"
for p in github aad google orcid; do
  read -r code location < <(curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$HOST/.auth/login/$p") || true
  host=$(sed -E 's#^https?://([^/]+).*#\1#' <<< "${location:-}")
  echo "  $p: $code ${host:-}"
done
echo "expected once a build with these providers is live: github -> github.com, aad -> login.microsoftonline.com,"
echo "google -> accounts.google.com, orcid -> orcid.org. Build and deploy: docs/RUNBOOK.md, \"Sign-in registrations\"."
