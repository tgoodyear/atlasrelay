import { Navigate, useSearchParams } from 'react-router-dom';
import SignInPrompt from '../components/SignInPrompt';
import Spinner from '../components/Spinner';
import { useAuth } from '../lib/auth';
import { META } from '../lib/pages';
import { safeReturnPath } from '../lib/signin';
import { usePageMeta } from '../lib/usePageMeta';

/** /signin?next=/projects/abc: the sign-in choices, coming back to next (a path on this site). */
export default function SignIn() {
  const { loading, principal } = useAuth();
  usePageMeta(META.signIn);
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  if (loading) return <div className="container"><Spinner /></div>;
  if (principal) return <Navigate to={next} replace />;
  return (
    <div className="narrow" style={{ marginTop: '3rem' }}>
      <SignInPrompt heading="Sign in" reason="Choose the account to sign in with." returnTo={next} />
    </div>
  );
}
