import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtCompact, type Project, type Stats } from '../lib/api';
import ProjectCard from '../components/ProjectCard';
import Spinner from '../components/Spinner';

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    api.stats().then((r) => setStats(r.stats)).catch(() => setStats(null));
    api.projects({ status: 'open', sort: 'newest' }).then((r) => setProjects(r.projects.slice(0, 6))).catch(() => setProjects([]));
  }, []);

  return (
    <>
      <section className="hero">
        <div className="container">
          <div>
            <span className="eyebrow">For RIPE Atlas researchers</span>
            <h1>Spare Atlas credits, meet the research that needs them.</h1>
            <p className="lead">
              Post the measurement project you are building and how many credits it needs. Atlas users with credits to spare send them straight to your RIPE account.
            </p>
            <div className="actions">
              <Link to="/projects" className="btn btn-lg btn-amber">Browse projects</Link>
              <Link to="/projects/new" className="btn btn-lg btn-secondary">Post a project</Link>
            </div>
          </div>
          <div className="hero-art" aria-label="Platform statistics">
            <div className="stat-tile">
              <div className="value">{stats ? fmtCompact(stats.creditsRequested) : '—'}</div>
              <div className="label">credits currently requested</div>
            </div>
            <div className="stat-tile">
              <div className="value">{stats ? fmtCompact(stats.creditsTransferred) : '—'}</div>
              <div className="label">credits transferred so far</div>
            </div>
            <div className="stat-tile">
              <div className="value">{stats ? stats.openProjects : '—'}</div>
              <div className="label">open projects · {stats ? stats.fundedProjects : '—'} funded</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section container">
        <div className="section-head">
          <h2>Open projects</h2>
          <Link to="/projects">See all →</Link>
        </div>
        {projects === null ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <div className="empty">
            No open projects yet. <Link to="/projects/new">Be the first to post one.</Link>
          </div>
        ) : (
          <div className="grid">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>

      <section className="section container">
        <p className="muted small" style={{ margin: 0 }}>
          RIPE Atlas: about 12,900 probes and 810 anchors in 178 countries, 1.3 billion measurement results a day, and more than a thousand research publications built on them.{' '}
          <a href="https://arxiv.org/abs/2511.22474" target="_blank" rel="noreferrer">Nosyk et al., 2025</a>
        </p>
      </section>

      <section className="section container">
        <div className="section-head">
          <h2>How it works</h2>
          <Link to="/how-it-works">Details →</Link>
        </div>
        <div className="how">
          <div className="card"><div className="card-body">
            <h3><span className="num">1</span> Post a project</h3>
            <p className="muted">Describe the measurements you are planning, the credits you need, and your RIPE NCC Access email (kept private).</p>
          </div></div>
          <div className="card"><div className="card-body">
            <h3><span className="num">2</span> Donors send credits</h3>
            <p className="muted">Either through the RIPE Atlas API with a single-use, transfer-only key, or by hand on atlas.ripe.net.</p>
          </div></div>
          <div className="card"><div className="card-body">
            <h3><span className="num">3</span> Confirm and measure</h3>
            <p className="muted">Credits land directly in your Atlas account. Confirm receipt, run your measurements, share your results.</p>
          </div></div>
        </div>
      </section>
    </>
  );
}
