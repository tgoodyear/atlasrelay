# Security

Atlas Relay handles two kinds of sensitive data: the RIPE NCC Access email addresses
researchers add to their profiles, and the RIPE Atlas API keys people paste: donors when they
transfer credits through the site, and researchers when they check a manual pledge.

## Reporting a vulnerability

Please report privately rather than opening a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/tgoodyear/atlasrelay/security/advisories/new)
on this repository, which reaches the maintainer directly.

Include what you found, how to reproduce it, and what an attacker could do with it. You will
get an acknowledgement within a few days. There is no bounty; this is a volunteer community
project.

Please do not run automated scanners against the live site, and do not use real people's
credits, projects or email addresses to demonstrate a finding.

## Reporting abuse or asking for a takedown

Nobody vets the projects posted here. Posting needs a sign-in (GitHub or Microsoft, and Google or
ORCID once the site offers them) and a self-declared RIPE NCC Access email, and the site cannot tell a real research project from an
invented one. The transfer page tells donors this.

If a project is fraudulent, misrepresents who is behind it, or should come down for another
reason, open an issue labelled `abuse` with the project's URL and what is wrong with it. If
naming the project publicly would make things worse, use private vulnerability reporting
instead.

There is one maintainer, so expect a response in days rather than hours. A fraudulent project
is closed by the site, which stops it accepting credits and removes it from the listing and
the sitemap. Its page answers "not found". The owner, once signed in, can still open it in the
app to settle pledges, but cannot reopen it. The owner's profile and stored email can be deleted too, but that is
not a ban: signing in again with the same account creates a new profile linked to the old
projects and pledges.

Credits already transferred cannot be recovered. They move directly between RIPE Atlas
accounts, and neither this site nor the RIPE NCC can reverse a transfer on our request. If you
sent credits to a project you believe is fraudulent, report it here so others are warned, and
contact the RIPE NCC if you think a RIPE Atlas account is being misused.

## How the site handles sensitive data

**RIPE Atlas API keys are never stored or logged.** A key pasted into the transfer form is
used for the request and discarded. The optional **Check balance** button sends the key to
`POST /api/atlas/balance`, which makes one call to RIPE. Submitting a transfer sends the key
once more and makes at most two calls: a balance check, then the transfer. If RIPE reports a
balance below the amount, nothing is sent. If the balance check fails for any other reason,
for example because the key lacks that permission, the transfer goes ahead with a warning.
Error handling never echoes request bodies, so a key cannot reach a log.

Donors should create a key with only the two permissions the site uses, "Transfer credits to
another user" and "Get information about your credits", give it a short validity window, and
delete it afterwards.

A researcher confirming a manual pledge may paste a key of their own so the site records the
amount that actually arrived. The key is sent with the confirmation and is used for one request
to RIPE, `GET /api/v2/credits/transactions/?sort=-date&type=admin&page_size=100`, which lists the
researcher's recent transfers. The page keeps the key while the confirm dialog is open and sends
it again, for the same single request, when the researcher picks a transfer or checks again. It
drops the key when the dialog closes. Nothing else is done with it, and it is
handled like a donor's key: not stored, not logged, not echoed in errors. It needs only "Get
information about your credits". The site keeps the amount it found and RIPE's id for that
transaction. RIPE's reason and description text for each listed transfer is shown to the researcher and not kept.
The transaction id is shown to the researcher and the donor of that pledge. Public pledge data
leaves the id out; it shows whether the amount was verified and whether the pledge has a reference.

**RIPE NCC Access emails are private.** No anonymous endpoint returns them. A signed-in donor
sees a researcher's address when they start a manual pledge, because they need it to send the
transfer, and the researcher sees that donor's name. A donor can hold one live pledge per
project at a time. Researchers can delete their profile, and the stored address with it, from
the profile page.

**Donors can pledge anonymously.** Public views then show the pledge as "Anonymous", with the
amount, message and date still visible, so a distinctive amount or message can still identify
someone. The researcher receiving the credits still sees who pledged, since they may need to
match it against their RIPE transaction log, and the pledge record keeps the donor's account
id.

