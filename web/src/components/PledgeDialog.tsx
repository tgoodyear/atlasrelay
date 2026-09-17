import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmt, type Project } from '../lib/api';

interface Props {
  project: Project;
  onClose: () => void;
  onDone: (project: Project) => void;
}

type Step = 'form' | 'manual-instructions' | 'api-done';

export default function PledgeDialog({ project, onClose, onDone }: Props) {
  const [amount, setAmount] = useState(String(Math.min(project.remaining > 0 ? project.remaining : project.maxPledge, 100_000)));
  const [method, setMethod] = useState<'api' | 'manual'>('api');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState('');
  const [warning, setWarning] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const n = Number(amount);
  const amountOk = Number.isInteger(n) && n >= 1 && n <= project.maxPledge;

  const checkBalance = async () => {
    setChecking(true);
    setError('');
    try {
      const r = await api.balance(apiKey.trim());
      setBalance(r.balance);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check balance');
    } finally {
      setChecking(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!amountOk) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.createPledge(project.id, { amount: n, method, message, ...(method === 'api' ? { apiKey: apiKey.trim() } : {}) });
      setApiKey('');
      setWarning(res.warning ?? '');
      if (method === 'manual') {
        setRecipient(res.recipientEmail ?? '');
        setStep('manual-instructions');
      } else {
        setStep('api-done');
      }
      onDone(res.project);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pledge-title">
        <div className="modal-head">
          <h2 id="pledge-title">
            {step === 'form' ? 'Send credits' : step === 'api-done' ? 'Credits transferred' : 'Finish the transfer on atlas.ripe.net'}
          </h2>
          <button className="close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {step === 'form' && (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="amount">Amount</label>
                <input id="amount" type="number" min={1} max={project.maxPledge} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} required />
                <span className="hint">
                  {project.remaining > 0
                    ? `This project still needs ${fmt(project.remaining)} credits to reach its goal. `
                    : 'This project has reached its goal. '}
                  {`The largest single pledge it accepts right now is ${fmt(project.maxPledge)} credits, and it can take ${fmt(project.capacity)} in total.`}
                </span>
              </div>

              <div className="method-choice" role="radiogroup" aria-label="Transfer method">
                <label>
                  <input type="radio" name="method" checked={method === 'api'} onChange={() => setMethod('api')} />
                  <div>
                    <strong>Transfer now with an API key</strong>
                    <span>We call the RIPE Atlas API once with a key you paste and record the transaction as proof. The key is never stored.</span>
                  </div>
                </label>
                <label>
                  <input type="radio" name="method" checked={method === 'manual'} onChange={() => setMethod('manual')} />
                  <div>
                    <strong>I'll transfer on atlas.ripe.net myself</strong>
                    <span>We show you the researcher's RIPE NCC Access email so you can send the credits. They will see your name against this pledge.</span>
                  </div>
                </label>
              </div>

              {method === 'api' && (
                <div className="field">
                  <label htmlFor="apiKey">RIPE Atlas API key</label>
                  <input id="apiKey" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setBalance(null); }} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required />
                  <span className="hint">
                    Create one at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a> with these two permissions, and nothing else:
                    {' '}<strong>Transfer credits to another user</strong> and <strong>Get information about your credits</strong>.
                    The second is what lets us check your balance before sending. Set a short validity window, and delete the key afterwards.
                  </span>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={checkBalance} disabled={checking || apiKey.trim().length < 36}>
                      {checking ? 'Checking…' : 'Check balance'}
                    </button>
                    {balance !== null && (
                      <span className="small">
                        Balance: <strong>{fmt(balance)}</strong> credits{balance < n ? <span style={{ color: 'var(--red)' }}> (less than the amount)</span> : null}
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="field">
                <label htmlFor="message">Message (optional, public)</label>
                <input id="message" type="text" maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Good luck with the study!" />
              </div>

              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-actions">
                <button className="btn" type="submit" disabled={submitting || !amountOk || (method === 'api' && apiKey.trim().length < 36)}>
                  {submitting ? (method === 'api' ? 'Transferring…' : 'Saving…') : method === 'api' ? `Transfer ${amountOk ? fmt(n) : ''} credits` : 'Create pledge'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button>
              </div>
            </form>
          )}

          {step === 'manual-instructions' && (
            <>
              <div className="alert alert-success">Pledge recorded. Now make the transfer on RIPE Atlas.</div>
              <ol className="steps">
                <li>
                  Open <a href="https://atlas.ripe.net/credits/transfer/" target="_blank" rel="noreferrer">atlas.ripe.net/credits/transfer</a> (sign in with your RIPE NCC Access account).
                </li>
                <li>
                  Recipient email:
                  <div className="copy-box" style={{ marginTop: '0.4rem' }}>
                    <span>{recipient}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(recipient)}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </li>
                <li>
                  Amount: <strong className="mono">{fmt(n)}</strong> credits.
                </li>
                <li>Back on your dashboard, mark the pledge as <strong>sent</strong>. The researcher will confirm once the credits appear.</li>
              </ol>
              <p className="small muted" style={{ marginTop: '1rem' }}>
                Use this address only to send these credits. The researcher can see that you asked for it, and you can hold one pledge per project at a time.
              </p>
              <div className="form-actions">
                <button className="btn" type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {step === 'api-done' && (
            <>
              <div className="alert alert-success">RIPE Atlas accepted the transfer of {fmt(n)} credits. The pledge is confirmed with the transaction reference.</div>
              {warning && <div className="alert alert-warn">{warning}</div>}
              <p>Remember to delete or disable the API key you used at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a>.</p>
              <div className="form-actions">
                <button className="btn" type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
