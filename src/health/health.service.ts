import { Injectable } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { JobQueueService } from '../jobs/job-queue.service';
import { SmsService } from '../notifications/sms.service';
import { MomoService } from '../payments/momo.service';
import { PrismaService } from '../prisma/prisma.service';

type Check = {
  status: 'up' | 'down' | 'disabled' | 'degraded';
  latencyMs?: number;
  error?: string;
  [k: string]: unknown;
};

/**
 * Health (msfts §10): `live` = the process answers; `ready` = it can serve (database);
 * the full report adds SMTP, Cloudinary, SMS, MoMo and the job queue. A failing optional
 * dependency makes the report `degraded`, never `down`.
 */
@Injectable()
export class HealthService {
  private cloudinaryCheck: { at: number; result: Check } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly momo: MomoService,
    private readonly queue: JobQueueService,
  ) {}

  live() {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  private async database(): Promise<Check> {
    const t = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - t };
    } catch (e) {
      return {
        status: 'down',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async ready() {
    const database = await this.database();
    return { status: database.status === 'up' ? 'ok' : 'down', database };
  }

  private async cloudinary(): Promise<Check> {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
    const key = process.env.CLOUDINARY_API_KEY?.trim();
    const secret = process.env.CLOUDINARY_API_SECRET?.trim();
    if (!cloud || !key || !secret) return { status: 'disabled' };
    if (
      this.cloudinaryCheck &&
      Date.now() - this.cloudinaryCheck.at < 5 * 60_000
    ) {
      return this.cloudinaryCheck.result;
    }
    const t = Date.now();
    let result: Check;
    try {
      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/ping`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
          },
          signal: AbortSignal.timeout(5000),
        },
      );
      result = res.ok
        ? { status: 'up', latencyMs: Date.now() - t }
        : { status: 'down', error: `HTTP ${res.status}` };
    } catch (e) {
      result = {
        status: 'down',
        error: e instanceof Error ? e.message : String(e),
      };
    }
    this.cloudinaryCheck = { at: Date.now(), result };
    return result;
  }

  private async jobs(): Promise<Check> {
    try {
      const [dead, pending, oldest] = await Promise.all([
        this.prisma.job.count({
          where: {
            status: JobStatus.DEAD,
            createdAt: { gte: new Date(Date.now() - 86400_000) },
          },
        }),
        this.prisma.job.count({
          where: { status: { in: [JobStatus.PENDING, JobStatus.FAILED] } },
        }),
        this.prisma.job.findFirst({
          where: { status: JobStatus.PENDING },
          orderBy: { runAt: 'asc' },
          select: { runAt: true },
        }),
      ]);
      const lagSeconds = oldest
        ? Math.max(0, Math.round((Date.now() - oldest.runAt.getTime()) / 1000))
        : 0;
      const status: Check['status'] = !this.queue.workerEnabled
        ? 'disabled'
        : lagSeconds > 300 || dead > 0
          ? 'degraded'
          : 'up';
      return {
        status,
        pending,
        deadLast24h: dead,
        lagSeconds,
        worker: this.queue.workerEnabled,
      };
    } catch (e) {
      return {
        status: 'down',
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async check() {
    const [database, smtp, cloudinary, jobs] = await Promise.all([
      this.database(),
      this.email.smtpHealth(),
      this.cloudinary(),
      this.jobs(),
    ]);
    const checks: Record<string, Check> = {
      database,
      smtp,
      cloudinary,
      sms: {
        status: this.sms.enabled ? 'up' : 'disabled',
        provider: this.sms.provider,
      },
      momo: {
        status: this.momo.mode === 'disabled' ? 'disabled' : 'up',
        mode: this.momo.mode,
        collection: this.momo.isEnabled('collection'),
        disbursement: this.momo.isEnabled('disbursement'),
      },
      jobs,
    };
    const status =
      database.status !== 'up'
        ? 'down'
        : Object.values(checks).some(
              (c) => c.status === 'down' || c.status === 'degraded',
            )
          ? 'degraded'
          : 'ok';
    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version:
        process.env.APP_VERSION ?? process.env.npm_package_version ?? null,
      database: database.status,
      checks,
    };
  }
}
