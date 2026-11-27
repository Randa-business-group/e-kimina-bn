import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32 (no padding) and RFC 6238 TOTP (SHA-1, 30 s, 6 digits). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export const totpStep = (at = Date.now()) => Math.floor(at / 1000 / 30);

export const totpAt = (secretB32: string, step: number) =>
  hotp(base32Decode(secretB32), step);

/** Returns the matching time step (±window) or null. */
export function verifyTotp(
  secretB32: string,
  code: string,
  window = 1,
  at = Date.now(),
): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(at);
  for (let d = -window; d <= window; d++) {
    const expected = Buffer.from(hotp(key, now + d));
    if (timingSafeEqual(expected, Buffer.from(c))) return now + d;
  }
  return null;
}

export function otpauthUrl(
  secretB32: string,
  account: string,
  issuer = 'E-kimina',
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
