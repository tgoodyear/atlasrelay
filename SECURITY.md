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

## Reporting abuse, or asking for a takedown

Nobody vets the projects posted here. Anyone who can sign in with GitHub or
Microsoft can ask for credits, and the site cannot tell a real research project
from an invented one. That is stated on the page where donors transfer credits,
because it is the moment it matters.

If a project is fraudulent, misrepresents who is behind it, or should come down
for any other reason, open an issue labelled `abuse` on this repository, or use
private vulnerability reporting if naming the project publicly would make things
worse. Say which project (the URL is enough) and what is wrong with it.

There is one maintainer and no rota, so expect days rather than hours. A project
found to be fraudulent is closed, which stops it accepting further credits, and
its owner's account is removed. Credits already transferred are gone: they move
directly between RIPE Atlas accounts, and neither this site nor the RIPE NCC can
reverse a transfer on our say-so.

If you sent credits to a project you now believe was fraudulent, report it here
so nobody else does, and raise it with RIPE NCC if you think a RIPE Atlas
account is being misused.

## What the site does with sensitive data

**RIPE Atlas API keys are never stored.** A key pasted into the transfer form is
used inside a single API call for up to three requests, and is then discarded: a
balance check before sending, the transfer itself, and a lookup of the resulting
transaction so the pledge can carry RIPE's reference. It is used for nothing else. It is not written to storage, and error
paths deliberately avoid echoing request bodies so a key cannot reach a log.
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
