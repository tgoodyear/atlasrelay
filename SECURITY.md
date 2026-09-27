# Security

Atlas Relay handles two kinds of sensitive data: the RIPE NCC Access email addresses
researchers add to their profiles, and the RIPE Atlas API keys donors paste when they
transfer credits through the site.

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

Nobody vets the projects posted here. Posting needs a GitHub or Microsoft sign-in and a
self-declared RIPE NCC Access email, and the site cannot tell a real research project from an
invented one. The transfer page tells donors this.

If a project is fraudulent, misrepresents who is behind it, or should come down for another
reason, open an issue labelled `abuse` with the project's URL and what is wrong with it. If
naming the project publicly would make things worse, use private vulnerability reporting
instead.

There is one maintainer, so expect a response in days rather than hours. A fraudulent project
is closed by the site, which stops it accepting credits and removes it from the listing; the
owner cannot reopen it. The owner's profile and stored email can be deleted too, but that is
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

**The site never holds credits.** Every transfer happens inside RIPE Atlas between the two
accounts. The site records the project, the pledge and its confirmation.

## Infrastructure

GitHub Actions deploys with OpenID Connect through a user-assigned managed identity that
trusts only this repository's `main` branch. No long-lived Azure credential is stored in the
repository or in GitHub secrets. The identity's custom role is scoped to one resource group
and cannot change role assignments, modify its own federation, change DNS, delete the site or
the storage account, or regenerate storage keys.
