import { fmt, type Project } from '../lib/api';

export default function Progress({ project, large = false }: { project: Pick<Project, 'creditsRequested' | 'creditsConfirmed' | 'creditsPending'>; large?: boolean }) {
  const total = Math.max(1, project.creditsRequested);
  const confirmedPct = Math.min(100, (project.creditsConfirmed / total) * 100);
  const pendingPct = Math.min(100 - confirmedPct, (project.creditsPending / total) * 100);
  const pct = Math.round(confirmedPct);
  return (
    <div className={`progress${large ? ' progress-lg' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Credits received">
      <div className="bar">
        <div className="confirmed" style={{ width: `${confirmedPct}%` }} />
        {pendingPct > 0 && <div className="pending" style={{ width: `${pendingPct}%` }} title="Pledged, awaiting confirmation" />}
      </div>
      <div className="figures">
        <span>
          <strong>{fmt(project.creditsConfirmed)}</strong> of {fmt(project.creditsRequested)} credits
        </span>
        <span>{pct}%{project.creditsPending > 0 ? ` · ${fmt(project.creditsPending)} pending` : ''}</span>
      </div>
    </div>
  );
}
