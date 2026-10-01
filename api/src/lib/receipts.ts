import { AtlasRefused, AtlasUnreachable, readAdminTransactions, transactionTime, type TransactionPage } from './atlas';
import { HttpError } from './http';
import { OVERFUND_MULTIPLIER } from './pledging';

/**
 * Checking a manual pledge against what actually reached the project owner's RIPE Atlas account.
 *
 * A manual pledge records what the donor said they would send. The donor makes the transfer on
 * atlas.ripe.net, out of this site's sight, and may send a different amount. When the owner
 * confirms, they may paste a key of their own with "Get information about your credits", and the
 * API reads their recent `admin` transactions (where RIPE records transfers) to find the arrival.
 *
 * What a row carries, per RIPE's API reference and the rows seen live: `id`, `type`, `amount`
 * (signed: an incoming transfer is positive), `date` (epoch seconds), `reason`, `description`,
 * `balance_before`, `balance_after`. Nothing documented names the other account, so a row cannot
 * be tied to a particular donor. Matching therefore rests on direction, time and amount, and
 * whenever those do not single out one row the owner decides rather than this code guessing.
 */

/** An incoming transfer that could be this pledge's. */
export interface Receipt {
  /** RIPE's transaction id. The only per-transfer reference RIPE gives. */
  id: string;
  amount: number;
  /** When RIPE recorded it. */
  at: string;
  /**
   * RIPE's own reason and description text, so the owner can tell rows apart. Shown to the owner
   * in the response, since it is their own log, and never stored or logged: its format is not
   * documented and it may name the sending account.
   */
  note: string;
  /**
   * Another of this owner's pledges of the same amount could account for this row: one still
   * waiting to be settled, or one confirmed without a reference (every API transfer, and every
   * manual pledge confirmed without a check) whose time fits. Such a row is never matched
   * automatically, so one donor's transfer cannot be counted a second time against another pledge.
   */
  contested: boolean;
}

/**
 * One of the owner's other pledges that could own an arrival of `amount` recorded between `from`
 * and `until` (milliseconds; `until` null means no upper bound). See ledgerRivals in store.ts.
 */
export interface Rival {
  amount: number;
  from: number;
  until: number | null;
}

export type ReceiptMatch =
  /** Exactly one arrival of the pledged amount. */
  | { kind: 'exact'; receipt: Receipt }
  /** No arrival of the pledged amount, and exactly one arrival of some other amount. */
  | { kind: 'different'; receipt: Receipt }
  /** More than one row could be this pledge's, or the list may be incomplete. */
  | { kind: 'several'; receipts: Receipt[]; more: boolean }
  /** `more` when the page may be incomplete, so a qualifying row could be on a page not read. */
  | { kind: 'none'; more: boolean };

/** What the browser is told when a check needs the owner, or failed. Mirrored in web/src/lib/api.ts. */
export interface VerificationDetails {
  outcome: 'none' | 'different' | 'several' | 'choice-unavailable' | 'over-ceiling' | 'unreachable' | 'key-refused' | 'refused';
  pledged?: number;
  receipts?: Receipt[];
  /** The candidate list was cut short; there may be older rows that also qualify. */
  more?: boolean;
  /** Credits the project can still record before its ceiling. Only on over-ceiling. */
  room?: number;
}

/** A check that settled on an amount to record. */
export interface CheckedConfirmation {
  /** exact: the one arrival of the pledged amount. chosen: the owner picked a row. */
  outcome: 'exact' | 'chosen';
  /** Credits to record: what arrived, read from the owner's log in this request. */
  amount: number;
  transactionId: string;
}

/** The most rows offered to the owner to choose from. */
export const MAX_RECEIPTS_SHOWN = 25;
const NOTE_MAX = 200;

function idOf(raw: unknown): string {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && /^[1-9][0-9]{0,19}$/.test(raw)) return raw;
  return '';
}

function noteOf(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of [row.reason, row.description]) {
    if (typeof field !== 'string') continue;
    const text = field.replace(/\s+/g, ' ').trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' / ').slice(0, NOTE_MAX);
}

/**
 * The rows that could be this pledge's transfer arriving: `admin` rows with a positive amount,
 * recorded no earlier than the pledge was created, that carry an id and are not already recorded
 * against another pledge. Newest first.
 *
 * Positive only. A transfer out of the owner's account is negative, and counting it would record a
 * transfer the owner made as one they received.
 *
 * The lower bound is the pledge's creation, floored to its second because RIPE stamps whole
 * seconds (see findTransferTransaction). A manual donor learns where to send only from the response
 * that created the pledge, so their transfer cannot be older. A row whose date cannot be read is
 * left out, as is one with no usable id: a match with no reference cannot be shown to be unique.
 */
