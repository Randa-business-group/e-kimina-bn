import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Minimal Web Push sender (no dependency):
 *  - RFC 8291 message encryption (aes128gcm content coding, RFC 8188)
 *  - RFC 8292 VAPID authentication (ES256 JWT)
 */

export const b64u = (b: Buffer | Uint8Array) =>
  Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export type VapidKeys = { publicKey: string; privateKey: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** New P-256 key pair: public = 65-byte uncompressed point, private = 32-byte scalar (base64url). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(ecdh.getPrivateKey()),
  };
}

/** RFC 8291 §3–4: one aes128gcm record for the user agent's key. */
export function encryptPayload(
  payload: Buffer,
  uaPublicB64: string,
  authSecretB64: string,
  salt = randomBytes(16),
  asKeys = (() => {
    const e = createECDH('prime256v1');
    e.generateKeys();
    return e;
  })(),
): Buffer {
  const uaPublic = fromB64u(uaPublicB64);
  const authSecret = fromB64u(authSecretB64);
  if (uaPublic.length !== 65 || authSecret.length < 16) {
    throw new Error('Invalid push subscription keys.');
  }
  const asPublic = asKeys.getPublicKey();
  const shared = asKeys.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync(
      'sha256',
      ikm,
      salt,
      Buffer.from('Content-Encoding: aes128gcm\0'),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );

  const rs = 4096;
  if (payload.length + 1 + 16 > rs) throw new Error('Push payload too large.');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = padding delimiter of the last (only) record.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292: `vapid t=<jwt>, k=<public key>` for the push service's origin. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  ttlSeconds = 12 * 3600,
): string {
  const pub = fromB64u(keys.publicKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: keys.privateKey,
    x: b64u(pub.subarray(1, 33)),
    y: b64u(pub.subarray(33, 65)),
  };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds,
        sub: subject,
      }),
    ),
  );
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export type PushSendResult = { ok: boolean; status: number; gone: boolean };

export async function sendWebPush(
  target: PushTarget,
  payload: object,
  keys: VapidKeys,
  subject: string,
  ttl = 24 * 3600,
): Promise<PushSendResult> {
  const body = encryptPayload(
    Buffer.from(JSON.stringify(payload)),
    target.p256dh,
    target.auth,
  );
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}
