import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * AES-256-GCM for secrets stored in the database (group MoMo API keys).
 * Key: PAYMENT_SECRETS_KEY (any string; hashed to 32 bytes). Falls back to JWT_SECRET
 * with a warning so development works without extra setup.
 */
let cachedKey: Buffer | null = null;
let warned = false;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.PAYMENT_SECRETS_KEY?.trim();
  if (!raw && !warned) {
    warned = true;
    new Logger('SecretBox').warn(
      'PAYMENT_SECRETS_KEY is not set; payment secrets are encrypted with a key derived from JWT_SECRET.',
    );
  }
  const material = raw || `ekimina:${process.env.JWT_SECRET ?? 'dev'}`;
  cachedKey = createHash('sha256').update(material).digest();
  return cachedKey;
}

/** Returns `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, enc]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
}

export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, enc] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !enc) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      d.update(Buffer.from(enc, 'base64')),
      d.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** "••••1234" for display; never the secret itself. */
export function maskSecret(sealed: string | null | undefined): string | null {
  const plain = openSecret(sealed);
  if (!plain) return null;
  return `••••${plain.slice(-4)}`;
}
