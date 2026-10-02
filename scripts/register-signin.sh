#!/usr/bin/env bash
# Register the site's own sign-in apps for an environment and put their secrets in its sign-in
# vault (docs/RUNBOOK.md, "Sign-in registrations").
#
#   scripts/register-signin.sh dev                       # every provider, then provision
#   scripts/register-signin.sh prod aad                   # one (aad, github, google, orcid)
#   scripts/register-signin.sh prod --rotate github       # a new secret for an existing app
#
# Microsoft: creates or updates the Entra app registration with Microsoft Graph (name, accounts,
#   redirect URI, ID tokens, links, logo, sign-in permissions) and has it trust the site's sign-in
#   identity through a federated identity credential. It adds no client secret. Graph cannot set
#   the publisher domain, so until it is set the script lists it at the end as a step for the
#   Entra admin center.
# GitHub: creates a GitHub App from a manifest; you click "Create GitHub App" on github.com.
# Google, ORCID: prints what to register, then asks for the client id and, without echoing it,
#   the client secret.
#
# Secrets go from the provider straight into the vault, on standard input: never printed, never on
# a command line, never in a file. The client ids go to the settings file and the vault. Once
# GitHub and Microsoft both have registrations, the stack is deployed, the providers the site's
# build should offer are recorded as SIGNIN_PROVIDERS (and in the repository variable the matching
# workflow builds with), and the script prints where each provider's sign-in leads on the live
# site.
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

# The hostnames people sign in on. Static Web Apps sends each provider the callback on the hostname
# the sign-in started from, so every one of them needs its redirect URI registered (seen on dev,
# 2026-10: a sign-in from dev.atlasrelay.org failed at GitHub and Microsoft with only the site's own
# hostname registered). Prod: the domain alone, because the site redirects every other hostname to
# it once it is the default domain (docs/RUNBOOK.md, "Canonical host"), which is checked below. Any
# other environment: the site's own hostname, which the full-flow tests use, and <env>.<domain>.
ZONE=$(aget ATLASRELAY_DNS_ZONE)
if [ "$ENV_NAME" = prod ]; then
  HOSTS=("$ZONE")
  NAME="Atlas Relay"
else
  HOSTS=("$(aget SWA_HOSTNAME)")
  [ -z "$ZONE" ] || HOSTS+=("$ENV_NAME.$ZONE")
  NAME="Atlas Relay ($ENV_NAME)"
fi
[ -n "${HOSTS[0]}" ] || die "no hostname for $ENV_NAME (ATLASRELAY_DNS_ZONE or SWA_HOSTNAME); provision it first"
HOST=${HOSTS[0]}
# Every redirect URI for one provider, one per line.
callbacks() { local h; for h in "${HOSTS[@]}"; do echo "https://$h/.auth/login/$1/callback"; done; }
callback_list() { callbacks "$1" | paste -sd ' ' -; }

# The vault comes with the stack. An environment provisioned before it existed gets it now.
VAULT=$(aget SIGNIN_KEY_VAULT_NAME)
if [ -z "$VAULT" ] || [ -z "$(aget SIGNIN_IDENTITY_PRINCIPAL_ID)" ]; then
  echo "== deploying the stack, for the sign-in vault and identity"
  provision
  VAULT=$(aget SIGNIN_KEY_VAULT_NAME)
  [ -n "$VAULT" ] || die "the deployment did not report a sign-in vault"
fi

