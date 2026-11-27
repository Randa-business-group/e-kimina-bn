/** CSV / PDF renderers for the report data returned by ReportsService (msfts §5). */
import { toCsv } from '../common/csv';
import { renderPdf, type PdfLine } from '../common/pdf/simple-pdf';
import type { PlatformReportsService } from './platform-reports.service';
import type { ReportsService } from './reports.service';

type Data<K extends keyof ReportsService> = Awaited<
  ReturnType<ReportsService[K]>
>;
export interface FileOut {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

const fmt = (n: number | null | undefined) =>
  n == null ? '-' : Math.round(n).toLocaleString('en-US');
const day = (s: string | Date | null | undefined) =>
  s ? new Date(s).toISOString().slice(0, 10) : '-';
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const csv = (
  name: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): FileOut => ({
  buffer: toCsv(headers, rows),
  contentType: 'text/csv; charset=utf-8',
  filename: `${name}.csv`,
});
const pdf = (name: string, lines: PdfLine[], footer: string): FileOut => ({
  buffer: renderPdf(lines, footer),
  contentType: 'application/pdf',
  filename: `${name}.pdf`,
});
const title = (t: string, group: string, sub: string): PdfLine[] => [
  { text: t, size: 16, bold: true },
  { text: `${group} - ${sub}`, size: 9 },
  {
    text: `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    size: 8,
  },
];

// ── member statement ─────────────────────────────────────────────────────
export function memberStatementFile(
  d: Data<'memberStatement'>,
  format: 'csv' | 'pdf',
): FileOut {
  const name = `statement-${slug(d.member.name)}-${day(d.period.from)}-${day(d.period.to)}`;
  if (format === 'csv') {
    return csv(
      name,
      ['Date', 'Type', 'Fund', 'In', 'Out', 'Description'],
      d.lines.map((l) => [
        day(l.date),
        l.label,
        l.fund,
        l.direction === 'IN' ? l.amount : '',
        l.direction === 'OUT' ? l.amount : '',
        l.description ?? '',
      ]),
    );
  }
  const s = d.summary;
  const lines: PdfLine[] = [
    ...title(
      'Member statement',
      d.group,
      `${day(d.period.from)} to ${day(d.period.to)}`,
    ),
    {
      text: `${d.member.name}  ${d.member.email}${d.member.phone ? '  ' + d.member.phone : ''}  (${d.member.status.toLowerCase()})`,
      gap: 8,
    },
    { text: 'Summary', bold: true, gap: 8 },
    {
      text: `Savings: opening ${fmt(s.openingSavings)} + this period ${fmt(s.savingsInPeriod)} = closing ${fmt(s.closingSavings)} RWF`,
    },
    {
      text: `Social fund this period: ${fmt(s.socialFundInPeriod)}    Fines paid: ${fmt(s.finesPaidInPeriod)}    Loan repaid: ${fmt(s.loanRepaidInPeriod)} RWF`,
    },
    {
      text: `Open fines: ${fmt(s.openFines)}    Loan outstanding: ${fmt(s.loanOutstanding)} RWF    Late contributions: ${s.lateContributions}`,
      bold: true,
    },
    { text: 'Transactions', bold: true, gap: 10 },
    {
      text: 'Date',
      bold: true,
      size: 9,
      columns: [
        [110, 'Type'],
        [290, 'In'],
        [360, 'Out'],
        [430, 'Fund'],
      ],
    },
    ...d.lines.map(
      (l): PdfLine => ({
        text: day(l.date),
        size: 9,
        columns: [
          [110, l.label],
          [290, l.direction === 'IN' ? fmt(l.amount) : ''],
          [360, l.direction === 'OUT' ? fmt(l.amount) : ''],
          [430, l.fund.toLowerCase()],
        ],
      }),
    ),
    { text: 'Contribution periods', bold: true, gap: 10 },
    ...d.contributions.map(
      (c): PdfLine => ({
        text: day(c.dueDate),
        size: 9,
        columns: [
          [110, c.fund.toLowerCase()],
          [200, `${fmt(c.amountPaid)} / ${fmt(c.amount)}`],
          [320, c.status],
        ],
      }),
    ),
  ];
  if (d.loans.length) {
    lines.push({ text: 'Loans', bold: true, gap: 10 });
    for (const l of d.loans) {
      lines.push({
        text: day(l.disbursedAt),
        size: 9,
        columns: [
          [110, `principal ${fmt(l.principal)}`],
          [230, `repaid ${fmt(l.repaid)}`],
          [340, `outstanding ${fmt(l.outstanding)}`],
          [470, l.status],
        ],
      });
    }
  }
  if (d.fines.length) {
    lines.push({ text: 'Fines issued in the period', bold: true, gap: 10 });
    for (const f of d.fines)
      lines.push({
        text: day(f.date),
        size: 9,
        columns: [
          [110, f.reason.slice(0, 55)],
          [400, fmt(f.amount)],
          [470, f.status],
        ],
      });
  }
  return pdf(name, lines, `E-kimina member statement - ${d.member.name}`);
}

// ── contribution matrix ─────────────────────────────────────────────────
export function contributionMatrixFile(
  d: Data<'contributionMatrix'>,
  format: 'csv' | 'pdf',
): FileOut {
  const name = `contributions-${slug(d.group)}-${day(d.period.from)}-${day(d.period.to)}`;
  const code: Record<string, string> = {
    PAID: 'P',
    LATE: 'L',
    PARTIALLY_PAID: 'PP',
    PENDING: '-',
    CANCELLED: 'X',
  };
  if (format === 'csv') {
    return csv(
      name,
      [
        'Member',
        ...d.periods.map(day),
        'Paid',
        'Late',
        'Partial',
        'Pending',
        'Amount paid',
        'Amount due',
      ],
      [
        ...d.members.map((m) => [
          m.name,
          ...m.cells.map((c) => (c ? code[c.status] : '')),
          m.paid,
          m.late,
          m.partial,
          m.pending,
          m.amountPaid,
          m.amountDue,
        ]),
        [
          'Collected',
          ...d.periodTotals.map((p) => p.collected),
          '',
          '',
          '',
          '',
          d.totals.collected,
          d.totals.expected,
        ],
      ],
    );
  }
  return pdf(
    name,
    [
      ...title(
        `Contribution summary (${d.fund.toLowerCase()})`,
        d.group,
        `${day(d.period.from)} to ${day(d.period.to)} - ${d.periods.length} periods`,
      ),
      {
        text: `Expected ${fmt(d.totals.expected)} RWF - collected ${fmt(d.totals.collected)} RWF`,
        bold: true,
        gap: 6,
      },
      {
        text: 'Member',
        bold: true,
        size: 9,
        gap: 8,
        columns: [
          [220, 'Paid'],
          [270, 'Late'],
          [320, 'Partial'],
          [370, 'Pending'],
          [430, 'Paid RWF'],
          [500, 'Due RWF'],
        ],
      },
      ...d.members.map(
        (m): PdfLine => ({
          text: m.name,
          size: 9,
          columns: [
            [220, String(m.paid)],
            [270, String(m.late)],
            [320, String(m.partial)],
            [370, String(m.pending)],
            [430, fmt(m.amountPaid)],
            [500, fmt(m.amountDue)],
          ],
        }),
      ),
      { text: 'Per period', bold: true, gap: 10, size: 10 },
      ...d.periodTotals.map(
        (p): PdfLine => ({
          text: day(p.dueDate),
          size: 9,
          columns: [
            [120, `collected ${fmt(p.collected)} / ${fmt(p.expected)}`],
            [320, `paid ${p.paidCount}`],
            [400, `late ${p.lateCount}`],
          ],
        }),
      ),
    ],
    'E-kimina contribution summary (full matrix in the CSV export)',
  );
}

// ── arrears ──────────────────────────────────────────────────────────────
export function arrearsFile(
  d: Data<'arrears'>,
  format: 'csv' | 'pdf',
): FileOut {
  const name = `arrears-${slug(d.group)}-${day(d.asOf)}`;
  if (format === 'csv') {
    return csv(
      name,
      [
        'Member',
        'Phone',
        'Status',
        'Late contributions',
        'Late amount',
        'Oldest late',
        'Open fines',
        'Overdue loan',
        'Days overdue',
        'Defaulted',
        'Called guarantees',
        'Total',
      ],
      d.members.map((m) => [
        m.name,
        m.phone ?? '',
        m.membershipStatus,
        m.lateContributions,
        m.lateAmount,
        day(m.oldestLateDueDate),
        m.openFines,
        m.overdueLoanAmount,
        m.daysOverdue,
        m.defaulted ? 'yes' : '',
        m.calledGuarantees,
        m.total,
      ]),
    );
  }
  const t = d.totals;
  return pdf(
    name,
    [
      ...title('Arrears & defaulters', d.group, `as of ${day(d.asOf)}`),
      {
        text: `${t.members} members in arrears, ${t.defaulters} defaulted - total ${fmt(t.total)} RWF (contributions ${fmt(t.lateAmount)}, fines ${fmt(t.openFines)}, loans ${fmt(t.overdueLoanAmount)})`,
        bold: true,
        gap: 6,
      },
      {
        text: 'Member',
        bold: true,
        size: 9,
        gap: 8,
        columns: [
          [200, 'Late'],
          [260, 'Fines'],
          [320, 'Loan'],
          [390, 'Days'],
          [440, 'Total'],
          [500, 'Default'],
        ],
      },
      ...d.members.map(
        (m): PdfLine => ({
          text: m.name,
          size: 9,
          columns: [
            [200, `${m.lateContributions} / ${fmt(m.lateAmount)}`],
            [260, fmt(m.openFines)],
            [320, fmt(m.overdueLoanAmount)],
            [390, String(m.daysOverdue)],
            [440, fmt(m.total)],
            [500, m.defaulted ? 'YES' : ''],
          ],
        }),
      ),
    ],
    'E-kimina arrears report',
  );
}

// ── loan portfolio ───────────────────────────────────────────────────────
export function loanPortfolioFile(
  d: Data<'loanPortfolio'>,
  format: 'csv' | 'pdf',
): FileOut {
  const name = `loan-portfolio-${slug(d.group)}-${day(d.asOf)}`;
  if (format === 'csv') {
    return csv(
      name,
      [
        'Borrower',
        'Disbursed',
        'Due',
        'Principal',
        'Principal outstanding',
        'Total outstanding',
        'Penalty',
        'Status',
        'Days overdue',
        'Bucket',
      ],
      d.loans.map((l) => [
        l.borrower,
        day(l.disbursedAt),
        day(l.dueDate),
        l.principal,
        l.principalOutstanding,
        l.outstanding,
        l.penalty,
        l.status,
        l.daysOverdue,
        l.bucket,
      ]),
    );
  }
  const p = d.portfolio;
  const f = d.periodFlows;
  return pdf(
    name,
    [
      ...title(
        'Loan portfolio',
        d.group,
        `as of ${day(d.asOf)}; flows ${day(d.period.from)} to ${day(d.period.to)}`,
      ),
      {
        text: `Active ${d.counts.active}, defaulted ${d.counts.defaulted}, overdue ${d.counts.overdue}, repaid ${d.counts.repaid}, written off ${d.counts.writtenOff}`,
        gap: 6,
      },
      {
        text: `Principal outstanding ${fmt(p.principalOutstanding)} RWF (total incl. interest & penalties ${fmt(p.totalOutstanding)})`,
        bold: true,
      },
      {
        text: `PAR30 ${p.par30.percent}% (${fmt(p.par30.amount)})   PAR60 ${p.par60.percent}% (${fmt(p.par60.amount)})   PAR90 ${p.par90.percent}% (${fmt(p.par90.amount)})`,
      },
      {
        text: `Period: disbursed ${f.disbursedCount} loans / ${fmt(f.disbursedAmount)} - principal repaid ${fmt(f.principalRepaid)} - interest ${fmt(f.interestEarned)} - penalties ${fmt(f.penaltiesEarned)} - written off ${fmt(f.writtenOff)}`,
      },
      { text: 'Ageing', bold: true, gap: 8 },
      ...d.buckets.map(
        (b): PdfLine => ({
          text: b.bucket,
          size: 9,
          columns: [
            [120, `${b.loans} loans`],
            [220, `${fmt(b.principalOutstanding)} RWF`],
          ],
        }),
      ),
      { text: 'Open loans', bold: true, gap: 8 },
      {
        text: 'Borrower',
        bold: true,
        size: 9,
        columns: [
          [180, 'Principal'],
          [250, 'Left'],
          [320, 'Total due'],
          [400, 'Days'],
          [450, 'Status'],
        ],
      },
      ...d.loans.map(
        (l): PdfLine => ({
          text: l.borrower,
          size: 9,
          columns: [
            [180, fmt(l.principal)],
            [250, fmt(l.principalOutstanding)],
            [320, fmt(l.outstanding)],
            [400, String(l.daysOverdue)],
            [450, l.status],
          ],
        }),
      ),
    ],
    'E-kimina loan portfolio',
  );
}

// ── cash book ────────────────────────────────────────────────────────────
export function cashBookFile(
  d: Data<'cashBook'>,
  format: 'csv' | 'pdf',
): FileOut {
  const name = `cash-book-${slug(d.group)}-${String(d.fund).toLowerCase()}-${day(d.period.from)}-${day(d.period.to)}`;
  if (format === 'csv') {
    return csv(
      name,
      [
        'Date',
        'Fund',
        'Type',
        'Member',
        'Description',
        'In',
        'Out',
        'Balance',
        'Reference',
      ],
      [
        [
          day(d.period.from),
          '',
          'Opening balance',
          '',
          '',
          '',
          '',
          d.openingBalance,
          '',
        ],
        ...d.lines.map((l) => [
          day(l.date),
          l.fund,
          l.label,
          l.member ?? '',
          l.description ?? '',
          l.in || '',
          l.out || '',
          l.balance,
          l.reference,
        ]),
        [
          day(d.period.to),
          '',
          'Closing balance',
          '',
          '',
          d.totalIn,
          d.totalOut,
          d.closingBalance,
          '',
        ],
      ],
    );
  }
  return pdf(
    name,
    [
      ...title(
        `Cash book (${String(d.fund).toLowerCase()})`,
        d.group,
        `${day(d.period.from)} to ${day(d.period.to)}`,
      ),
      {
        text: `Opening ${fmt(d.openingBalance)} + in ${fmt(d.totalIn)} - out ${fmt(d.totalOut)} = closing ${fmt(d.closingBalance)} RWF`,
        bold: true,
        gap: 6,
      },
      {
        text: 'Date',
        bold: true,
        size: 8,
        gap: 8,
        columns: [
          [100, 'Type'],
          [230, 'Member'],
          [360, 'In'],
          [420, 'Out'],
          [480, 'Balance'],
        ],
      },
      ...d.lines.map(
        (l): PdfLine => ({
          text: day(l.date),
          size: 8,
          columns: [
            [100, l.label],
            [230, (l.member ?? '').slice(0, 24)],
            [360, l.in ? fmt(l.in) : ''],
            [420, l.out ? fmt(l.out) : ''],
            [480, fmt(l.balance)],
          ],
        }),
      ),
    ],
    'E-kimina cash book',
  );
}

// ── share-out ────────────────────────────────────────────────────────────
export function shareOutFile(
  d: Data<'shareOut'>,
  format: 'csv' | 'pdf',
): FileOut {
  const lines = d.lines as {
    fullName: string;
    openingBalance: number;
    savings: number;
    profitShare: number;
    grossAmount: number;
    fineDeduction: number;
    loanDeduction: number;
    netPayout: number;
    status?: string;
  }[];
  const name = `share-out-${slug(d.group)}-${slug(d.cycle.name)}`;
  if (format === 'csv') {
    return csv(
      name,
      [
        'Member',
        'Opening',
        'Savings',
        'Profit share',
        'Gross',
        'Fine deduction',
        'Loan deduction',
        'Net payout',
        'Status',
      ],
      lines.map((l) => [
        l.fullName,
        l.openingBalance,
        l.savings,
        l.profitShare,
        l.grossAmount,
        l.fineDeduction,
        l.loanDeduction,
        l.netPayout,
        l.status ?? (d.final ? '' : 'PREVIEW'),
      ]),
    );
  }
  const t = (d.totals ?? {}) as Record<string, number>;
  return pdf(
    name,
    [
      ...title(
        `Share-out - ${d.cycle.name}`,
        d.group,
        `${day(d.cycle.startDate)} to ${day(d.cycle.endDate)} - ${d.final ? 'final' : 'preview (cycle still open)'}`,
      ),
      {
        text: `Savings ${fmt(t.totalSavings)} + profit ${fmt(t.netProfit)} (interest ${fmt(t.interestIncome)}, penalties ${fmt(t.penaltyIncome)}, fines ${fmt(t.fineIncome)}, expenses -${fmt(t.expenses)})`,
        gap: 6,
      },
      {
        text: `Net payout ${fmt(t.netPayout)} RWF after ${fmt(t.deductions)} RWF of member debts`,
        bold: true,
      },
      {
        text: 'Member',
        bold: true,
        size: 9,
        gap: 8,
        columns: [
          [190, 'Savings'],
          [260, 'Profit'],
          [330, 'Gross'],
          [400, 'Debts'],
          [470, 'Net'],
        ],
      },
      ...lines.map(
        (l): PdfLine => ({
          text: l.fullName,
          size: 9,
          columns: [
            [190, fmt(l.savings + l.openingBalance)],
            [260, fmt(l.profitShare)],
            [330, fmt(l.grossAmount)],
            [400, fmt(l.fineDeduction + l.loanDeduction)],
            [470, fmt(l.netPayout)],
          ],
        }),
      ),
    ],
    'E-kimina share-out report',
  );
}

// ── receipt ──────────────────────────────────────────────────────────────
export function receiptFile(d: Data<'receipt'>): FileOut {
  return pdf(
    d.receiptNumber.toLowerCase(),
    [
      { text: 'Payment receipt', size: 18, bold: true },
      { text: d.group, size: 11 },
      { text: `Receipt ${d.receiptNumber}`, bold: true, gap: 10 },
      { text: `Received from: ${d.member.name} (${d.member.email})` },
      {
        text: `Date: ${d.paidAt.slice(0, 16).replace('T', ' ')} UTC    Method: ${d.method.replace('_', ' ')}${d.providerTransactionId ? `    Transaction: ${d.providerTransactionId}` : ''}`,
      },
      { text: `Confirmed by: ${d.confirmedBy ?? '-'}` },
      {
        text: `Amount: ${fmt(d.amount)} ${d.currency}`,
        size: 14,
        bold: true,
        gap: 10,
      },
      {
        text: `Contribution ${fmt(d.breakdown.contribution)} - fines ${fmt(d.breakdown.fines)} - loan ${fmt(d.breakdown.loan)}`,
        size: 9,
      },
      { text: 'Applied to', bold: true, gap: 10 },
      ...d.lines.map(
        (l): PdfLine => ({
          text: l.detail || l.kind,
          size: 9,
          columns: [[420, `${fmt(l.amount)} ${d.currency}`]],
        }),
      ),
    ],
    `E-kimina receipt ${d.receiptNumber} - keep this for your records`,
  );
}

// ── platform ─────────────────────────────────────────────────────────────
export function platformFile(
  d: Awaited<ReturnType<PlatformReportsService['metrics']>>,
): FileOut {
  return csv(
    `platform-metrics-${day(d.asOf)}`,
    [
      'Month',
      'Deposit volume',
      'Deposits',
      'MoMo volume',
      'Manual volume',
      'Loans disbursed',
      'New users',
      'New groups',
    ],
    d.series.map((s) => [
      s.month,
      s.depositVolume,
      s.depositCount,
      s.momoVolume,
      s.manualVolume,
      s.loansDisbursed,
      s.newUsers,
      s.newGroups,
    ]),
  );
}
