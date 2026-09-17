import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PledgeStatusPill, StatusPill } from '../components/Pills';
import Progress from '../components/Progress';
import SignInPrompt from '../components/SignInPrompt';
import Spinner from '../components/Spinner';
import { api, ApiError, fmt, fmtDate, type Pledge, type Project } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function Dashboard() {
  const { loading, principal, user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pledges, setPledges] = useState<Pledge[]>([]);
  const [tab, setTab] = useState<'projects' | 'pledges'>('projects');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    api.my().then((r) => { setProjects(r.projects); setPledges(r.pledges); }).catch((e) => setError(e.message));

  useEffect(() => {
    if (principal) void load();
  }, [principal]);

  if (loading) return <div className="container"><Spinner /></div>;
  if (!principal) return <div className="narrow" style={{ marginTop: '3rem' }}><SignInPrompt reason="Your dashboard lists the projects you posted and the pledges you made." returnTo="/dashboard" /></div>;

  const updatePledge = async (p: Pledge, status: Pledge['status']) => {
    setBusy(p.id);
    try {
      await api.updatePledge(p.projectId, p.id, status);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Could not update');
    } finally {
      setBusy('');
    }
  };

  const awaiting = projects?.reduce((n, p) => n + (p.creditsPending > 0 ? 1 : 0), 0) ?? 0;

  return (
    <div className="container">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
        <div>
          <h1>Dashboard</h1>
          <p>Hi {user?.displayName || principal.userDetails}. {user && !user.hasAtlasEmail ? <Link to="/profile">Add your RIPE email</Link> : null}</p>
        </div>
        <Link className="btn btn-amber" to="/projects/new">Post a project</Link>
      </div>

      {user && !user.hasAtlasEmail && <div className="alert alert-warn">You have not added a RIPE NCC Access email yet, so you cannot post projects. <Link to="/profile">Fix that in your profile.</Link></div>}
      {awaiting > 0 && <div className="alert alert-info">{awaiting} of your projects {awaiting === 1 ? 'has' : 'have'} pending pledges. Check <a href="https://atlas.ripe.net/credits/" target="_blank" rel="noreferrer">your Atlas credits</a> and confirm them on the project page.</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>My projects ({projects?.length ?? 0})</button>
        <button role="tab" aria-selected={tab === 'pledges'} className={tab === 'pledges' ? 'active' : ''} onClick={() => setTab('pledges')}>My pledges ({pledges.length})</button>
      </div>

      {projects === null ? (
        <Spinner />
      ) : tab === 'projects' ? (
        projects.length === 0 ? (
          <div className="empty">You have not posted a project. <Link to="/projects/new">Post one.</Link></div>
        ) : (
          <div className="stack">
            {projects.map((p) => (
              <div className="card" key={p.id}>
                <div className="card-body" style={{ display: 'grid', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}><Link to={`/projects/${p.id}`}>{p.title}</Link></h3>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <StatusPill project={p} />
                      <Link className="btn btn-secondary btn-sm" to={`/projects/${p.id}/edit`}>Edit</Link>
                    </div>
                  </div>
                  <Progress project={p} />
                  {p.creditsPending > 0 && <span className="small muted">{fmt(p.creditsPending)} credits pledged and awaiting your confirmation. <Link to={`/projects/${p.id}`}>Review pledges</Link></span>}
                </div>
              </div>
            ))}
          </div>
        )
      ) : pledges.length === 0 ? (
        <div className="empty">You have not pledged to any project. <Link to="/projects">Find one.</Link></div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Project</th><th>Amount</th><th>Method</th><th>Status</th><th>Date</th><th></th></tr>
              </thead>
              <tbody>
                {pledges.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/projects/${p.projectId}`}>{p.projectTitle || p.projectId}</Link></td>
                    <td className="mono">{fmt(p.amount)}</td>
                    <td>{p.method === 'api' ? 'API' : 'Manual'}{p.transactionId ? ` · RIPE txn ${p.transactionId}` : ''}</td>
                    <td><PledgeStatusPill status={p.status} apiTransfer={p.apiTransfer} transferUncertain={p.transferUncertain} /></td>
                    <td>{fmtDate(p.createdAt)}</td>
                    <td>
                      {p.status === 'pledged' && <button className="btn btn-sm" disabled={busy === p.id} onClick={() => updatePledge(p, 'sent')}>Mark sent</button>}
                      {(p.status === 'pledged' || p.status === 'sent') && (
                        <button className="btn btn-sm btn-ghost" disabled={busy === p.id} onClick={() => confirm('Cancel this pledge?') && updatePledge(p, 'cancelled')}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
