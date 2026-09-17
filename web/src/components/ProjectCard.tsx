import { Link } from 'react-router-dom';
import { fmtDate, type Project } from '../lib/api';
import Progress from './Progress';
import { StatusPill, TagPills } from './Pills';

export default function ProjectCard({ project }: { project: Project }) {
  return (
    <Link to={`/projects/${project.id}`} className="card project-card">
      <div className="card-body">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start' }}>
          <h3>{project.title}</h3>
          <StatusPill project={project} />
        </div>
        <div className="byline">
          {project.ownerName}
          {project.affiliation ? ` · ${project.affiliation}` : ''}
        </div>
        <p className="summary">{project.summary}</p>
        <TagPills tags={project.tags} />
        <Progress project={project} />
        <div className="meta">
          <span>Posted {fmtDate(project.createdAt)}</span>
          {project.deadline && <span>Needed by {fmtDate(project.deadline)}</span>}
        </div>
      </div>
    </Link>
  );
}
