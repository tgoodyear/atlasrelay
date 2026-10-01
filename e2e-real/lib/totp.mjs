// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 seconds, 6 digits), the kind an
// authenticator app shows. Used only when a test account has a TOTP seed in the vault.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** @param {string} seed base32, as Microsoft shows it ("Can't scan the QR code?"), spaces allowed */
export function base32Decode(seed) {
  const clean = seed.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('The TOTP seed is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * @param {Buffer} key
 * @param {number} counter
 * @param {number} digits
 */
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/**
 * @param {string} seed base32
 * @param {number} nowMs
 */
export function totp(seed, nowMs = Date.now(), { step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(seed), Math.floor(nowMs / 1000 / step), digits);
}