# Writes the value on this function's standard input to the vault as the given secret. Retries
# for a few minutes, since the operator's role on a new vault takes a moment to apply. The value
# is held in a shell variable, never in a file or on a command line (printf is a builtin).
put_secret() {
  local name=$1 value attempt provider
  provider=${name#signin-}; provider=${provider%-client-secret}
  IFS= read -r -d '' value || true
  value=${value%$'\n'}
  [ -n "$value" ] || die "no value for $name"
  for attempt in $(seq 1 10); do
    if printf '%s' "$value" | az keyvault secret set --vault-name "$VAULT" --name "$name" --file /dev/stdin \
      --encoding utf-8 --content-type "text/plain; client secret" --tags kind=client-secret "provider=$provider" \
      "${AZ_SUB[@]}" -o none --only-show-errors; then
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

# Records a provider's client id in the vault too, next to its secret, so the settings file is not
# the only copy (scripts/lib/env.sh reads it back when the file has none). A client id is public.
put_client_id() {
  local provider=$1 value=$2 tag
  tag=$provider; [ "$tag" = aad ] && tag=microsoft
  az keyvault secret set --vault-name "$VAULT" --name "signin-$tag-client-id" --value "$value" \
    --content-type "text/plain; public client id" --tags kind=client-id "provider=$tag" \
    "${AZ_SUB[@]}" -o none --only-show-errors
  echo "  recorded the client id in $VAULT"
}

# Whether the vault holds the named secret (its name only; the value is never read).
has_secret() {
  az keyvault secret show --vault-name "$VAULT" --name "$1" "${AZ_SUB[@]}" --query name -o tsv > /dev/null 2>&1
}

# ---------- Microsoft ----------

# Microsoft Graph's delegated sign-in permissions: openid and profile. Not email: the site never uses
# the address, and the sign-in asks for openid and profile only (web/src/lib/signin.ts).
GRAPH_APP=00000003-0000-0000-c000-000000000000
register_aad() {
  local app_id object_id body logo logo_dir token principal fic existing
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
  body=$(jq -n --arg n "$NAME" --argjson cb "$(callbacks aad | jq -R . | jq -s .)" --arg g "$GRAPH_APP" '{
    displayName: $n,
    signInAudience: "AzureADandPersonalMicrosoftAccount",
    api: {requestedAccessTokenVersion: 2},
    web: {
      redirectUris: $cb,
      homePageUrl: "https://atlasrelay.org",
      implicitGrantSettings: {enableIdTokenIssuance: true, enableAccessTokenIssuance: false}
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
        {id: "14dad69e-099b-42c9-810b-d002981feec1", type: "Scope"}
      ]
    }]
  }')
  # ID tokens on: Static Web Apps asks Microsoft for "code id_token" (posted back to the callback).
  # Without them Microsoft answers the callback with an error and the site shows "401:
  # Unauthorized" after a successful sign-in (seen on dev, 2026-10).
  az rest --method patch --url "$GRAPH/applications/$object_id" --headers Content-Type=application/json --body "$body" -o none
  echo "  name, accounts, redirect URIs $(callback_list aad), ID tokens, links and sign-in permissions set"
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
  # A directory of our own: GNU and BSD mktemp disagree on -t, and Graph wants a .png name.
  logo_dir=$(mktemp -d)
  logo="$logo_dir/logo.png"
  node scripts/lib/render-logo.mjs "$logo" 215 > /dev/null
  token=$(az account get-access-token --resource-type ms-graph --query accessToken -o tsv)
  if printf 'Authorization: Bearer %s\n' "$token" | curl -fsS -X PUT "$GRAPH/applications/$object_id/logo" \
    -H @- -H 'Content-Type: image/png' --data-binary "@$logo" -o /dev/null; then
    echo "  logo uploaded"
  else
    echo "  warning: the logo upload failed" >&2
  fi
  unset token
  rm -rf "$logo_dir"
  # The app's service principal in its own tenant, so the tenant's own accounts can sign in.
  if ! az rest --method get --url "$GRAPH/servicePrincipals(appId='$app_id')" -o none 2> /dev/null; then
    az rest --method post --url "$GRAPH/servicePrincipals" --headers Content-Type=application/json \
      --body "$(jq -n --arg a "$app_id" '{appId: $a}')" -o none
    echo "  service principal created"
  fi
  # No client secret: the app trusts the site's user-assigned identity (infra/app.bicep) through a
  # federated identity credential, and the site signs in with that identity's token
  # (https://learn.microsoft.com/azure/static-web-apps/authentication-custom, "Use a managed
  # identity instead of a secret").
  principal=$(aget SIGNIN_IDENTITY_PRINCIPAL_ID)
  [ -n "$principal" ] || die "no SIGNIN_IDENTITY_PRINCIPAL_ID; run scripts/provision.sh $ENV_NAME first"
  fic=$(jq -n --arg n "static-web-apps-$ENV_NAME" --arg i "https://login.microsoftonline.com/$(aget AZURE_TENANT_ID)/v2.0" --arg s "$principal" \
    '{name: $n, issuer: $i, subject: $s, audiences: ["api://AzureADTokenExchange"], description: "Sign-in identity of the static web app (id-atlasrelay-*-signin)"}')
  existing=$(az rest --method get --url "$GRAPH/applications/$object_id/federatedIdentityCredentials" \
    --query "value[?name=='static-web-apps-$ENV_NAME'].id | [0]" -o tsv)
  if [ -n "$existing" ]; then
    az rest --method patch --url "$GRAPH/applications/$object_id/federatedIdentityCredentials/$existing" \
      --headers Content-Type=application/json --body "$(jq 'del(.name)' <<< "$fic")" -o none
  else
    az rest --method post --url "$GRAPH/applications/$object_id/federatedIdentityCredentials" \
      --headers Content-Type=application/json --body "$fic" -o none
  fi
  echo "  trusts the site's sign-in identity ($principal); no client secret"
  if [ "$(az rest --method get --url "$GRAPH/applications/$object_id" --query 'length(passwordCredentials)' -o tsv)" != 0 ]; then
    PENDING+=("Entra app \"$NAME\" ($app_id) still has a client secret. Once Microsoft sign-in works on a build that signs in with the identity, remove it (Certificates & secrets) and delete $(signin_secret_name aad) from $VAULT")
  fi
  put_client_id aad "$app_id"
}