**Telemetry carries no user ids, API keys or email addresses.** The site records page views, page load times, browser
errors and the API calls each page makes in Azure Application Insights. It sets no cookies, stores
nothing in the browser, and removes query strings and anything shaped like an API key or email
address before sending. The API's own logs get the same treatment. Page views also carry the
referring site's origin, and any `utm_source`, `utm_medium` and `utm_campaign` from the landing
URL, redacted the same way and cut to 64 characters. A few actions are counted (opening the pledge
form, making a pledge, posting a project, following a sign-in or atlas.ripe.net link) with the
route, public project ids, the pledge method and the amount as a power-of-ten range. The
[privacy page](https://atlasrelay.org/privacy) lists everything collected.

**Accounts from different sign-in providers are never merged.** The site keys each account by the
id Azure Static Web Apps issues for that sign-in, never by email address, so a Google account and a
Microsoft account with the same email are two accounts. Google and ORCID account ids also carry the
provider's name. The API treats a sign-in from any provider other than GitHub, Microsoft, Google and ORCID as
signed out.

**The site never holds credits.** Every transfer happens inside RIPE Atlas between the two
accounts. The site records the project, the pledge and its confirmation.

## Infrastructure

GitHub Actions deploys with OpenID Connect through a user-assigned managed identity that
trusts only jobs in this repository's GitHub Environment `prod`, which only the `main` branch may
use. No long-lived Azure credential is stored in the repository or in GitHub secrets. The
identity's custom roles let it read its resource group, the static web app and its linked
backend, list the site's deployment token, and read the API's Function App and publish a package
to it. It can do nothing else: it cannot deploy infrastructure, change role assignments, modify
its own federation, read or change app settings, change DNS, read or change storage, or delete
anything. Infrastructure is
deployed by a subscription Owner as a deployment stack whose deny settings block deleting its
resources outside the stack.

Sign-in uses Azure Static Web Apps' built-in GitHub and Microsoft providers, which need no secret
of the site's own. Google and ORCID sign-in need the site's own app registrations, and once a site
has any registration of its own, Static Web Apps turns its built-in providers off, so GitHub and
Microsoft then need the site's own registrations too. Each registration has a client secret. The
secrets are kept in the owner's git-ignored settings file and in the static web app's app settings,
which the CI identity cannot read; `staticwebapp.config.json`, which ships with the site, names the
settings and holds no values. The config asks for no scopes beyond the ones Static Web Apps uses
to sign people in (for ORCID, only `openid`), and the API never receives a provider's token.
A leaked secret lets someone act as the site's registration with that provider, within the
redirect URIs registered there. It does not let anyone sign in to this site as another person, and
it reaches no Azure resource or data. If a secret leaks, rotate it at once; the runbook ("Google
and ORCID sign-in") has the steps.

The API runs on an Azure Function App that only the static web app can call: linking the two puts
an identity provider in front of the Function App that refuses requests the site did not send, and
every deploy checks that a direct request is refused. The API reaches its tables with a managed
identity. In the data account it may read and write rows in the `users`, `projects`, `pledges` and
`claims` tables and nothing else; its other roles are on a separate storage account that holds
only the Functions host's state and the deployment package. No storage account accepts its access
keys, and no storage key or storage connection string is stored anywhere.

The dev environment, when it exists, adds a test harness for the full-flow tests with real
Microsoft sign-in and real RIPE Atlas transfers (docs/RUNBOOK.md, "Full-flow tests on dev"). Two
test accounts in a separate tenant sign in there, and one RIPE Atlas account sends credits to
another through the site, which sends them back with the RIPE Atlas API. The accounts' passwords, the two live RIPE Atlas API keys
and the RIPE account emails are in a Key Vault with public network access disabled. Two
principals can read them: a Container Apps job inside the environment's virtual network, through a
private endpoint, as the job's own managed identity; and the Owner recorded as the environment's
operator, who writes them (Key Vault Secrets Officer) and can reach the vault only while
`scripts/set-test-users.sh` or `scripts/set-ripe-keys.sh` has opened it to their address. The
GitHub workflow that runs the tests deploys the commit's site and API to dev, builds the job's
image in the environment's private container registry, starts the job and downloads its results;
its identity has no role on the vault, and GitHub holds no test credentials. To deploy, it uses
the roles `infra/rbac.bicep` gives every environment's CI identity, on dev's resource group and
Function App only. That identity, the operator and the job's identity also have Storage Blob Data
Contributor on the `locks` container, which holds only the blob whose lease keeps a second run off
dev while one is deploying or testing. The run publishes only its summary (outcome, counts, commit) as
an artifact, because anyone signed in to GitHub can download the artifacts of a public repository;
the report, traces and console stay in the private results container. The keys are copied in from
a separate vault that refuses every network; `scripts/set-ripe-keys.sh` admits the operator's
address only while it reads from it. Before results leave the job, the passwords, the RIPE keys and
account emails, and the site's session cookies are replaced with `[redacted]` in the output, the
report and every trace, including the keys the tests paste into the pledge form.

The keys can move real credits. The workflow chooses the image that runs with the job's identity,
since it builds the image and starts the job with it. A key works only within the validity
window set when it was created, and can be disabled or deleted on atlas.ripe.net at any time.

Only the repository owner can make that workflow run. It has no pull request trigger of any kind,
so a fork or a pull request cannot start it; every job checks the repository, the actor and the
branch; and the job that gets an Azure token runs in the GitHub Environment `dev`, which only
`main` may use and which waits for the owner's approval. The approval is on by default; the owner
can turn it off with `scripts/bootstrap.sh dev --no-approval`, which leaves the other checks in
place. The tests run in Azure rather than on a self-hosted runner, because a self-hosted runner in
a public repository can be given work by a pull request from a fork.
