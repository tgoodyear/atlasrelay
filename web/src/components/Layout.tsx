import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#12304d" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="#2dd4bf" strokeWidth="4" />
      <circle cx="32" cy="32" r="5" fill="#f59e0b" />
      <path d="M32 15v-6M32 55v-6M15 32H9M55 32h-6" stroke="#2dd4bf" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export default function Layout() {
  const { principal, user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <header className="site-header">
        <div className="container">
          <Link to="/" className="brand" onClick={close}>
            <Logo />
            Atlas Relay
          </Link>
          <button className="menu-toggle" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            ☰
          </button>
          <nav className={`nav${open ? ' open' : ''}`}>
            <NavLink to="/projects" onClick={close}>Projects</NavLink>
            <NavLink to="/how-it-works" onClick={close}>How it works</NavLink>
            {!loading && principal ? (
              <>
                <NavLink to="/dashboard" onClick={close}>Dashboard</NavLink>
                <NavLink to="/profile" onClick={close}>{user?.displayName || principal.userDetails || 'Profile'}</NavLink>
                <Link to="/projects/new" className="btn btn-amber btn-sm" onClick={close}>Post a project</Link>
                <a href="/.auth/logout?post_logout_redirect_uri=/">Sign out</a>
              </>
            ) : (
              !loading && (
                <a href="/.auth/login/github?post_login_redirect_uri=/dashboard" className="btn btn-sm">
                  Sign in
                </a>
              )
            )}
          </nav>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="container">
          <span>
            Atlas Relay is a community project and is not affiliated with or endorsed by the RIPE NCC.
          </span>
          <span>
            <a href="https://atlas.ripe.net/docs/getting-started/credits/" target="_blank" rel="noreferrer">About RIPE Atlas credits</a>
            {' · '}
            <a href="https://github.com/tgoodyear/atlasrelay" target="_blank" rel="noreferrer">Source</a>
          </span>
        </div>
      </footer>
    </>
  );
}
