import { Link } from 'react-router-dom';
import { META } from '../lib/pages';
import { usePageMeta } from '../lib/usePageMeta';

export default function NotFound() {
  usePageMeta(META.notFound);
  return (
    <div className="narrow">
      <div className="empty" style={{ marginTop: '3rem' }}>
        <h1>Page not found</h1>
        <p>
          <Link to="/">Back to the front page</Link>
        </p>
      </div>
    </div>
  );
}
