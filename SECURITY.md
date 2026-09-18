# Security

Atlas Credit Exchange handles two things that deserve care: the RIPE NCC Access
email addresses researchers add to their profiles, and the RIPE Atlas API keys
donors paste when they transfer credits through the site.

## Reporting a vulnerability

Please report privately rather than opening a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/tgoodyear/internetresearch/security/advisories/new)
on this repository, which reaches the maintainer directly.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgement within a few days. There is no bounty; this
is a volunteer community project.

Please do not run automated scanners against the live site, and do not use real
people's credits, projects or email addresses to demonstrate a finding.

## What the site does with sensitive data

**RIPE Atlas API keys are never stored.** A key pasted into the transfer form is
used and then discarded, never written to storage. Two separate things send it,
and both are worth naming.

The **Check balance** button on the transfer form is optional and can be pressed
as often as you like. Each press sends the key to `POST /api/atlas/balance`,
which makes one request to RIPE and returns the balance. Nothing is stored.

**Submitting the transfer** sends the key once more, and that request uses it for
at most three calls to RIPE: a balance check before sending, the transfer itself,
and a lookup of the resulting transaction so the pledge can carry a reference.

It is used for nothing else. Error paths deliberately avoid echoing request
bodies so a key cannot reach a log.
Donors are advised to create a key carrying only the two permissions the site uses,
"Transfer credits to another user" and "Get information about your credits", with a
short validity window, and to delete it afterwards.

**RIPE NCC Access emails are not public.** They never appear on an anonymous
endpoint. A signed-in donor is shown a researcher's address at the point they
begin a manual pledge, because they need it to send the transfer, and the
researcher sees that donor by name. A donor may hold one live pledge per project
at a time. Researchers can delete their profile, and the stored address with it,
from the profile page.

**The platform never holds credits.** Every transfer happens in RIPE Atlas
between the two accounts. The site records the ask, the pledge, and the proof.

## Infrastructure

Deployments run from GitHub Actions using OpenID Connect against a user-assigned
managed identity, federated only to this repository's `main` branch. There is no
long-lived Azure credential in the repository or in GitHub secrets. The identity
holds a custom role scoped to one resource group that cannot change role
assignments, re-federate itself, alter DNS, delete the site or the data, or
regenerate storage keys.
