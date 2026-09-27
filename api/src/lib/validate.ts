import { HttpError } from './http';

export const TAGS = ['ping', 'traceroute', 'dns', 'sslcert', 'http', 'ntp', 'ipv4', 'ipv6', 'anchors', 'other'] as const;
export type Tag = (typeof TAGS)[number];

export const MAX_CREDITS = 1_000_000_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Error messages reach the forms as they are, so they name fields the way the forms label them.
// Keys with no entry here are never typed by a person and keep their API name.
const LABELS: Record<string, string> = {
  title: 'Title',
  summary: 'One-paragraph summary',
  description: 'Full description',
  creditsRequested: 'Credits needed',
  tags: 'Measurement types',
  deadline: 'Needed by',
  affiliation: 'Affiliation',
  homepageUrl: 'Project homepage',
  repoUrl: 'Code repository',
  paperUrl: 'Paper or proposal',
  resultsSummary: 'Results',
  resultsUrl: 'Link to the results',
  displayName: 'Display name',
  atlasEmail: 'RIPE NCC Access email',
  url: 'Homepage',
  amount: 'Amount',
  message: 'Message',
};
const label = (key: string): string => LABELS[key] ?? key;

export function str(input: Record<string, unknown>, key: string, opts: { max: number; min?: number; required?: boolean }): string | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) {
    if (opts.required) throw new HttpError(400, `${label(key)} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') throw new HttpError(400, `${label(key)} must be a string`);
  const value = raw.trim();
  if (opts.required && value.length < (opts.min ?? 1)) throw new HttpError(400, `${label(key)} is required`);
  if (value.length > opts.max) throw new HttpError(400, `${label(key)} must be at most ${opts.max} characters`);
  return value;
}

export function int(input: Record<string, unknown>, key: string, opts: { min: number; max: number; required?: boolean }): number | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) throw new HttpError(400, `${label(key)} is required`);
    return undefined;
  }
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new HttpError(400, `${label(key)} must be a whole number`);
  if (n < opts.min || n > opts.max) throw new HttpError(400, `${label(key)} must be between ${opts.min} and ${opts.max}`);
  return n;
}

export function email(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = str(input, key, { max: 254, required });
  if (value === undefined || value === '') return value;
  if (!EMAIL_RE.test(value)) throw new HttpError(400, `${label(key)} must be a valid email address`);
  return value.toLowerCase();
}

export function httpsUrl(input: Record<string, unknown>, key: string): string | undefined {
  const value = str(input, key, { max: 500 });
  if (value === undefined || value === '') return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(400, `${label(key)} must be a valid URL`);
  }
  // https only, which is what this function is called, what its error says, and what the fields using it
  // are documented as accepting. It accepted http as well, so the name, the message and the behaviour all
  // disagreed -- and a project could carry an http homepage, repo or paper link that the docs promised was
  // https. Tightening it rather than renaming, because the docs and the message are the intent and the
  // behaviour was the accident.
  if (parsed.protocol !== 'https:') throw new HttpError(400, `${label(key)} must start with https://`);
  return parsed.toString();
}

export function tags(input: Record<string, unknown>, key = 'tags'): Tag[] | undefined {
  const raw = input[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new HttpError(400, `${label(key)} must be an array`);
  const out: Tag[] = [];
  for (const t of raw) {
    if (typeof t !== 'string' || !(TAGS as readonly string[]).includes(t)) throw new HttpError(400, `unknown tag: ${String(t)}`);
    if (!out.includes(t as Tag)) out.push(t as Tag);
  }
  if (out.length > 6) throw new HttpError(400, 'Pick at most 6 measurement types');
  return out;
}

export function isoDate(input: Record<string, unknown>, key: string): string | undefined {
  const value = str(input, key, { max: 10 });
  if (value === undefined || value === '') return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${label(key)} must be YYYY-MM-DD`);
  return value;
}

/**
 * Read a boolean field. Absent means false, but a present value has to be an actual boolean.
 * Coercing here would be the wrong kind of lenient: this reads a donor's privacy choice, and
 * "false" as a string, or 0, would otherwise quietly come out as "name me publicly".
 *
 * Only `undefined` takes the default. `null` is a value the caller sent, not a field they left
 * out, so it is rejected like any other non-boolean: treating it as absent is the same silent
 * coercion this exists to prevent, just spelled differently.
 */
export function bool(input: Record<string, unknown>, key: string): boolean {
  const value = input[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new HttpError(400, `${label(key)} must be true or false`);
  return value;
}

export function oneOf<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[], required = false): T | undefined {
  const value = str(input, key, { max: 32, required });
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw new HttpError(400, `${label(key)} must be one of ${allowed.join(', ')}`);
  return value as T;
}
