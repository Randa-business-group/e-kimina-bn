import { EPS, roundMoney } from './money.util';

/**
 * Pure loan eligibility rules (msfts §10). `getLoanRequestPreview` gathers the facts from the
 * database and these functions decide.
 */

/** How much a member may borrow: their stake (× multiplier) and the group's free cash. */
export function loanCap(p: {
  /** Savings paid in, minus what they guarantee for others. */
  stake: number;
  allowExceedContribution: boolean;
  /** null = no limit when exceeding is allowed. */
  multiplier: number | null;
  cashAvailable: number;
  /** A top-up only pays out the difference, so the old balance needs no cash. */
  topUpBalance?: number;
}) {
  let stakeCap: number;
  if (!p.allowExceedContribution) stakeCap = p.stake;
  else if (p.multiplier != null) stakeCap = p.stake * p.multiplier;
  else stakeCap = Number.POSITIVE_INFINITY;
  const maxAmount = roundMoney(
    Math.max(0, Math.min(stakeCap, p.cashAvailable + (p.topUpBalance ?? 0))),
  );
  return { stakeCap, maxAmount };
}

export type EligibilityFacts = {
  topUpRequested: boolean;
  allowTopUp: boolean;
  /** The open loan matches the requested top-up. */
  topUpMatches: boolean;
  topUpActive: boolean;
  hasOpenLoan: boolean;
  hasPendingApplication: boolean;
  writtenOffLoans: number;
  blockIfArrears: boolean;
  lateContributions: number;
  openFines: number;
  cashAvailable: number;
  constitutionNotAccepted: number | null;
  maxAmount: number;
  currency?: string;
};

/** Reasons a member cannot apply right now (empty = may apply). */
export function loanBlockers(f: EligibilityFacts): string[] {
  const cur = f.currency ?? 'RWF';
  const out: string[] = [];
  if (f.topUpRequested) {
    if (!f.allowTopUp) out.push('This group does not allow loan top-ups.');
    else if (!f.topUpMatches)
      out.push('Only your current loan can be topped up.');
    else if (!f.topUpActive) out.push('A defaulted loan cannot be topped up.');
  } else if (f.hasOpenLoan) {
    out.push(
      'You already have an unpaid loan in this group. Repay it before applying for another loan.',
    );
  }
  if (f.hasPendingApplication)
    out.push('You already have a loan application waiting for approval.');
  if (f.writtenOffLoans > 0)
    out.push(
      'A previous loan of yours was written off. Talk to your group leaders.',
    );
  if (f.blockIfArrears && (f.lateContributions > 0 || f.openFines > EPS)) {
    const parts: string[] = [];
    if (f.lateContributions > 0) {
      parts.push(
        `${f.lateContributions} late contribution${f.lateContributions > 1 ? 's' : ''}`,
      );
    }
    if (f.openFines > EPS)
      parts.push(`${f.openFines.toFixed(0)} ${cur} in unpaid fines`);
    out.push(`Clear your arrears first (${parts.join(' and ')}).`);
  }
  if (f.cashAvailable < 1)
    out.push('The group has no cash available for loans right now.');
  if (f.constitutionNotAccepted != null) {
    out.push(
      `Read and accept the group rules (version ${f.constitutionNotAccepted}) before applying for a loan.`,
    );
  }
  if (out.length === 0 && f.maxAmount <= 0)
    out.push('You are not eligible yet (max amount is 0). Contribute first.');
  return out;
}
