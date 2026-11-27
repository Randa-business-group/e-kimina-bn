import { hostname } from 'node:os';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { JobStatus, Prisma, type Job } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type JobHandler = (
  payload: Record<string, unknown>,
  job: Job,
) => Promise<void>;

/** Thrown by a handler when retrying is pointless (bad input, permanent refusal). */
export class PermanentJobError extends Error {}

const envInt = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/**
 * Durable background jobs in PostgreSQL (msfts §10; no Redis available here). Workers claim
 * rows with `FOR UPDATE SKIP LOCKED`, so several API instances can share the queue.
 * Failed jobs are retried with exponential backoff; after `maxAttempts` they become DEAD and
 * show up in the admin job view. JOBS_WORKER_ENABLED=false turns the worker off on an
 * instance (e.g. web-only nodes); JOBS_POLL_MS sets the idle poll (default 1000 ms).
 */
@Injectable()
export class JobQueueService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(JobQueueService.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workerId = `${hostname()}:${process.pid}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kicked = false;
  private stopped = false;
  private lastMaintenance = 0;

  constructor(private readonly prisma: PrismaService) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  get workerEnabled(): boolean {
    return process.env.JOBS_WORKER_ENABLED !== 'false';
  }

  onApplicationBootstrap() {
    if (!this.workerEnabled) {
      this.logger.log('Job worker disabled on this instance.');
      return;
    }
    this.schedule(envInt('JOBS_POLL_MS', 1000));
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  /** Adds a job. With a dedupe key, a second PENDING/RUNNING job for it is skipped (null). */
  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
  ): Promise<Job | null> {
    try {
      const job = await this.prisma.job.create({
        data: {
          type,
          payload: payload as Prisma.InputJsonValue,
          runAt: opts.runAt ?? new Date(),
          dedupeKey: opts.dedupeKey ?? null,
          maxAttempts: opts.maxAttempts ?? 5,
        },
      });
      if (!opts.runAt || opts.runAt <= new Date()) this.kick();
      return job;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return null;
      throw e;
    }
  }

  /** Run soon instead of waiting for the next poll. */
  kick() {
    if (!this.workerEnabled || this.stopped) return;
    this.kicked = true;
    if (!this.running) this.schedule(20);
  }

  static backoffMs(attempts: number): number {
    return Math.min(3600_000, 15_000 * 2 ** Math.max(0, attempts - 1));
  }

  private async claim(limit: number): Promise<Job[]> {
    return this.prisma.$queryRaw<Job[]>(Prisma.sql`
      UPDATE "jobs" SET "status" = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${this.workerId},
        "attempts" = "attempts" + 1
      WHERE "id" IN (
        SELECT "id" FROM "jobs"
        WHERE "status" IN ('PENDING', 'FAILED') AND "runAt" <= now()
        ORDER BY "runAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
  }

  private async runOne(job: Job) {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler)
        throw new PermanentJobError(`No handler for job type ${job.type}`);
      await handler((job.payload ?? {}) as Record<string, unknown>, job);
      await this.prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.DONE,
          finishedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const dead =
        e instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      await this.prisma.job.update({
        where: { id: job.id },
        data: dead
          ? {
              status: JobStatus.DEAD,
              finishedAt: new Date(),
              lockedAt: null,
              lastError: message.slice(0, 1000),
            }
          : {
              status: JobStatus.FAILED,
              lockedAt: null,
              lastError: message.slice(0, 1000),
              runAt: new Date(
                Date.now() + JobQueueService.backoffMs(job.attempts),
              ),
            },
      });
      this.logger[dead ? 'error' : 'warn'](
        `job ${job.type} ${job.id} ${dead ? 'is dead' : `failed (attempt ${job.attempts}/${job.maxAttempts})`}: ${message}`,
      );
    }
  }

  /** Crash recovery and housekeeping, at most once a minute. */
  private async maintenance() {
    if (Date.now() - this.lastMaintenance < 60_000) return;
    this.lastMaintenance = Date.now();
    await this.prisma.job.updateMany({
      where: {
        status: JobStatus.RUNNING,
        lockedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      data: {
        status: JobStatus.FAILED,
        lockedAt: null,
        lastError: 'worker stopped while running',
      },
    });
    await this.prisma.job.deleteMany({
      where: {
        status: JobStatus.DONE,
        finishedAt: { lt: new Date(Date.now() - 7 * 86400_000) },
      },
    });
  }

  /** Process everything that is due (also used by tests). Returns jobs handled. */
  async drain(max = 500): Promise<number> {
    let done = 0;
    while (done < max) {
      const jobs = await this.claim(Math.min(10, max - done));
      if (!jobs.length) break;
      await Promise.all(jobs.map((j) => this.runOne(j)));
      done += jobs.length;
    }
    return done;
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.kicked = false;
    try {
      await this.maintenance();
      await this.drain();
    } catch (e) {
      this.logger.error(
        `job worker error: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
      this.schedule(this.kicked ? 20 : envInt('JOBS_POLL_MS', 1000));
    }
  }

  // ── admin view ────────────────────────────────────────────────────────

  async summary() {
    const [byStatus, byType, recent] = await Promise.all([
      this.prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.job.groupBy({
        by: ['type', 'status'],
        where: {
          status: { in: [JobStatus.PENDING, JobStatus.FAILED, JobStatus.DEAD] },
        },
        _count: { _all: true },
      }),
      this.prisma.job.findMany({
        where: { status: { in: [JobStatus.FAILED, JobStatus.DEAD] } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          lastError: true,
          runAt: true,
          createdAt: true,
        },
      }),
    ]);
    const oldest = await this.prisma.job.findFirst({
      where: { status: JobStatus.PENDING },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    });
    return {
      worker: { enabled: this.workerEnabled, id: this.workerId },
      counts: Object.fromEntries(
        byStatus.map((b) => [b.status, b._count._all]),
      ),
      backlog: byType.map((b) => ({
        type: b.type,
        status: b.status,
        count: b._count._all,
      })),
      oldestPendingSeconds: oldest
        ? Math.max(0, Math.round((Date.now() - oldest.runAt.getTime()) / 1000))
        : 0,
      problems: recent,
    };
  }

  async retry(id: string) {
    const r = await this.prisma.job.updateMany({
      where: { id, status: { in: [JobStatus.DEAD, JobStatus.FAILED] } },
      data: {
        status: JobStatus.PENDING,
        runAt: new Date(),
        attempts: 0,
        lastError: null,
        finishedAt: null,
      },
    });
    if (r.count) this.kick();
    return { retried: r.count === 1 };
  }
}
