import { OFFERED } from '../lib/offered';
import { loginUrl } from '../lib/signin';

export default function SignInPrompt({ reason, returnTo, heading = 'Sign in to continue' }: { reason: string; returnTo?: string; heading?: string }) {
  const back = returnTo ?? (typeof window !== 'undefined' ? window.location.pathname : '/dashboard');
  return (
    <div className="card">
      <div className="card-body" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
        {/* The page's only heading when signed out, so it is the h1, at the h2 size it had. */}
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>{heading}</h1>
        <p className="muted">{reason}</p>
        <ul className="sign-in-options" aria-label="Sign-in options">
          {OFFERED.map((p) => (
            <li key={p.id}>
              <a className={`btn btn-signin btn-${p.id}`} href={loginUrl(p.id, back)}>Sign in with {p.label}</a>
            </li>
          ))}
        </ul>
        <p className="small muted" style={{ marginTop: '1.25rem' }}>
          The account you sign in with only identifies you here. This site never asks for your RIPE Atlas password.
        </p>
      </div>
    </div>
  );
}
