import type { Pledge, Project, Tag } from '../lib/api';

export function TagPills({ tags }: { tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <div className="pills">
      {tags.map((t) => (
        <span key={t} className="pill">{t}</span>
      ))}
    </div>
  );
}

export function StatusPill({ project }: { project: Pick<Project, 'status' | 'funded'> }) {
  if (project.status === 'closed') return <span className="pill pill-muted">Closed</span>;
  if (project.funded) return <span className="pill pill-green">Funded</span>;
  return <span className="pill pill-teal">Open</span>;
}

export function PledgeStatusPill({ status, hasProof }: { status: Pledge['status']; hasProof?: boolean }) {
  switch (status) {
    case 'confirmed':
      return <span className="pill pill-green">{hasProof ? 'Transferred' : 'Confirmed'}</span>;
    case 'sent':
      return <span className="pill pill-amber">Sent, awaiting confirmation</span>;
    case 'cancelled':
      return <span className="pill pill-muted">Cancelled</span>;
    default:
      return <span className="pill pill-amber">Pledged</span>;
  }
}
