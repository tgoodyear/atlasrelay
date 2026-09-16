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
            <li>Sign in with GitHub or Microsoft and add the email of your <a href="https://access.ripe.net" target="_blank" rel="noreferrer">RIPE NCC Access</a> account to your profile. That email is where donors send credits. It is never shown publicly, only to a donor who has committed to a pledge.</li>
            <li>Post a project: what you are measuring, why it matters, how many credits you need, and by when. Rough guide from the <a href="https://atlas.ripe.net/docs/getting-started/credits/" target="_blank" rel="noreferrer">RIPE Atlas docs</a>: a ping result costs 3 credits, DNS 10 to 20, traceroute 30, one-off measurements double.</li>
            <li>When a donor sends credits manually, they appear in your <a href="https://atlas.ripe.net/credits/" target="_blank" rel="noreferrer">Atlas credits page</a>. Confirm the pledge on your dashboard. API-driven transfers are confirmed automatically.</li>
            <li>Close the project when you are done and, ideally, link your results so donors see what they enabled.</li>
          </ol>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>If you have credits to share</h2>
          <ol className="steps">
            <li>Open a project and click <strong>Send credits</strong>. Choose an amount; you can't exceed what the project still needs.</li>
            <li><strong>Transfer through the API.</strong> Create a key at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a> with only the credit-transfer permission and, ideally, a short validity window. Paste it in. We call <code>POST /api/v2/credits/transfers/</code> once, record RIPE's transaction reference as proof, and discard the key. Delete the key afterwards.</li>
            <li><strong>Or transfer by hand.</strong> We show you the recipient email and amount with a link to <a href="https://atlas.ripe.net/credits/transfer/" target="_blank" rel="noreferrer">the Atlas transfer page</a>. Mark the pledge as sent; the researcher confirms receipt.</li>
          </ol>
        </div></div>

        <div className="card"><div className="card-body faq">
          <h2>Questions</h2>
          <details>
            <summary>Why do I need to sign in with GitHub or Microsoft rather than RIPE NCC Access?</summary>
            <p>RIPE NCC Access is a standard OpenID Connect provider, but RIPE NCC does not currently issue client registrations to third-party sites, so we cannot federate with it. GitHub and Microsoft sign-in are built into our hosting platform at no cost. If RIPE NCC makes a client available we will add it, which would also let us verify recipient emails automatically.</p>
          </details>
          <details>
            <summary>Is my RIPE Atlas API key stored?</summary>
            <p>No. A key you paste is used for at most two requests (an optional balance check and the transfer) inside a single API call, and it is never written to storage or logs. Use a key scoped to credit transfers only and delete it afterwards.</p>
          </details>
          <details>
            <summary>How do I know the researcher is who they say they are?</summary>
            <p>Projects show the poster's sign-in handle, affiliation, and links to homepages, papers or repositories. We cannot verify RIPE emails without federation, so treat this like any community exchange: look at the links, start small, and prefer API transfers, whose success proves the recipient email belongs to a real RIPE NCC Access account.</p>
          </details>
          <details>
            <summary>Can a project ask for more than it needs?</summary>
            <p>Pledges are capped at the unfunded remainder of each project. Once the confirmed total reaches the request, the project shows as funded and stops accepting pledges unless the owner raises the request.</p>
          </details>
          <details>
            <summary>Is this run by RIPE NCC?</summary>
            <p>No. It is an independent community tool built on the public <a href="https://atlas.ripe.net/docs/apis/rest-api-manual/credits/transferring-credits/" target="_blank" rel="noreferrer">RIPE Atlas REST API</a>. RIPE Atlas also offers standing orders and "bill me" sharing between users you already know.</p>
          </details>
        </div></div>

        <p className="muted small">
          Ready? <Link to="/projects">Browse projects</Link> or <Link to="/projects/new">post one</Link>.
        </p>
      </div>
    </div>
  );
}
