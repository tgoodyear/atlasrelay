import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, TAGS, type Project } from '../lib/api';
import ProjectCard from '../components/ProjectCard';
import Spinner from '../components/Spinner';

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const tag = params.get('tag') ?? '';
  const sort = params.get('sort') ?? 'newest';
  const q = params.get('q') ?? '';
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setProjects(null);
    api.projects({ status, tag, sort, q })
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message));
  }, [status, tag, sort, q]);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="container">
      <div className="page-head">
        <h1>Projects</h1>
        <p>Internet measurement research looking for RIPE Atlas credits. Pick one and send what you can spare.</p>
      </div>

      <div className="filters">
        <input type="search" placeholder="Search titles, summaries, institutions…" value={q} onChange={(e) => set('q', e.target.value)} aria-label="Search projects" />
        <select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="open">Open</option>
          <option value="funded">Funded</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
          <option value="newest">Newest</option>
          <option value="need">Largest need</option>
          <option value="progress">Closest to funded</option>
          <option value="deadline">Deadline</option>
        </select>
      </div>
      <div className="chip-row" style={{ marginBottom: '1.5rem' }}>
        <button className={`chip${!tag ? ' active' : ''}`} onClick={() => set('tag', '')}>All types</button>
        {TAGS.map((t) => (
          <button key={t} className={`chip${tag === t ? ' active' : ''}`} onClick={() => set('tag', tag === t ? '' : t)}>{t}</button>
        ))}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {projects === null ? (
        <Spinner />
      ) : projects.length === 0 ? (
        <div className="empty">
          Nothing matches. <Link to="/projects/new">Post a project</Link> or clear the filters.
        </div>
      ) : (
        <div className="grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
