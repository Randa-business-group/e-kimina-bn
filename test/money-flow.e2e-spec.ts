/* eslint-disable @typescript-eslint/no-require-imports -- the app must load after the test env is set */
/**
 * End-to-end money flow (msfts §10): register → create group → join → verify → contribute →
 * apply for a loan (idempotent) → approve + pay out → repay. Runs the real app against the
 * database in DATABASE_URL (migrated and seeded: it uses the seeded super admin).
 * External services are simulated: SMS (mock inbox), MTN MoMo (mock), no SMTP.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

process.env.SMS_PROVIDER = 'mock';
process.env.SMTP_HOST = '';
process.env.MOMO_MODE = 'mock';
process.env.FINANCE_JOBS_ENABLED = 'false';
process.env.JOBS_WORKER_ENABLED = 'false';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.ACCESS_LOG = 'false';

type Api = ReturnType<typeof request>;

describe('money flow (e2e)', () => {
  let app: INestApplication;
  let http: Api;
  let inbox: (phone: string) => { message: string }[];
  const run = Date.now().toString(36);
  const created = { users: [] as string[], groupId: '' };

  const as = (token?: string) => ({
    get: (p: string) =>
      request(app.getHttpServer())
        .get(`/api${p}`)
        .set('Authorization', `Bearer ${token}`),
    post: (
      p: string,
      body: object = {},
      headers: Record<string, string> = {},
    ) =>
      request(app.getHttpServer())
        .post(`/api${p}`)
        .set('Authorization', `Bearer ${token}`)
        .set(headers)
        .send(body),
    put: (p: string, body: object) =>
      request(app.getHttpServer())
        .put(`/api${p}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (p: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/api${p}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  async function signUp(name: string, phone: string) {
    const email = `e2e.${name}.${run}@example.com`;
    const reg = await http.post('/api/auth/register').send({
      email,
      password: 'Password123!',
      fullName: `E2E ${name}`,
      phoneNumber: phone,
    });
    expect(reg.status).toBe(201);
    const code = /\b(\d{6})\b/.exec(inbox(phone)[0]?.message ?? '')?.[1];
    expect(code).toBeDefined();
    const ver = await http
      .post('/api/auth/verify-email')
      .send({ email, otp: code });
    expect(ver.status).toBe(200);
    created.users.push(ver.body.user.id);
    return {
      token: ver.body.accessToken as string,
      id: ver.body.user.id as string,
      email,
    };
  }

  beforeAll(async () => {
    // Loaded after the env above is set (the config module reads it at import time).
    const { Test } =
      require('@nestjs/testing') as typeof import('@nestjs/testing');
    const { AppModule } =
      require('../src/app.module') as typeof import('../src/app.module');
    const { ValidationPipe } =
      require('@nestjs/common') as typeof import('@nestjs/common');
    const { AllExceptionsFilter } =
      require('../src/common/filters/all-exceptions.filter') as typeof import('../src/common/filters/all-exceptions.filter');
    const { SmsService } =
      require('../src/notifications/sms.service') as typeof import('../src/notifications/sms.service');
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    http = request(app.getHttpServer()) as unknown as Api;
    const sms = app.get(SmsService);
    inbox = (phone) => sms.mockInbox(phone);
  });

  afterAll(async () => {
    if (app) {
      const { PrismaService } =
        require('../src/prisma/prisma.service') as typeof import('../src/prisma/prisma.service');
      const prisma = app.get(PrismaService);
      if (created.groupId)
        await prisma.group
          .delete({ where: { id: created.groupId } })
          .catch(() => undefined);
      if (created.users.length)
        await prisma.user.deleteMany({ where: { id: { in: created.users } } });
      await app.close();
    }
  });

  it('runs the whole money flow', async () => {
    const digits = String(Date.now()).slice(-6);
    const admin = await signUp(
      'admin',
      `0788${digits.slice(0, 3)}${digits.slice(3)}`,
    );
    const member = await signUp(
      'member',
      `0789${digits.slice(0, 3)}${digits.slice(3)}`,
    );
    const A = as(admin.token);
    const M = as(member.token);

    // group: create (public), member asks to join, admin approves
    const g = await A.post('/groups', {
      name: `E2E group ${run}`,
      maxMembers: 10,
      minMembers: 2,
      isPublic: true,
    });
    expect(g.status).toBe(201);
    created.groupId = g.body.id;
    const G = `/groups/${g.body.id}`;
    expect((await M.post(`${G}/join`)).status).toBeLessThan(300);
    const approve = await A.post(
      `${G}/governance/join-requests/${member.id}/approve`,
    );
    expect(approve.status).toBeLessThan(300);

    // a super admin verifies the group (unlocks money features)
    const sa = await http
      .post('/api/auth/login')
      .send({ email: 'superadmin@ekimina.local', password: 'Password123!' });
    expect(sa.status).toBe(200);
    expect(
      (await as(sa.body.accessToken).patch(`${G}/verify`, {})).status,
    ).toBe(200);

    // rules: weekly 10,000 RWF started a week ago; loans up to 3× savings, 10% flat
    const start = new Date(Date.now() - 8 * 86400_000);
    start.setUTCHours(8, 0, 0, 0);
    const cc = await A.put(`${G}/contribution-config`, {
      amount: 10000,
      interval: 'WEEKLY',
      startDate: start.toISOString(),
      dayOfWeek: start.getUTCDay(),
      allowPartialPayments: false,
      gracePeriodDays: 2,
    });
    expect(cc.status).toBe(200);
    const lc = await A.put(`${G}/loan-config`, {
      interestRate: 10,
      repaymentPeriodDays: 30,
      allowExceedContribution: true,
      maxLoanMultiplier: 3,
      allowPartialPayments: true,
      gracePeriodDays: 3,
    });
    expect(lc.status).toBe(200);

    // both pay what is due by MoMo (simulated provider settles at once)
    for (const [who, phone] of [
      [A, '0788000111'],
      [M, '0788000222'],
    ] as const) {
      const p = await who.get(`${G}/finance/deposit-preview`);
      expect(p.body.total).toBeGreaterThan(0);
      const d = await who.post(`${G}/finance/deposits`, {
        amount: p.body.total,
        paymentMethod: 'MTN_MOMO',
        phone,
      });
      expect(d.status).toBe(201);
      expect(d.body.status).toBe('CONFIRMED');
    }
    const summary = await A.get(`${G}/accounting/summary`);
    expect(summary.body.cash.savingsBalance).toBeGreaterThanOrEqual(20000);

    // loan: eligibility, idempotent apply, approval and payout
    const pre = await M.get(`${G}/finance/loan-request-preview`);
    expect(pre.body.canRequest).toBe(true);
    const amount = Math.min(pre.body.maxAmount, 15000);
    const key = `e2e-loan-${run}`;
    const app1 = await M.post(
      `${G}/finance/loan-applications`,
      { requestedAmount: amount },
      { 'Idempotency-Key': key },
    );
    expect(app1.status).toBe(201);
    const app2 = await M.post(
      `${G}/finance/loan-applications`,
      { requestedAmount: amount },
      { 'Idempotency-Key': key },
    );
    expect(app2.body.id).toBe(app1.body.id); // a double click does not create a second request
    expect(app2.body.replayed).toBe(true);

    const ok = await A.post(
      `${G}/finance/loan-applications/${app1.body.id}/approve`,
    );
    expect(ok.status).toBeLessThan(300);
    const loans = await A.get(`${G}/finance/member-loans`);
    const loan = loans.body.find(
      (l: { userId: string }) => l.userId === member.id,
    );
    expect(loan).toBeDefined();
    expect(loan.status).toBe('ACTIVE');
    expect(loan.principal).toBe(amount);
    expect(loan.totalRepayable).toBeCloseTo(amount * 1.1, 2);

    // repay everything
    const rp = await M.get(
      `${G}/finance/loan-repayment-preview?memberLoanId=${loan.id}`,
    );
    expect(rp.status).toBe(200);
    const due = rp.body.installment ?? rp.body.total;
    const pay = await M.post(`${G}/finance/deposits`, {
      amount: due,
      paymentMethod: 'MTN_MOMO',
      phone: '0788000222',
      memberLoanId: loan.id,
      idempotencyKey: `e2e-repay-${run}`,
    });
    expect(pay.status).toBe(201);
    expect(pay.body.status).toBe('CONFIRMED');
    const after = (await A.get(`${G}/finance/member-loans`)).body.find(
      (l: { id: string }) => l.id === loan.id,
    );
    expect(after.status).toBe('REPAID');
    expect(after.outstanding).toBe(0);

    // the books balance: savings + interest earned are in the cash book
    const end = await A.get(`${G}/accounting/summary`);
    expect(end.body.cash.savingsBalance).toBeCloseTo(
      summary.body.cash.savingsBalance + amount * 0.1,
      0,
    );
  });
});