# ---------- GitHub ----------

register_github() {
  local id out page
  echo "== GitHub: $NAME"
  id=$(aget ATLASRELAY_GITHUB_CLIENT_ID)
  if [ -n "$id" ]; then
    # GitHub has no API for a GitHub App's callback URLs, so the list is checked by hand.
    PENDING+=("GitHub App $id (Settings, Developer settings, GitHub Apps, the app, General): Callback URLs must include $(callback_list github)")
  fi
  # Registered means the client id and its secret: an earlier run that stopped between the two left
  # an id with no secret, and is finished here.
  if [ -n "$id" ] && [ "$ROTATE" != true ] && has_secret "$(signin_secret_name github)"; then
    echo "  already registered ($id); use --rotate for a new secret"
    return 0
  fi
  if [ -n "$id" ]; then
    echo "  On the app's page on github.com (Settings, Developer settings, GitHub Apps), choose"
    echo "  'Generate a new client secret', and paste it here. Delete the old one there afterwards."
    read_secret_into_vault "GitHub client secret" "$(signin_secret_name github)"
    put_client_id github "$id"
    return 0
  fi
  echo "  A browser opens on github.com. Check the name (GitHub app names are unique across GitHub;"
  echo "  change it there if '$NAME' is taken), then choose 'Create GitHub App'."
  local args=() cb
  while read -r cb; do args+=(--callback "$cb"); done < <(callbacks github)
  out=$(node scripts/lib/github-app.mjs --name "$NAME" --homepage https://atlasrelay.org \
    "${args[@]}" --vault "$VAULT" --secret-name "$(signin_secret_name github)" \
    --subscription "$(aget AZURE_SUBSCRIPTION_ID)")
  id=$(sed -n 1p <<< "$out"); page=$(sed -n 2p <<< "$out")
  [[ $id =~ ^Iv[0-9A-Za-z.]+$ ]] || die "the GitHub App was not created"
  aset ATLASRELAY_GITHUB_CLIENT_ID "$id"
  put_client_id github "$id"
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
  [ -z "$(aget ATLASRELAY_GOOGLE_CLIENT_ID)" ] ||
    PENDING+=("Google client $(aget ATLASRELAY_GOOGLE_CLIENT_ID) (Google Auth Platform, Clients): Authorized redirect URIs must include $(callback_list google)")
  if [ -n "$(aget ATLASRELAY_GOOGLE_CLIENT_ID)" ] && [ "$ROTATE" != true ] && has_secret "$(signin_secret_name google)"; then
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
              authorized redirect URIs $(callback_list google)
  Then copy the client id and the client secret.
EOF
  read_client_id "Google client id" ATLASRELAY_GOOGLE_CLIENT_ID '^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$'
  read_secret_into_vault "Google client secret" "$(signin_secret_name google)"
  put_client_id google "$(aget ATLASRELAY_GOOGLE_CLIENT_ID)"
}

