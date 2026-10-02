import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Field from '../components/Field';
import SignInPrompt from '../components/SignInPrompt';
import Spinner from '../components/Spinner';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { META } from '../lib/pages';
import { providerLabel } from '../lib/signin';
import { usePageMeta } from '../lib/usePageMeta';

export default function Profile() {
  const { loading, principal, user, refresh } = useAuth();
  usePageMeta(META.profile);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '';
  const [displayName, setDisplayName] = useState('');
  const [atlasEmail, setAtlasEmail] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setAtlasEmail(user.atlasEmail);
      setAffiliation(user.affiliation);
      setUrl(user.url);
    }
  }, [user]);

  if (loading) return <div className="narrow"><Spinner /></div>;
  if (!principal) return <div className="narrow" style={{ marginTop: '3rem' }}><SignInPrompt reason="Your profile holds the RIPE NCC Access email that donors send credits to." returnTo="/profile" /></div>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await api.updateMe({ displayName, atlasEmail, affiliation, url });
      await refresh();
      setSaved(true);
      if (next) navigate(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="narrow">
      <div className="page-head">
        <h1>Your profile</h1>
        <p>Signed in with {providerLabel(principal.identityProvider)} as <strong>{principal.userDetails || user?.displayName || 'you'}</strong>.</p>
      </div>
      {next && !user?.hasAtlasEmail && <div className="alert alert-info">Add your RIPE NCC Access email first, then you can post a project.</div>}
      <form className="card" onSubmit={submit}>
        <div className="card-body">
          <Field label="Display name" htmlFor="displayName" hint="Shown publicly on your projects and pledges. Avoid using an email address here.">
            <input id="displayName" type="text" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </Field>
          <Field
            label="RIPE NCC Access email"
            htmlFor="atlasEmail"
            hint={
              <>
                The email of your atlas.ripe.net account, where donors send credits. It never appears on public pages. A signed-in donor sees it when they start a manual pledge to one of your projects, and you see that donor's name on the project.
              </>
            }
          >
            <input id="atlasEmail" type="email" maxLength={254} value={atlasEmail} onChange={(e) => setAtlasEmail(e.target.value)} placeholder="you@example.org" autoComplete="off" />
          </Field>
          <div className="form-row">
            <Field label="Affiliation" htmlFor="affiliation" hint="University, lab, company, or “independent”.">
              <input id="affiliation" type="text" maxLength={120} value={affiliation} onChange={(e) => setAffiliation(e.target.value)} />
            </Field>
            <Field label="Homepage" htmlFor="url" hint="Optional. Helps donors verify who you are.">
              <input id="url" type="url" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
            </Field>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          {saved && !next && <div className="alert alert-success">Profile saved.</div>}
          <div className="form-actions">
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button>
          </div>
        </div>
      </form>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="card-body">
          <h2>Delete your profile</h2>
          <p className="muted">
            This removes your profile and your RIPE NCC Access email, and closes any of your projects
            that are still open, since nobody can send credits without that address. Projects you
            posted and pledges you made stay on the site with your name removed, and show as Anonymous
            to everyone. They keep an internal account id, so signing in again with the same GitHub or
            Microsoft account reconnects you to them. Credits already transferred stay transferred, and
            RIPE Atlas keeps its own record of them. If a pledge was under way when you delete, this
            page will tell you.
          </p>
          <button
            className="btn btn-danger"
            type="button"
            disabled={deleting}
            onClick={async () => {
              if (!confirm('Delete your profile and remove your RIPE NCC Access email?')) return;
              setDeleting(true);
              try {
                const res = await api.deleteMe();
                // A pledge can be past the point of no return when the profile goes: a transfer
                // already sent to RIPE, or a donor already shown the address. Nothing can undo
                // either, so the most the page can do is say so before logging out, rather than
                // leave the person believing their address is out of use.
                const inFlight = res.pledgesInFlight;
                const inFlightNote =
                  inFlight === null
                    ? 'We could not check whether anyone was pledging to your projects while you deleted your profile. If a pledge was under way, its credits may still reach your RIPE NCC Access account, or its donor may have been shown your RIPE NCC Access email.'
                    : inFlight > 0
                      ? `${inFlight === 1 ? 'A pledge to your projects was' : `${inFlight} pledges to your projects were`} under way while you deleted your profile. Credits already sent may still reach your RIPE NCC Access account, and a donor pledging by hand may already have been shown your RIPE NCC Access email.`
                      : '';
                // The profile is gone either way, which is the promise that matters. But the copy
                // above also says every open project is closed, and the sweep can fail partway, so
                // logging out silently would leave someone believing something untrue about what
                // is still listed under their name.
                //
                // Every path still logs out. Staying signed in on this page left the old form live,
                // and saving it would recreate the profile and put the RIPE address back -- undoing
                // the deletion the notice is about. So the notice is a blocking alert shown before
                // the redirect rather than a message left on the page.
                const notes: string[] = [];
                if (!res.sweepComplete) {
                  const n = res.projectsNotClosed;
                  const named = res.namesNotAnonymized;
                  // Two different things can be left undone and they need different words: a project
                  // still open is a project that cannot take credits, and a row that kept its name is
                  // the part of the promise about the name. Saying only the first would leave someone
                  // believing their name was gone everywhere when it is not.
                  const parts: string[] = [];
                  if (n === null || (n && n > 0)) {
                    parts.push(
                      n && n > 0
                        ? `${n} of your projects could not be closed and may still be listed. Nobody can pledge to them, because there is no longer an address to send credits to.`
                        : 'Your projects could not all be closed and some may still be listed. Nobody can pledge to them, because there is no longer an address to send credits to.',
                    );
                  }
                  if (named === null || (named && named > 0)) {
                    parts.push(
                      named && named > 0
                        ? `${named} of your projects or pledges still show your display name.`
                        : 'Some of your projects or pledges may still show your display name.',
                    );
                  }
                  notes.push(`${parts.join(' ')} Please report this so it can be finished by hand.`);
                }
                if (inFlightNote) notes.push(inFlightNote);
                if (notes.length > 0) {
                  alert(`Your profile and RIPE NCC Access email have been deleted. ${notes.join(' ')}`);
                }
                window.location.href = '/logout';
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not delete your profile');
                setDeleting(false);
              }
            }}
          >
            {deleting ? 'Deleting…' : 'Delete my profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
