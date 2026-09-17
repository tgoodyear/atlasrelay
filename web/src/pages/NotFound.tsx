import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="narrow">
      <div className="empty" style={{ marginTop: '3rem' }}>
        <h2>Page not found</h2>
        <p>
          <Link to="/">Back to the front page</Link>
        </p>
      </div>
    </div>
  );
}
