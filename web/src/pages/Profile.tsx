import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Field from '../components/Field';
import SignInPrompt from '../components/SignInPrompt';
import Spinner from '../components/Spinner';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Profile() {
  const { loading, principal, user, refresh } = useAuth();
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
        <p>Signed in via {principal.identityProvider === 'aad' ? 'Microsoft' : principal.identityProvider} as <strong>{principal.userDetails || user?.displayName || 'you'}</strong>.</p>
      </div>
      {next && !user?.hasAtlasEmail && <div className="alert alert-info">Add your RIPE NCC Access email first, then you can post a project.</div>}
      <form className="card" onSubmit={submit}>
        <div className="card-body">
          <Field label="Display name" htmlFor="displayName" hint="Shown on your projects and pledges.">
            <input id="displayName" type="text" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </Field>
          <Field
            label="RIPE NCC Access email"
            htmlFor="atlasEmail"
            hint={
              <>
                The email of the account you use at atlas.ripe.net. Donors transfer credits to this address. <strong>Never shown publicly</strong>; only revealed to a donor who has pledged to one of your projects.
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
    </div>
  );
}