register_orcid() {
  echo "== ORCID: $NAME"
  [ -z "$(aget ATLASRELAY_ORCID_CLIENT_ID)" ] ||
    PENDING+=("ORCID client $(aget ATLASRELAY_ORCID_CLIENT_ID) (orcid.org, Developer tools): Redirect URIs must include $(callback_list orcid)")
  if [ -n "$(aget ATLASRELAY_ORCID_CLIENT_ID)" ] && [ "$ROTATE" != true ] && has_secret "$(signin_secret_name orcid)"; then
    echo "  already registered; use --rotate for a new secret"
    return 0
  fi
  cat << EOF
  Sign in to https://orcid.org (the account's email must be verified), open Developer tools and
  register for the public API:
    Name: $NAME    Website: https://atlasrelay.org
    Description: Sign-in for Atlas Relay, which connects researchers who need RIPE Atlas
                 credits with people who can donate them.
    Redirect URIs: $(callback_list orcid)
  Each ORCID account has one public API client, so dev and prod share it: if it already exists,
  add the redirect URI above to it. Then copy the client id (APP-...) and the client secret.
EOF
  read_client_id "ORCID client id" ATLASRELAY_ORCID_CLIENT_ID '^APP-[0-9A-Z]{16}$'
  read_secret_into_vault "ORCID client secret" "$(signin_secret_name orcid)"
  put_client_id orcid "$(aget ATLASRELAY_ORCID_CLIENT_ID)"
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

# Prod registers the domain alone, so every other hostname of the site must redirect to it before
# anyone signs in there.
if [ "$ENV_NAME" = prod ]; then
  for h in "www.$ZONE" "$(aget SWA_HOSTNAME)"; do
    [ -n "$h" ] || continue
    to=$(curl -s -o /dev/null -w '%{redirect_url}' "https://$h/" || true)
    case "$to" in
      "https://$ZONE/"*) ;;
      *) PENDING+=("https://$h/ does not redirect to https://$ZONE/, so sign-in there would fail: make $ZONE the site's default domain (docs/RUNBOOK.md, \"Canonical host\")") ;;
    esac
  done
fi

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
  # The first answer is the site redirecting to itself with a nonce; follow it to the provider.
  url="https://$HOST/.auth/login/$p" code="" jar=$(mktemp)
  for _ in 1 2 3; do
    read -r code location < <(curl -s -b "$jar" -c "$jar" -o /dev/null -w '%{http_code} %{redirect_url}\n' "$url") || true
    [ -n "${location:-}" ] || break
    url=$location
    [[ $url == "https://$HOST/"* ]] || break
  done
  rm -f "$jar"
  host=$(sed -E 's#^https?://([^/?]+).*#\1#' <<< "$url")
  echo "  $p: $code -> ${host:-nothing}"
done
echo "expected once a build with these providers is live: github -> github.com, aad -> login.microsoftonline.com,"
echo "google -> accounts.google.com, orcid -> orcid.org. Build and deploy: docs/RUNBOOK.md, \"Sign-in registrations\"."
