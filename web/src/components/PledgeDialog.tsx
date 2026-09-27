import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, fmt, type Project } from '../lib/api';

interface Props {
  project: Project;
  onClose: () => void;
  onDone: (project: Project) => void;
}

type Step = 'form' | 'manual-instructions' | 'api-done' | 'api-unknown' | 'settled-elsewhere';

export default function PledgeDialog({ project, onClose, onDone }: Props) {
  // Always bounded by the server-computed per-pledge limit, so the dialog never opens on a
  // value the submit button would reject.
  const [amount, setAmount] = useState(String(Math.min(project.remaining > 0 ? project.remaining : project.maxPledge, project.maxPledge, 100_000)));
  const [method, setMethod] = useState<'api' | 'manual'>('api');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [recipient, setRecipient] = useState('');
  const [warning, setWarning] = useState('');
  // Whether the server got the confirmation into storage. It reports the row that exists rather
  // than the one it meant to write, so a post-transfer write that failed comes back as 'pledged'
  // with a warning. Treating every 201 as confirmed made this screen contradict both that warning
  // and the dashboard, over the one case where the donor most needs to be told what to do next.
  const [recorded, setRecorded] = useState(true);
  // Whether a pledge row exists at all after an unknown outcome. When the server could not write
  // one either, there is nothing for the researcher to settle and saying otherwise sends the donor
  // to somebody with no record to act on.
  const [rowExists, setRowExists] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Not while a transfer is running: closing reloads the project, and the donor would be shown
    // their pledge sitting at "Pledged" while the credits were actually moving.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !submitting && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

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
    // Pin the method for the rest of this request. The radios are disabled while it runs, but the
    // state is still what every branch below reads, and reading it after the await would let a
    // stray change decide which recovery path an in-flight API transfer takes: an unknown outcome
    // arriving as `manual` skips the terminal screen and leaves the form live with a transfer
    // possibly already sent.
    const sending = method;
    setSubmitting(true);
    setError('');
    try {
      const res = await api.createPledge(project.id, { amount: n, method: sending, message, anonymous, ...(sending === 'api' ? { apiKey: apiKey.trim() } : {}) });
      setApiKey('');
      setWarning(res.warning ?? '');
      if (sending === 'manual') {
        setRecipient(res.recipientEmail ?? '');
        setStep('manual-instructions');
      } else {
        setRecorded(res.pledge.status === 'confirmed');
        setStep('api-done');
      }
      onDone(res.project);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Something went wrong';
      // What matters is whether the server answered. An ApiError means it did, and its status
      // says whether RIPE refused (nothing moved, retrying is right) or never replied (502,
      // unknown). Anything that is not an ApiError is the browser losing the connection, and by
      // then the server may already have sent the transfer, so it is unknown in exactly the same
      // way. Both must end the dialog rather than leave a populated form and a live button.
      // Classify by what the status can only mean, not by listing the failures we thought of.
      // Singling out 502 as the unknown case was backwards: a completed transfer can end in a 500
      // from a failed cleanup write, or a 504 from the edge giving up while RIPE was still
      // working, and each of those left the form live with the key in it. Only statuses the server
      // cannot reach after sending a transfer keep the form open; everything else, including
      // anything that is not an ApiError at all, ends the dialog.
      // Branch on what the server said, not on the status code. A status cannot answer this: the
      // handler raises 503 on paths where it stopped before sending anything, while a 503 from the
      // platform edge can arrive over a transfer that was already in flight. The handler marks the
      // cases it is certain about, and everything else, including a lost connection, is unknown.
      const serverAnswered = err instanceof ApiError;
      const refusedBeforeSending = serverAnswered && (err as ApiError).transferDefinitelyNotSent;
      // Somebody else acted on this pledge while the request was running, so where it stands is not
      // something this dialog can state. It must not leave the form live either: on a manual pledge
      // the other actor may have marked it sent or confirmed, and a confirmed pledge no longer
      // counts as live, so resubmitting would be allowed and would ask the donor to transfer by
      // hand a second time. Terminal for both methods.
      if (serverAnswered && (err as ApiError).transferOutcomeUnknown) {
        setApiKey('');
        setError(message);
        setStep('settled-elsewhere');
      } else if (sending === 'api' && !refusedBeforeSending) {
        setApiKey('');
        setError(serverAnswered ? message : 'The connection was lost before we got a usable answer.');
        // A lost connection tells us nothing about whether a row was written, so assume one was:
        // the alternative sends every dropped connection to the "tell them out of band" advice.
        setRowExists(!serverAnswered || !(err as ApiError).transferNotRecorded);
        setStep('api-unknown');
      } else {
        // A refusal means nothing moved and the donor can correct and retry, but the key is
        // dropped even so: a populated field beside a live button is how a second transfer starts.
        if (sending === 'api') setApiKey('');
        setError(message);
      }
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
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pledge-title">
        <div className="modal-head">
          <h2 id="pledge-title">
            {step === 'form'
              ? 'Send credits'
              : step === 'api-done'
                ? (recorded ? 'Credits transferred' : 'Credits transferred, recording incomplete')
                : step === 'api-unknown'
                  ? 'Check before you send again'
                  : step === 'settled-elsewhere'
                    ? 'This pledge changed while you were sending'
                  : 'Finish the transfer on atlas.ripe.net'}
          </h2>
          <button className="close" aria-label="Close" onClick={onClose} disabled={submitting}>×</button>
        </div>
        <div className="modal-body">
          {step === 'form' && (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="amount">Amount</label>
                <input id="amount" type="number" min={1} max={project.maxPledge} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} disabled={submitting} required />
                <span className="hint">
                  {project.remaining > 0
                    ? `This project still needs ${fmt(project.remaining)} credits to reach its goal. `
                    : 'This project has reached its goal. '}
                  {`The largest single pledge it accepts right now is ${fmt(project.maxPledge)} credits, and it can take ${fmt(project.capacity)} in total.`}
                </span>
              </div>

              <div className="method-choice" role="radiogroup" aria-label="Transfer method">
                <label>
                  <input type="radio" name="method" checked={method === 'api'} disabled={submitting} onChange={() => setMethod('api')} />
                  <div>
                    <strong>Transfer now with an API key</strong>
                    <span>We check your balance and send the transfer with a key you paste. RIPE accepting the transfer is the record; the transaction appears in your own RIPE log a minute or so later. The key is never stored.</span>
                  </div>
                </label>
                <label>
                  <input type="radio" name="method" checked={method === 'manual'} disabled={submitting} onChange={() => setMethod('manual')} />
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

              <div className="field">
                <label className="check">
                  {/* The caveats below are the substance of this choice, not decoration: who still
                      sees the name, and what stays public regardless. Tied to the control so a
                      screen reader reads them on focus rather than only when the paragraph is
                      reached, by which point the box may already have been ticked. */}
                  <input
                    type="checkbox"
                    checked={anonymous}
                    onChange={(e) => setAnonymous(e.target.checked)}
                    aria-describedby="anon-note"
                  />
                  <span>Do not show my name on this project</span>
                </label>
                <p className="small muted" id="anon-note">
                  The pledge is listed as Anonymous, with the amount and any message still shown.
                  The researcher receiving the credits still sees your name: they confirm manual
                  transfers themselves, and may need to match any pledge against their own RIPE
                  records, which name the sending account. The amount, the message and the date stay
                  public and can be compared with other pledges, so leave anything identifying out
                  of the message. This site keeps a record of who pledged either way, so it hides
                  your name from other visitors rather than making the pledge anonymous.
                </p>
              </div>

              <p className="small muted" style={{ marginTop: '1rem' }}>
                Nobody checks that a request is genuine. Posting needs a sign-in and a RIPE NCC
                Access email, both self-declared, and this site cannot verify that a person is who
                they say they are or that the credits will be used as described. Read the project's links, start with a small amount, and
                send only what you are willing to lose. Credits cannot be recalled once transferred.
                {' '}
                <a
                  href={`https://github.com/tgoodyear/atlasrelay/issues/new?labels=abuse&title=${encodeURIComponent(`Report a project: ${project.title}`)}&body=${encodeURIComponent(`Project: ${window.location.origin}/projects/${project.id}\n\nWhat is wrong with it:\n`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Report this project
                </a>{' '}
                if it looks fraudulent.
              </p>

              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-actions">
                <button className="btn" type="submit" disabled={submitting || !amountOk || (method === 'api' && apiKey.trim().length < 36)}>
                  {submitting ? (method === 'api' ? 'Transferring…' : 'Saving…') : method === 'api' ? `Transfer ${amountOk ? fmt(n) : ''} credits` : 'Create pledge'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
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

          {step === 'api-unknown' && (
            <>
              <div className="alert alert-warn">{error}</div>
              <p>
                We cannot tell you whether the {fmt(n)} credits left your account. RIPE Atlas either
                never answered, or answered in a way that does not say whether it completed the
                transfer. It may have gone through. Check your transaction log before doing anything
                else.
              </p>
              <ol className="steps">
                <li>
                  Open <a href="https://atlas.ripe.net/credits/transactions/" target="_blank" rel="noreferrer">atlas.ripe.net/credits/transactions</a>.
                </li>
                <li>Look for an outgoing transfer of <strong className="mono">{fmt(n)}</strong> credits in the last few minutes.</li>
                <li>
                  {rowExists ? (
                    <>
                      If it is there, the transfer worked. The pledge is already recorded, and the
                      researcher confirms it once the credits show up on their side.
                    </>
                  ) : (
                    <>
                      If it is there, the transfer worked -- but it was never recorded here, so no
                      pledge exists on this site for the researcher to confirm.
                    </>
                  )}
                </li>
                <li>
                  If it is not there, wait a couple of minutes and look again. RIPE does not publish a
                  transfer to your log at the moment it accepts it; we have measured the entry appearing
                  40 to 70 seconds later. An empty log straight away is not evidence that the credits
                  stayed put.
                </li>
                <li>
                  {rowExists ? (
                    <>
                      If it is still not there after that, tell the researcher what you found and let them
                      settle the pledge. Only they can close a transfer we sent: cancelling frees your slot,
                      and if the credits did move after all, your next pledge would send them a second time.
                    </>
                  ) : (
                    <>
                      Whatever you find, tell the researcher directly, quoting the transaction if there is
                      one. This pledge was never recorded here, so there is nothing on either dashboard for
                      them to confirm or cancel, and nobody but you knows the transfer was attempted.
                    </>
                  )}
                </li>
              </ol>
              <p className="small muted">
                Do not send the credits a second time on the strength of an empty log you have only just
                looked at. Remember to delete the API key
                you used at <a href="https://atlas.ripe.net/keys/" target="_blank" rel="noreferrer">atlas.ripe.net/keys</a>.
              </p>
              <div className="form-actions">
                <button className="btn" type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {step === 'settled-elsewhere' && (
            <>
              <div className="alert alert-warn">{error}</div>
              <p>
                Somebody acted on this pledge while you were sending it, so we cannot say where it
                stands. Open it on your dashboard and look before you send anything. A pledge marked
                confirmed means the researcher has the credits. One marked sent means a transfer was
                reported but nobody has confirmed it arrived, which still has to be settled with them
                rather than sent again.
              </p>
              <div className="form-actions">
                <button className="btn" type="button" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {step === 'api-done' && (
            <>
              <div className={recorded ? 'alert alert-success' : 'alert alert-warn'}>
                RIPE Atlas accepted the transfer of {fmt(n)} credits.
                {recorded
                  ? ' The pledge is confirmed.'
                  : ' Recording it here did not complete, so the pledge is still showing as pending. Do not send the credits again: the researcher can confirm it once they arrive.'}
                {' '}RIPE accepting the transfer is the record; it publishes the transaction to
                your account’s log a minute or so later, where you can see it yourself.
              </div>
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
