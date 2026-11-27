import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto';
import {
  b64u,
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
} from './web-push';

/** Plays the browser: decrypts an RFC 8291 aes128gcm message. */
function decrypt(
  body: Buffer,
  ua: ReturnType<typeof createECDH>,
  auth: Buffer,
) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    ua.getPublicKey(),
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
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
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([
    d.update(ct.subarray(0, ct.length - 16)),
    d.final(),
  ]);
  return { rs, text: plain.subarray(0, plain.lastIndexOf(2)).toString('utf8') };
}

describe('Web Push', () => {
  it('encrypts so the subscribed browser can decrypt (RFC 8291)', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const payload = JSON.stringify({
      title: 'Contribution due soon',
      body: '5,000 RWF on Friday',
    });
    const body = encryptPayload(
      Buffer.from(payload),
      b64u(ua.getPublicKey()),
      b64u(auth),
    );
    const out = decrypt(body, ua, auth);
    expect(out.rs).toBe(4096);
    expect(JSON.parse(out.text)).toEqual(JSON.parse(payload));
  });

  it('refuses malformed subscription keys', () => {
    expect(() =>
      encryptPayload(
        Buffer.from('x'),
        b64u(Buffer.alloc(10)),
        b64u(randomBytes(16)),
      ),
    ).toThrow();
  });

  it('signs a VAPID JWT for the push service origin (RFC 8292)', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:ops@example.com',
    );
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:ops@example.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64u(pub.subarray(1, 33)),
        y: b64u(pub.subarray(33)),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url'),
      ),
    ).toBe(true);
  });
});
