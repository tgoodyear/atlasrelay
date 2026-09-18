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

Nobody vets the projects posted here. Posting needs a GitHub or Microsoft
sign-in and a RIPE NCC Access email added to the profile, which is where the
credits would go. Neither is checked against anything: the address is
self-declared, and the site cannot tell a real research project from an invented
one. That is stated on the page where donors transfer credits,
because it is the moment it matters.

If a project is fraudulent, misrepresents who is behind it, or should come down
for any other reason, open an issue labelled `abuse` on this repository, or use
private vulnerability reporting if naming the project publicly would make things
worse. Say which project (the URL is enough) and what is wrong with it.

There is one maintainer and no rota, so expect days rather than hours. A project
found to be fraudulent is closed, which stops it accepting further credits and
takes it off the listing. That closure is marked as the site's rather than the
owner's, so the owner cannot simply reopen it. The owner's profile, including their stored RIPE NCC
Access email, can be deleted too. Be clear about what that is not: it is not a
ban. Signing in again with the same account recreates a profile, and the past
projects and pledges are still linked to it. Credits already transferred are
gone; they move directly between RIPE Atlas accounts, and neither this site nor
the RIPE NCC can reverse a transfer on our say-so.

If you sent credits to a project you now believe was fraudulent, report it here
so nobody else does, and raise it with RIPE NCC if you think a RIPE Atlas
account is being misused.

## What the site does with sensitive data

**RIPE Atlas API keys are never stored.** A key pasted into the transfer form is
used and then discarded, never written to storage. Two separate things send it,
and both are worth naming.

The **Check balance** button on the transfer form is optional and can be pressed
as often as you like. Each press sends the key to `POST /api/atlas/balance`,
which makes one request to RIPE and returns the balance. Nothing is stored.

**Submitting the transfer** sends the key once more, and that request uses it for
at most two calls to RIPE: a balance check before sending, and then the transfer.

The balance check is attempted for every key, including one that carries only the
transfer permission. A check that *fails* does not stop anything: RIPE refusing it
for want of a permission, or not answering at all, is recorded as a warning and
the transfer goes ahead regardless. What stops the request is a balance RIPE
reports successfully and which is below the amount; then the key has been used
once and nothing was sent. The same is true if something else fails between the
two, such as the recipient no longer being available. Never more than two.

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

**Donors may pledge without being named publicly.** Choosing this on the pledge
form lists the pledge as "Anonymous" everywhere the public can see it, with the
amount and any message still shown. What it withholds is a stable identity: every
anonymous pledge carries the same name, so nothing account-derived is published
that would tie one to another. It is not unlinkability. The amount, the message
and the date stay public, and those can be correlated, so a distinctive amount or
a message that gives the donor away still gives them away.
The researcher receiving the credits still sees who pledged. They confirm manual
transfers themselves, and for any pledge they may need to reconcile it against
their own RIPE transaction log, which lists the sending account. Their view says
the name is not public. The row
records the donor either way, which is what enforces one live pledge per project
and lets a donor see their own pledges. So this withholds a name from public
view; it does not make a pledge untraceable to the operator or to the
researcher.

**The platform never holds credits.** Every transfer happens in RIPE Atlas
between the two accounts. The site records the ask, the pledge, and the proof.

## Infrastructure

Deployments run from GitHub Actions using OpenID Connect against a user-assigned
managed identity, federated only to this repository's `main` branch. There is no
long-lived Azure credential in the repository or in GitHub secrets. The identity
holds a custom role scoped to one resource group that cannot change role
assignments, re-federate itself, alter DNS, delete the site or the data, or
regenerate storage keys.
