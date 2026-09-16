import { loginUrl } from '../lib/auth';

export default function SignInPrompt({ reason, returnTo }: { reason: string; returnTo?: string }) {
  return (
    <div className="card">
      <div className="card-body" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
        <h2>Sign in to continue</h2>
        <p className="muted">{reason}</p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '1rem' }}>
          <a className="btn btn-github" href={loginUrl('github', returnTo)}>Continue with GitHub</a>
          <a className="btn btn-ms" href={loginUrl('aad', returnTo)}>Continue with Microsoft</a>
        </div>
        <p className="small muted" style={{ marginTop: '1.25rem' }}>
          We only use your account to identify you on this site. Your RIPE Atlas credentials never pass through us.
        </p>
      </div>
    </div>
  );
}
