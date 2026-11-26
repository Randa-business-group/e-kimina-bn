import { Prisma } from '@prisma/client';

export const EPS = 0.005;

export function decN(
  v: Prisma.Decimal | number | string | null | undefined,
): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return v.toNumber();
}

export function roundMoney(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(roundMoney(n).toFixed(2));
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
