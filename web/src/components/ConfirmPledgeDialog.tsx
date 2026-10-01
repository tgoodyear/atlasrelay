import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, fmt, type Pledge, type Project, type Receipt, type VerificationDetails, type VerificationResult } from '../lib/api';
import { useDialogFocus } from '../lib/useDialogFocus';

interface Props {
  project: Project;
  pledge: Pledge;
  onClose: () => void;
}

type Step = 'form' | 'decide' | 'done';

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The project owner confirming a manual pledge. The donor made that transfer on atlas.ripe.net,
 * so this site never saw it, and the owner may paste a key of their own to have the server read
 * what actually arrived. The key is held in this component only while the dialog is open, so a
 * follow-up choice can be checked again, and is dropped on success and on close. The server reads
 * the log afresh on every request; nothing the page sends about amounts is trusted.
 */
export default function ConfirmPledgeDialog({ project, pledge, onClose }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [details, setDetails] = useState<VerificationDetails | null>(null);
  const [message, setMessage] = useState('');
  const [picked, setPicked] = useState('');
  const [result, setResult] = useState<VerificationResult | null>(null);
  const pledged = pledge.pledgedAmount ?? pledge.amount;
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  // Each step replaces the controls, including whichever one had focus, so focus would fall to the
  // page behind the overlay. Put it on the first control of the new step.
  useEffect(() => {
    if (step === 'form') return;
    const first = dialogRef.current?.querySelector<HTMLElement>('.modal-body button:not([disabled]), .modal-body input:not([disabled])');
    (first ?? dialogRef.current)?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const close = () => {
    setApiKey('');
    onClose();
  };

  const send = async (check: { apiKey?: string; transactionId?: string }) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.confirmPledge(project.id, pledge.id, check);
      setApiKey('');
      if (!check.apiKey) {
        close();
        return;
      }
      setResult(res.verification ?? null);
      setStep('done');
    } catch (err) {
      const v = err instanceof ApiError ? err.verification : undefined;
      const text = err instanceof ApiError ? err.message : 'The connection was lost. Reload the page to see whether the pledge was confirmed.';
      if (v && v.outcome !== 'key-refused' && v.outcome !== 'refused') {
        setDetails(v);
        setMessage(text);
        // Pre-selected only where the server offered exactly one arrival as this pledge's. Anywhere
        // else, including a fresh list after a choice went stale, the owner picks for themselves.
        const list = v.receipts ?? [];
        setPicked(v.outcome === 'different' && list.length === 1 && !list[0].contested ? list[0].id : '');
        setStep('decide');
      } else {
        if (v?.outcome === 'key-refused') setApiKey('');
        setError(text);
        if (step !== 'form' && !(v?.outcome === 'refused')) setStep('form');
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    void send(key ? { apiKey: key } : {});
  };

  const receipts: Receipt[] = details?.receipts ?? [];
  const choosable = details && details.outcome !== 'over-ceiling' && receipts.length > 0;
  const selected = receipts.find((r) => r.id === picked);
  // The pledged amount without the check stays on offer unless even that would pass the ceiling.
  const pledgedFits = !(details?.outcome === 'over-ceiling' && details.room !== undefined && pledged > details.room);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" ref={dialogRef} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="confirm-title">{step === 'done' ? 'Pledge confirmed' : 'Confirm this pledge'}</h2>
          <button className="close" aria-label="Close" onClick={close} disabled={busy}>×</button>
        </div>
        <div className="modal-body">
          {step === 'form' && (
            <form onSubmit={submit}>
              <p>
                <strong>{pledge.donorName || 'A donor'}</strong> pledged <strong className="mono">{fmt(pledged)}</strong> credits
                {pledge.status === 'sent' ? ' and says they have sent them' : ''}. Check that they reached your account at{' '}
                <a href="https://atlas.ripe.net/credits/transactions/" target="_blank" rel="noreferrer">atlas.ripe.net/credits/transactions</a> before confirming.
              </p>
              <div className="field">
                <label htmlFor="ownerKey">RIPE Atlas API key (optional)</label>
                <input
                  id="ownerKey"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  disabled={busy}
                />
                <span className="hint">
                  To record the amount that actually arrived, paste a key of your own from{' '}
                  <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a> with only the
                  {' '}<strong>Get information about your credits</strong> permission. We read your recent transfers to find
                  this one and never store the key.
                </span>
              </div>
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-actions">
                <button className="btn" type="submit" disabled={busy || (apiKey.trim() !== '' && apiKey.trim().length < 36)}>
                  {busy ? 'Confirming…' : apiKey.trim() ? 'Check and confirm' : `Confirm ${fmt(pledged)} credits`}
                </button>
                <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>Cancel</button>
              </div>
            </form>
          )}

          {step === 'decide' && details && (
            <>
              <div className="alert alert-warn">{message}</div>
              {choosable && (
                <div className="method-choice" role="radiogroup" aria-label="Transfers in your RIPE Atlas log">
                  {receipts.map((r) => (
                    <label key={r.id}>
                      <input type="radio" name="receipt" checked={picked === r.id} disabled={busy} onChange={() => setPicked(r.id)} />
                      <div>
                        <strong>{fmt(r.amount)} credits</strong>
                        <span>
                          {when(r.at)} · transaction {r.id}{r.note ? ` · ${r.note}` : ''}
                          {r.contested ? ' · another pledge of the same amount could account for this one' : ''}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {choosable && details.more && (
                <p className="small muted">Your log has more transfers than are listed here. If this one is missing, confirm the pledged amount instead.</p>
              )}
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-actions">
                {choosable && (
                  <button className="btn" type="button" disabled={busy || !selected} onClick={() => selected && send({ apiKey: apiKey.trim(), transactionId: selected.id })}>
                    {selected ? `Record ${fmt(selected.amount)} credits` : 'Choose a transfer'}
                  </button>
                )}
                {details.outcome !== 'over-ceiling' && (
                  <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => send({ apiKey: apiKey.trim() })}>{busy ? 'Checking…' : 'Check again'}</button>
                )}
                {pledgedFits && (
                  <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => send({})}>
                    Confirm the pledged {fmt(pledged)} credits without checking
                  </button>
                )}
                <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>Close</button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              {result && (
                <div className="alert alert-success">
                  RIPE Atlas shows {fmt(result.received)} credits arrived
                  {result.received !== pledged ? ` (pledged ${fmt(pledged)})` : ''}, and the pledge now records that amount.
                  {` RIPE transaction ${result.transactionId}.`}
                </div>
              )}
              <p>If you made the key only for this, you can delete it at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a>.</p>
              <div className="form-actions">
                <button className="btn" type="button" onClick={close}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
