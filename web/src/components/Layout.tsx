import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#12304d" />
      <g stroke="#2dd4bf" strokeWidth="3.5" strokeLinecap="round" fill="none" opacity="0.5">
        <path d="M13 25L29 11M29 11L51 20M51 20L48 48M18 50L48 48" />
      </g>
      <g stroke="#2dd4bf" strokeWidth="3.5" strokeLinecap="round">
        <path d="M32 33L13 25M32 33L29 11M32 33L51 20M32 33L48 48M32 33L18 50" />
      </g>
      <g fill="#2dd4bf">
        <circle cx="13" cy="25" r="4.5" />
        <circle cx="29" cy="11" r="4.5" />
        <circle cx="51" cy="20" r="4.5" />
        <circle cx="48" cy="48" r="4.5" />
        <circle cx="18" cy="50" r="4.5" />
      </g>
      <circle cx="32" cy="33" r="7" fill="#f59e0b" />
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
            {' · '}
            <Link to="/privacy">Privacy</Link>
          </span>
        </div>
      </footer>
    </>
  );
}
