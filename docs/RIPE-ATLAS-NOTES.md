# RIPE Atlas research notes

Source: https://atlas.ripe.net/docs/ (read 2026-09-16). These notes capture only what
matters for a credit donation site. Verify against the live docs before relying
on any detail marked *unverified*.

## Credits in one paragraph

Credits are the currency of RIPE Atlas. Hosting a connected probe earns 15 credits per
minute (~21,600/day) plus 1 credit per result delivered; anchors earn 10x. RIPE NCC
members can claim a monthly allowance. Sponsors receive the credits of the probes they
sponsor. Credits are spent on user-defined measurements: ping 3/result, DNS 10 (UDP) or
20 (TCP)/result, traceroute 30/result, SSL cert 10/result. One-off measurements cost
double. When a balance is projected to run out within five days RIPE emails a warning,
and measurements can be stopped automatically if the account goes into deficit.

## Moving credits between users (what RIPE already supports)

| Mechanism | Where | Notes |
| --- | --- | --- |
| One-off transfer | Web UI at https://atlas.ripe.net/credits/transfer/ and `POST /api/v2/credits/transfers/` | Recipient is identified by the **email address of their RIPE NCC Access account**. |
| Standing order | `/api/v2/credits/standing-order/` | Threshold + amount, evenly split across recipients. Recurring. |
| Shared access ("bill me") | `/api/v2/credits/bill-me/` | Lets another user charge measurements against your balance. |
| Vouchers | `/api/v2/credits/voucher/redeem/` | Codes issued by RIPE NCC. Not self-service. |

### Transfer endpoint (verified)

```
POST https://atlas.ripe.net/api/v2/credits/transfers/
Authorization: Key <api-key>
Content-Type: application/json

{ "recipient": "user@example.com", "amount": 1000 }
```

- Response `201 Created`. The docstring promises `{ "transaction": "<URL>" }`, but the schema in
  the OpenAPI document is `{amount, recipient}`, and a real transfer returned a generic list URL
  (`.../credits/transactions/?sort=-date&type=admin`) identical for every transfer. So the 201
  itself is the only signal that credits moved; the platform does not look the transaction up
  to record a reference.
- `amount` is an integer; `recipient` must be a RIPE NCC Access account. The docs say a
  recipient who has never used Atlas can still receive and will see the credits after
  visiting atlas.ripe.net.
- The manual's page uses `/credits/transfer/` (singular) while the reference uses
  `/credits/transfers/` (plural). The reference is generated from the API schema, and the plural
  form is confirmed working against the live API, so the platform posts to it once and never
  retries on another path. Re-posting a transfer to guess at a path could send credits twice.
- No documented amount limits or rate limits. Measurement-creation endpoints are
  documented as more strictly rate-limited than reads; 429 = back off.

### Balance endpoint (verified)

`GET /api/v2/credits/` returns `current_balance`, `estimated_daily_income`,
`estimated_daily_expenditure`, `estimated_runout_seconds`, `past_day_credits_spent`,
plus links to `income_items`, `expense_items` and `transactions`. Requires an API key
with a credits-read permission (the manual calls it "credits read"; the exact
`permission_group.permission_name` id is only visible from the authenticated
`GET /api/v2/keys/permissions/` endpoint, so it is *unverified from public docs*).

### Transactions (verified)

`GET /api/v2/credits/transactions/` returns `id`, `type` (`admin` | `measurement` |
`probe`), `reason`, `description`, `amount`, `balance_before`, `balance_after`, `date`.
Filters: `date`, `date__gt/gte/lt/lte`, `type`, `sort`, `page_size`. Transfers appear as
`admin` transactions; the description format is not documented, so automatic
receipt-matching is best-effort.

Seen live (2026-09-18): the list is `{count, next, previous, results}`, newest first with
`sort=-date`; `date` is an integer epoch in seconds; a transfer out is a negative `amount` and credits
in are positive. In the sender's list, a transfer's row appeared 40 to 70 seconds after the
transfer, not at once. The site checks manual pledges against the owner's list using `sort`,
`type` and `page_size` only; the date filters are documented but have not been tried live.

Seen live (2026-10-01, the dev full-flow run, two transfers of 100 and 90 credits):
`?sort=-date&type=admin&page_size=100` answers 200. Both sides list the transfer as `admin`, with
`reason` "Transfer" and a `description` of "from" and an email address on the recipient's row,
"to" and an email address on the sender's (the run masks addresses, so which address is not
recorded; presumably the other account's RIPE NCC Access email). The two rows of one transfer
have different transaction ids. The recipient's row was listed within 1 to 6
seconds of the transfer, carrying the second the transfer was made. One run is not a guarantee, so
the site still tells the owner a new transfer can take a minute or two to appear. No documented
field names the other account. The `description` appears to, but its format is undocumented, so
the site does not rely on it.

## Authentication and identity

- **API keys** (preferred): `Authorization: Key <uuid>`. Keys are scoped by *grants*
  (`permission` + optional `target`), shown once at creation, can be time-boxed
  (`valid_from`/`valid_to`), disabled, regenerated, and are frozen after inactivity.
  403 means missing permission, unknown key, disabled, or outside the valid window.
