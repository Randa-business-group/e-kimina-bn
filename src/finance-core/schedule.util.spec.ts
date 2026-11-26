import { ContributionInterval } from '@prisma/client';
import {
  dueDatesBetween,
  firstDueAfter,
  firstDueDate,
  nextDueDate,
  type ScheduleConfig,
} from './schedule.util';

const d = (iso: string) => new Date(iso);
const iso = (x: Date) => x.toISOString();

describe('schedule.util', () => {
  const weeklyFri: ScheduleConfig = {
    interval: ContributionInterval.WEEKLY,
    startDate: d('2026-01-01T08:00:00.000Z'), // Thursday
    dayOfWeek: 5, // Friday
    dayOfMonth: null,
  };

  it('weekly: first due is the first matching weekday on/after start, at start time', () => {
    expect(iso(firstDueDate(weeklyFri))).toBe('2026-01-02T08:00:00.000Z');
  });

  it('weekly: steps 7 days', () => {
    const dates = dueDatesBetween(weeklyFri, d('2026-01-01'), d('2026-01-31'));
    expect(dates.map(iso)).toEqual([
      '2026-01-02T08:00:00.000Z',
      '2026-01-09T08:00:00.000Z',
      '2026-01-16T08:00:00.000Z',
      '2026-01-23T08:00:00.000Z',
      '2026-01-30T08:00:00.000Z',
    ]);
  });

  it('weekly: from filter prorates (join date)', () => {
    const dates = dueDatesBetween(weeklyFri, d('2026-01-10'), d('2026-01-24'));
    expect(dates.map(iso)).toEqual([
      '2026-01-16T08:00:00.000Z',
      '2026-01-23T08:00:00.000Z',
    ]);
  });

  it('biweekly: steps 14 days', () => {
    const cfg = { ...weeklyFri, interval: ContributionInterval.BIWEEKLY };
    expect(iso(nextDueDate(cfg, firstDueDate(cfg)))).toBe(
      '2026-01-16T08:00:00.000Z',
    );
  });

  it('weekly without dayOfWeek uses the start date itself', () => {
    const cfg = { ...weeklyFri, dayOfWeek: null };
    expect(iso(firstDueDate(cfg))).toBe('2026-01-01T08:00:00.000Z');
  });

  it('monthly: clamps day 31 to short months', () => {
    const cfg: ScheduleConfig = {
      interval: ContributionInterval.MONTHLY,
      startDate: d('2026-01-15T00:00:00.000Z'),
      dayOfWeek: null,
      dayOfMonth: 31,
    };
    const dates = dueDatesBetween(cfg, d('2026-01-01'), d('2026-04-30'));
    expect(dates.map(iso)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-02-28T00:00:00.000Z',
      '2026-03-31T00:00:00.000Z',
      '2026-04-30T00:00:00.000Z',
    ]);
  });

  it('monthly: day already passed in the start month moves to next month', () => {
    const cfg: ScheduleConfig = {
      interval: ContributionInterval.MONTHLY,
      startDate: d('2026-01-20T00:00:00.000Z'),
      dayOfWeek: null,
      dayOfMonth: 5,
    };
    expect(iso(firstDueDate(cfg))).toBe('2026-02-05T00:00:00.000Z');
  });

  it('firstDueAfter skips to the next schedule date (advance payments, off-schedule rows)', () => {
    expect(iso(firstDueAfter(weeklyFri, d('2026-01-09T08:00:00.000Z')))).toBe(
      '2026-01-16T08:00:00.000Z',
    );
    expect(iso(firstDueAfter(weeklyFri, d('2026-01-11T15:30:00.000Z')))).toBe(
      '2026-01-16T08:00:00.000Z',
    );
  });
});
