import { Link } from 'react-router-dom';
import { META, PRIVACY_TEXT } from '../lib/pages';
import { usePageMeta } from '../lib/usePageMeta';

// Every statement here has to stay true of the code and the Azure resources. SECURITY.md,
// docs/ARCHITECTURE.md ("Privacy") and docs/RUNBOOK.md ("Monitoring", "Traffic") say the same
// things in more detail; change them together.
export default function Privacy() {
  usePageMeta(META.privacy);
  return (
    <div className="narrow">
      <div className="page-head">
        <h1>Privacy</h1>
        <p>{PRIVACY_TEXT}</p>
      </div>

      <div className="stack">
        <div className="card"><div className="card-body">
          <h2>Usage statistics</h2>
          <p className="muted">
            Atlas Relay counts how the site is used with Azure Application Insights, a Microsoft
            service. Once a page has finished loading, your browser sends:
          </p>
          <ul>
            <li>the pages you open, as paths without the query string or anything after a #;</li>
            <li>
              the address of the site whose link brought you here, cut to its origin (for example
              https://news.example, never the page or its query), or "direct" when your browser sent none;
            </li>
            <li>utm_source, utm_medium and utm_campaign, if the link you followed carried them;</li>
            <li>how long the page took to load, JavaScript errors, and the calls the page makes to this site's API (method, path, status and time);</li>
            <li>
              a few actions: opening the Send credits form, making a pledge (the method, and the amount
              rounded to a power of ten), posting a project, following a sign-in link, and following a
              link to atlas.ripe.net;
            </li>
            <li>your browser, operating system and device model, as your browser reports them.</li>
          </ul>
          <p className="muted">
            Application Insights works out an approximate location (country, region and city) from
            your IP address when the data arrives, and stores the address as 0.0.0.0.
          </p>
          <p className="muted">
            No id links one visit to the next. The site sets no cookies, stores nothing in your
            browser, and gives you no user or tracking id. Each page load gets a random id that is
            gone when you close the tab. Anything shaped like an email address or a RIPE Atlas API
            key is removed before sending. There is no advertising and no other analytics service.
            If your browser blocks Application Insights, the site works the same.
          </p>
          <p className="muted">
            The site's API logs each request it answers (which operation, the result and how long it
            took) and the outcome of each credit transfer it makes. These logs hold project and
            pledge ids, but no request bodies, API keys or email addresses.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Accounts, projects and pledges</h2>
          <p className="muted">
            You sign in with GitHub or Microsoft through Azure Static Web Apps. Your profile stores
            which of the two you used, the account name it passes on (for Microsoft this can be your
            email address), and an internal account id. Your display name starts as that account
            name, without anything after an @, and is shown next to your projects and pledges. You can
            change it on your profile page, and add an affiliation and a link, which are public too.
          </p>
          <p className="muted">
            Researchers add the email of their RIPE NCC Access account so donors can send them
            credits. It never appears on a public page. A signed-in donor sees it when they start a
            manual pledge to that researcher's project, and the researcher then sees that donor's name
            on the pledge.
          </p>
          <p className="muted">
            Projects and pledges are public: their text, amounts, messages, dates and names. A pledge
            marked anonymous shows as Anonymous, but the researcher still sees who made it.
          </p>
          <p className="muted">
            A RIPE Atlas API key you paste is used for your request and then discarded. It is never
            stored or logged.
          </p>
          <p className="muted">
            <strong>Delete my profile</strong> on your <Link to="/profile">profile page</Link> removes
            your profile and your RIPE NCC Access email and closes your open projects. Your projects
            and pledges stay on the site and show as Anonymous. They keep the internal account id, so
            signing in again with the same account reconnects you to them.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Storage and retention</h2>
          <p className="muted">
            Microsoft Azure hosts the site. The account, project and pledge records and the usage
            statistics and logs are stored in Azure's West US 2 region, in Washington state, USA.
            Usage statistics and logs are deleted after 30 days. Your profile is kept until you
            delete it, and projects and pledges are kept after that, as described above.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Legal basis</h2>
          <p className="muted">
            The usage statistics and logs are kept to count how the site is used and to keep it
            working, which is a legitimate interest. There is no consent banner because the site
            stores nothing on your device. Account, project and pledge records are kept because the
            site cannot publish a project or record a pledge without them.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Other services</h2>
          <p className="muted">
            The site's fonts come from Google Fonts, so your browser requests them from
            fonts.googleapis.com and fonts.gstatic.com, and Google receives your IP address and
            browser details with those requests. Signing in takes you to GitHub or Microsoft, and
            links to RIPE Atlas take you to atlas.ripe.net; their own privacy terms apply there.
          </p>
        </div></div>

        <div className="card"><div className="card-body">
          <h2>Contact</h2>
          <p className="muted">
            For questions about your data, or to ask for something to be corrected or removed, use{' '}
            <a href="https://goodyeartechnical.com/contact/" target="_blank" rel="noreferrer">goodyeartechnical.com/contact</a>.
          </p>
          <p className="small muted">Last updated 29 September 2026.</p>
        </div></div>
      </div>
    </div>
  );
}
