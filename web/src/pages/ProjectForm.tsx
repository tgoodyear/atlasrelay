import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Field from '../components/Field';
import SignInPrompt from '../components/SignInPrompt';
import Spinner from '../components/Spinner';
import { api, ApiError, TAGS, pingsFor, type Tag } from '../lib/api';
import { useAuth } from '../lib/auth';
import { META } from '../lib/pages';
import { usePageMeta } from '../lib/usePageMeta';

export default function ProjectForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const { loading, principal, user } = useAuth();
  usePageMeta(editing ? META.editProject : META.newProject);

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [creditsRequested, setCreditsRequested] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [affiliation, setAffiliation] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [paperUrl, setPaperUrl] = useState('');
  const [deadline, setDeadline] = useState('');
  const [resultsSummary, setResultsSummary] = useState('');
  const [resultsUrl, setResultsUrl] = useState('');
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [ready, setReady] = useState(!editing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing && user && !affiliation) setAffiliation(user.affiliation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, editing]);

  useEffect(() => {
    if (!id) return;
    api.project(id)
      .then(({ project }) => {
        setTitle(project.title);
        setSummary(project.summary);
        setDescription(project.description);
        setCreditsRequested(String(project.creditsRequested));
        setTags(project.tags);
        setAffiliation(project.affiliation);
        setHomepageUrl(project.homepageUrl);
        setRepoUrl(project.repoUrl);
        setPaperUrl(project.paperUrl);
        setDeadline(project.deadline);
        setResultsSummary(project.resultsSummary);
        setResultsUrl(project.resultsUrl);
        setStatus(project.status);
        setReady(true);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  if (loading || !ready) return <div className="narrow"><Spinner /></div>;
  if (!principal) return <div className="narrow" style={{ marginTop: '3rem' }}><SignInPrompt reason="Sign in to post a project." returnTo={editing ? `/projects/${id}/edit` : '/projects/new'} /></div>;
  if (!editing && user && !user.hasAtlasEmail) {
    return (
      <div className="narrow" style={{ marginTop: '3rem' }}>
        <div className="card"><div className="card-body">
          <h2>Add your RIPE NCC Access email</h2>
          <p>Donors send credits to your RIPE NCC Access email, so we need it before you can post. It stays private.</p>
          <Link className="btn" to="/profile?next=/projects/new">Add my RIPE email</Link>
        </div></div>
      </div>
    );
  }

  const credits = Number(creditsRequested);
  const toggleTag = (t: Tag) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    // The results fields are sent only from the edit form, because that is the only place they are
    // shown. Sending them empty on create would work -- the route stamps nothing for empty text --
    // but a form should not post fields it never offered.
    const body = { title, summary, description, creditsRequested: credits, tags, affiliation, homepageUrl, repoUrl, paperUrl, deadline, ...(editing ? { status, resultsSummary, resultsUrl } : {}) };
    try {
      const res = editing ? await api.updateProject(id!, body) : await api.createProject(body);
      navigate(`/projects/${res.project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  return (
    <div className="narrow">
      <div className="page-head">
        <h1>{editing ? 'Edit project' : 'Post a project'}</h1>
        <p>Tell donors what you are measuring, which probes you need, how you arrived at the credit estimate, and where the results will be published.</p>
      </div>
      <form className="card" onSubmit={submit}>
        <div className="card-body">
          <Field label="Title" htmlFor="title">
            <input id="title" type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. IPv6 reachability of African IXPs, 2026 snapshot" />
          </Field>
          <Field label="One-paragraph summary" htmlFor="summary" hint={`${summary.length}/280. Shown on project cards.`}>
            <textarea id="summary" maxLength={280} value={summary} onChange={(e) => setSummary(e.target.value)} required style={{ minHeight: 80 }} />
          </Field>
          <Field label="Full description" htmlFor="description" hint="Methodology, probe selection, measurement schedule, how results will be published, and whether built-in or existing public measurements were considered first. Plain text; blank lines make paragraphs.">
            <textarea id="description" maxLength={8000} value={description} onChange={(e) => setDescription(e.target.value)} required />
          </Field>
          <div className="form-row">
            <Field
              label="Credits needed"
              htmlFor="credits"
              hint={
                credits > 0
                  ? `About ${pingsFor(credits)} ping results, or ${Math.floor(credits / 30).toLocaleString('en-US')} traceroutes, at RIPE's base rates. What a measurement is billed comes from its own settings and can differ. RIPE Atlas also caps how much any one account may spend per day, so a large request takes time to use; your own limit is shown on your credits page.`
                  : 'Whole number. At the base rates RIPE publishes, a ping result costs 3 credits and a traceroute 30, though what a measurement is billed depends on how it is set up. RIPE Atlas caps daily spending per account, so check your own limit before asking for a very large amount.'
              }
            >
              <input id="credits" type="number" min={1} max={1000000000} step={1} value={creditsRequested} onChange={(e) => setCreditsRequested(e.target.value)} required />
            </Field>
            <Field label="Needed by" htmlFor="deadline" hint="Optional.">
              <input id="deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </Field>
          </div>
          <Field label="Measurement types" hint="Pick up to six.">
            <div className="tag-select">
              {TAGS.map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={tags.includes(t)} onChange={() => toggleTag(t)} disabled={!tags.includes(t) && tags.length >= 6} />
                  {t}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Affiliation" htmlFor="affiliation">
            <input id="affiliation" type="text" maxLength={120} value={affiliation} onChange={(e) => setAffiliation(e.target.value)} />
          </Field>
          <div className="form-row">
            <Field label="Project homepage" htmlFor="homepage" hint="Optional.">
              <input id="homepage" type="url" value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} placeholder="https://" />
            </Field>
            <Field label="Code repository" htmlFor="repo" hint="Optional.">
              <input id="repo" type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://" />
            </Field>
          </div>
          <Field label="Paper or proposal" htmlFor="paper" hint="Optional. A preprint or proposal helps donors judge the work.">
            <input id="paper" type="url" value={paperUrl} onChange={(e) => setPaperUrl(e.target.value)} placeholder="https://" />
          </Field>
          {/* Only when editing. A project being posted has nothing to report yet, and offering the
              boxes at that point would invite people to describe what they intend to find. */}
          {editing && (
            <>
              <Field
                label="Results"
                htmlFor="results-summary"
                hint={`${resultsSummary.length}/4000. What came of the work, for the donors who gave credits and for anyone deciding whether to. Plain text; blank lines make paragraphs. Leave it empty until you have something to say.`}
              >
                <textarea id="results-summary" maxLength={4000} value={resultsSummary} onChange={(e) => setResultsSummary(e.target.value)} style={{ minHeight: 120 }} />
              </Field>
              <Field label="Link to the results" htmlFor="results-url" hint="Optional. The RIPE Labs post, paper or dataset that came out. Different from the paper or proposal field above, which is what justified the ask.">
                <input id="results-url" type="url" value={resultsUrl} onChange={(e) => setResultsUrl(e.target.value)} placeholder="https://" />
              </Field>
              <Field label="Status" htmlFor="status" hint="Closed projects stop accepting pledges.">
                <select id="status" value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'closed')}>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </Field>
            </>
          )}
          {error && <div className="alert alert-error">{error}</div>}
          <div className="form-actions">
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Publish project'}</button>
            <Link className="btn btn-ghost" to={editing ? `/projects/${id}` : '/projects'}>Cancel</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