- **Session auth** only works for JavaScript running on the atlas.ripe.net origin. The
  site sets a strict CSP; third-party sites cannot use it. So a browser-side
  "click to transfer from our site" flow against the Atlas API is impossible.
- **Error format**: `{ "error": { "status", "code", "detail", "title", "errors": [...] } }`.
- **Privacy**: RIPE never shows user email addresses publicly, so this site treats the
  RIPE NCC Access email as private data.

## Can we federate identity with RIPE NCC Access?

RIPE NCC Access is a Keycloak realm. Its discovery document is public:

```
https://idp.ripe.net/realms/ripe-ncc/.well-known/openid-configuration
issuer:                 https://idp.ripe.net/realms/ripe-ncc
authorization_endpoint: .../protocol/openid-connect/auth
token_endpoint:         .../protocol/openid-connect/token
userinfo_endpoint:      .../protocol/openid-connect/userinfo
scopes: openid profile email ... audience/whois ... 
```

Findings:

1. It is standard OpenID Connect, so **technically** any OIDC relying party can use it.
2. **Client registration is gated.** The dynamic-registration endpoint answers
   `403 insufficient_scope, Policy 'Trusted Hosts' rejected request`. The only
   self-service path RIPE documents is the LIR Portal (https://my.ripe.net/#/oauth2),
   available to admin users of a member LIR, and that program is described as being
   for RIPE Database access (scopes `audience/whois`, `whois.mntner`). There is no
   published program for third-party Atlas apps.
3. Even with an OIDC login, **the Atlas API has no OAuth bearer support**. It accepts
   only API keys and same-origin session cookies. Federated login would prove *who* a
   user is (and give us their verified RIPE NCC Access email, which is exactly the
   transfer recipient identifier), but it would not let us move credits on their
   behalf. Transfers still need an API key or a manual step on atlas.ripe.net.

Conclusion for v1: sign users in with GitHub or Microsoft (built into Azure Static
Web Apps), ask requesters for their RIPE NCC Access email, and make
transfers happen either through a donor-supplied, single-use, transfer-scoped API key
or manually on atlas.ripe.net. Design the code so a RIPE NCC Access OIDC provider can
be plugged in later (Azure Static Web Apps Standard plan, custom OIDC provider) if
RIPE NCC issues a client; that would let us auto-verify the recipient email.

## Scale, quotas and research impact (Nosyk et al., 2025)

"Day in the Life of RIPE Atlas: Operational Insights and Applications in Network
Measurements" (Nosyk, Tashiro, Lone, Kisteleki, Duda, Korczyński; arXiv:2511.22474,
November 2025, https://arxiv.org/abs/2511.22474) analyses one full day of the platform
(21 February 2024). Facts from it that matter for this site:

- **Scale**: about 12.9K connected probes and 810 anchors in 178 countries and 4K+
  ASes; 50.9K active measurements produced 1.3 billion results (1.1 TB) in 24 hours.
  Germany and the United States together host about 28% of devices; 32 countries have
  a single device, and the authors call for more probes in underrepresented regions.
- **Where results come from**: anchoring measurements yield 67.5% of all results and
  built-in measurements 21.1%; user-defined measurements, the ones that cost credits,
  only 11.4%. A large share of existing data is free to reuse.
- **Credits and quotas** (section 2.2): each measurement's cost is proportional to the
  load it places on probes; a user cannot run more than 100 measurements at once or use
  more than 1,000 probes per measurement. The paper gives the daily spend limit as 1M
  credits, but the limit is set per account: one account checked in September 2026 reported
  `max_daily_credits: 10000000`. The live value is in the `max_daily_credits` field of
  `GET /api/v2/credits/`, so quote that rather than a constant. The Atlas team considers
  exceptions case by case. Anchors earn ten times the credits of probes.
- **Researcher access** (section 1): the platform "is open for anyone to launch custom
  measurements, provided a user possesses a sufficient amount of RIPE Atlas credits",
  and "if in need, researchers can request them by contacting the RIPE Atlas team
  directly". This site complements that route.
- **Research impact** (section 3): over a thousand publications use Atlas; 79 papers at
  top venues between 2019 and 2023 were analysed, dominated by traceroute, DNS and ping.
- **Guidance for new campaigns** (section 6): check whether built-in, anchoring or
  existing public measurements already answer the question; prefer recurring
  measurements over redundant one-offs; tag and describe measurements so others can
  find and reuse them (Measurement Bundles); assess ethics, including DNS queries for
  domains that are sensitive in some jurisdictions.

How the site uses this: the project form asks requesters whether existing measurements
were considered and to check their own daily limit before asking for a large amount; the
How it works page cites the paper and points to the direct-request route.

## Things worth asking RIPE NCC

- Whether they would issue an OIDC client for this site (verified email claim).
- The exact permission id for credit transfers, and whether a key can be limited to a
  maximum transfer amount or a target recipient (grants do support `target`, but the
  target types for credit permissions are not documented).
- Whether transfer transactions carry a stable reference that could be matched to a
  pledge (e.g. `description` containing sender email).
