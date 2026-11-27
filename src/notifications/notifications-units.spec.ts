import { NotificationChannel, NotificationType } from '@prisma/client';
import { diff, scrub } from '../audit/audit.service';
import {
  CATEGORIES,
  DEDICATED_EMAIL,
  MANDATORY_IN_APP,
  categoryOf,
  defaultEnabled,
  typesOf,
} from './notification-catalog';
import { normalizePhone, smsSegments } from './sms.service';

describe('notification catalog', () => {
  it('puts every notification type in exactly one category', () => {
    const all = Object.values(NotificationType);
    const listed = CATEGORIES.flatMap((c) => typesOf(c.key));
    expect(new Set(listed).size).toBe(listed.length);
    for (const t of all) expect(listed).toContain(t);
  });

  it('defaults: in-app and push on, SMS only for what matters', () => {
    expect(
      defaultEnabled(
        NotificationChannel.IN_APP,
        NotificationType.LEDGER_ADJUSTMENT,
      ),
    ).toBe(true);
    expect(
      defaultEnabled(
        NotificationChannel.SMS,
        NotificationType.CONTRIBUTION_DUE_SOON,
      ),
    ).toBe(true);
    expect(
      defaultEnabled(
        NotificationChannel.SMS,
        NotificationType.LEDGER_ADJUSTMENT,
      ),
    ).toBe(false);
    expect(
      defaultEnabled(
        NotificationChannel.EMAIL,
        NotificationType.NEW_GROUP_MEMBER,
      ),
    ).toBe(false);
    expect(categoryOf(NotificationType.GROUP_ANNOUNCEMENT)).toBe(
      'ANNOUNCEMENTS',
    );
  });

  it('never duplicates dedicated emails and always shows removals', () => {
    expect(DEDICATED_EMAIL.has(NotificationType.DEPOSIT_CONFIRMED)).toBe(true);
    expect(MANDATORY_IN_APP.has(NotificationType.REMOVED_FROM_GROUP)).toBe(
      true,
    );
  });
});

describe('SMS helpers', () => {
  it('normalises Rwandan numbers', () => {
    expect(normalizePhone('0788 123 456')).toBe('250788123456');
    expect(normalizePhone('+250788123456')).toBe('250788123456');
    expect(normalizePhone('788123456')).toBe('250788123456');
    expect(normalizePhone('00250788123456')).toBe('250788123456');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('counts SMS segments', () => {
    expect(smsSegments('x'.repeat(160))).toBe(1);
    expect(smsSegments('x'.repeat(161))).toBe(2);
    expect(smsSegments('x'.repeat(307))).toBe(3);
  });
});

describe('audit helpers', () => {
  it('redacts secrets anywhere in a body', () => {
    const out = scrub({
      email: 'a@b.c',
      password: 'hunter2',
      nested: {
        apiKey: 'k',
        code: '123456',
        recoveryCode: 'abcde-fghij',
        amount: 5000,
      },
    }) as Record<string, unknown>;
    expect(out.password).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[redacted]');
    expect(nested.code).toBe('[redacted]');
    expect(nested.recoveryCode).toBe('[redacted]');
    expect(nested.amount).toBe(5000);
    expect(out.email).toBe('a@b.c');
  });

  it('keeps only the fields that changed', () => {
    const d = diff(
      { a: 1, b: 'x', updatedAt: 'then' },
      { a: 2, b: 'x', updatedAt: 'now' },
    );
    expect(d).toEqual({ before: { a: 1 }, after: { a: 2 } });
    expect(diff({ a: 1 }, { a: 1 })).toEqual({ before: null, after: null });
  });
});
