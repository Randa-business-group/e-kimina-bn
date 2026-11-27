import { toCsv } from './csv';
import { originAllowed, readCookie } from './http-ctx';
import { RateLimitStore } from './rate-limit';
import { maskSecret, openSecret, sealSecret } from './secret-box';

describe('secret box (AES-256-GCM)', () => {
  it('round-trips and never stores the plain text', () => {
    const sealed = sealSecret('sk_live_123456');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('sk_live');
    expect(openSecret(sealed)).toBe('sk_live_123456');
  });

  it('uses a fresh IV every time', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  it('rejects tampered or foreign values', () => {
    const sealed = sealSecret('secret-value');
    const parts = sealed.split(':');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 1;
    parts[3] = flipped.toString('base64');
    expect(openSecret(parts.join(':'))).toBeNull();
    expect(openSecret('not-sealed')).toBeNull();
    expect(openSecret(null)).toBeNull();
  });

  it('masks for display', () => {
    expect(maskSecret(sealSecret('abcdef7890'))).toBe('••••7890');
  });
});

describe('CSV export', () => {
  const text = (b: Buffer) => b.toString('utf8');

  it('starts with a BOM and quotes what needs quoting', () => {
    const csv = text(toCsv(['Name', 'Note'], [['Aline, Uwase', 'said "hi"']]));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"Aline, Uwase","said ""hi"""');
  });

  it('neutralises spreadsheet formulas', () => {
    const csv = text(
      toCsv(
        ['x'],
        [['=HYPERLINK("http://evil")'], ['+1+1'], ['-2'], ['@SUM(A1)']],
      ),
    );
    for (const line of csv.split('\r\n').slice(1).filter(Boolean)) {
      expect(line.replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });
});

describe('rate limit store', () => {
  it('counts within a window and releases failures-only hits', () => {
    const store = new RateLimitStore();
    const b = store.get('login:1.2.3.4|a@b.c', 60_000);
    b.count += 3;
    expect(store.get('login:1.2.3.4|a@b.c', 60_000).count).toBe(3);
    store.release('login:1.2.3.4|a@b.c');
    expect(store.get('login:1.2.3.4|a@b.c', 60_000).count).toBe(2);
  });

  it('starts a new window after expiry', () => {
    const store = new RateLimitStore();
    const b = store.get('k', 1);
    b.count = 9;
    b.resetAt = Date.now() - 1;
    expect(store.get('k', 60_000).count).toBe(0);
  });
});

describe('http helpers', () => {
  const req = (headers: Record<string, string>) => ({
    method: 'POST',
    headers,
  });

  it('reads one cookie among many', () => {
    expect(readCookie(req({ cookie: 'a=1; ek_rt=abc%3D; b=2' }), 'ek_rt')).toBe(
      'abc=',
    );
    expect(readCookie(req({ cookie: 'a=1' }), 'ek_rt')).toBeNull();
    expect(readCookie(req({}), 'ek_rt')).toBeNull();
  });

  it('only lets known browser origins use the refresh cookie', () => {
    const prev = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = 'https://app.ekimina.rw';
    expect(originAllowed(req({ origin: 'https://app.ekimina.rw' }))).toBe(true);
    expect(originAllowed(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(originAllowed(req({}))).toBe(true); // non-browser clients send no Origin
    process.env.CORS_ORIGINS = prev;
  });
});
