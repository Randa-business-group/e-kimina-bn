import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpauthUrl,
  totpAt,
  totpStep,
  verifyTotp,
} from './totp';

describe('TOTP (RFC 4226 / 6238)', () => {
  const rfcSecret = Buffer.from('12345678901234567890');

  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) =>
      expect(hotp(rfcSecret, counter)).toBe(code),
    );
  });

  it('matches the RFC 6238 SHA-1 vector at T=59 (8 digits)', () => {
    expect(hotp(rfcSecret, Math.floor(59 / 30), 8)).toBe('94287082');
  });

  it('round-trips base32', () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts the current, previous and next step only', () => {
    const secret = newTotpSecret();
    const now = Date.UTC(2026, 10, 27, 10, 0, 15);
    const step = totpStep(now);
    expect(verifyTotp(secret, totpAt(secret, step), 1, now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), 1, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step + 1), 1, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(secret, step + 2), 1, now)).toBeNull();
    expect(verifyTotp(secret, '12345', 1, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 1, now)).toBeNull();
  });

  it('accepts codes typed with spaces', () => {
    const secret = newTotpSecret();
    const now = Date.now();
    const code = totpAt(secret, totpStep(now));
    expect(
      verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, 1, now),
    ).not.toBeNull();
  });

  it('builds an otpauth link authenticator apps understand', () => {
    const url = otpauthUrl('JBSWY3DPEHPK3PXP', 'aline@example.com');
    expect(url).toBe(
      'otpauth://totp/E-kimina%3Aaline%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=E-kimina&algorithm=SHA1&digits=6&period=30',
    );
  });
});
