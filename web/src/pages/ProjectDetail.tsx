import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PledgeDialog from '../components/PledgeDialog';
import { PledgeStatusPill, StatusPill, TagPills } from '../components/Pills';
import Progress from '../components/Progress';
import Spinner from '../components/Spinner';
import { api, ApiError, fmt, fmtDate, pingsFor, type Pledge, type Project, type PublicUser } from '../lib/api';
import { loginUrl, useAuth } from '../lib/auth';

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const { principal } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [owner, setOwner] = useState<PublicUser | null>(null);
  const [pledges, setPledges] = useState<Pledge[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [error, setError] = useState('');
  const [showPledge, setShowPledge] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.project(id);
      setProject(r.project);
      setOwner(r.owner);
      setIsOwner(Boolean(r.viewer?.isOwner));
      if (r.viewer) {
        // Signed in: fetch the private view (owner sees all pledges with actions; donor sees own).
        const mine = await api.pledges(id).catch(() => null);
        if (mine) {
          const byId = new Map(mine.pledges.map((p) => [p.id, p]));
          setPledges(r.pledges.map((p) => byId.get(p.id) ?? p).concat(mine.pledges.filter((p) => !r.pledges.some((x) => x.id === p.id))));
          return;
        }
      }
      setPledges(r.pledges);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'Project not found' : (e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="narrow"><div className="empty" style={{ marginTop: '3rem' }}>{error}. <Link to="/projects">All projects</Link></div></div>;
  if (!project) return <div className="container"><Spinner /></div>;

  const canPledge = project.open && project.maxPledge > 0 && !isOwner;

  const updatePledge = async (p: Pledge, status: Pledge['status']) => {
    setBusy(p.id);
    try {
      await api.updatePledge(project.id, p.id, status);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Could not update pledge');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="container">
      <div className="detail">
        <article>
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            <StatusPill project={project} />
            <TagPills tags={project.tags} />
          </div>
          <h1>{project.title}</h1>
          <p className="byline" style={{ fontSize: '1rem' }}>
            by <strong>{project.ownerName}</strong>
            {project.affiliation ? ` · ${project.affiliation}` : ''} · posted {fmtDate(project.createdAt)}
            {owner?.url && (
              <>
                {' · '}
                <a href={owner.url} target="_blank" rel="noreferrer">homepage</a>
              </>
            )}
          </p>
          <p style={{ fontSize: '1.1rem', color: 'var(--ink-2)' }}>{project.summary}</p>
          {(project.homepageUrl || project.repoUrl || project.paperUrl) && (
            <div className="links" style={{ marginBottom: '1.25rem' }}>
              {project.homepageUrl && <a className="btn btn-secondary btn-sm" href={project.homepageUrl} target="_blank" rel="noreferrer">Project site</a>}
              {project.repoUrl && <a className="btn btn-secondary btn-sm" href={project.repoUrl} target="_blank" rel="noreferrer">Code</a>}
              {project.paperUrl && <a className="btn btn-secondary btn-sm" href={project.paperUrl} target="_blank" rel="noreferrer">Paper / proposal</a>}
            </div>
          )}
          <div className="description">{project.description}</div>

          <section style={{ marginTop: '2.5rem' }}>
            <div className="section-head">
              <h2>Pledges</h2>
              <p>{pledges.length === 0 ? 'None yet' : `${pledges.length} ${pledges.length === 1 ? 'pledge' : 'pledges'}`}</p>
            </div>
            {pledges.length === 0 ? (
              <div className="empty">Be the first to send credits.</div>
            ) : (
              <div className="pledge-list">
                {pledges.map((p) => {
                  const mine = principal && p.donorId === principal.userId;
                  return (
                    <div className="pledge" key={p.id}>
                      <div className="avatar" aria-hidden="true">{(p.donorName || 'A').slice(0, 1).toUpperCase()}</div>
                      <div className="body">
                        <div className="top">
                          <span>
                            <strong>{p.donorName || 'Anonymous donor'}</strong> · {fmt(p.amount)} credits
                          </span>
                          <PledgeStatusPill status={p.status} apiTransfer={p.apiTransfer} transferUncertain={p.transferUncertain} />
                        </div>
                        {p.message && <p className="message">{p.message}</p>}
                        <div className="when">{fmtDate(p.createdAt)}{p.method === 'api' ? ' · via API' : ''}</div>
                        {(isOwner || mine) && p.status !== 'confirmed' && p.status !== 'cancelled' && (
                          <div className="actions">
                            {mine && p.status === 'pledged' && (
                              <button className="btn btn-sm" disabled={busy === p.id} onClick={() => updatePledge(p, 'sent')}>I've sent the credits</button>
                            )}
                            {isOwner && (
                              <button className="btn btn-sm" disabled={busy === p.id} onClick={() => updatePledge(p, 'confirmed')}>Confirm received</button>
                            )}
                            <button className="btn btn-sm btn-danger" disabled={busy === p.id} onClick={() => confirm('Cancel this pledge?') && updatePledge(p, 'cancelled')}>Cancel</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </article>

        <aside>
          <div className="card">
            <div className="card-body">
              <Progress project={project} large />
              <p className="small muted" style={{ margin: '0.75rem 0 1rem' }}>
                {project.remaining > 0
                  ? `${fmt(project.remaining)} credits to go, roughly ${pingsFor(project.remaining)} ping results.`
                  : project.maxPledge > 0
                    ? `The goal is reached, and the project can still accept ${fmt(project.capacity)} more credits, up to 100× its request.`
                    : 'This project has reached its ceiling of 100× its request. Thank you, donors.'}
                {project.deadline ? ` Needed by ${fmtDate(project.deadline)}.` : ''}
              </p>
              {canPledge && principal && (
                <button className="btn btn-lg btn-amber" style={{ width: '100%' }} onClick={() => setShowPledge(true)}>Send credits</button>
              )}
              {canPledge && !principal && (
                <a className="btn btn-lg btn-amber" style={{ width: '100%' }} href={loginUrl('github', `/projects/${project.id}`)}>Sign in to send credits</a>
              )}
              {isOwner && (
                <div className="stack" style={{ gap: '0.5rem' }}>
                  <Link className="btn btn-secondary" to={`/projects/${project.id}/edit`}>Edit project</Link>
                  <p className="small muted" style={{ margin: 0 }}>Confirm pledges below once credits show up at <a href="https://atlas.ripe.net/credits/" target="_blank" rel="noreferrer">atlas.ripe.net/credits</a>.</p>
                </div>
              )}
              {!canPledge && !isOwner && (
                <p className="small muted" style={{ margin: 0 }}>{project.status === 'closed' ? 'This project is closed.' : 'This project is not accepting more credits.'}</p>
              )}
            </div>
          </div>
          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="card-body">
              <dl className="kv">
                <dt>Requested</dt><dd>{fmt(project.creditsRequested)}</dd>
                <dt>Received</dt><dd>{fmt(project.creditsConfirmed)}</dd>
                <dt>Pending</dt><dd>{fmt(project.creditsPending)}</dd>
                <dt>Posted by</dt><dd>{owner ? `${project.ownerName} (signed in with ${owner.provider === 'aad' ? 'Microsoft' : 'GitHub'})` : project.ownerName}</dd>
                {project.deadline && (<><dt>Deadline</dt><dd>{fmtDate(project.deadline)}</dd></>)}
                <dt>Updated</dt><dd>{fmtDate(project.updatedAt)}</dd>
              </dl>
            </div>
          </div>
        </aside>
      </div>

      {showPledge && (
        <PledgeDialog
          project={project}
          onClose={() => { setShowPledge(false); void load(); }}
          onDone={(p) => setProject(p)}
        />
      )}
    </div>
  );
}
