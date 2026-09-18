import { Link } from 'react-router-dom';

export default function HowItWorks() {
  return (
    <div className="narrow">
      <div className="page-head">
        <h1>How it works</h1>
        <p>Atlas Credit Exchange is a notice board with a confirmation loop. RIPE Atlas stays the ledger; we never hold credits or long-lived keys.</p>
      </div>

      <div className="stack">
        <div className="card"><div className="card-body">
          <h2>If you need credits</h2>
          <ol className="steps">
            <li>Sign in with GitHub or Microsoft and add the email of your <a href="https://access.ripe.net" target="_blank" rel="noreferrer">RIPE NCC Access</a> account to your profile. That email is where donors send credits. It never appears on a public page, and a signed-in donor sees it when they start a manual pledge to your project, so that they can send the transfer. You see each of those donors by name.</li>
            <li>Post a project: what you are measuring, why it matters, how many credits you need, and by when. Rough guide from the <a href="https://atlas.ripe.net/docs/getting-started/credits/" target="_blank" rel="noreferrer">RIPE Atlas docs</a>: a ping result costs 3 credits, DNS 10 to 20, traceroute 30, one-off measurements double.</li>
            <li>When a donor sends credits manually, they appear in your <a href="https://atlas.ripe.net/credits/" target="_blank" rel="noreferrer">Atlas credits page</a>. Confirm the pledge on your dashboard. API-driven transfers are confirmed automatically.</li>
            <li>Close the project when you are done and, ideally, link your results so donors see what they enabled.</li>
          </ol>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>If you have credits to share</h2>
          <ol className="steps">
            <li>Open a project and click <strong>Send credits</strong>. Choose an amount; you can't exceed what the project still needs.</li>
            <li><strong>Transfer through the API.</strong> Create a key at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a> with two permissions and no others: <strong>Transfer credits to another user</strong>, which sends the credits, and <strong>Get information about your credits</strong>, which lets us check your balance first, so the commonest reason a transfer fails is caught before anything moves. Give it a short validity window. Paste it in, and we call <code>POST /api/v2/credits/transfers/</code> exactly once, then discard the key. RIPE accepting that call is what confirms the credits moved, and it is the only thing we record it by: RIPE does not index the transaction until well after it accepts the transfer, so there is no reference to attach while your request is still running. Delete the key afterwards. A key with only the transfer permission still works. We still ask for the balance, RIPE refuses that request, and the transfer goes ahead with a note that we could not check it first.</li>
            <li><strong>Or transfer by hand.</strong> We show you the recipient email and amount with a link to <a href="https://atlas.ripe.net/credits/transfer/" target="_blank" rel="noreferrer">the Atlas transfer page</a>. Mark the pledge as sent; the researcher confirms receipt.</li>
          </ol>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Before you ask for credits</h2>
          <p className="muted">
            A 2025 operational study of RIPE Atlas found that user-defined measurements, the ones that cost credits, produce only about 11% of the platform's 1.3 billion daily results; anchoring and built-in measurements produce the rest and are free to reuse. The same study documents the default per-user quotas: at most 100 concurrent measurements, 1,000 probes per measurement and 1,000,000 credits spent per day. The daily figure is a default rather than a universal ceiling. It is set per account, the RIPE NCC raises it on request, and your own is in the <code>max_daily_credits</code> field of your credits page.
          </p>
          <ol className="steps">
            <li>Check whether <a href="https://atlas.ripe.net/docs/getting-started/built-in-measurements/" target="_blank" rel="noreferrer">built-in</a>, anchoring or existing public measurements already answer your question. Say so in your project description; donors appreciate it.</li>
            <li>Size the request and the deadline against your own daily spend limit, not just the total. On the default 1M credits/day a 30M-credit campaign takes at least 30 days of measuring, however fast the credits arrive. Check your own limit first, and say in the project what it is, because it is what decides your realistic timeline.</li>
            <li>Prefer recurring measurements over repeated one-offs (one-offs cost double), tag and describe them so others can reuse them, and avoid DNS queries for domains that are sensitive in some jurisdictions.</li>
            <li>RIPE NCC also considers direct credit requests from researchers; contact the <a href="https://atlas.ripe.net/contact/" target="_blank" rel="noreferrer">RIPE Atlas team</a>. This exchange complements that route.</li>
          </ol>
          <p className="small muted" style={{ marginTop: '1rem', marginBottom: 0 }}>
            Source: Nosyk, Tashiro, Lone, Kisteleki, Duda and Korczyński, <a href="https://arxiv.org/abs/2511.22474" target="_blank" rel="noreferrer"><em>Day in the Life of RIPE Atlas: Operational Insights and Applications in Network Measurements</em></a>, arXiv:2511.22474, November 2025.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>What this site stores about you</h2>
          <p className="muted">
            Signing in records an identifier from GitHub or Microsoft, your display name, and
            anything you choose to add: affiliation, a homepage, and the email of your RIPE NCC
            Access account. Projects and pledges you create are stored with your display name.
          </p>
          <p className="muted">
            Your RIPE NCC Access email is never shown on a public page. It is shown to a signed-in
            donor at the point they begin a manual pledge to your project, because they need it to
            transfer the credits, and each such donor appears by name on your project. No advertising
            service receives anything, and there are no tracking cookies. The site does send
            operational telemetry to Azure Application Insights, which is what tells us the API is
            working: request paths, status codes, timings and errors, kept for 30 days. That stream
            carries no profile fields, no RIPE NCC Access email and no API key.
          </p>
          <p className="muted">
            RIPE Atlas API keys are never stored. A key you paste is used for a single transfer
            request and discarded; it is not written to storage or to logs.
          </p>
          <p className="muted">
            You can delete your profile, including your RIPE email, at any time from your{' '}
            <Link to="/profile">profile page</Link>. Projects and pledges remain, carrying only the
            display name you chose, because other people rely on that record.
          </p>
        </div></div>

        <div className="card"><div className="card-body faq">
          <h2>Questions</h2>
          <details>
            <summary>Why do I need to sign in with GitHub or Microsoft rather than RIPE NCC Access?</summary>
            <p>RIPE NCC Access is a standard OpenID Connect provider, but RIPE NCC does not currently issue client registrations to third-party sites, so we cannot federate with it. GitHub and Microsoft sign-in are built into our hosting platform at no cost. If RIPE NCC makes a client available we will add it, which would also let us verify recipient emails automatically.</p>
          </details>
          <details>
            <summary>Is my RIPE Atlas API key stored?</summary>
            <p>No. A key you paste is used for two requests (a balance check and the transfer) inside a single API call, and it is never written to storage or logs. Use a key scoped to credit transfers only and delete it afterwards.</p>
          </details>
          <details>
            <summary>How do I know the researcher is who they say they are?</summary>
            <p>You don't, and nobody here checks. Posting needs a GitHub or Microsoft sign-in and a RIPE NCC Access email, and neither is verified against anything: the address is self-declared, and this site cannot confirm that a person is who they say they are or that the credits will be used as described. What you can see is the display name they chose, their affiliation, and any links they gave to homepages, papers or repositories. The sign-in handle is deliberately not published, so it is not something you can check either. Treat it like any community exchange: read the links, start small, and send only what you are willing to lose. An API transfer at least proves the recipient email belongs to a real RIPE NCC Access account. Credits cannot be recalled once transferred. If a project looks fraudulent, <a href="https://github.com/tgoodyear/internetresearch/issues/new?labels=abuse&amp;title=Report%20a%20project" target="_blank" rel="noreferrer">report it</a>.</p>
          </details>
          <details>
            <summary>Can a project receive more than it asked for?</summary>
            <p>Yes. A project keeps accepting pledges and transfers until it has received 100 times what it asked for, so researchers can bank a buffer for reruns and follow-up measurements. Once the confirmed total reaches the request the project shows as funded, and it stays open until the owner closes it or the 100× ceiling is reached.</p>
          </details>
          <details>
            <summary>Is this run by RIPE NCC?</summary>
            <p>No. It is an independent community tool built on the public <a href="https://atlas.ripe.net/docs/apis/rest-api-manual/credits/transferring-credits/" target="_blank" rel="noreferrer">RIPE Atlas REST API</a>. RIPE Atlas also offers standing orders and "bill me" sharing between users you already know.</p>
          </details>
          <details>
            <summary>How big is RIPE Atlas, and does anyone use the data?</summary>
            <p>On a single day in February 2024 the platform had about 12,900 connected probes and 810 anchors in 178 countries and more than 4,000 networks, running 50,900 measurements that produced 1.3 billion results. Over a thousand scientific publications build on it, mostly with traceroute, DNS and ping measurements. Coverage is uneven. Germany and the United States together host about 28% of devices, 32 countries have a single device, and projects that measure from underrepresented regions are especially valuable (<a href="https://arxiv.org/abs/2511.22474" target="_blank" rel="noreferrer">Nosyk et al., 2025</a>).</p>
          </details>
        </div></div>

        <p className="muted small">
          <Link to="/projects">Browse projects</Link> or <Link to="/projects/new">post one</Link>.
        </p>
      </div>
    </div>
  );
}
