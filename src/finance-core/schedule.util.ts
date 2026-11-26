import { ContributionInterval } from '@prisma/client';
import { addDays } from './money.util';

export interface ScheduleConfig {
  interval: ContributionInterval;
  startDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
}

/** Safety cap so a bad config can never loop forever. */
const MAX_PERIODS = 5000;

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthlyDue(cfg: ScheduleConfig, year: number, month: number): Date {
  const s = cfg.startDate;
  const wanted = cfg.dayOfMonth ?? s.getUTCDate();
  const day = Math.min(wanted, daysInUtcMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      s.getUTCHours(),
      s.getUTCMinutes(),
      s.getUTCSeconds(),
    ),
  );
}

/**
 * First due date of the schedule: the first date on/after `startDate` that matches
 * `dayOfWeek` (weekly / biweekly) or `dayOfMonth` (monthly), at startDate's UTC time of day.
 */
export function firstDueDate(cfg: ScheduleConfig): Date {
  const s = cfg.startDate;
  if (cfg.interval === ContributionInterval.MONTHLY) {
    let due = monthlyDue(cfg, s.getUTCFullYear(), s.getUTCMonth());
    if (due < s) {
      const next = new Date(
        Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1),
      );
      due = monthlyDue(cfg, next.getUTCFullYear(), next.getUTCMonth());
    }
    return due;
  }
  if (cfg.dayOfWeek == null) return new Date(s);
  const shift = (cfg.dayOfWeek - s.getUTCDay() + 7) % 7;
  return addDays(s, shift);
}

/** Next due date strictly after `due` (which must be a schedule date). */
export function nextDueDate(cfg: ScheduleConfig, due: Date): Date {
  switch (cfg.interval) {
    case ContributionInterval.WEEKLY:
      return addDays(due, 7);
    case ContributionInterval.BIWEEKLY:
      return addDays(due, 14);
    case ContributionInterval.MONTHLY: {
      const next = new Date(
        Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 1),
      );
      return monthlyDue(cfg, next.getUTCFullYear(), next.getUTCMonth());
    }
  }
}

/** Typical period length in days (used for the look-ahead window). */
export function periodLengthDays(interval: ContributionInterval): number {
  return interval === ContributionInterval.WEEKLY
    ? 7
    : interval === ContributionInterval.BIWEEKLY
      ? 14
      : 31;
}

/** All schedule due dates d with from <= d <= to. */
export function dueDatesBetween(
  cfg: ScheduleConfig,
  from: Date,
  to: Date,
): Date[] {
  const out: Date[] = [];
  let d = firstDueDate(cfg);
  for (let i = 0; i < MAX_PERIODS && d <= to; i++) {
    if (d >= from) out.push(d);
    d = nextDueDate(cfg, d);
  }
  return out;
}

/** First schedule date strictly after `after`. */
export function firstDueAfter(cfg: ScheduleConfig, after: Date): Date {
  let d = firstDueDate(cfg);
  for (let i = 0; i < MAX_PERIODS && d <= after; i++) {
    d = nextDueDate(cfg, d);
  }
  return d;
}