export function incomingReceipts(rows: unknown[], since: number, used: ReadonlySet<string>, rivals: readonly Rival[] = []): Receipt[] {
  if (!Number.isFinite(since)) return [];
  const earliest = Math.floor(since / 1000) * 1000;
  const out: Receipt[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    if (row.type !== 'admin') continue;
    const amount = row.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) continue;
    const id = idOf(row.id);
    if (!id || used.has(id)) continue;
    const date = row.date;
    const when = typeof date === 'number' || typeof date === 'string' ? transactionTime(date) : null;
    if (when === null || when < earliest || !Number.isFinite(new Date(when).getTime())) continue;
    const contested = rivals.some((r) => r.amount === amount && when >= Math.floor(r.from / 1000) * 1000 && (r.until === null || when <= r.until));
    out.push({ id, amount, at: new Date(when).toISOString(), note: noteOf(row), contested });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Decide what the candidates say about a pledge of `pledged` credits.
 *
 * `complete` is false when RIPE has more rows than one page held and the oldest row on the page is
 * still inside the window, so rows this read never saw could also qualify. Nothing is decided
 * automatically then: a row the read missed could be a second arrival of the same amount.
 *
 * An arrival of the pledged amount is the match even when arrivals of other amounts sit beside it:
 * amount is one of the three things a match rests on, and those others are other donors' transfers
 * as far as anything here can tell. Two arrivals of the pledged amount cannot be told apart, so the
 * owner chooses, and so they do when the one arrival is contested: another pledge of the same
 * amount could own it, and matching it here would count the same credits twice.
 */
export function matchReceipt(receipts: Receipt[], pledged: number, complete: boolean): ReceiptMatch {
  if (receipts.length === 0) return { kind: 'none', more: !complete };
  const shown = receipts.slice(0, MAX_RECEIPTS_SHOWN);
  const more = !complete || receipts.length > shown.length;
  if (!complete) return { kind: 'several', receipts: shown, more };
  const exact = receipts.filter((r) => r.amount === pledged);
  if (exact.length === 1 && !exact[0].contested) return { kind: 'exact', receipt: exact[0] };
  if (exact.length === 0 && receipts.length === 1) return { kind: 'different', receipt: receipts[0] };
  return { kind: 'several', receipts: shown, more };
}

/** Whether the page could have stopped short of rows inside the window. */
export function pageComplete(page: TransactionPage, since: number): boolean {
  if (!page.hasMore) return true;
  // RIPE sorts newest first, so the last row is the oldest seen. If even that is inside the window,
  // the next page may hold more rows inside it too.
  const last = page.rows[page.rows.length - 1] as { date?: unknown } | undefined;
  const date = last?.date;
  const when = typeof date === 'number' || typeof date === 'string' ? transactionTime(date) : null;
  if (when === null) return false;
  return when < Math.floor(since / 1000) * 1000;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function credits(n: number): string {
  return `${fmt(n)} ${n === 1 ? 'credit' : 'credits'}`;
}

export interface CheckInput {
  /** The owner's RIPE Atlas key. Used for one read and not kept. */
  key: string;
  /** What the donor pledged. */
  pledged: number;
  /** When the pledge was created, in milliseconds. */
  since: number;
  /** Transaction ids already recorded against other pledges of this owner's. */
  used: ReadonlySet<string>;
  /** This owner's other pledges that could own an arrival without having recorded one. */
  rivals?: readonly Rival[];
  /** Credits the project can still record before its ceiling. */
  room: number;
  /** A transaction id the owner chose from an earlier answer. */
  choice?: string;
  /** For tests. */
  read?: (key: string) => Promise<TransactionPage>;
}

const CEILING = `the project's ceiling of ${OVERFUND_MULTIPLIER}× its request`;

/**
 * Read the owner's transactions and settle on what to record, or raise an HttpError whose details
 * tell the browser what the owner has to decide. Nothing here writes anything.
 *
 * Every failure leaves the pledge as it was. RIPE not answering is offered back to the owner with
 * confirm-as-pledged one click away, rather than confirmed on their behalf: confirming is final,
 * and a read that timed out after five seconds says nothing about what arrived.
 */
export async function checkReceipt(input: CheckInput): Promise<CheckedConfirmation> {
  const { pledged, since, used, room, choice } = input;
  const read = input.read ?? readAdminTransactions;
  // A project already at its ceiling cannot record anything, whatever arrived, so the key is not
  // sent to RIPE for an answer that could only end in a refusal.
  if (room < 1) throw new HttpError(409, `Confirming this pledge would exceed ${CEILING}; cancel it instead`);
  // RIPE's own refusal text is passed on to the owner. Should it ever quote the key it was sent,
  // the key must not ride back out in our response.
  const redact = (text: string) => text.split(input.key).join('[key]');
  let page: TransactionPage;
  try {
    page = await read(input.key);
  } catch (err) {
    if (err instanceof AtlasRefused) {
      if (err.upstreamStatus === 401 || err.upstreamStatus === 403) {
        throw new HttpError(
          400,
          'RIPE Atlas would not let this key read your transactions. It needs the "Get information about your credits" permission, and it has to be enabled and inside its validity window. Nothing was recorded, and the key was not kept.',
          { verification: { outcome: 'key-refused' } satisfies VerificationDetails },
        );
      }
      throw new HttpError(err.status, `${redact(err.message)} Nothing was recorded.`, { verification: { outcome: 'refused' } satisfies VerificationDetails });
    }
    if (!(err instanceof AtlasUnreachable)) throw err;
    throw new HttpError(
      409,
      `RIPE Atlas did not answer, so the amount could not be checked. Nothing was recorded. Check again, or confirm the pledged ${credits(pledged)} without checking.`,
      { verification: { outcome: 'unreachable', pledged } satisfies VerificationDetails },
    );
  }

  const receipts = incomingReceipts(page.rows, since, used, input.rivals ?? []);
  const complete = pageComplete(page, since);

  let picked: Receipt;
  let outcome: CheckedConfirmation['outcome'];
  if (choice !== undefined) {
    const found = receipts.find((r) => r.id === choice);
    if (!found) {
      throw new HttpError(
        409,
        'That RIPE Atlas transaction can no longer be matched to this pledge. It may already be recorded against another pledge. Nothing was recorded.',
        { verification: { outcome: 'choice-unavailable', pledged, receipts: receipts.slice(0, MAX_RECEIPTS_SHOWN), more: !complete || receipts.length > MAX_RECEIPTS_SHOWN } satisfies VerificationDetails },
      );
    }
    picked = found;
    outcome = 'chosen';
  } else {
    const match = matchReceipt(receipts, pledged, complete);
    switch (match.kind) {
      case 'exact':
        picked = match.receipt;
        outcome = 'exact';
        break;
      case 'none':
        throw new HttpError(
          409,
          match.more
            ? `RIPE Atlas may have more transfers since this pledge was made than one read returns, and none of those it returned could be this one. A new transfer can take a minute or two to appear. Check again later, or confirm the pledged ${credits(pledged)} without checking.`
            : `RIPE Atlas shows no incoming transfer since this pledge was made, apart from any already matched to other pledges. A new transfer can take a minute or two to appear. Check again later, or confirm the pledged ${credits(pledged)} without checking.`,
          { verification: { outcome: 'none', pledged, more: match.more } satisfies VerificationDetails },
        );
      case 'different':
        throw new HttpError(
          409,
          `RIPE Atlas shows ${credits(match.receipt.amount)} arrived since this pledge was made (pledged ${fmt(pledged)}).`,
          { verification: { outcome: 'different', pledged, receipts: [match.receipt] } satisfies VerificationDetails },
        );
      case 'several':
        throw new HttpError(
          409,
          match.receipts.length >= 2
            ? `RIPE Atlas shows more than one incoming transfer since this pledge was made that could be this one. Choose the one from this donor, or confirm the pledged ${credits(pledged)} without checking.`
            : match.more
              ? `RIPE Atlas lists more transfers since this pledge was made than one read returns, so this one cannot be picked out automatically. Choose it from the list, or confirm the pledged ${credits(pledged)} without checking.`
              : `RIPE Atlas shows ${credits(match.receipts[0].amount)} arrived since this pledge was made, but another pledge of the same amount could account for that transfer. Choose it only if you know it came from this donor, or confirm the pledged ${credits(pledged)} without checking.`,
          { verification: { outcome: 'several', pledged, receipts: match.receipts, more: match.more } satisfies VerificationDetails },
        );
    }
  }

  if (picked.amount > room) {
    // What arrived cannot all be recorded. Under the existing rule a confirmation never takes a
    // project past its ceiling, so the owner chooses: record the pledged amount if that still fits,
    // which understates what arrived and is labelled unchecked, or cancel.
    if (picked.amount === pledged || pledged > room) {
      throw new HttpError(409, `RIPE Atlas shows ${credits(picked.amount)} arrived in the transfer matched to this pledge. Recording that would exceed ${CEILING}; cancel the pledge instead.`, {
        verification: { outcome: 'over-ceiling', pledged, receipts: [picked], room: Math.max(0, room) } satisfies VerificationDetails,
      });
    }
    throw new HttpError(
      409,
      `RIPE Atlas shows ${credits(picked.amount)} arrived in the transfer matched to this pledge (pledged ${fmt(pledged)}). Recording that would exceed ${CEILING}. You can confirm the pledged ${credits(pledged)} without checking, or cancel the pledge.`,
      { verification: { outcome: 'over-ceiling', pledged, receipts: [picked], room: Math.max(0, room) } satisfies VerificationDetails },
    );
  }
  return { outcome, amount: picked.amount, transactionId: picked.id };
}
