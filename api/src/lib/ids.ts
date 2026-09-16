import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Time-prefixed, URL-safe id. Sorts chronologically as a string. */
export function newId(): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${time}${rand}`;
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-z]{12,32}$/.test(value);
}
